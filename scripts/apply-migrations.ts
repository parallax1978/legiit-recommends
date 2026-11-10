/**
 * Applies pending database migrations through the Supabase Management API.
 *
 *   npm run db:push:api                 apply everything pending, as one transaction
 *   npm run db:push:api -- --dry-run    list what is pending; nothing is sent
 *   npm run db:push:api -- --verify     run the pending migrations on the project, then roll
 *                                       them back: proves they apply there, changes nothing
 *   npm run db:push:api -- --per-file   one transaction per file, like `supabase db push`
 *
 * Use it when `supabase db push` is not an option: no direct database connection from the
 * machine, or no database password (a project created through a hosting integration). It needs
 * only SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF, and it only ever talks to a hosted
 * project — the local stack is migrated by `supabase start` / `supabase db reset`.
 *
 * By default all pending files and their history records are sent as one request, which
 * Postgres runs as a single transaction: either every migration of the deployment is applied
 * or none is, so a half-migrated database (for example tables created but the API lock-down
 * not yet reached) cannot be left behind. When the request fails, the history table is read
 * again and the outcome is reported from what it records. If the database rejected a statement,
 * the same statements are replayed file by file inside transactions that are rolled back, to
 * name the failing file; a failure of the request itself (too large, a gateway timeout, a lost
 * reply) is reported as that and blames no file.
 * Use --per-file when one file has to be committed before the next can run (a new enum value
 * that a later file uses). Each file is still a transaction together with its history record,
 * so statements that cannot run inside one at all (CREATE INDEX CONCURRENTLY, VACUUM) are not
 * supported on this path; apply those with `supabase db push` over a direct connection.
 *
 * The history table is the Supabase CLI's own, so `supabase db push` and `supabase migration
 * list` see these migrations as applied. Like `db push`, the command refuses to continue when
 * the project has migrations this checkout does not know, or when a pending migration is older
 * than one already applied (pass --include-all to apply those anyway).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, loadEnvFiles, parseArgs } from "./lib/env";
import { ManagementError, managementClient, type ManagementClient } from "./lib/management";
import {
  HISTORY_TABLE_SQL,
  classifyApplyFailure,
  migrationRequestSql,
  parseMigrationFileName,
  planMigrations,
  type LocalMigration,
} from "./lib/migrations";

const ROLLBACK_MARKER = "lr_migrations_verified_rolling_back";
const ROLLBACK_SQL = `do $lr_rollback$ begin raise exception '${ROLLBACK_MARKER}'; end $lr_rollback$;`;

function readLocalMigrations(): LocalMigration[] {
  const directory = resolve(process.cwd(), "supabase/migrations");
  const migrations: LocalMigration[] = [];
  for (const file of readdirSync(directory).sort()) {
    if (!file.endsWith(".sql")) continue;
    const parsed = parseMigrationFileName(file);
    if (!parsed) fail(`supabase/migrations/${file} is not named <14-digit version>_<name>.sql.`);
    migrations.push({ ...parsed, file, sql: readFileSync(join(directory, file), "utf8") });
  }
  return migrations;
}

function batchSql(
  migrations: LocalMigration[],
  options: { createHistory: boolean; rollBack: boolean },
): string {
  return [
    ...(options.createHistory ? [HISTORY_TABLE_SQL] : []),
    ...migrations.map(migrationRequestSql),
    ...(options.rollBack ? [ROLLBACK_SQL] : []),
  ].join("\n");
}

const reasonOf = (error: unknown): string =>
  error instanceof ManagementError ? error.message : String(error);

const HISTORY_EXISTS_SQL =
  "select to_regclass('supabase_migrations.schema_migrations') is not null as exists";

/** The versions the project records as applied. Empty when it has no history table yet. */
async function appliedVersions(api: ManagementClient): Promise<string[] | null> {
  const history = await api.sql<{ exists: boolean }>(HISTORY_EXISTS_SQL);
  if (history[0]?.exists !== true) return null;
  const rows = await api.sql<{ version: string }>(
    "select version from supabase_migrations.schema_migrations order by version",
  );
  return rows.map((row) => row.version);
}

/** Runs the batch and always rolls it back. Returns null when every statement succeeded. */
async function rehearse(
  api: ManagementClient,
  migrations: LocalMigration[],
  createHistory: boolean,
): Promise<string | null> {
  try {
    await api.sql(batchSql(migrations, { createHistory, rollBack: true }));
  } catch (error) {
    const reason = reasonOf(error);
    return reason.includes(ROLLBACK_MARKER) ? null : reason;
  }
  return "The project accepted the request without rolling it back; check its migration history.";
}

/** Finds the first file that fails, by rehearsing longer and longer prefixes. */
async function locateFailure(
  api: ManagementClient,
  migrations: LocalMigration[],
  createHistory: boolean,
): Promise<{ file: string; reason: string } | null> {
  for (let count = 1; count <= migrations.length; count += 1) {
    const reason = await rehearse(api, migrations.slice(0, count), createHistory);
    if (reason) return { file: migrations[count - 1]!.file, reason };
  }
  return null;
}

async function main() {
  loadEnvFiles();
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const verifyOnly = args.verify === true;
  const perFile = args["per-file"] === true;
  const api = managementClient();
  const local = readLocalMigrations();

  const recordedBefore = await appliedVersions(api);
  const hasHistory = recordedBefore !== null;
  const applied = recordedBefore ?? [];

  const plan = planMigrations(local, applied);
  console.log(
    `\nProject ${api.ref}: ${applied.length} migration(s) applied, ${plan.pending.length} pending.`,
  );
  if (plan.unknownRemote.length > 0) {
    fail(
      `The project has migrations that are not in supabase/migrations: ${plan.unknownRemote.join(", ")}. ` +
        "Update this checkout (or repair the history with `supabase migration repair`) before applying more.",
    );
  }
  if (plan.outOfOrder.length > 0 && args["include-all"] !== true) {
    fail(
      `These pending migrations are older than one already applied: ${plan.outOfOrder.map((m) => m.file).join(", ")}. ` +
        "Rename them with a newer version, or pass --include-all to apply them anyway.",
    );
  }
  if (plan.pending.length === 0) {
    console.log("Nothing to apply.\n");
    return;
  }
  for (const migration of plan.pending) console.log(`  pending  ${migration.file}`);
  if (dryRun) {
    console.log("\nDry run: nothing was sent to the project.\n");
    return;
  }

  if (verifyOnly) {
    const failure = await locateFailure(api, plan.pending, !hasHistory);
    if (failure) fail(`${failure.file} does not apply on this project:\n${failure.reason}`);
    console.log(
      `\nVerified: all ${plan.pending.length} pending migration(s) apply on this project. ` +
        "Everything was rolled back; nothing changed.\n",
    );
    return;
  }

  if (perFile) {
    if (!hasHistory) await api.sql(HISTORY_TABLE_SQL);
    for (const migration of plan.pending) {
      process.stdout.write(`  applying ${migration.file} … `);
      try {
        await api.sql(migrationRequestSql(migration));
        console.log("done");
      } catch (error) {
        console.log("FAILED");
        fail(
          `${migration.file} was rolled back and is not recorded.\n${reasonOf(error)}\n` +
            "Earlier migrations in this run stay applied. Fix the file and run the command again.",
        );
      }
    }
    console.log(`\nApplied ${plan.pending.length} migration(s), one transaction each.\n`);
    return;
  }

  process.stdout.write(`  applying ${plan.pending.length} migration(s) as one transaction … `);
  try {
    await api.sql(batchSql(plan.pending, { createHistory: !hasHistory, rollBack: false }));
    console.log("done");
  } catch (error) {
    console.log("FAILED");
    const status = error instanceof ManagementError ? error.status : null;
    const pendingVersions = plan.pending.map((migration) => migration.version);
    // What the project records now is the evidence; the error alone is not. A reply can be lost
    // after the transaction committed, and a gateway can refuse a request no file is to blame for.
    const recordedNow = await appliedVersions(api).catch(() => undefined);
    if (recordedNow === undefined) {
      fail(
        `The request failed (${reasonOf(error)}) and the project's migration history could not ` +
          "be read afterwards, so it is not known whether anything was applied. Run " +
          "`npm run db:push:api -- --dry-run` to see what the project records.",
      );
    }
    const verdict = classifyApplyFailure(status, pendingVersions, recordedNow ?? []);
    if (verdict.outcome === "applied") {
      console.log(
        `\nThe request reported a failure (${reasonOf(error)}), but the project records all ` +
          `${plan.pending.length} migration(s) as applied: the reply was lost, the work was not.\n`,
      );
      return;
    }
    if (verdict.outcome === "partial") {
      fail(
        `The request failed (${reasonOf(error)}) and the project records only some of the ` +
          `pending migrations: ${verdict.recorded.join(", ")}. One transaction cannot do that, so ` +
          "the history was changed by something else at the same time. Compare " +
          "`npm run db:push:api -- --dry-run` with the database before applying more.",
      );
    }
    if (verdict.outcome === "sql_error") {
      const failure = await locateFailure(api, plan.pending, !hasHistory).catch(() => null);
      fail(
        "Nothing was applied: the whole deployment was rolled back.\n" +
          (failure ? `${failure.file} failed:\n${failure.reason}` : reasonOf(error)) +
          "\nFix the file and run the command again.",
      );
    }
    fail(
      `The request did not go through (${status === null ? "no reply" : `HTTP ${status}`}: ${reasonOf(error)}). ` +
        "No migration file is at fault, and none of the pending migrations is recorded as applied." +
        (verdict.tooLarge
          ? "\nThe request was too large to send as one: run `npm run db:push:api -- --per-file`."
          : verdict.mayStillFinish
            ? "\nThe database may still be working on them. Wait a minute, then run " +
              "`npm run db:push:api -- --dry-run`: if they are still pending, run the command again."
            : "\nRun the command again."),
    );
  }
  console.log(`\nApplied ${plan.pending.length} migration(s).\n`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
