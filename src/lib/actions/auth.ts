"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, fromDbError, ok, type ActionResult } from "@/lib/result";
import { WORKSPACE_COOKIE, getIdentity } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

const MIN_PASSWORD = 10;

/** Only same-site paths are accepted as a post-login destination. */
function safeNext(value: FormDataEntryValue | null | undefined, fallback = "/overview"): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : fallback;
}

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
  redirect(safeNext(formData.get("next")));
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
