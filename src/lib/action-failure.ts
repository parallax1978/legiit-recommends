// What the interface says when calling a server action throws instead of returning a result.
// Client side only.

import { unstable_isUnrecognizedActionError, unstable_rethrow } from "next/navigation";
import { toast } from "sonner";

export const STALE_PAGE_CODE = "stale_page";

export const STALE_PAGE_TITLE = "This page is out of date";
export const STALE_PAGE_MESSAGE =
  "The app was updated after this page was opened, so that button no longer works here. " +
  "Reload the page and try again. Nothing was changed.";

export interface ActionFailure {
  ok: false;
  message: string;
  code?: string;
}

/** True when the server no longer knows the action: the page comes from an earlier deployment. */
export function isStalePage(error: unknown): boolean {
  return unstable_isUnrecognizedActionError(error);
}

/**
 * Turns an error thrown by a server action call into a result to show. Call it first thing in
 * the catch block.
 *
 * Two things arrive as errors without being failures of the request:
 *   * a redirect (or not-found) raised by the action, which Next has to receive to navigate. It
 *     is thrown on, so no failure message appears next to a successful action;
 *   * an action the server no longer recognizes, which happens to every open tab after a
 *     deployment. Blaming the connection for that sends people to check their network when the
 *     fix is to reload.
 */
export function actionFailure(
  error: unknown,
  fallback = "The request could not be completed. Check your connection and try again.",
): ActionFailure {
  unstable_rethrow(error);
  if (isStalePage(error)) return { ok: false, message: STALE_PAGE_MESSAGE, code: STALE_PAGE_CODE };
  return { ok: false, message: fallback };
}

/** Shows a failed action. An out-of-date page gets a Reload button and stays until used. */
export function toastFailure(result: { message: string; code?: string }): void {
  if (result.code === STALE_PAGE_CODE) {
    toast.error(result.message, {
      duration: Infinity,
      action: { label: "Reload", onClick: () => window.location.reload() },
    });
    return;
  }
  toast.error(result.message);
}
