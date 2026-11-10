/**
 * Bootstraps the first owner of a Legiit Recommends installation.
 *
 *   npm run bootstrap:owner -- --email owner@example.com
 *
 * What it does:
 *   1. Grants the email address the right to create one workspace.
 *   2. Makes sure an account exists for it:
 *        - default: sends a Supabase invitation email; the owner sets a password from the link;
 *        - with OWNER_PASSWORD set in the environment: creates the account with that password
 *          (for local development or when no email delivery is configured).
 *   3. The owner signs in and names the workspace. Pass --workspace "Name" to create it now
 *      instead (only possible once the account exists).
 *
 * It creates no campaigns, prompts or other data, and it is safe to run again.
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY. SITE_URL sets where the invitation link lands.
 */
import { adminClient, describeDbError, env, fail, loadEnvFiles, parseArgs } from "./lib/env";

async function main() {
  loadEnvFiles();
  const args = parseArgs(process.argv.slice(2));
  const email = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  const workspaceName = typeof args.workspace === "string" ? args.workspace.trim() : null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail("Pass the owner's email address: npm run bootstrap:owner -- --email owner@example.com");
  }

  const admin = adminClient();
  const password = env("OWNER_PASSWORD");
  const siteUrl = (env("SITE_URL") ?? env("NEXT_PUBLIC_SITE_URL") ?? "").replace(/\/$/, "");

  // 1. Record the grant first, so the account can name its workspace as soon as it exists.
  const first = await admin.rpc("svc_bootstrap_owner", { p_email: email, p_workspace_name: null });
  if (first.error) fail(describeDbError(first.error));
  let state = first.data as { user_id: string | null; workspace_id: string | null };

  // 2. Make sure the account exists.
  let accountNote = "The account already existed; its password was not changed.";
  if (!state.user_id) {
    if (password) {
      if (password.length < 10) fail("OWNER_PASSWORD must be at least 10 characters.");
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) fail(`Could not create the account: ${created.error.message}`);
      accountNote = "Account created with the password from OWNER_PASSWORD.";
    } else {
      const invited = await admin.auth.admin.inviteUserByEmail(
        email,
        siteUrl ? { redirectTo: `${siteUrl}/accept-invite` } : {},
      );
      if (invited.error) {
        fail(
          `Could not send the invitation email: ${invited.error.message}\n` +
            "Check the project's email (SMTP) settings, or set OWNER_PASSWORD to create the account with a password instead.",
        );
      }
      accountNote = `Invitation email sent to ${email}. The owner sets a password from the link in it.`;
    }
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
  console.log(`  Sign in at ${siteUrl || "<your site URL>"}/sign-in\n`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
