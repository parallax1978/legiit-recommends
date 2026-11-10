/**
 * Connects Supabase Cron to the queue consumer (the `worker` Edge Function).
 *
 *   npm run queues:activate
 *
 * Stores two values in Supabase Vault: the base URL the database should call and the shared
 * secret it presents. Until this has run, schedules still plan work and enqueue jobs, but
 * nothing wakes the consumer — no provider requests are made.
 *
 * Requires SUPABASE_URL, SUPABASE_SECRET_KEY and WORKER_SECRET (the same value set as the
 * WORKER_SECRET function secret). SUPABASE_FUNCTIONS_BASE_URL overrides the URL the database
 * calls; locally the database reaches the gateway at http://kong:8000.
 *
 * Pass --status to only report the current state.
 */
import {
  adminClient,
  describeDbError,
  env,
  fail,
  loadEnvFiles,
  parseArgs,
  requireEnv,
  supabaseUrl,
} from "./lib/env";

async function main() {
  loadEnvFiles();
  const args = parseArgs(process.argv.slice(2));
  const admin = adminClient();

  if (!args.status) {
    const secret = requireEnv(
      "WORKER_SECRET",
      "Use the same value as the WORKER_SECRET secret of the Edge Functions.",
    );
    if (secret.length < 32)
      fail("WORKER_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32");
    const url = supabaseUrl();
    const isLocal = /\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
    const base = (
      env("SUPABASE_FUNCTIONS_BASE_URL") ?? (isLocal ? "http://kong:8000" : url)
    ).replace(/\/$/, "");

    const configured = await admin.rpc("svc_configure_worker", {
      p_functions_base_url: base,
      p_worker_secret: secret,
    });
    if (configured.error) fail(describeDbError(configured.error));
    console.log(`\nQueue consumer activated. The database will call ${base}/functions/v1/worker.`);
  }

  const tick = await admin.rpc("svc_tick", { p_plan: false });
  if (tick.error) fail(describeDbError(tick.error));
  console.log("Scheduler tick:", JSON.stringify(tick.data));
  console.log(
    "Deploying or activating never starts paid work: only launched campaigns produce jobs.\n",
  );
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
