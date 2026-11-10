import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import type { Database } from "./database.types";
import { sessionCookieOptions, supabasePublishableKey, supabaseUrl } from "./env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * It carries the signed-in user's session and nothing more: every query runs under row level
 * security and every write goes through a database function that checks the user's role. The
 * web app never holds a service key.
 *
 * Everything read through it is per-user, live data, so rendering always waits for the request
 * (`connection()`): nothing that depends on a session is ever prerendered or cached.
 */
export async function createClient() {
  await connection();
  const cookieStore = await cookies();
  return createServerClient<Database>(supabaseUrl(), supabasePublishableKey(), {
    cookieOptions: sessionCookieOptions((await headers()).get("x-forwarded-proto")),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet)
            cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. The proxy refreshes
          // sessions, so this can be ignored.
        }
      },
    },
  });
}

export type ServerClient = Awaited<ReturnType<typeof createClient>>;
