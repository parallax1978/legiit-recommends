import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SIGN_OUT_PATH } from "@/lib/sign-out";
import { sessionCookieOptions, supabasePublishableKey, supabaseUrl } from "./env";

// Reachable without a session. Signing out is among them so that it also works for a session
// that has just expired: the handler then only clears cookies and sends the browser to sign-in.
const PUBLIC_PATHS = ["/sign-in", "/forgot-password", "/auth/confirm", SIGN_OUT_PATH];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Refreshes the session cookie and performs the optimistic route check. This is a convenience
 * redirect only: data access is protected independently by row level security and by the role
 * checks inside every database function.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Signing out is left entirely to its handler. If the session were refreshed here first, this
  // response would set a fresh session cookie while the handler's removes it, and which of the
  // two the browser kept would depend on the order the hosting platform merges them in.
  if (request.nextUrl.pathname === SIGN_OUT_PATH) return NextResponse.next({ request });

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabasePublishableKey(), {
    cookieOptions: sessionCookieOptions(
      request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol,
    ),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet)
          response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {}))
          response.headers.set(key, value as string);
      },
    },
  });

  // Nothing may run between creating the client and this call: it validates and refreshes tokens.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  if (!signedIn && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  if (signedIn && (pathname === "/sign-in" || pathname === "/forgot-password")) {
    const url = request.nextUrl.clone();
    url.pathname = "/overview";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}
