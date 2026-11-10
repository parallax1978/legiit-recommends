// Connects the integration tests to the local Supabase stack and makes the run deterministic:
// the cron-driven scheduler is paused (tests drive time explicitly) and queue consumers are
// deactivated (tests run the worker in-process).

import { execFileSync } from "node:child_process";
import pg from "pg";

function stackEnv(): Record<string, string> {
  let output: string;
  try {
    output = execFileSync("npx", ["supabase", "status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      "The local Supabase stack is not running. Start it with `npm run db:start` and apply migrations with `npm run db:reset`.",
    );
  }
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) values[match[1]!] = match[2]!;
  }
  return values;
}

/**
 * Right after `supabase db reset` the database has restarted and the API gateway takes a few
 * seconds to reconnect, answering 503 until it has. Tests started in that window would fail
 * for a reason that has nothing to do with them, so wait until a real query gets through.
 */
async function waitForApi(apiUrl: string, secret: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/rest/v1/model_prices?select=model_id&limit=1`, {
        headers: { apikey: secret, Authorization: `Bearer ${secret}` },
      });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(
    `The local API did not become ready (${last}). Is the stack running and migrated? Try \`npm run db:reset\`.`,
  );
}

export default async function setup(): Promise<() => Promise<void>> {
  const values = stackEnv();
  const apiUrl = process.env.LR_TEST_API_URL ?? values.API_URL;
  const dbUrl = process.env.LR_TEST_DB_URL ?? values.DB_URL;
  const publishable =
    process.env.LR_TEST_PUBLISHABLE_KEY ?? values.PUBLISHABLE_KEY ?? values.ANON_KEY;
  const secret = process.env.LR_TEST_SECRET_KEY ?? values.SECRET_KEY ?? values.SERVICE_ROLE_KEY;
  if (!apiUrl || !dbUrl || !publishable || !secret) {
    throw new Error("Could not read the local stack's URL and keys from `supabase status`.");
  }
  process.env.LR_TEST_API_URL = apiUrl;
  process.env.LR_TEST_DB_URL = dbUrl;
  process.env.LR_TEST_PUBLISHABLE_KEY = publishable;
  process.env.LR_TEST_SECRET_KEY = secret;
  await waitForApi(apiUrl, secret);

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const previous = await client.query<{ jobname: string; active: boolean }>(
    "select jobname, active from cron.job where jobname like 'lr-%'",
  );
  await client.query(
    "select cron.alter_job(jobid, active := false) from cron.job where jobname like 'lr-%'",
  );
  // No HTTP wake-ups: the in-process worker is the only consumer during these tests.
  const consumers = await client.query<{ name: string; secret: string }>(
    "select name, decrypted_secret as secret from vault.decrypted_secrets where name in ('lr_functions_base_url', 'lr_worker_secret')",
  );
  await client.query(
    "delete from vault.secrets where name in ('lr_functions_base_url', 'lr_worker_secret')",
  );
  await client.end();

  return async () => {
    const restore = new pg.Client({ connectionString: dbUrl });
    await restore.connect();
    for (const job of previous.rows) {
      await restore.query(
        "select cron.alter_job(jobid, active := $2) from cron.job where jobname = $1",
        [job.jobname, job.active],
      );
    }
    const url = consumers.rows.find((row) => row.name === "lr_functions_base_url")?.secret;
    const workerSecret = consumers.rows.find((row) => row.name === "lr_worker_secret")?.secret;
    if (url && workerSecret) {
      await restore.query("select public.svc_configure_worker($1, $2)", [url, workerSecret]);
    }
    await restore.end();
  };
}
