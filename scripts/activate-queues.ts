/**
 * Connects Supabase Cron to the queue consumer (the `worker` Edge Function).
 *
 *   npm run queues:activate
 *
 * Stores two values in Supabase Vault: the base URL the database should call and the shared
 * secret it presents. Until this has run, schedules still plan work and enqueue jobs, but
 * nothing wakes the consumer — no provider requests are made.
 *
 * It then sends one wake-up from the database and reports the worker's answer, because stored
 * settings alone prove nothing: a secret that does not match the function's, a function that is
 * not deployed or a wrong URL would all leave the queue silently unserved. A wake-up with
 * nothing queued makes the worker look for work, find none and stop.
 *
 * Requires WORKER_SECRET (the same value set as the WORKER_SECRET function secret) and either
 * SUPABASE_URL with SUPABASE_SECRET_KEY, or SUPABASE_ACCESS_TOKEN with SUPABASE_PROJECT_REF.
 * SUPABASE_FUNCTIONS_BASE_URL overrides the URL the database calls; locally the database
 * reaches the gateway at http://kong:8000.
 *
 * Pass --status to only report the current state (it still sends the one wake-up), or
 * --no-check to store the settings without the wake-up (the deploy script does this before the
 * worker function is deployed, and checks afterwards).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  adminClient,
  describeDbError,
  env,
  fail,
  isLocalUrl,
  loadEnvFiles,
  parseArgs,
  requireEnv,
  supabaseUrl,
} from "./lib/env";

interface WakeResult {
  done: boolean;
  status_code?: number | null;
  timed_out?: boolean | null;
  error?: string | null;
}

function isAccepted(result: WakeResult): boolean {
  const status = result.status_code ?? null;
  return status !== null && status >= 200 && status < 300;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One wake-up from the database, and the worker's answer to it. */
async function wakeOnce(admin: SupabaseClient): Promise<WakeResult> {
  const sent = await admin.rpc("svc_wake_check");
  if (sent.error) fail(describeDbError(sent.error));
  const requestId = sent.data as number;
  let result: WakeResult = { done: false };
  for (let attempt = 0; attempt < 30 && !result.done; attempt += 1) {
    await sleep(1000);
    const read = await admin.rpc("svc_wake_result", { p_request_id: requestId });
    if (read.error) fail(describeDbError(read.error));
    result = read.data as WakeResult;
  }
  return result;
}

/** Sends a wake-up from the database and reports whether the worker accepted it. */
async function checkWake(admin: SupabaseClient): Promise<void> {
  // A secret that was just replaced can take a little while to reach a running function, and
  // a function that was just deployed can take a moment to answer: try a few times.
  let result = await wakeOnce(admin);
  for (let retry = 0; retry < 5 && result.done && !isAccepted(result); retry += 1) {
    await sleep(8000);
    result = await wakeOnce(admin);
  }

  if (!result.done) {
    fail(
      "The database sent a wake-up but recorded no answer within 30 seconds. " +
        "Check that the pg_net extension is running (Dashboard → Database → Extensions).",
    );
  }
  const status = result.status_code ?? null;
  if (isAccepted(result)) {
    console.log(`Wake-up check: the worker accepted it (HTTP ${status}).`);
    return;
  }
  const hint =
    status === 401
      ? "The secret in the database does not match the WORKER_SECRET of the worker function. " +
        "Run `npm run deploy:supabase` to install one value on both sides."
      : status === 404
        ? "The worker function was not found at that address. Deploy it (`npm run deploy:supabase`) or correct the URL."
        : status === 503
          ? "The worker started but could not reach the database with its service key (for a local stack: apply the migrations with `npm run db:reset`). See the worker function's logs."
          : status !== null
            ? "Look at the worker function's logs in the Supabase dashboard."
            : "The worker could not be reached from the database. Check the URL above.";
  fail(
    `Wake-up check failed: ${status !== null ? `the worker answered HTTP ${status}` : (result.error ?? (result.timed_out ? "the request timed out" : "no response"))}.\n` +
      `${hint}\nUntil this passes, launched campaigns queue work that nothing picks up.`,
  );
}

async function main() {
  loadEnvFiles();
  const args = parseArgs(process.argv.slice(2));
  const admin = await adminClient();
  console.log(`\nProject: ${supabaseUrl()}`);

  if (!args.status) {
    const secret = requireEnv(
      "WORKER_SECRET",
      "Use the same value as the WORKER_SECRET secret of the Edge Functions.",
    );
    if (secret.length < 32)
      fail("WORKER_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32");
    const url = supabaseUrl();
    const base = (
      env("SUPABASE_FUNCTIONS_BASE_URL") ?? (isLocalUrl(url) ? "http://kong:8000" : url)
    ).replace(/\/$/, "");

    const configured = await admin.rpc("svc_configure_worker", {
      p_functions_base_url: base,
      p_worker_secret: secret,
    });
    if (configured.error) fail(describeDbError(configured.error));
    console.log(`\nQueue consumer activated. The database will call ${base}/functions/v1/worker.`);
  }

  if (args["no-check"]) {
    console.log("Settings stored. The wake-up check was skipped (--no-check).\n");
    return;
  }

  const tick = await admin.rpc("svc_tick", { p_plan: false });
  if (tick.error) fail(describeDbError(tick.error));
  console.log("Scheduler tick:", JSON.stringify(tick.data));
  await checkWake(admin);
  console.log(
    "Deploying or activating never starts paid work: only launched campaigns produce jobs.\n",
  );
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
