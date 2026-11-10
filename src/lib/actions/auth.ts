"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { EmailOtpType } from "@supabase/supabase-js";
import { fail, fromDbError, ok, type ActionResult } from "@/lib/result";
import { safeNextPath } from "@/lib/safe-path";
import { WORKSPACE_COOKIE, getIdentity } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

const MIN_PASSWORD = 10;
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
  await supabase.auth.resetPasswordForEmail(email.data);
  return ok("If an account exists for that address, a reset link is on its way.");
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
  if (!(await getIdentity()))
    return fail("This link has expired. Request a new one.", "unauthorized");
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: checked.password });
  if (error)
    return fail(
      error.message.includes("different")
        ? "Choose a password you have not used before."
        : "The password could not be updated. Request a new link and try again.",
    );
  redirect("/overview");
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
  const { error } = await supabase.auth.updateUser({ password: checked.password });
  if (error) {
    return fail(
      error.message.includes("different")
        ? "Choose a password you have not used before."
        : "The password could not be changed. Try again.",
    );
  }
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
  if (error)
    return fail("The password could not be saved. Ask the workspace owner to invite you again.");
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
