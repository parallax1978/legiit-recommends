import "server-only";
import { supabasePublishableKey, supabaseUrl } from "./supabase/env";
import { createClient } from "./supabase/server";

export type OpsResponse<T = Record<string, unknown>> =
  ({ ok: true } & T) | { ok: false; code: string; message: string };

/**
 * Calls the `ops` Edge Function on behalf of the signed-in user. Only the user's own access
 * token is forwarded; the function verifies it and authorizes the user itself.
 */
export async function invokeOps<T = Record<string, unknown>>(
  action: string,
  input: Record<string, unknown>,
): Promise<OpsResponse<T>> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token)
    return { ok: false, code: "unauthorized", message: "Your session has expired. Sign in again." };

  const base = (process.env.SUPABASE_FUNCTIONS_URL ?? `${supabaseUrl()}/functions/v1`).replace(
    /\/$/,
    "",
  );
  let response: Response;
  try {
    response = await fetch(`${base}/ops`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabasePublishableKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, input }),
      cache: "no-store",
      signal: AbortSignal.timeout(140_000),
    });
  } catch {
    return {
      ok: false,
      code: "unreachable",
      message: "The backend function could not be reached. Try again in a moment.",
    };
  }
  try {
    const body = (await response.json()) as OpsResponse<T>;
    if (typeof body === "object" && body !== null && "ok" in body) return body;
  } catch {
    // fall through
  }
  return {
    ok: false,
    code: "bad_response",
    message: `The backend function returned an unexpected response (${response.status}).`,
  };
}
