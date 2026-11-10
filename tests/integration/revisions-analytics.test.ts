import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeOpenAI } from "../support/fake-openai.ts";
import {
  TARGET,
  addPrice,
  closeConnections,
  createCampaign,
  createConnection,
  createWorkspace,
  drain,
  expectDbError,
  launch,
  resetDatabase,
  rpc,
  sql,
  startFake,
  tick,
  type CampaignFixture,
  type Workspace,
} from "./harness.ts";

let fake: FakeOpenAI;

beforeAll(async () => {
  fake = await startFake();
});
afterAll(async () => {
  await fake.stop();
  await closeConnections();
});
beforeEach(async () => {
  await resetDatabase();
  fake.reset();
});

async function runNextSlot(campaignId: string): Promise<void> {
  const [slot] = await sql<{ scheduled_for: Date }>(
    "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' and status = 'pending' order by scheduled_for limit 1",
    [campaignId],
  );
  await tick(new Date(slot!.scheduled_for));
  await drain(fake);
}

async function applyChanges(workspace: Workspace, campaign: CampaignFixture, patch: Record<string, unknown>) {
  await rpc(workspace.owner.client, "save_campaign_draft", { p_campaign_id: campaign.id, p_patch: patch });
  const check = await rpc<{ revision_id: string; problems: unknown[] }>(workspace.owner.client, "campaign_launch_check", { p_campaign_id: campaign.id });
  return rpc<{ revision_id: string }>(workspace.owner.client, "apply_campaign_changes", {
    p_campaign_id: campaign.id,
    p_expected_revision_id: check.revision_id,
  });
}

describe("configuration revisions", () => {
  it("freezes the launched configuration: nothing about it can be changed afterwards", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection);
    await launch(workspace, campaign);

    const immutable = async (statement: string, params: unknown[]) =>
      expect(sql(statement, params)).rejects.toThrow(/cannot be modified|immutable/);

    await immutable("update public.campaign_revisions set business_name = 'Someone Else' where id = $1", [campaign.revisionId]);
    await immutable("update public.campaign_revisions set model = 'other', max_output_tokens = 99 where id = $1", [campaign.revisionId]);
    await immutable("update public.campaign_revisions set daily_budget_usd = 9999 where id = $1", [campaign.revisionId]);
    await immutable("update public.campaign_revisions set state = 'draft' where id = $1", [campaign.revisionId]);
    await immutable("update public.campaign_revisions set effective_at = now() where id = $1", [campaign.revisionId]);
    await immutable("delete from public.campaign_revision_step_templates where revision_id = $1", [campaign.revisionId]);
    await immutable("update public.campaign_revision_steps set label = 'x' where revision_id = $1", [campaign.revisionId]);
    await immutable(
      "insert into public.campaign_revision_steps (workspace_id, revision_id, step_index, kind) values ($1, $2, 4, 'extra_step')",
      [workspace.id, campaign.revisionId],
    );
    await immutable("update public.template_versions set body = 'changed' where template_id = $1", [campaign.templateIds.initial![0]]);
    await immutable("update public.probe_questions set body = 'changed' where workspace_id = $1", [workspace.id]);
    await immutable("update public.comparison_groups set model = 'other' where campaign_id = $1", [campaign.id]);
    await immutable("update public.model_prices set output_usd_per_mtok = 0 where workspace_id = $1", [workspace.id]);

    // Through the API the frozen revision is not addressable at all: saving edits a new draft.
    const draftId = await rpc<string>(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { business_name: "Someone Else" } },
    });
    expect(draftId).not.toBe(campaign.revisionId);
    const [frozen] = await sql<{ business_name: string; state: string; revision_number: number }>(
      "select business_name, state, revision_number from public.campaign_revisions where id = $1",
      [campaign.revisionId],
    );
    expect(frozen).toEqual({ business_name: TARGET.business_name, state: "frozen", revision_number: 1 });
  });

  it("applies edits as a new revision for future work while existing runs keep everything they ran with", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, { questions: null });
    fake.reset();
    await launch(workspace, campaign);
    await runNextSlot(campaign.id);

    const snapshot = async () =>
      sql<Record<string, unknown>>(
        `select r.id, r.revision_id, r.model, r.model_params, r.max_output_tokens, r.price_id, r.target, r.cohort_key, r.combination,
                (select jsonb_agg(jsonb_build_object('prompt', t.rendered_prompt, 'version', t.template_version_id, 'output', t.output_text, 'cost', t.cost_usd) order by t.step_index)
                 from public.run_turns t where t.run_id = r.id) as turns
         from public.runs r where r.campaign_id = $1 order by r.created_at`,
        [campaign.id],
      );
    const [before] = await snapshot();

    // Edit everything a run depends on: wording, aliases, model settings and the price.
    await rpc(workspace.owner.client, "update_template", {
      p_template_id: campaign.templateIds.initial![0],
      p_body: "Which {{category}} do people in {{location}} recommend most?",
    });
    await addPrice(workspace.owner, workspace.id, connection.model, 3, 12);

    // Until the edit is applied, new runs still use the launched revision — including the old
    // wording, even though the library template has a newer version.
    await runNextSlot(campaign.id);
    const [, second] = await snapshot();
    expect(second!.revision_id).toBe(campaign.revisionId);
    expect((second!.turns as { prompt: string }[])[0]!.prompt).toBe("What are the best coffee subscription services in Portland?");
    expect(second!.price_id).toBe(before!.price_id);

    const applied = await applyChanges(workspace, campaign, {
      config: {
        business_aliases: ["Northwind Coffee", "NW Roasters"],
        max_output_tokens: 900,
      },
    });
    expect(applied.revision_id).not.toBe(campaign.revisionId);
    await runNextSlot(campaign.id);

    const [first, , third] = await snapshot();
    // The first run is byte-for-byte what it was.
    expect(first).toEqual(before);
    expect(first!.revision_id).toBe(campaign.revisionId);
    expect((first!.target as { business_aliases: string[] }).business_aliases).toEqual(["Northwind Coffee"]);
    expect(first!.max_output_tokens).toBe(600);

    // The third run used the new revision: new wording version, aliases, cap and price version.
    expect(third!.revision_id).toBe(applied.revision_id);
    expect((third!.turns as { prompt: string }[])[0]!.prompt).toBe("Which coffee subscription services do people in Portland recommend most?");
    expect((third!.turns as { version: string }[])[0]!.version).not.toBe((first!.turns as { version: string }[])[0]!.version);
    expect([...(third!.target as { business_aliases: string[] }).business_aliases].sort()).toEqual(["NW Roasters", "Northwind Coffee"]);
    expect(third!.max_output_tokens).toBe(900);
    expect(third!.price_id).not.toBe(first!.price_id);
    expect(third!.cohort_key).not.toBe(first!.cohort_key);

    const revisions = await sql<{ revision_number: number; state: string; effective: boolean }>(
      "select revision_number, state, effective_at is not null as effective from public.campaign_revisions where campaign_id = $1 order by revision_number",
      [campaign.id],
    );
    expect(revisions).toEqual([
      { revision_number: 1, state: "frozen", effective: true },
      { revision_number: 2, state: "frozen", effective: true },
    ]);

    // Different settings are reported as separate cohorts, never blended into one percentage.
    const cohorts = await rpc<{ max_output_tokens: number; runs_total: number; revision_numbers: number[] }[]>(
      workspace.owner.client, "campaign_conversation_metrics", { p_campaign_id: campaign.id });
    expect(cohorts.map((c) => [c.max_output_tokens, Number(c.runs_total), c.revision_numbers])).toEqual([
      [600, 2, [1]],
      [900, 1, [2]],
    ]);

    // The change is in the audit trail.
    const audit = await sql<{ action: string }>(
      "select action from public.audit_events where workspace_id = $1 and action like 'campaign.%' order by id",
      [workspace.id],
    );
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["campaign.created", "campaign.launched", "campaign.revision_applied"]));
  });

  it("launches only the configuration that was reviewed", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection);
    await expectDbError(
      rpc(workspace.owner.client, "launch_campaign", { p_campaign_id: campaign.id, p_expected_revision_id: "00000000-0000-0000-0000-000000000000" }),
      "stale_review",
    );
    await launch(workspace, campaign);
    await expectDbError(launch(workspace, campaign), "already_launched");
  });

  it("refuses to launch an incomplete or invalid configuration and says why", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const id = await rpc<string>(workspace.owner.client, "create_campaign", { p_workspace_id: workspace.id, p_name: "Empty" });
    const empty = await rpc<{ revision_id: string; problems: { code: string; field: string; message: string }[] }>(
      workspace.owner.client, "campaign_launch_check", { p_campaign_id: id });
    const fields = new Set(empty.problems.map((p) => p.field));
    for (const field of ["business_name", "website_url", "category", "connection_id", "model", "start_at", "end_at", "timezone", "daily_budget_usd", "total_budget_usd", "steps.1", "steps.2", "steps.3", "conversations_per_day"]) {
      expect(fields.has(field), field).toBe(true);
    }
    await expectDbError(rpc(workspace.owner.client, "launch_campaign", { p_campaign_id: id, p_expected_revision_id: empty.revision_id }), "campaign_invalid");
    // A brand-new campaign has no prefilled schedule, volume, budget or business.
    const [draft] = await sql<Record<string, unknown>>(
      "select business_name, website_url, category, start_at, end_at, conversations_per_day, total_conversation_limit, daily_budget_usd, total_budget_usd, baseline_samples, daily_checks, final_samples, timezone, model from public.campaign_revisions where id = $1",
      [empty.revision_id],
    );
    expect(Object.values(draft!).every((value) => value === null)).toBe(true);

    const expectProblem = async (config: Record<string, unknown>, code: string, options = {}) => {
      const campaign = await createCampaign(workspace, connection, { name: code, config, ...options });
      const check = await rpc<{ problems: { code: string }[] }>(workspace.owner.client, "campaign_launch_check", { p_campaign_id: campaign.id });
      expect(check.problems.map((p) => p.code), code).toContain(code);
      await expectDbError(launch(workspace, campaign), "campaign_invalid");
    };
    await expectProblem({ location: null }, "unresolved_variable");
    await expectProblem({ model_params: { temperature: 5 } }, "unsupported_parameter");
    await expectProblem({ model_params: { reasoning_effort: "high" } }, "unsupported_parameter");
    await expectProblem({ max_output_tokens: 5000 }, "unsupported_parameter"); // above the verified cap
    await expectProblem({ model: "fake-reasoning-1" }, "model_not_verified");
    await expectProblem({ max_concurrency: 40 }, "concurrency_exceeds_connection");
    await expectProblem({ end_at: new Date(Date.now() - 3600_000).toISOString(), start_at: new Date(Date.now() - 7200_000).toISOString() }, "end_in_past");
    await expectProblem({ daily_budget_usd: 0.0001 }, "budget_below_single_run");
    await expectProblem({ missed_slot_behavior: "catch_up" }, "required");
    await expectDbError(
      rpc(workspace.owner.client, "create_templates", { p_workspace_id: workspace.id, p_kind: "initial_question", p_items: [{ body: "What about {{competitor}}?" }] }),
      "invalid_template",
    );
    await expectDbError(
      rpc(workspace.owner.client, "create_templates", { p_workspace_id: workspace.id, p_kind: "initial_question", p_items: [{ body: "   " }] }),
      "invalid_template",
    );
  });

  it("supports duplicate, discard, archive and delete with the right permissions", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection);
    await launch(workspace, campaign);

    const copyId = await rpc<string>(workspace.owner.client, "duplicate_campaign", { p_campaign_id: campaign.id });
    const [copy] = await sql<{ status: string; name: string; start_at: Date | null; seed: string; steps: string }>(
      `select c.status, c.name, r.start_at, r.selection_seed as seed,
              (select count(*) from public.campaign_revision_step_templates st where st.revision_id = r.id) as steps
       from public.campaigns c join public.campaign_revisions r on r.id = c.draft_revision_id where c.id = $1`,
      [copyId],
    );
    // A copy is a draft with its own schedule to be chosen and its own selection seed.
    expect(copy).toMatchObject({ status: "draft", name: "Coffee subscriptions (copy)", start_at: null, steps: "3" });
    expect(copy!.seed).not.toBe("test-seed");

    // Pending edits can be thrown away without touching the running configuration.
    await rpc(workspace.owner.client, "save_campaign_draft", { p_campaign_id: campaign.id, p_patch: { config: { conversations_per_day: 3 } } });
    await rpc(workspace.owner.client, "discard_campaign_draft", { p_campaign_id: campaign.id });
    const [state] = await sql<{ draft_revision_id: string | null; active_revision_id: string }>(
      "select draft_revision_id, active_revision_id from public.campaigns where id = $1",
      [campaign.id],
    );
    expect(state).toEqual({ draft_revision_id: null, active_revision_id: campaign.revisionId });

    // Active campaigns cannot be archived or deleted; canceled ones can.
    await expectDbError(rpc(workspace.owner.client, "set_campaign_archived", { p_campaign_id: campaign.id, p_archived: true }), "campaign_active");
    await expectDbError(rpc(workspace.owner.client, "delete_campaign", { p_campaign_id: campaign.id }), "campaign_active");
    await rpc(workspace.owner.client, "cancel_campaign", { p_campaign_id: campaign.id });
    await rpc(workspace.owner.client, "set_campaign_archived", { p_campaign_id: campaign.id, p_archived: true });
    await drain(fake);
    await rpc(workspace.owner.client, "delete_campaign", { p_campaign_id: campaign.id });
    expect(await sql("select 1 from public.campaigns where id = $1", [campaign.id])).toHaveLength(0);
    for (const table of ["campaign_revisions", "jobs", "runs", "fresh_checks", "provider_attempts", "usage_ledger", "budget_reservations", "classifications"]) {
      const [row] = await sql<{ n: string }>(`select count(*) as n from public.${table} where campaign_id = $1`, [campaign.id]);
      expect(Number(row!.n), table).toBe(0);
    }
    await rpc(workspace.owner.client, "delete_campaign", { p_campaign_id: copyId });
  });
});

describe("analytics", () => {
  it("reports nothing for a campaign that has not produced anything", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection);
    const owner = workspace.owner.client;

    expect(await rpc(owner, "campaign_conversation_metrics", { p_campaign_id: campaign.id })).toEqual([]);
    expect(await rpc(owner, "campaign_check_metrics", { p_campaign_id: campaign.id })).toEqual([]);
    const usage = await rpc<unknown[]>(owner, "usage_daily", { p_workspace_id: workspace.id, p_from: "2020-01-01", p_to: "2099-01-01", p_campaign_id: campaign.id });
    expect(usage).toEqual([]);
    const budget = await rpc<{ campaigns: Record<string, unknown>[] }>(owner, "budget_status", { p_workspace_id: workspace.id });
    expect(budget.campaigns[0]).toMatchObject({ spent_today_usd: 0, spent_total_usd: 0, open_total_usd: 0, budget_skips: 0, budget_blocked: 0 });

    // A campaign with nothing filled in previews as empty rather than failing or inventing numbers.
    const blank = await rpc<string>(owner, "create_campaign", { p_workspace_id: workspace.id, p_name: "Blank" });
    const preview = await rpc<Record<string, unknown>>(owner, "campaign_plan_preview", { p_campaign_id: blank });
    expect(preview).toMatchObject({
      planned_conversations: 0,
      provider_requests: 0,
      days: [],
      max_cost_usd: null,
      est_run_max_cost_usd: null,
      observed_runs: 0,
      observed_avg_run_cost_usd: null,
      total_budget_shortfall: false,
    });

    // A workspace with no campaigns has an empty campaign list (nothing is seeded).
    const empty = await createWorkspace("Brand new");
    expect((await empty.owner.client.from("campaigns").select("id")).data).toEqual([]);
    expect((await empty.owner.client.from("templates").select("id")).data).toEqual([]);
    expect((await empty.owner.client.from("probe_sets").select("id")).data).toEqual([]);
    expect((await empty.owner.client.from("provider_connections").select("id")).data).toEqual([]);
  });

  it("uses valid denominators and keeps everything else visible", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, { questions: null, config: { conversations_per_day: 48 } });
    fake.reset();
    await launch(workspace, campaign);
    const firstTurn = (r: { body: Record<string, unknown> | null }) => !r.body?.previous_response_id;

    // A: absent at first, included after the request.
    await runNextSlot(campaign.id);
    // B: already present in the first answer.
    fake.includeOrganically("coffee subscription", TARGET.business_name, 1);
    await runNextSlot(campaign.id);
    fake.reset();
    // C: the first answer is cut off.
    fake.script({ type: "incomplete" }, { when: firstTurn });
    await runNextSlot(campaign.id);
    // D: the first answer mentions the business in prose only (needs a human).
    fake.script({ type: "respond", text: "Honestly, people often bring up Northwind Roasters for this, among several others." }, { when: firstTurn });
    await runNextSlot(campaign.id);
    // E: the first request keeps failing.
    fake.script({ type: "http_error", status: 500, error: { message: "boom", type: "server_error" } }, { times: 99 });
    await runNextSlot(campaign.id);
    fake.reset();

    const metrics = async () =>
      (await rpc<Record<string, number>[]>(workspace.owner.client, "campaign_conversation_metrics", { p_campaign_id: campaign.id }))[0]!;
    const numbers = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, Number(v)]));

    expect(numbers(await metrics())).toMatchObject({
      runs_total: 5,
      runs_completed: 3, // A, B, D
      runs_incomplete: 1, // C
      runs_failed: 1, // E
      runs_in_progress: 0,
      // First answers: A (no), B (yes) are decided; D waits for review; C and E have no answer.
      first_valid: 2,
      first_included: 1,
      first_not_mentioned: 1,
      first_needs_review: 1,
      // Final answers of complete sequences: A, B, D all end with the business in the list.
      final_valid: 3,
      final_included: 3,
      final_not_mentioned: 0,
      final_needs_review: 0,
    });

    // A reviewer decides D's first answer; the correction is audited and history is kept.
    const [review] = await sql<{ id: string }>(
      "select id from public.run_turns where campaign_id = $1 and step_index = 1 and inclusion = 'ambiguous'",
      [campaign.id],
    );
    await rpc(workspace.owner.client, "correct_classification", {
      p_subject_type: "run_turn",
      p_subject_id: review!.id,
      p_inclusion: "mentioned_only",
      p_note: "Named in passing, not recommended.",
    });
    expect(numbers(await metrics())).toMatchObject({ first_valid: 3, first_included: 1, first_mentioned_only: 1, first_needs_review: 0 });

    const history = await sql<{ method: string; inclusion: string; is_current: boolean; note: string | null; matched: number }>(
      "select method, inclusion, is_current, note, jsonb_array_length(matched_spans) as matched from public.classifications where subject_id = $1 order by created_at",
      [review!.id],
    );
    expect(history).toEqual([
      { method: "rules", inclusion: "ambiguous", is_current: false, note: null, matched: 1 },
      { method: "manual", inclusion: "mentioned_only", is_current: true, note: "Named in passing, not recommended.", matched: 1 },
    ]);
    const [audit] = await sql<{ details: Record<string, unknown>; actor_user_id: string }>(
      "select details, actor_user_id from public.audit_events where action = 'classification.corrected' and workspace_id = $1",
      [workspace.id],
    );
    expect(audit).toMatchObject({ actor_user_id: workspace.owner.id, details: { from: "ambiguous", to: "mentioned_only", from_method: "rules" } });

    // A rank can only be recorded for a numbered list; a bullet position never becomes a rank.
    await rpc(workspace.owner.client, "correct_classification", { p_subject_type: "run_turn", p_subject_id: review!.id, p_inclusion: "included", p_list_position: 2 });
    const [corrected] = await sql<{ rank: number | null; list_position: number | null; inclusion: string }>(
      "select rank, list_position, inclusion from public.run_turns where id = $1",
      [review!.id],
    );
    expect(corrected).toEqual({ rank: null, list_position: 2, inclusion: "included" });

    // The raw answer and the matched text are preserved exactly.
    const [raw] = await sql<{ output_text: string; spans: { start: number; end: number; text: string }[] }>(
      "select t.output_text, k.matched_spans as spans from public.run_turns t join public.classifications k on k.id = t.classification_id where t.id = $1",
      [review!.id],
    );
    expect(raw!.output_text).toBe("Honestly, people often bring up Northwind Roasters for this, among several others.");
    expect(raw!.output_text.slice(raw!.spans[0]!.start, raw!.spans[0]!.end)).toBe("Northwind Roasters");
  });

  it("separates fresh-check results by phase and question type, and keeps manual observations apart", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, { config: { baseline_samples: 6 } });
    fake.reset();
    // One baseline check keeps failing until it runs out of attempts.
    fake.script({ type: "http_error", status: 503, error: { message: "overloaded", type: "service_unavailable_error", code: "server_is_overloaded" } }, { times: 5 });
    await launch(workspace, campaign);
    await drain(fake);

    const rows = await rpc<Record<string, unknown>[]>(workspace.owner.client, "campaign_check_metrics", { p_campaign_id: campaign.id });
    const sum = (key: string) => rows.reduce((total, row) => total + Number(row[key]), 0);
    expect(rows.every((row) => row.phase === "baseline" && row.group_sequence === 1 && row.local_day === null)).toBe(true);
    expect(new Set(rows.map((row) => row.is_held_out))).toEqual(new Set([true, false]));
    expect({ total: sum("total"), valid: sum("valid"), failed: sum("failed"), included: sum("included"), not_mentioned: sum("not_mentioned") })
      .toEqual({ total: 6, valid: 5, failed: 1, included: 0, not_mentioned: 5 });

    // A manually recorded ChatGPT observation is stored with its date and source label...
    const manualId = await rpc<string>(workspace.owner.client, "record_manual_check", {
      p_campaign_id: campaign.id,
      p_observed_on: "2026-11-09",
      p_source_label: "ChatGPT web app (logged in)",
      p_question: "Best coffee subscriptions in Portland?",
      p_response_text: "1. Alder & Finch\n2. Northwind Roasters\n3. Cobalt Harbor",
      p_classification: { mentioned: true, inclusion: "included", rank: 2, list_position: null, list_kind: "numbered", list_length: 3, matched_spans: [], detector_version: "rules-1" },
    });
    const [manual] = await sql<{ observed_on: string; source_label: string; inclusion: string; rank: number }>(
      "select observed_on::text, source_label, inclusion, rank from public.manual_checks where id = $1",
      [manualId],
    );
    expect(manual).toEqual({ observed_on: "2026-11-09", source_label: "ChatGPT web app (logged in)", inclusion: "included", rank: 2 });
    // ...and never enters the API measurements.
    const after = await rpc<Record<string, unknown>[]>(workspace.owner.client, "campaign_check_metrics", { p_campaign_id: campaign.id });
    expect(after).toEqual(rows);
    expect(await sql("select 1 from public.fresh_checks where campaign_id = $1", [campaign.id])).toHaveLength(6);
    await expectDbError(
      rpc(workspace.owner.client, "record_manual_check", { p_campaign_id: campaign.id, p_observed_on: "2026-11-09", p_source_label: "", p_question: null, p_response_text: "x", p_classification: null }),
      "invalid_source",
    );
  });

  it("applies the retention period to stored text only", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, { config: { baseline_samples: 2 } });
    fake.reset();
    await launch(workspace, campaign);
    await drain(fake);
    await tick();
    await runNextSlot(campaign.id);
    await rpc(workspace.owner.client, "update_workspace", { p_workspace_id: workspace.id, p_name: "Test workspace", p_retention_days: 30 });

    // Nothing is old enough yet.
    expect((await sql<{ n: number }>("select app_private.apply_retention(now()) as n"))[0]!.n).toBe(0);
    // Forty days later the stored prompts and answers are removed...
    const purged = (await sql<{ n: number }>("select app_private.apply_retention(now() + interval '40 days') as n"))[0]!.n;
    expect(purged).toBe(3); // one run and two fresh checks
    const [turn] = await sql<{ rendered_prompt: string | null; output_text: string | null; inclusion: string; cost_usd: string }>(
      "select rendered_prompt, output_text, inclusion, cost_usd from public.run_turns where campaign_id = $1 and step_index = 3",
      [campaign.id],
    );
    expect(turn).toMatchObject({ rendered_prompt: null, output_text: null, inclusion: "included" });
    // ...while results, usage and the audit trail remain.
    expect(Number(turn!.cost_usd)).toBeGreaterThan(0);
    const [metrics] = await rpc<Record<string, number>[]>(workspace.owner.client, "campaign_conversation_metrics", { p_campaign_id: campaign.id });
    expect(Number(metrics!.final_included)).toBe(1);
    expect((await sql("select 1 from public.usage_ledger where campaign_id = $1", [campaign.id])).length).toBeGreaterThan(0);
    expect(await sql("select 1 from public.audit_events where workspace_id = $1 and action = 'retention.applied'", [workspace.id])).toHaveLength(1);
  });
});
