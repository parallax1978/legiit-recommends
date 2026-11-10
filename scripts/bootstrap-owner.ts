/**
 * Bootstraps the first owner of a Legiit Recommends installation.
 *
 *   npm run bootstrap:owner -- --email owner@example.com
 *
 * What it does:
 *   1. Grants the email address the right to create one workspace.
 *   2. Makes sure an account exists for it, in one of three ways:
 *        - default: sends a Supabase invitation email; the owner sets a password from the link;
 *        - --link: prints a one-time link instead of sending anything, so no email delivery is
 *          needed. For an account that already has a password the link resets it, which also
 *          makes this the way back in for an owner who is locked out;
 *        - OWNER_PASSWORD set in the environment: creates the account with that password
 *          (local development and automated tests).
 *   3. The owner signs in and names the workspace. Pass --workspace "Name" to create it now
 *      instead (only possible once the account exists).
 *
 * An account that already exists for the address but was never confirmed is not trusted: it
 * may have been registered by someone else while public sign-up was still open on the project.
 * Its password is replaced before anything can confirm it.
 *
 * It creates no campaigns, prompts or other data, and it is safe to run again.
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_ACCESS_TOKEN and
 * SUPABASE_PROJECT_REF). SITE_URL sets where the invitation or one-time link lands.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, describeDbError, env, fail, loadEnvFiles, parseArgs } from "./lib/env";

type Account = { id: string; confirmed: boolean } | null;

async function readAccount(admin: SupabaseClient, userId: string | null): Promise<Account> {
  if (!userId) return null;
  const found = await admin.auth.admin.getUserById(userId);
  if (found.error || !found.data.user) {
    fail(`Could not read the account: ${found.error?.message ?? "not found"}`);
  }
  return { id: userId, confirmed: Boolean(found.data.user.email_confirmed_at) };
}

/** Gives an unconfirmed account a password nobody knows, so an older one cannot be used. */
async function discardPassword(admin: SupabaseClient, account: { id: string }): Promise<void> {
  const replaced = await admin.auth.admin.updateUserById(account.id, {
    password: randomBytes(32).toString("base64url"),
  });
  if (replaced.error) fail(`Could not reset the existing account: ${replaced.error.message}`);
}

/**
 * A single-use link that takes the person to choose a password: an invitation for an account
 * that has never been confirmed, a password reset for one that has.
 */
async function oneTimeLink(
  admin: SupabaseClient,
  email: string,
  account: Account,
  siteUrl: string,
): Promise<{ url: string; kind: "invite" | "recovery" }> {
  const kind = account?.confirmed ? "recovery" : "invite";
  const generated = await admin.auth.admin.generateLink({ type: kind, email });
  const token = generated.data?.properties?.hashed_token;
  if (generated.error || !token) {
    fail(`Could not create the link: ${generated.error?.message ?? "no token was returned"}`);
  }
  const next = kind === "invite" ? "/accept-invite" : "/reset-password";
  // Same shape as the links in supabase/templates: the web app verifies the token on its server.
  return {
    url: `${siteUrl}/auth/confirm?token_hash=${encodeURIComponent(token)}&type=${kind}&next=${next}`,
    kind,
  };
}

async function main() {
  loadEnvFiles();
  const args = parseArgs(process.argv.slice(2));
  const email = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  const workspaceName = typeof args.workspace === "string" ? args.workspace.trim() : null;
  const wantsLink = args.link === true;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail("Pass the owner's email address: npm run bootstrap:owner -- --email owner@example.com");
  }

  const admin = await adminClient();
  const password = env("OWNER_PASSWORD");
  const siteUrl = (env("SITE_URL") ?? env("NEXT_PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");
  if (wantsLink && !siteUrl) fail("--link needs SITE_URL: the link has to point at the web app.");
  if (wantsLink && password) fail("Use either --link or OWNER_PASSWORD, not both.");
  if (password && password.length < 10) fail("OWNER_PASSWORD must be at least 10 characters.");

  // 1. Record the grant first, so the account can name its workspace as soon as it exists.
  const first = await admin.rpc("svc_bootstrap_owner", { p_email: email, p_workspace_name: null });
  if (first.error) fail(describeDbError(first.error));
  let state = first.data as { user_id: string | null; workspace_id: string | null };

  // 2. Make sure the account exists and that only the owner can get into it.
  const account = await readAccount(admin, state.user_id);
  const untrusted = account !== null && !account.confirmed;
  let accountNote: string;
  let link: { url: string; kind: "invite" | "recovery" } | null = null;

  if (wantsLink) {
    if (untrusted) await discardPassword(admin, account);
    link = await oneTimeLink(admin, email, account, siteUrl);
    accountNote =
      link.kind === "invite"
        ? "One-time link created. Opening it lets the owner choose a password."
        : "One-time link created. Opening it lets the owner choose a new password.";
  } else if (password) {
    if (!account) {
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) fail(`Could not create the account: ${created.error.message}`);
      accountNote = "Account created with the password from OWNER_PASSWORD.";
    } else if (untrusted) {
      const updated = await admin.auth.admin.updateUserById(account.id, {
        password,
        email_confirm: true,
      });
      if (updated.error) fail(`Could not update the account: ${updated.error.message}`);
      accountNote =
        "An unconfirmed account already existed for this address. Its password was replaced with OWNER_PASSWORD.";
    } else {
      accountNote =
        "The account already existed; its password was not changed. If you did not create it, " +
        "run the command again with --link: opening that link replaces the password.";
    }
  } else if (!account || untrusted) {
    if (untrusted) await discardPassword(admin, account);
    const invited = await admin.auth.admin.inviteUserByEmail(
      email,
      siteUrl ? { redirectTo: `${siteUrl}/accept-invite` } : {},
    );
    if (invited.error) {
      fail(
        `Could not send the invitation email: ${invited.error.message}\n` +
          "Supabase's built-in email sender only delivers to members of the project's organization. " +
          "Configure SMTP for the project, or run the command again with --link to get a one-time link instead.",
      );
    }
    accountNote = `Invitation email sent to ${email}. The owner sets a password from the link in it.`;
  } else {
    accountNote =
      "The account already existed; its password was not changed. If you did not create it, " +
      "run the command again with --link: opening that link replaces the password.";
  }

  // 3. Optionally create the workspace now.
  const second = await admin.rpc("svc_bootstrap_owner", {
    p_email: email,
    p_workspace_name: workspaceName,
  });
  if (second.error) fail(describeDbError(second.error));
  state = second.data as { user_id: string | null; workspace_id: string | null };

  console.log(`\nOwner bootstrap for ${email}`);
  console.log(`  ${accountNote}`);
  if (state.workspace_id) {
    console.log(`  Workspace ready${workspaceName ? ` ("${workspaceName}")` : ""}.`);
  } else {
    console.log("  The owner names the workspace on first sign-in.");
  }
  if (link) {
    console.log(
      "\n  Open this link in a browser, or give it to the owner over a private channel. It works",
    );
    console.log(
      "  once and expires after the project's email link lifetime (one hour unless changed):\n",
    );
    console.log(`  ${link.url}\n`);
  } else {
    console.log(`  Sign in at ${siteUrl || "<your site URL>"}/sign-in\n`);
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
