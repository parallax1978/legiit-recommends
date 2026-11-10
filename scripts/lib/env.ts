// Shared helpers for the operator scripts. These scripts hold the Supabase secret key and are
// meant to be run from a trusted machine or CI job — never from the web app.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Loads .env.operator, .env.local and .env from the repository root without overriding variables
 * that are already set. Operator secrets live in .env.operator, which Next.js does not read.
 */
export function loadEnvFiles(): void {
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
  return (
    env("SUPABASE_URL") ??
    env("NEXT_PUBLIC_SUPABASE_URL") ??
    fail(
      "Set SUPABASE_URL (for example https://<project-ref>.supabase.co, or http://127.0.0.1:54321 locally).",
    )
  );
}

/** Service-role client. The key is read from the environment and never printed. */
export function adminClient(): SupabaseClient {
  const key =
    env("SUPABASE_SECRET_KEY") ??
    env("SUPABASE_SERVICE_ROLE_KEY") ??
    fail(
      "Set SUPABASE_SECRET_KEY to the project's secret (service role) key. Find it under Project Settings → API keys.",
    );
  return createClient(supabaseUrl(), key, {
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
