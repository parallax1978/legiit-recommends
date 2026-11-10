// Shared helpers for the operator scripts. These scripts hold the Supabase secret key and are
// meant to be run from a trusted machine or CI job — never from the web app.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { projectRef, secretKeyFromApi } from "./management";

/**
 * Loads operator values without overriding variables that are already set.
 *
 * By default it reads .env.operator, .env.local and .env from the repository root (operator
 * secrets live in .env.operator, which Next.js does not read). Set ENV_FILE to read exactly one
 * other file instead, for example a file for the hosted project next to the one that
 * `npm run env:local` writes for the local stack — values from the two are then never mixed.
 */
export function loadEnvFiles(): void {
  const chosen = process.env.ENV_FILE?.trim();
  if (chosen) {
    const path = resolve(process.cwd(), chosen);
    if (!existsSync(path)) fail(`ENV_FILE points at ${chosen}, which does not exist.`);
    process.loadEnvFile(path);
    return;
  }
  for (const name of [".env.operator", ".env.local", ".env"]) {
    const path = resolve(process.cwd(), name);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

export function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function requireEnv(name: string, hint?: string): string {
  const value = env(name);
  if (!value) {
    fail(`Missing environment variable ${name}.${hint ? ` ${hint}` : ""}`);
  }
  return value;
}

export function fail(message: string): never {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}

/** Parses `--name value` and `--flag` arguments. */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[arg.slice(2)] = next;
      i += 1;
    } else {
      out[arg.slice(2)] = true;
    }
  }
  return out;
}

export function supabaseUrl(): string {
  const explicit = env("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL");
  if (explicit) return explicit;
  const ref = env("SUPABASE_PROJECT_REF");
  if (ref) return `https://${ref}.supabase.co`;
  fail(
    "Set SUPABASE_URL (for example https://<project-ref>.supabase.co, or http://127.0.0.1:54321 locally) or SUPABASE_PROJECT_REF.",
  );
}

export function isLocalUrl(url: string): boolean {
  return /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
}

/**
 * Service-role client. The key is read from SUPABASE_SECRET_KEY, or fetched through the
 * Management API when only an access token and project ref are configured. It is never printed.
 */
export async function adminClient(): Promise<SupabaseClient> {
  const url = supabaseUrl();
  let key = env("SUPABASE_SECRET_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key && !isLocalUrl(url) && projectRef()) {
    try {
      key = await secretKeyFromApi();
    } catch (error) {
      fail(
        `Could not read the project's secret key through the Management API: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!key) {
    fail(
      "Set SUPABASE_SECRET_KEY to the project's secret (service role) key (Project Settings → API keys), " +
        "or set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF so it can be read for you.",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function describeDbError(error: {
  message: string;
  details?: string | null;
  hint?: string | null;
}): string {
  return [error.message, error.details, error.hint].filter(Boolean).join(" — ");
}
