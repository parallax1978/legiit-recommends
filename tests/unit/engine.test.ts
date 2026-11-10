import { describe, expect, it } from "vitest";
import {
  createSupabaseEngineDb,
  isUnknownOutcome,
  type EngineDb,
  type LeaseRef,
  type Unit,
} from "@shared/engine/db";
import { DEFAULT_ENGINE_CONFIG, processOneUnit, type EngineDeps } from "@shared/engine/worker";
import { planProbe, probeModel } from "@shared/provider/probe";
import {
  EMPTY_USAGE,
  type ProviderClient,
  type ProviderFailure,
  type ProviderOutcome,
  type ProviderResult,
} from "@shared/provider/types";

const REF: LeaseRef = { job_id: "job-1", lease_token: "lease-1", fencing_token: 1 };

/** A supabase-js stand-in whose rpc() answers from a script, then succeeds. */
function scriptedClient(script: { code?: string; message?: string; status?: number }[]) {
  const calls: string[] = [];
  const client = {
    rpc(fn: string) {
      calls.push(fn);
      const next = script.shift();
      if (!next) return Promise.resolve({ data: { ok: true }, error: null, status: 200 });
      return Promise.resolve({
        data: null,
        error: { code: next.code ?? "", message: next.message ?? "failed" },
        status: next.status ?? 500,
      });
    },
  };
  const sleeps: number[] = [];
  const db = createSupabaseEngineDb(client as never, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { db, calls, sleeps };
}

const RESULT: ProviderResult = {
  status: "completed",
  response_id: "resp_1",
  output_text: "OK",
  output_items: [],
  returned_model: "model-x",
  service_tier: null,
  incomplete_reason: null,
  refusal: false,
  provider_request_id: null,
  http_status: 200,
  latency_ms: 10,
  usage: EMPTY_USAGE,
  echo: {
    reasoning_effort: null,
    verbosity: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 32,
  },
};

const failure = (overrides: Partial<ProviderFailure>): ProviderFailure => ({
  class: "server_error",
  uncertain: false,
  http_status: 500,
  type: null,
  code: null,
  param: null,
  message: "failed",
  retry_after_ms: null,
  provider_request_id: null,
  response_id: null,
  latency_ms: 5,
  ...overrides,
});

describe("database calls from the worker", () => {
  it("keeps a paid answer when the gateway fails for a moment", async () => {
    const { db, calls, sleeps } = scriptedClient([
      { status: 503, code: "PGRST001", message: "Database client error" },
      { status: 502, message: "Bad Gateway" },
      { status: 0, message: "TypeError: fetch failed" },
    ]);
    await expect(db.commitResult(REF, "attempt-1", RESULT, null)).resolves.toEqual({ ok: true });
    expect(calls).toEqual(Array(4).fill("svc_commit_result"));
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  it("does not repeat a call that must not run twice when its outcome is unknown", async () => {
    const begin = scriptedClient([{ status: 503, code: "PGRST001" }]);
    await expect(
      begin.db.beginAttempt(REF, {
        mode: "sync",
        est_input_tokens: 10,
        max_output_tokens: 10,
        request_params: {},
      }),
    ).rejects.toThrow(/svc_begin_attempt/);
    expect(begin.calls).toHaveLength(1);

    const claim = scriptedClient([{ status: 504, message: "Gateway Timeout" }]);
    await expect(claim.db.receiveWork("worker-1")).rejects.toThrow(/svc_receive_work/);
    expect(claim.calls).toHaveLength(1);
  });

  it("repeats any call that Postgres aborted without writing anything", async () => {
    const { db, calls } = scriptedClient([
      { status: 500, code: "40P01", message: "deadlock detected" },
      { status: 500, code: "40001", message: "could not serialize" },
    ]);
    await expect(db.receiveWork("worker-1")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it("gives up after about forty seconds, and at once for a real error", async () => {
    const stuck = scriptedClient(Array.from({ length: 30 }, () => ({ status: 503 })));
    await expect(stuck.db.failAttempt(REF, "attempt-1", failure({}))).rejects.toThrow(
      /svc_fail_attempt/,
    );
    expect(stuck.calls).toHaveLength(10);
    expect(stuck.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(39_750);

    const refused = scriptedClient([
      { status: 400, code: "P0001", message: "The lease is no longer held." },
    ]);
    await expect(refused.db.commitResult(REF, "attempt-1", RESULT, null)).rejects.toThrow(
      /lease is no longer held/,
    );
    expect(refused.calls).toHaveLength(1);
  });

  it("tells an unknown outcome from a definite answer", () => {
    expect(isUnknownOutcome({ message: "TypeError: fetch failed" }, 0)).toBe(true);
    expect(isUnknownOutcome({ code: "PGRST002", message: "schema cache" }, 503)).toBe(true);
    expect(isUnknownOutcome({ code: "57014", message: "statement timeout" }, 500)).toBe(true);
    expect(isUnknownOutcome({ message: "upstream timed out" }, 500)).toBe(true);
    expect(isUnknownOutcome({ code: "P0001", message: "not allowed" }, 400)).toBe(false);
    expect(isUnknownOutcome({ code: "42501", message: "permission denied" }, 403)).toBe(false);
    expect(isUnknownOutcome({ code: "23505", message: "duplicate key" }, 409)).toBe(false);
  });
});

/** An EngineDb whose methods record what the worker asked for. */
function recordingDb(overrides: Partial<EngineDb>): { db: EngineDb; log: unknown[][] } {
  const log: unknown[][] = [];
  const record =
    (name: string, value: unknown) =>
    (...args: unknown[]) => {
      log.push([name, ...args]);
      return Promise.resolve(value);
    };
  const db = {
    receiveWork: record("receiveWork", null),
    materializeRun: record("materializeRun", { ok: false, action: "stale" }),
    beginAttempt: record("beginAttempt", {
      ok: true,
      attempt_id: "attempt-1",
      attempt_number: 1,
      reserved_usd: 0.01,
      previous_response_id: null,
    }),
    excludeCheck: record("excludeCheck", undefined),
    attemptInFlight: record("attemptInFlight", undefined),
    pollPending: record("pollPending", undefined),
    commitResult: record("commitResult", { ok: true, next: "done" }),
    failAttempt: record("failAttempt", { ok: true, action: "retry" }),
    releaseWork: record("releaseWork", undefined),
    getConnectionSecret: record("getConnectionSecret", "sk-test"),
    tick: record("tick", undefined),
    ...overrides,
  } as EngineDb;
  return { db, log };
}

const checkUnit = (extra: Partial<Unit> = {}): Unit =>
  ({
    ...REF,
    msg_id: 1,
    kind: "check",
    job_kind: "check_baseline",
    workspace_id: "ws-1",
    campaign_id: "campaign-1",
    connection_id: "connection-1",
    lease_expires_at: new Date(Date.now() + 180_000).toISOString(),
    attempts: 0,
    max_attempts: 5,
    last_error_class: null,
    background_supported: true,
    poll: null,
    check: {
      id: "check-1",
      phase: "baseline",
      status: "pending",
      question_body: "Which bakeries would you recommend?",
      variables: {},
      rendered_prompt: null,
      model: "model-x",
      params: null,
      max_output_tokens: 600,
      execution_mode: "sync",
      store_response: false,
      attempt_count: 0,
    },
    analysis_target: { business_name: "Example Bakery", website_url: null, aliases: [] },
    ...extra,
  }) as unknown as Unit;

const depsFor = (db: EngineDb, provider: Partial<ProviderClient>): EngineDeps => ({
  db,
  createProvider: () => provider as ProviderClient,
  config: { ...DEFAULT_ENGINE_CONFIG, workerId: "worker-1" },
});

describe("worker engine", () => {
  it("records a request as not sent when the API key cannot be read after the reservation", async () => {
    let providerCreated = false;
    const { db, log } = recordingDb({
      receiveWork: () => Promise.resolve(checkUnit()),
      getConnectionSecret: () => Promise.reject(new Error("svc_get_connection_secret: 503")),
    });
    const outcome = await processOneUnit({
      ...depsFor(db, {}),
      createProvider: () => {
        providerCreated = true;
        return {} as ProviderClient;
      },
    });
    expect(providerCreated).toBe(false);
    expect(outcome).toMatchObject({ status: "processed", result: "failed:connection_error:retry" });
    const failed = log.find(([name]) => name === "failAttempt")!;
    // Not "uncertain": nothing left this machine, so nothing can have been billed.
    expect(failed[3]).toMatchObject({
      class: "connection_error",
      uncertain: false,
      code: "not_sent",
    });
    expect(String((failed[3] as ProviderFailure).message)).toContain("was not sent");
  });

  it("stops following a background response whose status can no longer be learned", async () => {
    const pollUnit = (minutesOld: number) =>
      checkUnit({
        poll: {
          attempt_id: "attempt-1",
          response_id: "resp_bg",
          poll_count: 4,
          started_at: new Date(Date.now() - minutesOld * 60_000).toISOString(),
        },
      });
    const rejected: ProviderOutcome = {
      kind: "failure",
      failure: failure({ class: "invalid_credentials", http_status: 401 }),
    };
    const provider = { retrieveResponse: () => Promise.resolve(rejected) };

    // Young: a failed status check says nothing about the response, so look again later.
    const young = recordingDb({ receiveWork: () => Promise.resolve(pollUnit(5)) });
    expect(await processOneUnit(depsFor(young.db, provider))).toMatchObject({
      result: "poll_deferred:invalid_credentials",
    });
    expect(young.log.map(([name]) => name)).toContain("pollPending");

    // Older than a background response may run: record it as unknown and stop polling.
    const old = recordingDb({ receiveWork: () => Promise.resolve(pollUnit(45)) });
    expect(await processOneUnit(depsFor(old.db, provider))).toMatchObject({
      result: "failed:timeout:retry",
    });
    expect(old.log.map(([name]) => name)).not.toContain("pollPending");
    expect(old.log.find(([name]) => name === "failAttempt")![3]).toMatchObject({
      class: "timeout",
      uncertain: true,
      response_id: "resp_bg",
      code: "background_unreachable",
    });

    // The same when the key itself is gone.
    const noKey = recordingDb({
      receiveWork: () => Promise.resolve(pollUnit(45)),
      getConnectionSecret: () => Promise.resolve(null),
    });
    expect(await processOneUnit(depsFor(noKey.db, provider))).toMatchObject({
      result: "failed:timeout:retry",
    });
    const stillYoung = recordingDb({
      receiveWork: () => Promise.resolve(pollUnit(5)),
      getConnectionSecret: () => Promise.resolve(null),
    });
    expect(await processOneUnit(depsFor(stillYoung.db, provider))).toMatchObject({
      result: "poll_deferred:no_credentials",
    });
  });
});

describe("model verification time budget", () => {
  const instant: ProviderClient = {
    createResponse: () => Promise.resolve({ kind: "result", result: RESULT }),
    retrieveResponse: () => Promise.resolve({ kind: "result", result: RESULT }),
    cancelResponse: () => Promise.resolve({ kind: "result", result: RESULT }),
    listModels: () => Promise.resolve({ ok: true, models: [] }),
  };

  it("verifies normally when the provider answers in time, never waiting past the budget", async () => {
    const timeouts: number[] = [];
    const provider: ProviderClient = {
      ...instant,
      createResponse: (_request, options) => {
        timeouts.push(options.timeoutMs);
        return Promise.resolve({ kind: "result", result: RESULT });
      },
    };
    const result = await probeModel(
      provider,
      "model-x",
      2000,
      { onOutcome: async () => {}, onUnused: async () => {} },
      { timeoutMs: 45_000, totalBudgetMs: 20_000 },
    );
    expect(result).toMatchObject({ verified: true, error: null });
    expect(result.inconclusive).toBeFalsy();
    // No single request may outlive what is left of the whole verification.
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(20_000);
  });

  it("stops when the budget is spent, releases what it did not send, and concludes nothing", async () => {
    const sent: string[] = [];
    const unused: string[] = [];
    const result = await probeModel(
      instant,
      "model-x",
      2000,
      {
        onOutcome: async (key) => {
          sent.push(key);
        },
        onUnused: async (key) => {
          unused.push(key);
        },
      },
      { timeoutMs: 45_000, totalBudgetMs: 0 },
    );
    expect(result).toMatchObject({ verified: false, capabilities: null, inconclusive: true });
    expect(result.error).toContain("did not finish in time");
    expect(sent).toEqual(["base"]);
    // Every planned request that was not sent has its reservation released.
    expect([...sent, ...unused].sort()).toEqual(
      planProbe(2000)
        .map((step) => step.key)
        .sort(),
    );
  });
});
