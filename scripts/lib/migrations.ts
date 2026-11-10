// Pure helpers for applying migrations through the Supabase Management API (see
// scripts/apply-migrations.ts). The bookkeeping matches what `supabase db push` writes, so the
// CLI and this path can be used on the same project interchangeably.

export interface LocalMigration {
  /** 14-digit timestamp prefix of the file name. */
  version: string;
  /** The rest of the file name, without the extension. */
  name: string;
  file: string;
  sql: string;
}

export interface MigrationPlan {
  /** Local migrations that are not recorded on the project yet, in order. */
  pending: LocalMigration[];
  /** Versions recorded on the project that have no local file: the histories have diverged. */
  unknownRemote: string[];
  /** Pending migrations older than the newest one already applied. */
  outOfOrder: LocalMigration[];
}

/** DDL for the history table, identical to the one the Supabase CLI creates. */
export const HISTORY_TABLE_SQL = [
  "create schema if not exists supabase_migrations;",
  "create table if not exists supabase_migrations.schema_migrations (",
  "  version text not null primary key,",
  "  statements text[],",
  "  name text",
  ");",
].join("\n");

export function parseMigrationFileName(file: string): { version: string; name: string } | null {
  const match = /^(\d{14})_(.+)\.sql$/.exec(file);
  return match ? { version: match[1]!, name: match[2]! } : null;
}

export function planMigrations(local: LocalMigration[], applied: string[]): MigrationPlan {
  const ordered = [...local].sort((a, b) => a.version.localeCompare(b.version));
  const seen = new Set<string>();
  for (const migration of ordered) {
    if (seen.has(migration.version)) {
      throw new Error(`Two migration files share the version ${migration.version}.`);
    }
    seen.add(migration.version);
  }
  const appliedSet = new Set(applied);
  const newestApplied = applied.reduce((max, version) => (version > max ? version : max), "");
  const pending = ordered.filter((migration) => !appliedSet.has(migration.version));
  return {
    pending,
    unknownRemote: applied.filter((version) => !seen.has(version)).sort(),
    outOfOrder: pending.filter((migration) => migration.version < newestApplied),
  };
}

/** A dollar-quote tag that does not occur in `text`, so the text can be embedded verbatim. */
export function dollarTag(text: string): string {
  for (let n = 0; ; n += 1) {
    const tag = n === 0 ? "$lr_migration$" : `$lr_migration_${n}$`;
    if (!text.includes(tag)) return tag;
  }
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * One request that applies a migration and records it. The Management API sends it as a single
 * multi-statement query, which Postgres runs as one transaction: if any statement fails, nothing
 * of the migration is kept and it is not recorded.
 */
export function migrationRequestSql(migration: LocalMigration): string {
  if (!/^\d{14}$/.test(migration.version)) {
    throw new Error(`Invalid migration version "${migration.version}".`);
  }
  const tag = dollarTag(migration.sql);
  return [
    migration.sql,
    ";",
    "insert into supabase_migrations.schema_migrations (version, name, statements)",
    `values (${sqlLiteral(migration.version)}, ${sqlLiteral(migration.name)}, array[${tag}${migration.sql}${tag}]);`,
  ].join("\n");
}

/** What a failed "apply everything" request turned out to mean, judged from the history table. */
export type ApplyFailure =
  /** Every pending migration is recorded after all: the reply was lost, the work was not. */
  | { outcome: "applied" }
  /**
   * Nothing is recorded and the request was answered with a refusal that can be a statement
   * error: look for the file by rehearsing, and blame one only if a rehearsal fails on it.
   */
  | { outcome: "sql_error" }
  /** Nothing is recorded and the request failed for a reason that is in no file. */
  | { outcome: "not_applied"; tooLarge: boolean; mayStillFinish: boolean; credentials: boolean }
  /** Some but not all are recorded. One transaction cannot do this: the history was changed. */
  | { outcome: "partial"; recorded: string[] };

/**
 * Decides what to tell the operator after the single-transaction request failed. The history
 * table is the evidence, read again after the failure. The HTTP status only separates what is
 * clearly not a statement error (no reply, a timeout, a request that is too large or too
 * frequent, a rejected token) from everything else. The Management API answers a statement
 * error with 400 ("Failed to run sql query: ERROR: ..."), checked with `select 1/0`; any other
 * unrecognised status is treated the same way and settled by the rehearsal.
 */
export function classifyApplyFailure(
  status: number | null,
  pendingVersions: string[],
  recordedVersions: string[],
): ApplyFailure {
  const now = new Set(recordedVersions);
  const recorded = pendingVersions.filter((version) => now.has(version));
  if (pendingVersions.length > 0 && recorded.length === pendingVersions.length) {
    return { outcome: "applied" };
  }
  if (recorded.length > 0) return { outcome: "partial", recorded };
  // No reply, or a gateway that gave up waiting: the database may still be running the batch.
  const mayStillFinish = status === null || status === 408 || (status >= 502 && status <= 504);
  const credentials = status === 401 || status === 403;
  const tooLarge = status === 413;
  if (mayStillFinish || credentials || tooLarge || status === 429) {
    return { outcome: "not_applied", tooLarge, mayStillFinish, credentials };
  }
  return { outcome: "sql_error" };
}
