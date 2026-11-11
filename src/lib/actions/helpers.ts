import "server-only";
import { refresh } from "next/cache";
import { invokeOps, type OpsResponse } from "@/lib/ops";
import { fail, fromDbError, type ActionResult } from "@/lib/result";
import { getIdentity } from "@/lib/session";
import { leaveEndedSession } from "@/lib/session-end";
import { createClient, type ServerClient } from "@/lib/supabase/server";

interface DbResult<T> {
  data: T | null;
  error: { message: string; code?: string; details?: string | null; hint?: string | null } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

export const NOT_SIGNED_IN = fail("Your session has expired. Sign in again.", "unauthorized");

/**
 * Runs one database call for the signed-in user and converts the outcome into an action result.
 * Authorization is not decided here: every database function checks the caller's membership and
 * role itself, so an id supplied by the browser never grants access on its own.
 */
export async function mutate<T>(
  call: (supabase: ServerClient) => PromiseLike<DbResult<T>>,
  options: { success?: string; refresh?: boolean } = {},
): Promise<ActionResult<T>> {
  if (!(await getIdentity())) return NOT_SIGNED_IN;
  const supabase = await createClient();
  const { data, error } = await call(supabase);
  if (error) return fromDbError(error);
  if (options.refresh !== false) refresh();
  return { ok: true, message: options.success, data: (data ?? undefined) as T | undefined };
}

/** Calls the trusted `ops` function (credentials, provider requests, invitations). */
export async function operate<T = Record<string, unknown>>(
  action: string,
  input: Record<string, unknown>,
  options: { success?: string | ((result: T) => string) } = {},
): Promise<ActionResult<T>> {
  if (!(await getIdentity())) return NOT_SIGNED_IN;
  const result: OpsResponse<T> = await invokeOps<T>(action, input);
  // The function checks the session with the Auth server on every call. A token that still
  // reads as valid here can belong to a session that was ended elsewhere: there is nothing to
  // retry, the person has to sign in again.
  if (!result.ok && result.code === "unauthorized") await leaveEndedSession();
  if (!result.ok) return fail(result.message, result.code);
  refresh();
  const message = typeof options.success === "function" ? options.success(result) : options.success;
  return { ok: true, message, data: result as T };
}

export function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** A positive decimal amount, or null for blank. NaN signals invalid input. */
export function amount(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

export function integer(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : Number.NaN;
}
