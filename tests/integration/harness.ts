// Shared helpers for integration tests.
//
// These tests run against the real local Supabase stack (Postgres with pgmq/pg_cron/Vault,
// PostgREST, Auth) through the same supabase-js calls the application makes. The only thing
// simulated is the provider: tests/support/fake-openai.ts stands in for the OpenAI API.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { createSupabaseEngineDb } from "@shared/engine/db.ts";
import {
  DEFAULT_ENGINE_CONFIG,
  processOneUnit,
  type EngineDeps,
  type FaultHooks,
  type UnitOutcome,
} from "@shared/engine/worker.ts";
import { runOpsAction, type OpsContext, type OpsResult } from "@shared/ops/handlers.ts";
import { createOpenAIProvider } from "@shared/provider/openai.ts";
import { FakeOpenAI, VALID_KEY_PREFIX } from "../support/fake-openai.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is not set. Integration tests need the local Supabase stack (npm run db:start).`,
    );
  return value;
}

export const stack = {
  get apiUrl() {
    return required("LR_TEST_API_URL");
  },
  get publishableKey() {
    return required("LR_TEST_PUBLISHABLE_KEY");
  },
  get secretKey() {
    return required("LR_TEST_SECRET_KEY");
  },
  get dbUrl() {
    return required("LR_TEST_DB_URL");
  },
};

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service-role client
export type Client = SupabaseClient<any, any, any>;

let pool: pg.Pool | null = null;
let adminClient: Client | null = null;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: stack.dbUrl, max: 12 });
  return pool;
}

/** Runs SQL as the database owner (test setup and assertions only). */
export async function sql<Row extends object = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const result = await db().query(text, params);
  return result.rows as Row[];
}

/** Service-role client: what the Edge Functions use. */
export function admin(): Client {
  adminClient ??= createClient(stack.apiUrl, stack.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}

export function anonClient(): Client {
  return createClient(stack.apiUrl, stack.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function closeConnections(): Promise<void> {
  await pool?.end();
  pool = null;
}

/** Removes every tenant record, test user and queue message. */
export async function resetDatabase(): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query("set constraints all deferred");
    await client.query("delete from public.workspaces");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  await sql("delete from auth.users where email like '%@lr.test'");
  await sql("delete from app_private.owner_bootstrap_grants");
  await sql("delete from app_private.heartbeats");
  await sql("select pgmq.purge_queue('lr_work')");
  await sql("delete from pgmq.a_lr_work");
  await sql("delete from vault.secrets where name like 'lr_conn_%'");
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  /** A client signed in as this user: exactly what the browser/server session can do. */
  client: Client;
}

let userCounter = 0;

export async function createUser(label = "user"): Promise<TestUser> {
  userCounter += 1;
  const email = `${label}-${Date.now().toString(36)}-${userCounter}@lr.test`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  const client = anonClient();
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(`signIn failed: ${signedIn.error.message}`);
  return { id: data.user.id, email, password, client };
}

/** Calls a client RPC and returns its data, throwing with the database's message on error. */
export async function rpc<T = unknown>(
  client: Client,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    const failure = new Error(`${fn}: ${error.message}`) as Error & {
      code?: string;
      detail?: string;
    };
    failure.code = error.code;
    failure.detail = error.details ?? undefined;
    throw failure;
  }
  return data as T;
}

export interface Workspace {
  id: string;
  owner: TestUser;
}

/** Bootstraps an owner and their workspace the same way the CLI command does. */
export async function createWorkspace(name = "Test workspace"): Promise<Workspace> {
  const owner = await createUser("owner");
  const result = await rpc<{ workspace_id: string }>(admin(), "svc_bootstrap_owner", {
    p_email: owner.email,
    p_workspace_name: name,
  });
  return { id: result.workspace_id, owner };
}

export async function addMember(
  workspace: Workspace,
  role: "owner" | "admin" | "member",
): Promise<TestUser> {
  const user = await createUser(role);
  const result = await rpc<{ outcome: string }>(admin(), "svc_invite_member", {
    p_workspace_id: workspace.id,
    p_actor: workspace.owner.id,
    p_email: user.email,
    p_role: role,
  });
  if (result.outcome !== "added")
    throw new Error(`addMember: unexpected outcome ${result.outcome}`);
  return user;
}

// ---------------------------------------------------------------------------------------------
// Provider double and worker
// ---------------------------------------------------------------------------------------------

export const VALID_KEY = `${VALID_KEY_PREFIX}-0000000000000000`;

export function opsContext(user: TestUser, fake: FakeOpenAI): OpsContext {
  return {
    admin: admin(),
    userId: user.id,
    createProvider: (apiKey) => createOpenAIProvider({ apiKey, baseURL: fake.baseURL }),
  };
}

export async function ops(
  user: TestUser,
  fake: FakeOpenAI,
  action: string,
  input: Record<string, unknown>,
): Promise<OpsResult> {
  return runOpsAction(opsContext(user, fake), action, input);
}

export function engineDeps(
  fake: FakeOpenAI,
  overrides: Partial<EngineDeps["config"]> = {},
  faults?: FaultHooks,
): EngineDeps {
  return {
    db: createSupabaseEngineDb(admin()),
    createProvider: (apiKey) => createOpenAIProvider({ apiKey, baseURL: fake.baseURL }),
    config: {
      ...DEFAULT_ENGINE_CONFIG,
      workerId: `test-${Math.random().toString(36).slice(2, 8)}`,
      ...overrides,
    },
    faults,
  };
}

/** Processes one unit, as one worker invocation would. */
export function work(
  fake: FakeOpenAI,
  overrides: Partial<EngineDeps["config"]> = {},
  faults?: FaultHooks,
): Promise<UnitOutcome> {
  return processOneUnit(engineDeps(fake, overrides, faults));
}

/** One scheduler pass at the given instant (defaults to now). */
export async function tick(
  now?: Date,
  plan = true,
): Promise<{ plan: unknown; dispatch: { dispatched: number; released: number; wakes: number } }> {
  return rpc(admin(), "svc_tick", { p_now: now ? now.toISOString() : null, p_plan: plan });
}

/** Makes every waiting queue message visible now (skips retry backoff and poll delays). */
export async function makeQueueVisible(): Promise<void> {
  await sql("update pgmq.q_lr_work set vt = now() - interval '1 second'");
}

/**
 * Runs workers until the queue has nothing visible. Returns the outcomes in order.
 * `skipWaits` makes retry backoffs and poll delays elapse immediately.
 */
export async function drain(
  fake: FakeOpenAI,
  options: { max?: number; skipWaits?: boolean; config?: Partial<EngineDeps["config"]> } = {},
): Promise<UnitOutcome[]> {
  const outcomes: UnitOutcome[] = [];
  const max = options.max ?? 200;
  for (let i = 0; i < max; i += 1) {
    if (options.skipWaits !== false) await makeQueueVisible();
    const outcome = await work(fake, options.config);
    if (outcome.status === "idle") break;
    outcomes.push(outcome);
  }
  return outcomes;
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export interface ConnectionFixture {
  id: string;
  model: string;
}

export async function addPrice(
  owner: TestUser,
  workspaceId: string,
  model: string,
  input = 1,
  output = 4,
): Promise<void> {
  await rpc(owner.client, "add_model_price", {
    p_workspace_id: workspaceId,
    p_price: {
      model_id: model,
      input_usd_per_mtok: input,
      cached_input_usd_per_mtok: input / 10,
      output_usd_per_mtok: output,
      source_url: "https://example.test/fake-pricing",
      verified_on: new Date().toISOString().slice(0, 10),
      notes: "Test fixture price for a fictional model.",
    },
  });
}

/** Creates a connection with a working key and a verified model, through the real code paths. */
export async function createConnection(
  workspace: Workspace,
  fake: FakeOpenAI,
  options: {
    model?: string;
    dailyBudget?: number;
    totalBudget?: number | null;
    maxConcurrent?: number;
    verifyCap?: number;
  } = {},
): Promise<ConnectionFixture> {
  const model = options.model ?? "fake-chat-1";
  const id = await rpc<string>(workspace.owner.client, "create_connection", {
    p_workspace_id: workspace.id,
    p_name: `Connection ${Math.random().toString(36).slice(2, 7)}`,
    p_daily_budget_usd: options.dailyBudget ?? 50,
    p_total_budget_usd: options.totalBudget ?? null,
    p_max_concurrent_requests: options.maxConcurrent ?? 4,
  });
  const stored = await ops(workspace.owner, fake, "connection.set_credential", {
    connection_id: id,
    api_key: VALID_KEY,
  });
  if (!stored.ok) throw new Error(`set_credential failed: ${stored.message}`);
  await addPrice(workspace.owner, workspace.id, model);
  const verified = await ops(workspace.owner, fake, "model.verify", {
    connection_id: id,
    model_id: model,
    max_output_tokens: options.verifyCap ?? 2000,
  });
  if (!verified.ok) throw new Error(`model.verify failed: ${verified.message}`);
  return { id, model };
}

export const TARGET = {
  business_name: "Northwind Roasters",
  website_url: "https://northwindroasters.example",
  business_aliases: ["Northwind Coffee"],
  domain_aliases: ["nwr-coffee.example"],
};

export interface CampaignOptions {
  name?: string;
  /** Extra revision config merged over the defaults. */
  config?: Record<string, unknown>;
  initialQuestions?: string[];
  inclusionRequests?: string[];
  revisionRequests?: string[];
  extraSteps?: string[][];
  questions?: { body: string; is_held_out: boolean }[] | null;
  startAt?: Date;
  endAt?: Date;
}

export interface CampaignFixture {
  id: string;
  revisionId: string;
  probeSetId: string | null;
  templateIds: { initial: string[]; inclusion: string[]; revision: string[] };
}

async function makeTemplates(
  user: TestUser,
  workspaceId: string,
  kind: string,
  bodies: string[],
): Promise<string[]> {
  return rpc<string[]>(user.client, "create_templates", {
    p_workspace_id: workspaceId,
    p_kind: kind,
    p_items: bodies.map((body) => ({ body })),
  });
}

/** A complete draft campaign that passes launch validation. */
export async function createCampaign(
  workspace: Workspace,
  connection: ConnectionFixture,
  options: CampaignOptions = {},
): Promise<CampaignFixture> {
  const user = workspace.owner;
  const id = await rpc<string>(user.client, "create_campaign", {
    p_workspace_id: workspace.id,
    p_name: options.name ?? "Coffee subscriptions",
  });

  const initial = await makeTemplates(
    user,
    workspace.id,
    "initial_question",
    options.initialQuestions ?? ["What are the best {{category}} in {{location}}?"],
  );
  const inclusion = await makeTemplates(
    user,
    workspace.id,
    "inclusion_request",
    options.inclusionRequests ?? ['Please add "{{business_name}}" ({{website_url}}) to that list.'],
  );
  const revision = await makeTemplates(
    user,
    workspace.id,
    "revision_request",
    options.revisionRequests ?? ["Can you show me the complete revised list?"],
  );
  const extras: string[][] = [];
  for (const bodies of options.extraSteps ?? [])
    extras.push(await makeTemplates(user, workspace.id, "extra_step", bodies));

  let probeSetId: string | null = null;
  const questions =
    options.questions === undefined
      ? [
          { body: "Which {{category}} would you recommend in {{location}}?", is_held_out: false },
          { body: "Who offers great {{category}} near {{location}}?", is_held_out: true },
        ]
      : options.questions;
  if (questions) {
    const saved = await rpc<{ probe_set_id: string }>(user.client, "save_probe_set", {
      p_workspace_id: workspace.id,
      p_probe_set_id: null,
      p_name: "Coffee questions",
      p_description: null,
      p_questions: questions,
    });
    probeSetId = saved.probe_set_id;
  }

  const startAt = options.startAt ?? new Date(Date.now() - 60_000);
  const endAt = options.endAt ?? new Date(startAt.getTime() + 7 * 24 * 3600_000);
  const revisionId = await rpc<string>(user.client, "save_campaign_draft", {
    p_campaign_id: id,
    p_patch: {
      config: {
        ...TARGET,
        category: "coffee subscription services",
        location: "Portland",
        language: "English",
        connection_id: connection.id,
        model: connection.model,
        model_params: {},
        max_output_tokens: 600,
        execution_mode: "sync",
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        timezone: "UTC",
        active_weekdays: [1, 2, 3, 4, 5, 6, 7],
        active_start_minute: 0,
        active_end_minute: 1440,
        conversations_per_day: 24,
        total_conversation_limit: null,
        max_concurrency: 2,
        jitter_seconds: 0,
        missed_slot_behavior: "skip",
        daily_budget_usd: 5,
        total_budget_usd: 20,
        probe_set_id: probeSetId,
        baseline_samples: probeSetId ? 2 : 0,
        daily_checks: probeSetId ? 2 : 0,
        final_samples: probeSetId ? 2 : 0,
        on_existing_inclusion: "continue",
        selection_mode: "balanced",
        selection_seed: "test-seed",
        ...(options.config ?? {}),
      },
      steps: [
        { template_ids: initial },
        { template_ids: inclusion },
        { template_ids: revision },
        ...extras.map((template_ids) => ({ template_ids })),
      ],
    },
  });

  return { id, revisionId, probeSetId, templateIds: { initial, inclusion, revision } };
}

export async function launch(workspace: Workspace, campaign: CampaignFixture): Promise<void> {
  await rpc(workspace.owner.client, "launch_campaign", {
    p_campaign_id: campaign.id,
    p_expected_revision_id: campaign.revisionId,
  });
}

export async function campaignStatus(campaignId: string): Promise<string> {
  const [row] = await sql<{ status: string }>("select status from public.campaigns where id = $1", [
    campaignId,
  ]);
  return row!.status;
}

/** Starts a fresh fake provider for a test file. */
export async function startFake(): Promise<FakeOpenAI> {
  return new FakeOpenAI().start();
}

/** Expects a promise to reject with a database error carrying the given machine code. */
export async function expectDbError(
  promise: Promise<unknown>,
  detailOrCode: string,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    const failure = error as Error & { code?: string; detail?: string };
    if (failure.detail === detailOrCode || failure.code === detailOrCode) return failure;
    throw new Error(
      `Expected error "${detailOrCode}" but got code=${failure.code} detail=${failure.detail}: ${failure.message}`,
    );
  }
  throw new Error(`Expected error "${detailOrCode}" but the call succeeded`);
}
