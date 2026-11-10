import { cookies } from "next/headers";
import { WORKSPACE_COOKIE } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

/** The Supabase session cookie, including the numbered parts a long session is split into. */
const SESSION_COOKIE = /^sb-.+-auth-token(\.\d+)?$/;

/**
 * Signs out. It is a plain form POST to a fixed address rather than a server action, for two
 * reasons:
 *   * a server action belongs to one build, so in a tab that was opened before a deployment it
 *     no longer exists and "Sign out" would do nothing;
 *   * the browser then loads /sign-in as a new page, which discards every screen the previous
 *     person had open (a client-side navigation keeps earlier screens in the page, hidden).
 */
export async function POST(request: Request) {
  // The rule Next applies to server actions: a form on another site cannot post here. Like
  // Next, the host is the first entry when several proxies have each added theirs.
  const origin = request.headers.get("origin");
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))
    ?.split(",")[0]
    ?.trim();
  if (origin && host && hostOf(origin) !== host) {
    return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  const cookieStore = await cookies();
  if (error) {
    // The Auth service could not be told (it is down or unreachable) and the client keeps the
    // session in that case. Whoever pressed "Sign out" must still be signed out of this
    // browser, so the cookies that carry the session are removed here.
    console.error("sign_out_failed", error.status ?? 0, error.code ?? error.name);
    for (const cookie of cookieStore.getAll()) {
      if (SESSION_COOKIE.test(cookie.name)) cookieStore.delete(cookie.name);
    }
  }
  cookieStore.delete(WORKSPACE_COOKIE);
  // 303: the browser follows with a GET. Relative, so it is right behind any proxy.
  return new Response(null, {
    status: 303,
    headers: { Location: "/sign-in", "Cache-Control": "no-store" },
  });
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
