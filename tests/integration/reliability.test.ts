import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeOpenAI } from "../support/fake-openai.ts";
import {
  admin,
  campaignStatus,
  closeConnections,
  createCampaign,
  createConnection,
  createWorkspace,
  drain,
  expectDbError,
  launch,
  makeQueueVisible,
  ops,
  resetDatabase,
  rpc,
  sql,
  startFake,
  tick,
  work,
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

interface Scenario {
  workspace: Workspace;
  campaign: CampaignFixture;
  connectionId: string;
}

/** A launched campaign with exactly one conversation dispatched and waiting in the queue. */
async function oneQueuedConversation(config: Record<string, unknown> = {}, connectionOptions = {}): Promise<Scenario> {
  const workspace = await createWorkspace();
  const connection = await createConnection(workspace, fake, connectionOptions);
  const campaign = await createCampaign(workspace, connection, { questions: null, config });
  fake.reset();
  await launch(workspace, campaign);
  const [slot] = await sql<{ scheduled_for: Date }>(
    "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' and status = 'pending' order by scheduled_for limit 1",
    [campaign.id],
  );
  await tick(new Date(slot!.scheduled_for));
  return { workspace, campaign, connectionId: connection.id };
}

const job = async (campaignId: string) =>
  (
    await sql<{ id: string; status: string; status_reason: string | null; attempts: number; next_attempt_at: Date | null; last_error_class: string | null; fencing_token: string }>(
      "select id, status, status_reason, attempts, next_attempt_at, last_error_class, fencing_token from public.jobs where campaign_id = $1 and kind in ('conversation', 'test_conversation') and status not in ('pending', 'skipped') order by created_at limit 1",
      [campaignId],
    )
  )[0]!;

const attempts = (campaignId: string) =>
  sql<{ id: string; status: string; error_class: string | null; attempt_number: number; http_status: number | null; retry_after_ms: number | null; cost_usd: string | null; response_id: string | null; mode: string }>(
    "select id, status, error_class, attempt_number, http_status, retry_after_ms, cost_usd, response_id, mode from public.provider_attempts where campaign_id = $1 order by started_at",
    [campaignId],
  );

const reservations = (campaignId: string) =>
  sql<{ status: string; amount_usd: string; settled_cost_usd: string | null }>(
    "select status, amount_usd, settled_cost_usd from public.budget_reservations where campaign_id = $1 order by created_at",
    [campaignId],
  );

const run = async (campaignId: string) =>
  (await sql<{ id: string; status: string; steps_completed: number; error_class: string | null }>(
    "select id, status, steps_completed, error_class from public.runs where campaign_id = $1 order by created_at limit 1",
    [campaignId],
  ))[0]!;

describe("claims and leases", () => {
  it("lets only one of many concurrent workers claim a unit", async () => {
    const { campaign } = await oneQueuedConversation();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => work(fake)));
    expect(outcomes.filter((o) => o.status === "processed")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "idle")).toHaveLength(7);
    // One claim, one provider request, one attempt.
    expect(fake.responseRequests()).toHaveLength(1);
    expect(await attempts(campaign.id)).toHaveLength(1);
    expect(Number((await job(campaign.id)).fencing_token)).toBe(1);
  });

  it("rejects state changes from a worker whose lease has been taken over, but still records its cost", async () => {
    const { campaign } = await oneQueuedConversation();
    const db = admin();

    // Worker A claims the first turn and begins a request, then stalls.
    const unitA = await rpc<{ job_id: string; lease_token: string; fencing_token: number }>(db, "svc_receive_work", { p_worker_id: "A" });
    const plan = { combination_index: "0", target_in_initial_prompt: false, turns: [
      { step_index: 1, step_kind: "initial_question", template_id: campaign.templateIds.initial[0], template_version_id: (await sql<{ id: string }>("select current_version_id as id from public.templates where id = $1", [campaign.templateIds.initial[0]]))[0]!.id, rendered_prompt: "Q1" },
      { step_index: 2, step_kind: "inclusion_request", template_id: campaign.templateIds.inclusion[0], template_version_id: (await sql<{ id: string }>("select current_version_id as id from public.templates where id = $1", [campaign.templateIds.inclusion[0]]))[0]!.id, rendered_prompt: "Q2" },
      { step_index: 3, step_kind: "revision_request", template_id: campaign.templateIds.revision[0], template_version_id: (await sql<{ id: string }>("select current_version_id as id from public.templates where id = $1", [campaign.templateIds.revision[0]]))[0]!.id, rendered_prompt: "Q3" },
    ] };
    const refA = { p_job_id: unitA.job_id, p_lease_token: unitA.lease_token, p_fencing_token: unitA.fencing_token };
    await rpc(db, "svc_materialize_run", { ...refA, p_plan: plan });
    const beginA = await rpc<{ ok: boolean; attempt_id: string }>(db, "svc_begin_attempt", {
      ...refA, p_mode: "sync", p_est_input_tokens: 100, p_max_output_tokens: 600, p_request_params: {},
    });
    expect(beginA.ok).toBe(true);

    // A's lease expires; worker B takes the job over.
    await sql("update public.jobs set lease_expires_at = now() - interval '1 minute' where id = $1", [unitA.job_id]);
    await makeQueueVisible();
    const unitB = await rpc<{ job_id: string; lease_token: string; fencing_token: number }>(db, "svc_receive_work", { p_worker_id: "B" });
    expect(unitB.job_id).toBe(unitA.job_id);
    expect(unitB.fencing_token).toBe(unitA.fencing_token + 1);
    // A's request is now ambiguous and its reservation stays counted.
    expect((await attempts(campaign.id))[0]).toMatchObject({ status: "uncertain", error_class: "worker_lost" });
    expect((await reservations(campaign.id))[0]!.status).toBe("unresolved");

    // A wakes up with a real result. It may not touch the job...
    const usage = { input_tokens: 40, cached_tokens: 0, cache_write_tokens: 0, cache_write_30m_tokens: 0, cache_write_12h_tokens: 0, output_tokens: 20, reasoning_tokens: 0, total_tokens: 60 };
    const commitA = await rpc<{ ok: boolean; action: string }>(db, "svc_commit_result", {
      ...refA, p_attempt_id: beginA.attempt_id,
      p_result: { status: "completed", response_id: "resp_stale", output_text: "stale answer", output_items: [], usage, latency_ms: 5 },
      p_classification: null,
    });
    expect(commitA).toMatchObject({ ok: false, action: "stale" });
    const [turn] = await sql<{ status: string; output_text: string | null; response_id: string | null }>(
      "select status, output_text, response_id from public.run_turns where campaign_id = $1 and step_index = 1",
      [campaign.id],
    );
    expect(turn).toMatchObject({ output_text: null, response_id: null });

    // ...but what its request cost is reconciled instead of staying unresolved.
    const [stale] = await attempts(campaign.id);
    expect(stale).toMatchObject({ status: "succeeded" });
    expect(Number(stale!.cost_usd)).toBeGreaterThan(0);
    expect((await reservations(campaign.id))[0]!.status).toBe("settled");

    // A stale materialize, begin, defer or failure report is refused as well.
    for (const [fn, extra] of [
      ["svc_begin_attempt", { p_mode: "sync", p_est_input_tokens: 1, p_max_output_tokens: 16, p_request_params: {} }],
      ["svc_release_work", { p_delay_seconds: 0 }],
      ["svc_materialize_run", { p_plan: plan }],
    ] as const) {
      expect(await rpc(db, fn, { ...refA, ...extra })).toMatchObject({ ok: false, action: "stale" });
    }
    expect((await job(campaign.id)).status).toBe("running");
  });
});

describe("crash recovery", () => {
  it("resumes from the failed turn after a worker dies between the provider's answer and the commit", async () => {
    const { campaign } = await oneQueuedConversation();
    // Turn one completes normally.
    await drain(fake, { max: 1 });
    expect((await run(campaign.id)).steps_completed).toBe(1);

    // During turn two the worker dies right after the provider answered, before anything was saved.
    await expect(
      work(fake, {}, {
        afterProviderCall: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");

    expect((await run(campaign.id)).steps_completed).toBe(1);
    expect((await job(campaign.id)).status).toBe("running");
    const [, secondAttempt] = await attempts(campaign.id);
    expect(secondAttempt).toMatchObject({ status: "started", attempt_number: 1 });

    // Nothing happens while the lease is still held.
    expect((await work(fake)).status).toBe("idle");

    // The lease runs out; the message becomes visible; a new worker picks the job up.
    await sql("update public.jobs set lease_expires_at = now() - interval '1 minute' where campaign_id = $1 and status = 'running'", [campaign.id]);
    await drain(fake);

    const finished = await run(campaign.id);
    expect(finished).toMatchObject({ status: "completed", steps_completed: 3 });

    // The lost request is recorded as uncertain and its reservation is kept, not treated as free.
    const all = await attempts(campaign.id);
    expect(all.map((a) => a.status)).toEqual(["succeeded", "uncertain", "succeeded", "succeeded"]);
    const money = await reservations(campaign.id);
    expect(money.map((r) => r.status)).toEqual(["settled", "unresolved", "settled", "settled"]);

    // Only turn two was sent again; turn one was never replayed.
    const requests = fake.responseRequests();
    expect(requests).toHaveLength(4); // turn one, turn two (lost), turn two again, turn three
    const turns = await sql<{ step_index: number; response_id: string; previous_response_id: string | null; attempt_count: number }>(
      "select step_index, response_id, previous_response_id, attempt_count from public.run_turns where campaign_id = $1 order by step_index",
      [campaign.id],
    );
    expect(requests.filter((r) => !r.body!.previous_response_id)).toHaveLength(1);
    expect(requests.filter((r) => r.body!.previous_response_id === turns[0]!.response_id)).toHaveLength(2);
    expect(turns.map((t) => t.attempt_count)).toEqual([1, 2, 1]);
    expect(turns[1]!.previous_response_id).toBe(turns[0]!.response_id);
    expect(turns[2]!.previous_response_id).toBe(turns[1]!.response_id);
  });

  it("commits a turn and enqueues the next one atomically", async () => {
    const { campaign } = await oneQueuedConversation();
    await drain(fake, { max: 1 });
    // After the first commit exactly one message exists, already visible, for the same job.
    const queue = await sql<{ job_id: string; visible: boolean }>(
      "select message ->> 'job_id' as job_id, vt <= clock_timestamp() as visible from pgmq.q_lr_work",
    );
    const current = await job(campaign.id);
    expect(queue).toEqual([{ job_id: current.id, visible: true }]);
    expect(current).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("re-sends a queue message that went missing", async () => {
    const { campaign } = await oneQueuedConversation();
    await sql("select pgmq.purge_queue('lr_work')");
    expect((await work(fake)).status).toBe("idle");
    // A later planner pass notices the job has no message and re-sends it.
    await tick(new Date(Date.now() + 5 * 60_000));
    await drain(fake);
    expect(await run(campaign.id)).toMatchObject({ status: "completed", steps_completed: 3 });
  });
});

describe("provider failures", () => {
  it("retries a 429 with backoff that honors the provider's retry guidance", async () => {
    const { campaign } = await oneQueuedConversation();
    fake.script({
      type: "http_error",
      status: 429,
      error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" },
      headers: { "retry-after": "17" },
    });

    const before = Date.now();
    expect(await work(fake)).toMatchObject({ result: "failed:rate_limited:retry" });
    const waiting = await job(campaign.id);
    expect(waiting).toMatchObject({ status: "waiting", attempts: 1, last_error_class: "rate_limited", status_reason: "retry_rate_limited" });
    // At least the 17 seconds the provider asked for.
    expect(new Date(waiting.next_attempt_at!).getTime() - before).toBeGreaterThanOrEqual(17_000);
    const [first] = await attempts(campaign.id);
    expect(first).toMatchObject({ status: "failed", error_class: "rate_limited", http_status: 429, retry_after_ms: 17000 });
    // A rejected request is not billed: the reservation is released.
    expect((await reservations(campaign.id))[0]!.status).toBe("released");

    // The message is hidden until then: a worker finds nothing.
    expect((await work(fake)).status).toBe("idle");

    await drain(fake);
    expect(await run(campaign.id)).toMatchObject({ status: "completed", steps_completed: 3 });
    // One request per attempt: the SDK did not retry behind the application's back.
    expect(fake.responseRequests()).toHaveLength(4);
    expect((await attempts(campaign.id)).map((a) => a.attempt_number)).toEqual([1, 2, 1, 1]);
  });

  it("stops after the maximum number of attempts and moves the job to the review queue", async () => {
    const { workspace, campaign } = await oneQueuedConversation();
    fake.script({ type: "http_error", status: 503, error: { message: "The server is overloaded", type: "service_unavailable_error", code: "server_is_overloaded" } }, { times: 99 });
    await drain(fake);

    const dead = await job(campaign.id);
    expect(dead).toMatchObject({ status: "dead", attempts: 5, last_error_class: "server_error" });
    expect(await run(campaign.id)).toMatchObject({ status: "failed", error_class: "server_error" });
    expect(fake.responseRequests()).toHaveLength(5);
    // The message is kept in the queue archive (dead-letter record), not silently dropped.
    const [archived] = await sql<{ n: string }>("select count(*) as n from pgmq.a_lr_work");
    expect(Number(archived!.n)).toBe(1);
    const [queued] = await sql<{ n: string }>("select count(*) as n from pgmq.q_lr_work");
    expect(Number(queued!.n)).toBe(0);

    // An owner or admin can retry it once the provider has recovered.
    fake.reset();
    await rpc(workspace.owner.client, "retry_job", { p_job_id: dead.id });
    await drain(fake);
    expect(await run(campaign.id)).toMatchObject({ status: "completed", steps_completed: 3 });
  });

  it("treats invalid credentials as an actionable failure, not something to retry", async () => {
    const { workspace, campaign, connectionId } = await oneQueuedConversation();
    fake.script({ type: "http_error", status: 401, error: { message: "Incorrect API key provided.", code: "invalid_api_key" } }, { times: 99 });
    await drain(fake);

    // Exactly one request was made.
    expect(fake.responseRequests()).toHaveLength(1);
    expect(await job(campaign.id)).toMatchObject({ status: "blocked", status_reason: "connection_invalid_credentials", attempts: 0 });
    const [connection] = await sql<{ status: string; status_code: string }>(
      "select status, status_code from public.provider_connections where id = $1",
      [connectionId],
    );
    expect(connection).toEqual({ status: "error", status_code: "invalid_credentials" });

    // While the connection is failing nothing further is dispatched for it.
    const [next] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    const dispatched = await tick(new Date(next!.scheduled_for));
    expect(dispatched.dispatch.dispatched).toBe(0);
    expect(fake.responseRequests()).toHaveLength(1);

    // The health view tells the owner what is wrong.
    const health = await rpc<{ workspace: { connections: { status: string; status_code: string }[] } }>(
      workspace.owner.client, "operational_status", { p_workspace_id: workspace.id });
    expect(health.workspace.connections[0]).toMatchObject({ status: "error", status_code: "invalid_credentials" });

    // After the owner fixes the key and the connection test succeeds, the blocked job continues.
    fake.reset();
    expect(await ops(workspace.owner, fake, "connection.test", { connection_id: connectionId })).toMatchObject({ ok: true });
    await tick(new Date(next!.scheduled_for));
    await drain(fake);
    expect(await run(campaign.id)).toMatchObject({ status: "completed" });
  });

  it("blocks the connection on exhausted quota instead of burning through the schedule", async () => {
    const { campaign, connectionId } = await oneQueuedConversation();
    fake.script({ type: "http_error", status: 429, error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } }, { times: 99 });
    await drain(fake);
    expect(fake.responseRequests()).toHaveLength(1);
    expect(await job(campaign.id)).toMatchObject({ status: "blocked", status_reason: "connection_quota_exhausted" });
    const [connection] = await sql<{ status_code: string }>("select status_code from public.provider_connections where id = $1", [connectionId]);
    expect(connection!.status_code).toBe("quota_exhausted");
  });

  it("pauses the campaign when the model or configuration is rejected", async () => {
    const { workspace, campaign } = await oneQueuedConversation();
    fake.script({ type: "http_error", status: 404, error: { message: "The model `fake-chat-1` does not exist or you do not have access to it.", code: "model_not_found", param: "model" } });
    await drain(fake);

    expect(fake.responseRequests()).toHaveLength(1);
    expect(await job(campaign.id)).toMatchObject({ status: "dead", last_error_class: "model_unavailable" });
    const [paused] = await sql<{ status: string; pause_reason: string; pause_detail: string }>(
      "select status, pause_reason, pause_detail from public.campaigns where id = $1",
      [campaign.id],
    );
    expect(paused).toMatchObject({ status: "paused", pause_reason: "model_unavailable" });
    expect(paused!.pause_detail).toContain("does not exist");
    const health = await rpc<{ workspace: { paused_campaigns: { pause_reason: string }[] } }>(
      workspace.owner.client, "operational_status", { p_workspace_id: workspace.id });
    expect(health.workspace.paused_campaigns).toHaveLength(1);
  });

  it("records an incomplete response with its usage and ends the conversation there", async () => {
    const { workspace, campaign } = await oneQueuedConversation();
    fake.script({ type: "incomplete", reason: "max_output_tokens" });
    await drain(fake);

    expect(await run(campaign.id)).toMatchObject({ status: "incomplete", steps_completed: 0, error_class: "incomplete_response" });
    const turns = await sql<{ status: string; incomplete_reason: string | null; inclusion: string | null; output_tokens: number | null }>(
      "select status, incomplete_reason, inclusion, output_tokens from public.run_turns where campaign_id = $1 order by step_index",
      [campaign.id],
    );
    expect(turns.map((t) => t.status)).toEqual(["incomplete", "skipped", "skipped"]);
    expect(turns[0]).toMatchObject({ incomplete_reason: "max_output_tokens", inclusion: null });
    // Billed tokens of the incomplete answer are in the ledger.
    const [attempt] = await attempts(campaign.id);
    expect(attempt!.status).toBe("incomplete");
    expect(Number(attempt!.cost_usd)).toBeGreaterThan(0);
    expect((await reservations(campaign.id))[0]!.status).toBe("settled");
    expect(fake.responseRequests()).toHaveLength(1);

    // It is visible as incomplete and is not counted as a negative result.
    const [metrics] = await rpc<{ runs_total: number; runs_incomplete: number; first_valid: number; first_not_mentioned: number }[]>(
      workspace.owner.client, "campaign_conversation_metrics", { p_campaign_id: campaign.id });
    expect(metrics).toMatchObject({ runs_total: 1, runs_incomplete: 1, first_valid: 0, first_not_mentioned: 0 });

    // It can be restarted explicitly as a brand-new conversation.
    const restarted = await rpc<string>(workspace.owner.client, "restart_run", { p_run_id: (await run(campaign.id)).id });
    await drain(fake);
    const [fresh] = await sql<{ status: string; restart_of_run_id: string }>("select status, restart_of_run_id from public.runs where id = $1", [restarted]);
    expect(fresh).toMatchObject({ status: "completed" });
  });

  it("tracks an ambiguous timeout separately and keeps its reservation until resolved", async () => {
    const { workspace, campaign } = await oneQueuedConversation();
    fake.script({ type: "hang" });

    expect(await work(fake, { syncTimeoutMs: 400 })).toMatchObject({ result: "failed:timeout:retry" });
    fake.releaseHanging();
    const [first] = await attempts(campaign.id);
    expect(first).toMatchObject({ status: "uncertain", error_class: "timeout", response_id: null });
    const [held] = await reservations(campaign.id);
    expect(held!.status).toBe("unresolved");
    const [turn] = await sql<{ status: string }>("select status from public.run_turns where campaign_id = $1 and step_index = 1", [campaign.id]);
    expect(turn!.status).toBe("uncertain");

    // The unresolved amount keeps counting against the budget.
    const budget = await rpc<{ campaigns: { open_total_usd: number; spent_total_usd: number }[] }>(
      workspace.owner.client, "budget_status", { p_workspace_id: workspace.id });
    expect(Number(budget.campaigns[0]!.open_total_usd)).toBeCloseTo(Number(held!.amount_usd), 8);
    const health = await rpc<{ workspace: { unresolved_attempts: number } }>(workspace.owner.client, "operational_status", { p_workspace_id: workspace.id });
    expect(health.workspace.unresolved_attempts).toBe(1);

    // The turn is retried (bounded) and the run finishes; the ambiguous attempt stays on record.
    await drain(fake);
    expect(await run(campaign.id)).toMatchObject({ status: "completed", steps_completed: 3 });
    expect((await attempts(campaign.id))[0]!.status).toBe("uncertain");
    expect((await reservations(campaign.id))[0]!.status).toBe("unresolved");

    // Only an owner can decide what the unknown request cost.
    const admins = await sql<{ id: string }>("select id from public.provider_attempts where id = $1", [first!.id]);
    await rpc(workspace.owner.client, "resolve_uncertain_attempt", { p_attempt_id: admins[0]!.id, p_resolution: "counted_as_spent" });
    const [resolved] = await reservations(campaign.id);
    expect(resolved).toMatchObject({ status: "settled" });
    expect(Number(resolved!.settled_cost_usd)).toBeCloseTo(Number(held!.amount_usd), 8);
    const [ledger] = await sql<{ basis: string; cost_usd: string }>("select basis, cost_usd from public.usage_ledger where attempt_id = $1", [first!.id]);
    expect(ledger!.basis).toBe("reservation");
    await expectDbError(rpc(workspace.owner.client, "resolve_uncertain_attempt", { p_attempt_id: first!.id, p_resolution: "released" }), "not_unresolved");
  });

  it("treats a dropped connection after sending as ambiguous, not as a free failure", async () => {
    const { campaign } = await oneQueuedConversation();
    fake.script({ type: "drop_after_processing" });
    expect(await work(fake)).toMatchObject({ result: "failed:connection_error:retry" });
    expect((await attempts(campaign.id))[0]).toMatchObject({ status: "uncertain", error_class: "connection_error" });
    expect((await reservations(campaign.id))[0]!.status).toBe("unresolved");
  });
});

describe("background responses", () => {
  it("follows a background response by id through queued polls", async () => {
    const { campaign } = await oneQueuedConversation({ execution_mode: "background" });
    fake.backgroundPolls = 2;

    // Create: accepted with an id, nothing generated yet.
    expect(await work(fake)).toMatchObject({ kind: "turn", result: "in_flight" });
    const [created] = await attempts(campaign.id);
    expect(created).toMatchObject({ status: "in_flight", mode: "background" });
    expect(created!.response_id).toMatch(/^resp_fake_/);
    expect(await job(campaign.id)).toMatchObject({ status: "waiting", status_reason: "awaiting_background_response" });
    expect(fake.responseRequests()[0]!.body).toMatchObject({ background: true, store: true });

    // Polls are separate units of work.
    await makeQueueVisible();
    expect(await work(fake)).toMatchObject({ kind: "poll", result: "in_flight" });
    await makeQueueVisible();
    expect(await work(fake)).toMatchObject({ kind: "poll", result: "committed:continue" });
    expect((await attempts(campaign.id))[0]!.status).toBe("succeeded");

    await drain(fake);
    expect(await run(campaign.id)).toMatchObject({ status: "completed", steps_completed: 3 });
    // Three creates in total; everything else was status polling.
    expect(fake.responseRequests()).toHaveLength(3);
    expect(fake.requests.filter((r) => r.method === "GET" && r.path.startsWith("/v1/responses/")).length).toBeGreaterThanOrEqual(6);
  });

  it("reconciles by response id when the worker dies after the provider accepted the request", async () => {
    const { campaign } = await oneQueuedConversation({ execution_mode: "background" });
    fake.backgroundPolls = 1;
    await expect(
      work(fake, {}, { afterProviderCall: () => { throw new Error("simulated crash"); } }),
    ).rejects.toThrow("simulated crash");
    // The id was never saved, so this one is ambiguous; the retry is tracked separately.
    await sql("update public.jobs set lease_expires_at = now() - interval '1 minute' where campaign_id = $1 and status = 'running'", [campaign.id]);
    await drain(fake);
    expect(await run(campaign.id)).toMatchObject({ status: "completed" });
    const all = await attempts(campaign.id);
    expect(all[0]).toMatchObject({ status: "uncertain", error_class: "worker_lost" });
    expect(all.slice(1).every((a) => a.status === "succeeded" && a.response_id)).toBe(true);
  });

  it("falls back to background mode after a synchronous attempt runs out of time", async () => {
    const { campaign } = await oneQueuedConversation({ execution_mode: "auto" });
    fake.script({ type: "hang" });
    await work(fake, { syncTimeoutMs: 300 });
    fake.releaseHanging();
    await drain(fake);
    const all = await attempts(campaign.id);
    expect(all[0]).toMatchObject({ mode: "sync", status: "uncertain" });
    expect(all[1]).toMatchObject({ mode: "background", status: "succeeded" });
    expect(await run(campaign.id)).toMatchObject({ status: "completed" });
  });
});

describe("pause, resume, cancel and stop", () => {
  it("stops dispatching on pause, lets the submitted turn resolve, and continues the same chain on resume", async () => {
    const { workspace, campaign } = await oneQueuedConversation();

    // Pause while the first turn is in flight (claimed, request out).
    let pausedDuringFlight = false;
    const outcome = await work(fake, {}, {
      afterBeginAttempt: async () => {
        await rpc(workspace.owner.client, "pause_campaign", { p_campaign_id: campaign.id });
        pausedDuringFlight = (await sql<{ status: string }>("select status from public.provider_attempts where campaign_id = $1", [campaign.id]))[0]!.status === "started";
      },
    });
    expect(pausedDuringFlight).toBe(true);
    // The in-flight request resolved and was saved; the next turn was not dispatched.
    expect(outcome).toMatchObject({ result: "committed:paused" });
    expect(await campaignStatus(campaign.id)).toBe("paused");
    expect(await run(campaign.id)).toMatchObject({ status: "in_progress", steps_completed: 1 });
    expect(await job(campaign.id)).toMatchObject({ status: "paused", status_reason: "campaign_paused" });
    expect(await sql("select 1 from pgmq.q_lr_work")).toHaveLength(0);

    // Nothing moves while paused: no worker finds work and no slot is dispatched.
    expect((await work(fake)).status).toBe("idle");
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    expect((await tick(new Date(slot!.scheduled_for))).dispatch.dispatched).toBe(0);
    expect(fake.responseRequests()).toHaveLength(1);

    await rpc(workspace.owner.client, "resume_campaign", { p_campaign_id: campaign.id });
    expect(await campaignStatus(campaign.id)).toBe("running");
    await drain(fake, { max: 2 });

    const turns = await sql<{ response_id: string; previous_response_id: string | null }>(
      "select response_id, previous_response_id from public.run_turns where run_id = $1 order by step_index",
      [(await run(campaign.id)).id],
    );
    // Same conversation: turn two continued from the response saved before the pause.
    expect(turns[1]!.previous_response_id).toBe(turns[0]!.response_id);
    expect(turns[2]!.previous_response_id).toBe(turns[1]!.response_id);
    expect(await run(campaign.id)).toMatchObject({ status: "completed", steps_completed: 3 });
  });

  it("cancels pending work and lets an in-flight request finish without starting another", async () => {
    const { workspace, campaign } = await oneQueuedConversation();
    const outcome = await work(fake, {}, {
      afterBeginAttempt: async () => {
        await rpc(workspace.owner.client, "cancel_campaign", { p_campaign_id: campaign.id });
      },
    });
    expect(outcome).toMatchObject({ result: "committed:canceled" });
    expect(await campaignStatus(campaign.id)).toBe("canceled");
    expect(await run(campaign.id)).toMatchObject({ status: "canceled", steps_completed: 1 });
    // The submitted turn was recorded (and paid for); nothing else was sent.
    expect(fake.responseRequests()).toHaveLength(1);
    expect((await attempts(campaign.id))[0]!.status).toBe("succeeded");
    const statuses = await sql<{ status: string; n: string }>(
      "select status, count(*) as n from public.jobs where campaign_id = $1 group by status",
      [campaign.id],
    );
    expect(statuses.every((s) => s.status === "canceled")).toBe(true);
    expect(await sql("select 1 from pgmq.q_lr_work")).toHaveLength(0);
    await expectDbError(rpc(workspace.owner.client, "resume_campaign", { p_campaign_id: campaign.id }), "not_paused");
  });

  it("honors the owner's global stop for every paid request and resumes when released", async () => {
    const { workspace, campaign, connectionId } = await oneQueuedConversation();
    await rpc(workspace.owner.client, "set_emergency_stop", { p_workspace_id: workspace.id, p_enabled: true, p_reason: "investigating spend" });

    expect((await work(fake)).status).toBe("idle");
    expect(fake.responseRequests()).toHaveLength(0);
    expect(await job(campaign.id)).toMatchObject({ status: "paused", status_reason: "emergency_stop" });

    // Tests, verification and generation are refused too.
    await expectDbError(rpc(workspace.owner.client, "request_test_conversation", { p_campaign_id: campaign.id }), "emergency_stop");
    expect(await ops(workspace.owner, fake, "model.verify", { connection_id: connectionId, model_id: "fake-chat-1", max_output_tokens: 64 }))
      .toMatchObject({ ok: false, code: "emergency_stop" });
    expect(await ops(workspace.owner, fake, "variations.generate", { workspace_id: workspace.id, campaign_id: campaign.id, kind: "initial_question", count: 2 }))
      .toMatchObject({ ok: false, code: "emergency_stop" });
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    expect((await tick(new Date(slot!.scheduled_for))).dispatch.dispatched).toBe(0);
    expect(fake.responseRequests()).toHaveLength(0);

    await rpc(workspace.owner.client, "set_emergency_stop", { p_workspace_id: workspace.id, p_enabled: false });
    await drain(fake);
    expect((await sql<{ status: string }>("select status from public.runs where campaign_id = $1 order by created_at limit 1", [campaign.id]))[0]!.status).toBe("completed");
  });
});

describe("expired conversation state", () => {
  it("requires an explicit restart instead of continuing as an unrelated conversation", async () => {
    const { workspace, campaign } = await oneQueuedConversation();
    await drain(fake, { max: 1 });
    await rpc(workspace.owner.client, "pause_campaign", { p_campaign_id: campaign.id });

    // While paused, the provider discards the stored responses.
    fake.expireAllResponses();
    await rpc(workspace.owner.client, "resume_campaign", { p_campaign_id: campaign.id });
    await drain(fake);

    const expired = await run(campaign.id);
    expect(expired).toMatchObject({ status: "expired", steps_completed: 1, error_class: "chain_expired" });
    expect(await job(campaign.id)).toMatchObject({ status: "dead", last_error_class: "chain_expired" });
    // One attempt at turn two, which the provider rejected. No silent fresh conversation.
    const requests = fake.responseRequests();
    expect(requests).toHaveLength(2);
    expect(requests.filter((r) => !r.body!.previous_response_id)).toHaveLength(1);
    expect(await campaignStatus(campaign.id)).toBe("running");

    // Retrying the dead job is refused: the chain cannot be continued.
    await expectDbError(rpc(workspace.owner.client, "retry_job", { p_job_id: (await job(campaign.id)).id }), "chain_expired");

    // An explicit restart begins a new conversation from turn one and keeps the old run as it was.
    const restartedId = await rpc<string>(workspace.owner.client, "restart_run", { p_run_id: expired.id });
    await drain(fake);
    const [restarted] = await sql<{ status: string; steps_completed: number; restart_of_run_id: string }>(
      "select status, steps_completed, restart_of_run_id from public.runs where id = $1",
      [restartedId],
    );
    expect(restarted).toEqual({ status: "completed", steps_completed: 3, restart_of_run_id: expired.id });
    expect((await run(campaign.id)).status).toBe("expired");
    const freshTurns = await sql<{ previous_response_id: string | null }>(
      "select previous_response_id from public.run_turns where run_id = $1 order by step_index",
      [restartedId],
    );
    expect(freshTurns[0]!.previous_response_id).toBeNull();
    await expectDbError(rpc(workspace.owner.client, "restart_run", { p_run_id: expired.id }), "already_restarted");
  });
});
