/**
 * Sets the hosted Auth settings this app depends on, and nothing else.
 *
 *   npm run auth:configure               apply
 *   npm run auth:configure -- --check    only report what differs (exit code 2 if anything does)
 *
 * What it sets:
 *   - Site URL = SITE_URL. Invitation and password-reset links are built from it, so it must be
 *     the address people can open — not a preview alias behind a login wall.
 *   - Redirect allow list = SITE_URL/** and nothing else. Entries added by a hosting
 *     integration for preview deployments are removed: the app never redirects to them, and a
 *     wildcard on a shared domain can be matched by a host somebody else registers.
 *   - Sign-ups disabled and anonymous sign-ins off: access is by invitation only.
 *   - Minimum password length, as declared in supabase/config.toml.
 *   - Every email template that carries a link (invite, recovery, sign-in link, confirmation,
 *     email change), from supabase/templates. All of them link to the web app, never to the
 *     Auth server with a redirect chosen by whoever requested the email.
 *
 * It deliberately does not push supabase/config.toml as a whole: that file carries local
 * development defaults (email throttling, MFA, pooler and storage settings) that would change a
 * production project in ways nobody asked for.
 *
 * Requires SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF and SITE_URL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMAIL_TEMPLATES,
  allowListEntries,
  changedSettings,
  describeSetting,
  desiredAuthSettings,
  readAuthDeclarations,
  type AuthConfig,
  type EmailTemplate,
  type EmailTemplateName,
} from "./lib/auth-settings";
import { fail, loadEnvFiles, parseArgs, requireEnv } from "./lib/env";
import { managementClient } from "./lib/management";

async function main() {
  loadEnvFiles();
  const args = parseArgs(process.argv.slice(2));
  const checkOnly = args.check === true;
  const siteUrl = requireEnv("SITE_URL", "Use the public https URL of the deployed web app.");

  const declared = readAuthDeclarations(
    readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8"),
  );
  const templates = {} as Record<EmailTemplateName, EmailTemplate>;
  for (const name of EMAIL_TEMPLATES) {
    const entry = declared.templates[name];
    if (!entry) fail(`supabase/config.toml does not declare the ${name} email template.`);
    templates[name] = {
      subject: entry.subject,
      content: readFileSync(resolve(process.cwd(), entry.contentPath), "utf8"),
    };
  }

  const api = managementClient();
  const current = await api.request<AuthConfig>("GET", "/config/auth");
  let desired: AuthConfig;
  try {
    desired = desiredAuthSettings({
      siteUrl,
      minimumPasswordLength: declared.minimumPasswordLength,
      templates,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const changes = changedSettings(desired, current);
  const names = Object.keys(changes);
  console.log(`\nAuth settings of project ${api.ref}:`);
  if (names.length === 0) {
    console.log("  Already as required. Nothing to change.\n");
    return;
  }
  for (const name of names) {
    console.log(`  ${name}: ${describeSetting(current[name])} → ${describeSetting(changes[name])}`);
  }
  if ("uri_allow_list" in changes) {
    const kept = new Set(allowListEntries(desired.uri_allow_list));
    const removed = allowListEntries(current.uri_allow_list).filter((entry) => !kept.has(entry));
    for (const entry of removed) console.log(`    removes redirect allow-list entry: ${entry}`);
  }
  if (checkOnly) {
    console.log(`\n${names.length} setting(s) differ. Run without --check to apply.\n`);
    process.exit(2);
  }

  await api.request("PATCH", "/config/auth", changes);
  const after = await api.request<AuthConfig>("GET", "/config/auth");
  const remaining = Object.keys(changedSettings(desired, after));
  if (remaining.length > 0) {
    fail(`The project did not accept these settings: ${remaining.join(", ")}.`);
  }
  console.log(`\nApplied ${names.length} setting(s).\n`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
