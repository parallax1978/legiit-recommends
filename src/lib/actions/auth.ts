"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { EmailOtpType } from "@supabase/supabase-js";
import { fail, fromDbError, ok, type ActionResult } from "@/lib/result";
import { safeNextPath } from "@/lib/safe-path";
import { WORKSPACE_COOKIE, getIdentity, signedInWithPassword } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

const MIN_PASSWORD = 10;
// The Auth server hashes with bcrypt, which reads no more than 72 bytes.
const MAX_PASSWORD = 72;
const LINK_TYPES: readonly string[] = [
  "invite",
  "recovery",
  "email",
  "magiclink",
  "email_change",
  "signup",
];
const LINK_INVALID = "That link is invalid or has expired. Request a new one.";

const credentials = z.object({
  email: z.email("Enter a valid email address.").transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1, "Enter your password."),
});

export async function signIn(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return fail(
      "Check the highlighted fields.",
      "invalid",
      Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
    );
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // One message for every failure: never reveal whether an account exists.
    return fail("That email and password do not match an account.", "invalid_credentials");
  }
  redirect(safeNextPath(formData.get("next"), "/overview"));
}

/**
 * Completes a one-time email link (invitation, password reset, sign-in link). It runs when the
 * person presses the button on /auth/confirm, never when the link is merely opened: mail
 * scanners and chat previews fetch links, and a link that signed people in on a plain GET
 * would be used up before its owner ever clicked it.
 */
export async function confirmEmailLink(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const tokenHash = String(formData.get("token_hash") ?? "");
  const type = String(formData.get("type") ?? "");
  if (!tokenHash || !LINK_TYPES.includes(type)) return fail(LINK_INVALID, "link_invalid");
  const fallback =
    type === "invite" ? "/accept-invite" : type === "recovery" ? "/reset-password" : "/overview";
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    type: type as EmailOtpType,
    token_hash: tokenHash,
  });
  if (error) return fail(LINK_INVALID, "link_invalid");
  redirect(safeNextPath(formData.get("next"), fallback));
}

export async function requestPasswordReset(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const email = z.email().safeParse(
    String(formData.get("email") ?? "")
      .trim()
      .toLowerCase(),
  );
  if (!email.success)
    return fail("Enter a valid email address.", "invalid", {
      email: "Enter a valid email address.",
    });
  const supabase = await createClient();
  // The recovery email links to /auth/confirm with a one-time token (see supabase/templates).
  const { error } = await supabase.auth.resetPasswordForEmail(email.data);
  if (error) {
    // Logged for the operator only. The reply stays the same whatever happened, so it cannot
    // be used to learn which addresses have an account.
    console.error(JSON.stringify({ event: "password_reset_email_failed", code: error.code }));
  }
  // The built-in email sender only delivers to a few addresses and a few times an hour, so
  // "on its way" would often be untrue. Say what to do when nothing arrives.
  return ok(
    "If an account exists for that address, a reset link has been requested. If nothing arrives within a few minutes, email delivery is not set up for it: ask whoever operates this installation for a one-time sign-in link.",
  );
}

function validatePassword(formData: FormData): { password: string } | { error: ActionResult } {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < MIN_PASSWORD) {
    return {
      error: fail(`Use at least ${MIN_PASSWORD} characters.`, "invalid", {
        password: `Use at least ${MIN_PASSWORD} characters.`,
      }),
    };
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD) {
    return {
      error: fail(`Use at most ${MAX_PASSWORD} characters.`, "invalid", {
        password: `Use at most ${MAX_PASSWORD} characters.`,
      }),
    };
  }
  if (password !== confirm) {
    return {
      error: fail("The two passwords do not match.", "invalid", {
        confirm: "The two passwords do not match.",
      }),
    };
  }
  return { password };
}

export async function updatePassword(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const checked = validatePassword(formData);
  if ("error" in checked) return checked.error;
  const identity = await getIdentity();
  if (!identity) return fail("This link has expired. Request a new one.", "unauthorized");
  // This form is for people who arrived through a one-time link. Someone who signed in with
  // a password has to give it again, which the form in Settings asks for.
  if (signedInWithPassword(identity)) {
    return fail(
      "To change your password while signed in, use Settings → Your account.",
      "current_password_required",
    );
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: checked.password });
  if (error) return fail(passwordProblem(error, "Request a new link and try again."));
  redirect("/overview");
}

/** Says what is wrong with a password the Auth server refused, when it is the password. */
function passwordProblem(error: { code?: string; message: string }, otherwise: string): string {
  if (error.code === "weak_password") return error.message;
  if (error.code === "same_password" || error.message.includes("different")) {
    return "Choose a password you have not used before.";
  }
  return `The password could not be saved. ${otherwise}`;
}

/**
 * Changes the password of the signed-in user without any email round trip. A session alone is
 * not enough: the current password is checked first, so an unattended browser cannot be used
 * to take over the account.
 */
export async function changePassword(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const current = String(formData.get("current_password") ?? "");
  if (!current) {
    return fail("Enter your current password.", "invalid", {
      current_password: "Enter your current password.",
    });
  }
  const checked = validatePassword(formData);
  if ("error" in checked) return checked.error;
  if (checked.password === current) {
    return fail("Choose a password that differs from the current one.", "invalid", {
      password: "Choose a password that differs from the current one.",
    });
  }
  const identity = await getIdentity();
  if (!identity?.email) return fail("Sign in again to change your password.", "unauthorized");

  const supabase = await createClient();
  const verified = await supabase.auth.signInWithPassword({
    email: identity.email,
    password: current,
  });
  if (verified.error) {
    if (verified.error.status === 429)
      return fail("Too many attempts. Wait a minute and try again.", "rate_limited");
    return fail("Your current password is not correct.", "invalid", {
      current_password: "Your current password is not correct.",
    });
  }
  // The current password travels with the change, so the Auth server can insist on it too.
  const { error } = await supabase.auth.updateUser({
    password: checked.password,
    current_password: current,
  });
  if (error) return fail(passwordProblem(error, "Try again."));
  return ok("Password changed.");
}

export async function acceptInvite(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const checked = validatePassword(formData);
  if ("error" in checked) return checked.error;
  if (!(await getIdentity()))
    return fail(
      "This invitation link has expired. Ask the workspace owner to invite you again.",
      "unauthorized",
    );
  const supabase = await createClient();
  const name = String(formData.get("display_name") ?? "").trim();
  const { error } = await supabase.auth.updateUser({ password: checked.password });
  if (error) {
    return fail(passwordProblem(error, "Ask the workspace owner to invite you again."));
  }
  if (name) await supabase.rpc("update_profile", { p_display_name: name });
  const accepted = await supabase.rpc("accept_pending_invitations");
  if (accepted.error) return fromDbError(accepted.error);
  redirect("/overview");
}

export async function joinInvitedWorkspaces(): Promise<ActionResult> {
  const supabase = await createClient();
  const accepted = await supabase.rpc("accept_pending_invitations");
  if (accepted.error) return fromDbError(accepted.error);
  redirect("/overview");
}

export async function completeSetup(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const name = String(formData.get("workspace_name") ?? "").trim();
  if (name.length < 1 || name.length > 80) {
    return fail("Enter a workspace name.", "invalid", {
      workspace_name: "Enter a name between 1 and 80 characters.",
    });
  }
  const supabase = await createClient();
  const created = await supabase.rpc("complete_owner_setup", { p_workspace_name: name });
  if (created.error) return fromDbError(created.error);
  redirect("/overview");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  (await cookies()).delete(WORKSPACE_COOKIE);
  redirect("/sign-in");
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  // Only stores a preference. Access is decided by membership on every request.
  (await cookies()).set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect("/overview");
}
