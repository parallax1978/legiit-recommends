// Pure helpers for the hosted Auth settings this app depends on (see scripts/configure-auth.ts).
//
// Only the listed fields are ever changed. Everything else on the project (rate limits, MFA,
// SMTP, sessions, the database pooler, storage) is left exactly as it is: supabase/config.toml
// carries local-development defaults that must not be pushed wholesale to a production project.

export interface EmailTemplate {
  subject: string;
  content: string;
}

/**
 * Every email the Auth server can send with a link in it. The app itself only triggers invite
 * and recovery, but the server will also mail a sign-in link to any existing address on
 * request, so none of them may keep a default template (those link to the Auth server with a
 * redirect chosen by whoever asked for the email).
 */
export const EMAIL_TEMPLATES = [
  "invite",
  "recovery",
  "magic_link",
  "confirmation",
  "email_change",
] as const;
export type EmailTemplateName = (typeof EMAIL_TEMPLATES)[number];

export interface AuthSettingsInput {
  siteUrl: string;
  minimumPasswordLength: number;
  templates: Record<EmailTemplateName, EmailTemplate>;
}

/** Field names of the Management API's /config/auth resource. */
export type AuthConfig = Record<string, unknown>;

export function normalizeSiteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`"${value}" is not a URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error("SITE_URL must be the https URL of the deployed web app.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SITE_URL must be an origin without a path, for example https://app.example.");
  }
  return url.origin;
}

/** Entries of a comma-separated redirect allow list. */
export function allowListEntries(value: unknown): string[] {
  return typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

export function desiredAuthSettings(input: AuthSettingsInput): AuthConfig {
  const site = normalizeSiteUrl(input.siteUrl);
  const settings: AuthConfig = {
    // Email links are built from the site URL (see supabase/templates), so it must be the
    // address people can actually open.
    site_url: site,
    // Exactly the web app. A wildcard entry for preview deployments on a shared domain can be
    // matched by a host somebody else registers, and an allowed redirect receives the session
    // of whoever follows a sign-in link.
    uri_allow_list: `${site}/**`,
    // Invite-only: nobody can register themselves. Admin-created and invited accounts still work.
    disable_signup: true,
    external_anonymous_users_enabled: false,
    external_email_enabled: true,
    password_min_length: input.minimumPasswordLength,
  };
  for (const name of EMAIL_TEMPLATES) {
    const template = input.templates[name];
    if (!template.content.includes("{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}")) {
      throw new Error(
        `The ${name} email template must link to {{ .SiteURL }}/auth/confirm with the token hash.`,
      );
    }
    if (/\{\{\s*\.(ConfirmationURL|RedirectTo)\s*\}\}/.test(template.content)) {
      throw new Error(
        `The ${name} email template must not use ConfirmationURL or RedirectTo: they carry a redirect chosen by the requester.`,
      );
    }
    settings[`mailer_subjects_${name}`] = template.subject;
    settings[`mailer_templates_${name}_content`] = template.content;
  }
  return settings;
}

/** The subset of `desired` that differs from what the project has now. */
export function changedSettings(desired: AuthConfig, current: AuthConfig): AuthConfig {
  const changes: AuthConfig = {};
  for (const [key, value] of Object.entries(desired)) {
    if (current[key] !== value) changes[key] = value;
  }
  return changes;
}

/** A printable form of a setting: long bodies are summarised, never dumped. */
export function describeSetting(value: unknown): string {
  if (typeof value === "string" && value.length > 120) return `<${value.length} characters>`;
  return value === undefined ? "(unset)" : JSON.stringify(value);
}

/** Reads the values this app declares in supabase/config.toml without a TOML dependency. */
export function readAuthDeclarations(configToml: string): {
  minimumPasswordLength: number;
  templates: Record<string, { subject: string; contentPath: string }>;
} {
  const length = /^minimum_password_length\s*=\s*(\d+)\s*$/m.exec(configToml);
  if (!length) throw new Error("supabase/config.toml does not declare minimum_password_length.");
  const templates: Record<string, { subject: string; contentPath: string }> = {};
  const section = /^\[auth\.email\.template\.([a-z_]+)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
  for (const match of configToml.matchAll(section)) {
    const body = match[2] ?? "";
    const subject = /^subject\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(body);
    const path = /^content_path\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(body);
    if (subject && path) {
      templates[match[1]!] = { subject: subject[1]!, contentPath: path[1]! };
    }
  }
  return { minimumPasswordLength: Number(length[1]), templates };
}
