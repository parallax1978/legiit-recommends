// The shape every server action returns, so the client can show the outcome consistently.

export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; message: string; code?: string; fieldErrors?: Record<string, string> };

export function ok(message?: string): ActionResult {
  return { ok: true, message };
}

export function okData<T>(data: T, message?: string): ActionResult<T> {
  return { ok: true, data, message };
}

export function fail(
  message: string,
  code?: string,
  fieldErrors?: Record<string, string>,
): { ok: false; message: string; code?: string; fieldErrors?: Record<string, string> } {
  return { ok: false, message, code, fieldErrors };
}

interface DbError {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** Converts an error raised by the database functions into an action result. */
export function fromDbError(error: DbError): {
  ok: false;
  message: string;
  code?: string;
  fieldErrors?: Record<string, string>;
} {
  if (error.code === "42501")
    return fail(error.message || "You do not have permission to do that.", "forbidden");
  if (error.code === "P0001") {
    const code = error.details && /^[a-z_]+$/.test(error.details) ? error.details : "invalid";
    return fail(error.message, code);
  }
  if (error.code === "PGRST301" || error.code === "401")
    return fail("Your session has expired. Sign in again.", "unauthorized");
  // Unexpected database errors are not shown verbatim.
  console.error("database error", error.code, error.message);
  return fail("Something went wrong. Please try again.", "internal_error");
}
