// Prepares the local stack for an end-to-end run: clears data left by earlier runs, then uses
// the real operator commands to bootstrap the owner and activate the queue consumers.

import { execFileSync } from "node:child_process";
import { OWNER, clearMail, sql, stack } from "./support";

function runScript(script: string, args: string[], env: Record<string, string>): void {
  execFileSync("npx", ["tsx", script, ...args], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
}

export default async function globalSetup(): Promise<void> {
  const local = stack();
  if (!/127\.0\.0\.1|localhost/.test(local.apiUrl))
    throw new Error("End-to-end tests only run against a local Supabase stack.");
  const health = await fetch("http://127.0.0.1:4010/health").then(
    (response) => response.json() as Promise<{ fake?: boolean }>,
  );
  if (!health.fake) throw new Error("Port 4010 is not serving the provider double.");

  // Start from an empty installation: no workspaces, no users from earlier runs, an empty queue.
  await sql("begin; set constraints all deferred; delete from public.workspaces; commit;");
  await sql("delete from auth.users where email like '%@e2e.lr.test'");
  await sql("delete from app_private.owner_bootstrap_grants");
  await sql("select pgmq.purge_queue('lr_work')");
  await sql("delete from vault.secrets where name like 'lr_conn_%'");
  await sql("select cron.alter_job(jobid, active := true) from cron.job where jobname like 'lr-%'");
  await clearMail();

  const env = {
    SUPABASE_URL: local.apiUrl,
    SUPABASE_SECRET_KEY: local.secretKey,
    SITE_URL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  };
  // The owner bootstrap command, exactly as an operator runs it (password route: no email needed).
  runScript("scripts/bootstrap-owner.ts", ["--email", OWNER.email], {
    ...env,
    OWNER_PASSWORD: OWNER.password,
  });
  // Queue activation, exactly as an operator runs it.
  runScript("scripts/activate-queues.ts", [], {
    ...env,
    WORKER_SECRET: local.workerSecret,
    SUPABASE_FUNCTIONS_BASE_URL: "http://kong:8000",
  });
}
