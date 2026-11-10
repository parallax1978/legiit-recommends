// Guards for the live smoke test. Pure, so they are tested without sending anything.
//
// The smoke test is the evidence that the application works against the real OpenAI API. That
// only holds if it cannot be pointed anywhere else and if its spending cap cannot be switched
// off by a price that makes every request look free.

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * The OpenAI SDK reads OPENAI_BASE_URL from the environment. A run redirected to a gateway or
 * to the test double would still print "passed", so the smoke test refuses to start instead.
 */
export function endpointOverrideProblem(value: string | undefined): string | null {
  if (!value || value.trim() === "") return null;
  if (value.trim().replace(/\/+$/, "") === OPENAI_API_BASE_URL) return null;
  return (
    `OPENAI_BASE_URL is set, and not to ${OPENAI_API_BASE_URL}. The live smoke test only talks to ` +
    "OpenAI itself: a run against another endpoint proves nothing about the live integration. " +
    "Unset OPENAI_BASE_URL and run it again."
  );
}

/** A price the spending cap can be computed from: a finite number above zero. */
export function positivePrice(label: string, raw: unknown): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${label} must be a number above zero (US dollars per million tokens). With a zero or ` +
        "negative price every request would look free and the spending cap would never stop the run.",
    );
  }
  return value;
}
