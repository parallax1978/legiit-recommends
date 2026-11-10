import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeOpenAI } from "../support/fake-openai.ts";
import {
  VALID_KEY,
  addMember,
  admin,
  anonClient,
  closeConnections,
  createCampaign,
  createConnection,
  createUser,
  createWorkspace,
  drain,
  expectDbError,
  launch,
  ops,
  resetDatabase,
  rpc,
  sql,
  startFake,
  tick,
  type CampaignFixture,
  type ConnectionFixture,
  type TestUser,
  type Workspace,
} from "./harness.ts";

let fake: FakeOpenAI;
let alpha: Workspace;
let beta: Workspace;
let alphaConnection: ConnectionFixture;
let alphaCampaign: CampaignFixture;
let alphaAdmin: TestUser;
let alphaMember: TestUser;
let outsider: TestUser;
let alphaRunId: string;
let alphaJobId: string;

const TENANT_TABLES = [
  "workspaces",
  "workspace_members",
  "workspace_invitations",
  "audit_events",
  "provider_connections",
  "provider_models",
  "templates",
  "template_versions",
  "probe_sets",
  "probe_set_versions",
  "probe_questions",
  "campaigns",
  "campaign_revisions",
  "campaign_revision_steps",
  "campaign_revision_step_templates",
  "comparison_groups",
  "jobs",
  "runs",
  "run_turns",
  "fresh_checks",
  "manual_checks",
  "variation_generations",
  "provider_attempts",
  "budget_reservations",
  "usage_ledger",
  "classifications",
];

beforeAll(async () => {
  fake = await startFake();
  await resetDatabase();

  // Workspace "alpha" has real data in every table; "beta" belongs to someone else.
  alpha = await createWorkspace("Alpha");
  beta = await createWorkspace("Beta");
  alphaAdmin = await addMember(alpha, "admin");
  alphaMember = await addMember(alpha, "member");
  outsider = await createUser("outsider");

  alphaConnection = await createConnection(alpha, fake);
  alphaCampaign = await createCampaign(alpha, alphaConnection, { config: { baseline_samples: 2 } });
  await launch(alpha, alphaCampaign);
  await drain(fake);
  await tick();
  const [slot] = await sql<{ id: string; scheduled_for: Date }>(
    "select id, scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' and status = 'pending' order by scheduled_for limit 1",
    [alphaCampaign.id],
  );
  alphaJobId = slot!.id;
  await tick(new Date(slot!.scheduled_for));
  await drain(fake);
  const [run] = await sql<{ id: string }>("select id from public.runs where campaign_id = $1 limit 1", [alphaCampaign.id]);
  alphaRunId = run!.id;

  await ops(alpha.owner, fake, "members.invite", { workspace_id: alpha.id, email: "pending-invite@lr.test", role: "member" }).catch(() => undefined);
  await rpc(alpha.owner.client, "record_manual_check", {
    p_campaign_id: alphaCampaign.id,
    p_observed_on: new Date().toISOString().slice(0, 10),
    p_source_label: "ChatGPT web app",
    p_question: "Best coffee subscriptions?",
    p_response_text: "1. Alpha\n2. Beta",
    p_classification: null,
  });
  await ops(alpha.owner, fake, "variations.generate", {
    workspace_id: alpha.id,
    campaign_id: alphaCampaign.id,
    kind: "initial_question",
    count: 2,
  });
}, 180_000);

afterAll(async () => {
  await fake.stop();
  await closeConnections();
});

describe("workspace isolation", () => {
  it("lets members read their own workspace's data", async () => {
    for (const table of TENANT_TABLES) {
      if (table === "workspace_invitations" || table === "audit_events" || table === "variation_generations") continue;
      const { data, error } = await alphaMember.client.from(table).select("*").limit(5);
      expect(error, table).toBeNull();
      expect(data!.length, `${table} should be readable by a member`).toBeGreaterThan(0);
    }
  });

  it("hides every tenant table from other workspaces, strangers and anonymous callers", async () => {
    // Sanity: the rows exist.
    for (const table of TENANT_TABLES) {
      const [count] = await sql<{ n: string }>(`select count(*) as n from public.${table} where workspace_id = $1`.replace("workspace_id = $1", table === "workspaces" ? "id = $1" : "workspace_id = $1"), [alpha.id]);
      expect(Number(count!.n), `${table} has alpha rows`).toBeGreaterThan(0);
    }

    for (const [label, client] of [
      ["other workspace owner", beta.owner.client],
      ["user without workspace", outsider.client],
      ["anonymous", anonClient()],
    ] as const) {
      for (const table of TENANT_TABLES) {
        const column = table === "workspaces" ? "id" : "workspace_id";
        const { data, error } = await client.from(table).select("*").eq(column, alpha.id);
        // Either no rows (RLS) or no privilege at all (anonymous): never data.
        expect(data ?? [], `${label} reading ${table}`).toEqual([]);
        if (label !== "anonymous") expect(error, `${label} reading ${table}`).toBeNull();
      }
    }
  });

  it("gives no client role direct write access to any table", async () => {
    const rows = await sql<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type
       from information_schema.role_table_grants
       where table_schema in ('public', 'app_private')
         and grantee in ('anon', 'authenticated', 'PUBLIC')
         and privilege_type <> 'SELECT'`,
    );
    expect(rows).toEqual([]);
    const anonSelect = await sql(
      "select table_name from information_schema.role_table_grants where table_schema in ('public', 'app_private') and grantee = 'anon'",
    );
    expect(anonSelect).toEqual([]);

    // And in practice: a member's own direct writes are refused.
    const insert = await alpha.owner.client.from("campaigns").insert({ workspace_id: alpha.id, name: "direct" });
    expect(insert.error).not.toBeNull();
    const update = await alpha.owner.client.from("campaigns").update({ status: "completed" }).eq("id", alphaCampaign.id).select();
    expect(update.error).not.toBeNull();
    const remove = await alpha.owner.client.from("usage_ledger").delete().eq("workspace_id", alpha.id).select();
    expect(remove.error).not.toBeNull();
    const [still] = await sql<{ n: string }>("select count(*) as n from public.usage_ledger where workspace_id = $1", [alpha.id]);
    expect(Number(still!.n)).toBeGreaterThan(0);
  });

  it("enables row level security on every application table", async () => {
    const rows = await sql<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'app_private') and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("exposes only the intended functions to browser roles", async () => {
    const callable = await sql<{ name: string; grantee: string }>(
      `select p.proname as name, r.rolname as grantee
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_roles r on r.rolname in ('anon', 'authenticated')
       where n.nspname in ('public', 'app_private')
         and has_function_privilege(r.oid, p.oid, 'execute')
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
    );
    expect(callable.filter((row) => row.grantee === "anon")).toEqual([]);
    const names = new Set(callable.map((row) => row.name));
    // Nothing privileged is reachable: no service functions, no queue, budget or secret internals.
    for (const name of names) {
      expect(name.startsWith("svc_"), name).toBe(false);
    }
    const privateCallable = await sql<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and has_function_privilege('authenticated', p.oid, 'execute')`,
    );
    expect(privateCallable.map((row) => row.name).sort()).toEqual(["is_admin", "is_member", "is_owner", "role_in"]);

    // Browser roles cannot reach the queue, Vault or the secret reference table at all.
    const [access] = await sql<Record<string, boolean>>(
      `select has_schema_privilege('authenticated', 'pgmq', 'usage') as pgmq,
              has_schema_privilege('authenticated', 'vault', 'usage') as vault,
              has_table_privilege('authenticated', 'app_private.connection_secrets', 'select') as secrets,
              has_table_privilege('authenticated', 'vault.decrypted_secrets', 'select') as decrypted`,
    );
    expect(access).toEqual({ pgmq: false, vault: false, secrets: false, decrypted: false });

    for (const fn of ["svc_get_connection_secret", "svc_receive_work", "svc_tick", "svc_bootstrap_owner"]) {
      const { error } = await alpha.owner.client.rpc(fn, fn === "svc_get_connection_secret" ? { p_connection_id: alphaConnection.id } : fn === "svc_receive_work" ? { p_worker_id: "x" } : fn === "svc_bootstrap_owner" ? { p_email: "x@lr.test" } : {});
      expect(error, fn).not.toBeNull();
    }
  });

  it("does not let a known id from another workspace grant access through any RPC", async () => {
    const stranger = beta.owner.client;
    const calls: [string, Record<string, unknown>][] = [
      ["pause_campaign", { p_campaign_id: alphaCampaign.id }],
      ["resume_campaign", { p_campaign_id: alphaCampaign.id }],
      ["cancel_campaign", { p_campaign_id: alphaCampaign.id }],
      ["delete_campaign", { p_campaign_id: alphaCampaign.id }],
      ["duplicate_campaign", { p_campaign_id: alphaCampaign.id }],
      ["set_campaign_archived", { p_campaign_id: alphaCampaign.id, p_archived: true }],
      ["save_campaign_draft", { p_campaign_id: alphaCampaign.id, p_patch: { name: "hijacked" } }],
      ["begin_campaign_edit", { p_campaign_id: alphaCampaign.id }],
      ["launch_campaign", { p_campaign_id: alphaCampaign.id, p_expected_revision_id: alphaCampaign.revisionId }],
      ["request_test_conversation", { p_campaign_id: alphaCampaign.id }],
      ["campaign_launch_check", { p_campaign_id: alphaCampaign.id }],
      ["campaign_plan_preview", { p_campaign_id: alphaCampaign.id }],
      ["retry_job", { p_job_id: alphaJobId }],
      ["restart_run", { p_run_id: alphaRunId }],
      ["create_campaign", { p_workspace_id: alpha.id, p_name: "intruder" }],
      ["create_connection", { p_workspace_id: alpha.id, p_name: "intruder", p_daily_budget_usd: 1 }],
      ["update_connection", { p_connection_id: alphaConnection.id, p_patch: { daily_budget_usd: 9999 } }],
      ["archive_connection", { p_connection_id: alphaConnection.id }],
      ["declare_data_sharing", { p_connection_id: alphaConnection.id, p_setting: "enabled", p_verified_on: "2026-01-01" }],
      ["add_model_price", { p_workspace_id: alpha.id, p_price: { model_id: "x", input_usd_per_mtok: 0, output_usd_per_mtok: 0, source_url: "https://x.test", verified_on: "2026-01-01" } }],
      ["create_templates", { p_workspace_id: alpha.id, p_kind: "initial_question", p_items: [{ body: "x" }] }],
      ["save_probe_set", { p_workspace_id: alpha.id, p_probe_set_id: null, p_name: "x", p_description: null, p_questions: [{ body: "x", is_held_out: false }] }],
      ["update_workspace", { p_workspace_id: alpha.id, p_name: "hijacked", p_retention_days: null }],
      ["set_emergency_stop", { p_workspace_id: alpha.id, p_enabled: true }],
      ["update_member_role", { p_workspace_id: alpha.id, p_user_id: alphaMember.id, p_role: "owner" }],
      ["remove_member", { p_workspace_id: alpha.id, p_user_id: alphaMember.id }],
      ["delete_workspace", { p_workspace_id: alpha.id, p_confirm_name: "Alpha" }],
      ["budget_status", { p_workspace_id: alpha.id }],
      ["operational_status", { p_workspace_id: alpha.id }],
      ["record_manual_check", { p_campaign_id: alphaCampaign.id, p_observed_on: "2026-01-01", p_source_label: "x", p_question: null, p_response_text: "x", p_classification: null }],
    ];
    for (const [fn, args] of calls) {
      await expectDbError(rpc(stranger, fn, args), "forbidden");
    }

    // Reporting functions run with the caller's own row access: they return nothing.
    expect(await rpc(stranger, "campaign_conversation_metrics", { p_campaign_id: alphaCampaign.id })).toEqual([]);
    expect(await rpc(stranger, "campaign_check_metrics", { p_campaign_id: alphaCampaign.id })).toEqual([]);
    expect(await rpc(stranger, "usage_daily", { p_workspace_id: alpha.id, p_from: "2020-01-01", p_to: "2099-01-01" })).toEqual([]);
    const prices = await rpc<{ workspace_id: string | null }[]>(stranger, "effective_prices", { p_workspace_id: alpha.id });
    expect(prices.every((price) => price.workspace_id === null)).toBe(true);

    const [campaign] = await sql<{ name: string; status: string }>("select name, status from public.campaigns where id = $1", [alphaCampaign.id]);
    expect(campaign).toEqual({ name: "Coffee subscriptions", status: "running" });
  });

  it("enforces roles inside a workspace", async () => {
    // Members read and export; they cannot change anything.
    await expectDbError(rpc(alphaMember.client, "pause_campaign", { p_campaign_id: alphaCampaign.id }), "forbidden");
    await expectDbError(rpc(alphaMember.client, "create_campaign", { p_workspace_id: alpha.id, p_name: "x" }), "forbidden");
    await expectDbError(rpc(alphaMember.client, "correct_classification", { p_subject_type: "run_turn", p_subject_id: alphaRunId, p_inclusion: "included" }), "forbidden");
    expect(await rpc(alphaMember.client, "campaign_conversation_metrics", { p_campaign_id: alphaCampaign.id })).toHaveLength(1);

    // Admins manage campaigns and runs, but not credentials, limits, members or pricing.
    await rpc(alphaAdmin.client, "pause_campaign", { p_campaign_id: alphaCampaign.id });
    await rpc(alphaAdmin.client, "resume_campaign", { p_campaign_id: alphaCampaign.id });
    await expectDbError(rpc(alphaAdmin.client, "update_connection", { p_connection_id: alphaConnection.id, p_patch: { daily_budget_usd: 999 } }), "forbidden");
    await expectDbError(rpc(alphaAdmin.client, "set_emergency_stop", { p_workspace_id: alpha.id, p_enabled: true }), "forbidden");
    await expectDbError(rpc(alphaAdmin.client, "update_member_role", { p_workspace_id: alpha.id, p_user_id: alphaMember.id, p_role: "admin" }), "forbidden");
    await expectDbError(rpc(alphaAdmin.client, "add_model_price", { p_workspace_id: alpha.id, p_price: { model_id: "x", input_usd_per_mtok: 1, output_usd_per_mtok: 1, source_url: "https://x.test", verified_on: "2026-01-01" } }), "forbidden");
    await expectDbError(rpc(alphaAdmin.client, "delete_campaign", { p_campaign_id: alphaCampaign.id }), "forbidden");
    await expectDbError(rpc(alphaAdmin.client, "delete_workspace", { p_workspace_id: alpha.id, p_confirm_name: "Alpha" }), "forbidden");

    // Invitations and the audit trail are not visible to members.
    expect((await alphaMember.client.from("workspace_invitations").select("*")).data).toEqual([]);
    expect((await alphaMember.client.from("audit_events").select("*").limit(1)).data).toEqual([]);
    expect((await alphaAdmin.client.from("audit_events").select("*").limit(1)).data!.length).toBe(1);

    // The last owner cannot be removed or demoted.
    await expectDbError(rpc(alpha.owner.client, "update_member_role", { p_workspace_id: alpha.id, p_user_id: alpha.owner.id, p_role: "admin" }), "last_owner");
    await expectDbError(rpc(alpha.owner.client, "remove_member", { p_workspace_id: alpha.id, p_user_id: alpha.owner.id }), "last_owner");
  });

  it("authorizes the acting user again inside privileged operations", async () => {
    // Edge Function handlers: another workspace's owner, a member and an admin of this workspace.
    const forbidden: [TestUser, string, Record<string, unknown>][] = [
      [beta.owner, "connection.set_credential", { connection_id: alphaConnection.id, api_key: VALID_KEY }],
      [beta.owner, "connection.test", { connection_id: alphaConnection.id }],
      [beta.owner, "model.verify", { connection_id: alphaConnection.id, model_id: "fake-chat-1", max_output_tokens: 100 }],
      [beta.owner, "variations.generate", { workspace_id: alpha.id, campaign_id: alphaCampaign.id, kind: "initial_question", count: 2 }],
      [beta.owner, "members.invite", { workspace_id: alpha.id, email: "x@lr.test", role: "owner" }],
      [alphaAdmin, "connection.set_credential", { connection_id: alphaConnection.id, api_key: VALID_KEY }],
      [alphaAdmin, "model.verify", { connection_id: alphaConnection.id, model_id: "fake-chat-1", max_output_tokens: 100 }],
      [alphaAdmin, "members.invite", { workspace_id: alpha.id, email: "x@lr.test", role: "owner" }],
      [alphaMember, "connection.test", { connection_id: alphaConnection.id }],
      [alphaMember, "variations.generate", { workspace_id: alpha.id, campaign_id: alphaCampaign.id, kind: "initial_question", count: 2 }],
    ];
    const before = fake.requests.length;
    for (const [user, action, input] of forbidden) {
      const result = await ops(user, fake, action, input);
      expect(result, `${action} as ${user.email}`).toMatchObject({ ok: false, code: "not_found" });
    }
    // Refused before anything reached the provider.
    expect(fake.requests.length).toBe(before);

    // Mixing a workspace the caller owns with a campaign from another workspace is refused.
    const mixed = await ops(beta.owner, fake, "variations.generate", {
      workspace_id: beta.id,
      campaign_id: alphaCampaign.id,
      kind: "initial_question",
      count: 2,
    });
    expect(mixed).toMatchObject({ ok: false, code: "not_found" });

    // The SQL service functions check the actor themselves, whoever calls them.
    await expectDbError(
      rpc(admin(), "svc_store_connection_secret", { p_connection_id: alphaConnection.id, p_actor: beta.owner.id, p_api_key: VALID_KEY }),
      "forbidden",
    );
    await expectDbError(
      rpc(admin(), "svc_invite_member", { p_workspace_id: alpha.id, p_actor: alphaAdmin.id, p_email: "y@lr.test", p_role: "member" }),
      "forbidden",
    );
    await expectDbError(
      rpc(admin(), "svc_begin_adhoc", {
        p_workspace_id: alpha.id,
        p_actor: beta.owner.id,
        p_connection_id: alphaConnection.id,
        p_purpose: "variation_generation",
        p_model: "fake-chat-1",
        p_requests: [{ est_input_tokens: 10, max_output_tokens: 16 }],
      }),
      "forbidden",
    );
  });

  it("never stores or returns the API key outside Vault", async () => {
    const [connection] = await sql<Record<string, unknown>>("select * from public.provider_connections where id = $1", [alphaConnection.id]);
    expect(JSON.stringify(connection)).not.toContain(VALID_KEY);
    expect(connection!.key_hint).toBe(`${VALID_KEY.slice(0, 3)}…${VALID_KEY.slice(-4)}`);

    // Nothing an authenticated member can read contains the key.
    for (const table of ["provider_connections", "provider_attempts", "audit_events", "provider_models"]) {
      const { data } = await alpha.owner.client.from(table).select("*");
      expect(JSON.stringify(data), table).not.toContain(VALID_KEY);
    }
    // Only the trusted backend path can decrypt it.
    expect(await rpc(admin(), "svc_get_connection_secret", { p_connection_id: alphaConnection.id })).toBe(VALID_KEY);
    // The provider double never logs credentials either.
    expect(JSON.stringify(fake.requests)).not.toContain(VALID_KEY);
  });

  it("prevents cross-workspace links at the database level", async () => {
    const betaConnection = await rpc<string>(beta.owner.client, "create_connection", {
      p_workspace_id: beta.id,
      p_name: "Beta connection",
      p_daily_budget_usd: 1,
    });
    const betaCampaign = await rpc<string>(beta.owner.client, "create_campaign", { p_workspace_id: beta.id, p_name: "Beta campaign" });

    // Through the API: beta cannot attach alpha's connection, templates or question set.
    await expectDbError(
      rpc(beta.owner.client, "save_campaign_draft", { p_campaign_id: betaCampaign, p_patch: { config: { connection_id: alphaConnection.id } } }),
      "invalid_reference",
    );
    await expectDbError(
      rpc(beta.owner.client, "save_campaign_draft", { p_campaign_id: betaCampaign, p_patch: { config: { probe_set_id: alphaCampaign.probeSetId } } }),
      "invalid_reference",
    );
    await expectDbError(
      rpc(beta.owner.client, "save_campaign_draft", {
        p_campaign_id: betaCampaign,
        p_patch: { steps: [{ template_ids: alphaCampaign.templateIds.initial }, { template_ids: [] }, { template_ids: [] }] },
      }),
      "invalid_template",
    );

    // And even with direct SQL the relational constraints refuse the link.
    await expect(
      sql("update public.campaign_revisions set connection_id = $1 where campaign_id = $2", [alphaConnection.id, betaCampaign]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql("update public.jobs set campaign_id = $1 where campaign_id = $2", [betaCampaign, alphaCampaign.id]),
    ).rejects.toThrow(/foreign key/);
    expect(betaConnection).toBeTruthy();
  });
});
