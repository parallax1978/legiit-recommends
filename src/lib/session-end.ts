import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/** The Supabase session cookie, including the numbered parts a long session is split into. */
export const SESSION_COOKIE = /^sb-.+-auth-token(\.\d+)?$/;

/** Where someone whose session has ended is sent. The sign-in page explains why they are there. */
export const SESSION_ENDED_PATH = "/sign-in?ended=1";

/**
 * For a session the Auth server no longer knows: it was signed out elsewhere, or revoked. The
 * browser still holds a token that reads as valid until it expires, so pages keep loading while
 * everything that asks the Auth server is refused, and the sign-in page is closed to someone
 * who still looks signed in. Remove what the browser holds and send the person to sign in.
 *
 * Call it from a server action or a route handler (cookies cannot be changed while rendering),
 * and outside any try block: the redirect is delivered as a thrown error.
 */
export async function leaveEndedSession(): Promise<never> {
  const store = await cookies();
  for (const cookie of store.getAll()) {
    if (SESSION_COOKIE.test(cookie.name)) store.delete(cookie.name);
  }
  redirect(SESSION_ENDED_PATH);
}
