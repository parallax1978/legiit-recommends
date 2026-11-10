// Deno-only helpers shared by the Edge Functions.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

export function env(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** The secret (service) key: new-style key set when present, legacy service_role key otherwise. */
export function serviceKey(): string {
  const keys = env("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys) as Record<string, string>;
      const key = parsed.default ?? Object.values(parsed)[0];
      if (key) return key;
    } catch {
      // fall through to the legacy key
    }
  }
  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

// deno-lint-ignore no-explicit-any
export type AdminClient = SupabaseClient<any, any, any>;

/** Service-role client. Never handed to callers and never used with a user's token. */
export function adminClient(): AdminClient {
  return createClient(requireEnv("SUPABASE_URL"), serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Constant-time comparison of two secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Keeps the worker alive after the response has been sent, where the runtime supports it. */
export function runInBackground(work: Promise<unknown>): boolean {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(work);
    return true;
  }
  return false;
}

/**
 * Base URL for the provider. Unset in production (the SDK default, api.openai.com, is used).
 * Tests point it at the local deterministic provider double.
 */
export function providerBaseUrl(): string | undefined {
  return env("OPENAI_BASE_URL");
}
