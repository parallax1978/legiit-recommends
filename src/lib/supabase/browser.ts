"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { sessionCookieOptions } from "./env";

let client: ReturnType<typeof createBrowserClient<Database>> | null = null;

/** Browser client, used only for realtime subscriptions (authorized by row level security). */
export function getBrowserClient() {
  client ??= createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    // The browser rewrites the session cookie when it refreshes the session: same attributes
    // as the server sets (see sessionCookieOptions in ./env).
    { cookieOptions: sessionCookieOptions(window.location.protocol) },
  );
  return client;
}
