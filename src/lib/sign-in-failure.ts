// What to tell someone whose sign-in failed. Pure, so the three cases are tested.

export interface SignInFailure {
  message: string;
  code: "invalid_credentials" | "rate_limited" | "unavailable";
  /** Set when the failure says something about the service rather than the credentials. */
  log: string | null;
}

/**
 * None of the three messages depends on whether the account exists. Only a rejection of the
 * credentials themselves says "do not match": telling someone their correct password is wrong
 * while the Auth service is down or rate limiting sends them to a password reset they do not
 * need (and, without email delivery, cannot complete).
 */
export function signInFailure(error: {
  status?: number;
  code?: string;
  name?: string;
}): SignInFailure {
  const status = typeof error.status === "number" ? error.status : 0;
  if (status === 429) {
    return {
      message: "Too many sign-in attempts. Wait a few minutes and try again.",
      code: "rate_limited",
      log: `sign_in_rate_limited ${error.code ?? ""}`.trim(),
    };
  }
  // 400 and 422 are how the Auth server itself turns a sign-in down (wrong password, unknown or
  // unconfirmed address, malformed input). Any other 4xx comes from in front of it, for example
  // a gateway refusing the app's own API key, and says nothing about the person's password.
  if (status === 400 || status === 422) {
    // One message for every rejected sign-in: never reveal whether an account exists.
    return {
      message: "That email and password do not match an account.",
      code: "invalid_credentials",
      log: null,
    };
  }
  // No answer at all (status 0), a server error, or a refusal that is not about this sign-in:
  // the service, not the credentials.
  return {
    message: "Sign-in is temporarily unavailable. Try again in a moment.",
    code: "unavailable",
    log: `sign_in_unavailable ${status} ${error.code ?? error.name ?? ""}`.trim(),
  };
}
