// Queue consumer.
//
// Woken by Supabase Cron (pg_cron + pg_net) whenever messages are visible in the work queue, and
// by other workers when they hand off the next unit. Each invocation processes ONE unit of work
// (a conversation turn, a fresh check, or a background-response poll) and then asks the
// dispatcher to wake a consumer for whatever became ready.
//
// The HTTP response is returned immediately; the unit runs under EdgeRuntime.waitUntil. That is
// only a way to keep this invocation alive — durability comes from the queue: if the invocation
// dies, the message reappears after its visibility timeout and the job resumes from its last
// committed state.

import { createSupabaseEngineDb } from "../_shared/engine/db.ts";
import { DEFAULT_ENGINE_CONFIG, processOneUnit, type UnitOutcome } from "../_shared/engine/worker.ts";
import { createOpenAIProvider } from "../_shared/provider/openai.ts";
import { adminClient, env, json, providerBaseUrl, runInBackground, timingSafeEqual } from "../_shared/edge/runtime.ts";

function numberEnv(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function work(workerId: string): Promise<UnitOutcome | { status: "error"; message: string }> {
  const db = createSupabaseEngineDb(adminClient());
  const baseURL = providerBaseUrl();
  try {
    const outcome = await processOneUnit({
      db,
      createProvider: (apiKey) => createOpenAIProvider({ apiKey, ...(baseURL ? { baseURL } : {}) }),
      config: {
        workerId,
        syncTimeoutMs: numberEnv("PROVIDER_SYNC_TIMEOUT_MS", DEFAULT_ENGINE_CONFIG.syncTimeoutMs),
        shortTimeoutMs: numberEnv("PROVIDER_SHORT_TIMEOUT_MS", DEFAULT_ENGINE_CONFIG.shortTimeoutMs),
        backgroundMaxMs: numberEnv("PROVIDER_BACKGROUND_MAX_MS", DEFAULT_ENGINE_CONFIG.backgroundMaxMs),
      },
      log: (event, details) => console.log(JSON.stringify({ event, worker: workerId, ...details })),
    });
    if (outcome.status === "processed") {
      // Hand off: dispatch whatever is ready now instead of waiting for the next cron tick.
      await db.tick(false).catch((error) => console.error("handoff tick failed", String(error)));
    }
    return outcome;
  } catch (error) {
    // Nothing is lost: the claimed message becomes visible again when its lease expires.
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "worker_error", worker: workerId, message }));
    return { status: "error", message };
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const expected = env("WORKER_SECRET");
    const provided = request.headers.get("x-worker-secret") ?? "";
    if (!expected || !timingSafeEqual(provided, expected)) {
      return json({ error: "unauthorized" }, 401);
    }

    let wait = false;
    try {
      const body = (await request.json()) as { wait?: boolean };
      wait = body?.wait === true;
    } catch {
      // an empty body is fine
    }

    const workerId = crypto.randomUUID();
    const job = work(workerId);
    if (!wait && runInBackground(job)) {
      return json({ accepted: true, worker: workerId }, 202);
    }
    return json({ worker: workerId, outcome: await job });
  },
};
