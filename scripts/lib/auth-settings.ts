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
  /** Lifetime of one-time email links in seconds, as declared in supabase/config.toml. */
  linkLifetimeSeconds: number;
  /** Digits of the one-time code behind every email link, as declared in supabase/config.toml. */
  oneTimeCodeLength: number;
  templates: Record<EmailTemplateName, EmailTemplate>;
}

/** The placeholder the Auth server replaces with the project's Site URL setting. */
const SITE_URL_PLACEHOLDER = /\{\{\s*\.SiteURL\s*\}\}/g;

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
  if (
    !Number.isInteger(input.oneTimeCodeLength) ||
    input.oneTimeCodeLength < 8 ||
    input.oneTimeCodeLength > 10
  ) {
    throw new Error(
      "The one-time code length (otp_length under [auth.email] in supabase/config.toml) must be 8 to 10 digits.",
    );
  }
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
    // Invitations and workspace grants are addressed to an email address, so an account's
    // address has to be one its holder can receive mail at: addresses are confirmed, and a
    // change of address is confirmed from both the old and the new one.
    mailer_autoconfirm: false,
    mailer_secure_email_change_enabled: true,
    // A session alone must not be enough to replace a password. One-time links (invitation,
    // reset) are exempt on the Auth server, which is what lets them set a password at all.
    security_update_password_require_current_password: true,
    // Long enough for an invitation to be opened the next day; the Auth server's own limit.
    mailer_otp_exp: input.linkLifetimeSeconds,
    // The secret in every emailed link is a hash of the address and this numeric code, and the
    // code alone is accepted as well. Anyone can request a reset for an address they know and
    // then guess it: six digits are a million possibilities, and the Auth server allows each
    // network address thousands of guesses a day. Ten digits is the most it supports.
    mailer_otp_length: input.oneTimeCodeLength,
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
    // The address is written into the email itself. The project's Site URL setting can be
    // rewritten behind the app's back (a hosting integration does so on every deployment), and
    // every link would silently follow it.
    settings[`mailer_templates_${name}_content`] = template.content.replace(
      SITE_URL_PLACEHOLDER,
      site,
    );
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
  linkLifetimeSeconds: number;
  oneTimeCodeLength: number;
  templates: Record<string, { subject: string; contentPath: string }>;
} {
  const length = /^minimum_password_length\s*=\s*(\d+)\s*$/m.exec(configToml);
  if (!length) throw new Error("supabase/config.toml does not declare minimum_password_length.");
  // Both values live under [auth.email]; [auth.sms] has an otp_length of its own.
  const email = /^\[auth\.email\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(configToml)?.[1] ?? "";
  const lifetime = /^otp_expiry\s*=\s*(\d+)\s*$/m.exec(email);
  if (!lifetime) throw new Error("supabase/config.toml does not declare [auth.email] otp_expiry.");
  const codeLength = /^otp_length\s*=\s*(\d+)\s*$/m.exec(email);
  if (!codeLength)
    throw new Error("supabase/config.toml does not declare [auth.email] otp_length.");
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
  return {
    minimumPasswordLength: Number(length[1]),
    linkLifetimeSeconds: Number(lifetime[1]),
    oneTimeCodeLength: Number(codeLength[1]),
    templates,
  };
}
