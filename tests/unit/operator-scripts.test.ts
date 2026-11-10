import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMAIL_TEMPLATES,
  allowListEntries,
  changedSettings,
  describeSetting,
  desiredAuthSettings,
  normalizeSiteUrl,
  readAuthDeclarations,
  type AuthSettingsInput,
} from "../../scripts/lib/auth-settings";
import {
  dollarTag,
  migrationRequestSql,
  parseMigrationFileName,
  planMigrations,
  sqlLiteral,
  type LocalMigration,
} from "../../scripts/lib/migrations";

const migration = (version: string, name = "change", sql = "select 1;"): LocalMigration => ({
  version,
  name,
  file: `${version}_${name}.sql`,
  sql,
});

describe("migration planning (Management API path)", () => {
  it("parses migration file names and rejects anything else", () => {
    expect(parseMigrationFileName("20261110070000_foundations.sql")).toEqual({
      version: "20261110070000",
      name: "foundations",
    });
    expect(parseMigrationFileName("2026_foundations.sql")).toBeNull();
    expect(parseMigrationFileName("20261110070000_foundations.txt")).toBeNull();
    expect(parseMigrationFileName("seed.sql")).toBeNull();
  });

  it("applies only what the project does not have yet, in version order", () => {
    const local = [
      migration("20260103000000"),
      migration("20260101000000"),
      migration("20260102000000"),
    ];
    const plan = planMigrations(local, ["20260101000000"]);
    expect(plan.pending.map((m) => m.version)).toEqual(["20260102000000", "20260103000000"]);
    expect(plan.unknownRemote).toEqual([]);
    expect(plan.outOfOrder).toEqual([]);
  });

  it("reports nothing pending when the histories match", () => {
    const plan = planMigrations([migration("20260101000000")], ["20260101000000"]);
    expect(plan.pending).toEqual([]);
  });

  it("flags migrations on the project that this checkout does not know", () => {
    const plan = planMigrations(
      [migration("20260101000000")],
      ["20260101000000", "20260105000000"],
    );
    expect(plan.unknownRemote).toEqual(["20260105000000"]);
  });

  it("flags a pending migration that is older than one already applied", () => {
    const plan = planMigrations(
      [migration("20260101000000"), migration("20260102000000"), migration("20260103000000")],
      ["20260101000000", "20260103000000"],
    );
    expect(plan.pending.map((m) => m.version)).toEqual(["20260102000000"]);
    expect(plan.outOfOrder.map((m) => m.version)).toEqual(["20260102000000"]);
  });

  it("refuses two files with the same version", () => {
    expect(() =>
      planMigrations([migration("20260101000000", "a"), migration("20260101000000", "b")], []),
    ).toThrow(/share the version/);
  });

  it("embeds the migration text verbatim with a dollar tag the text does not contain", () => {
    expect(dollarTag("select 1;")).toBe("$lr_migration$");
    const tricky =
      "select $lr_migration$ nested $lr_migration$, $lr_migration_1$x$lr_migration_1$;";
    const tag = dollarTag(tricky);
    expect(tricky.includes(tag)).toBe(false);

    const body = "create function f() returns text language sql as $$ select 'it''s' $$;";
    const sql = migrationRequestSql(migration("20260101000000", "o'brien", body));
    // The migration runs first, then its history record, all in one request.
    expect(sql.startsWith(body)).toBe(true);
    expect(sql).toContain(
      "insert into supabase_migrations.schema_migrations (version, name, statements)",
    );
    expect(sql).toContain(
      "values ('20260101000000', 'o''brien', array[$lr_migration$" + body + "$lr_migration$]);",
    );
  });

  it("rejects a malformed version instead of interpolating it", () => {
    expect(() => migrationRequestSql(migration("2026'; drop"))).toThrow(
      /Invalid migration version/,
    );
    expect(sqlLiteral("a'b")).toBe("'a''b'");
  });
});

describe("hosted Auth settings", () => {
  const link = (type: string) =>
    `<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}">open</a>`;
  const input: AuthSettingsInput = {
    siteUrl: "https://app.example/",
    minimumPasswordLength: 10,
    linkLifetimeSeconds: 86_400,
    templates: {
      invite: { subject: "Invite", content: link("invite") },
      recovery: { subject: "Reset", content: link("recovery") },
      magic_link: { subject: "Sign in", content: link("magiclink") },
      confirmation: { subject: "Confirm", content: link("signup") },
      email_change: { subject: "Change", content: link("email_change") },
    },
  };

  it("accepts only an https origin as the site URL", () => {
    expect(normalizeSiteUrl("https://app.example/")).toBe("https://app.example");
    expect(normalizeSiteUrl(" https://app.example ")).toBe("https://app.example");
    expect(() => normalizeSiteUrl("http://app.example")).toThrow(/https/);
    expect(() => normalizeSiteUrl("https://app.example/path")).toThrow(/origin/);
    expect(() => normalizeSiteUrl("not a url")).toThrow(/not a URL/);
  });

  it("makes the project invite-only and points every email link at the site", () => {
    const desired = desiredAuthSettings(input);
    expect(desired).toMatchObject({
      site_url: "https://app.example",
      disable_signup: true,
      external_anonymous_users_enabled: false,
      external_email_enabled: true,
      password_min_length: 10,
      mailer_subjects_invite: "Invite",
      mailer_subjects_recovery: "Reset",
      mailer_subjects_magic_link: "Sign in",
      mailer_autoconfirm: false,
      mailer_secure_email_change_enabled: true,
      security_update_password_require_current_password: true,
      mailer_otp_exp: 86_400,
    });
    // The web app's address is written into every email, so links do not follow the project's
    // Site URL setting if something rewrites it.
    expect(desired.mailer_templates_magic_link_content).toBe(
      '<a href="https://app.example/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink">open</a>',
    );
    for (const name of EMAIL_TEMPLATES) {
      expect(String(desired[`mailer_templates_${name}_content`])).not.toContain("SiteURL");
    }
    // Nothing outside the fields the app depends on is ever sent.
    expect(Object.keys(desired).sort()).toEqual(
      [
        "disable_signup",
        "external_anonymous_users_enabled",
        "external_email_enabled",
        "mailer_autoconfirm",
        "mailer_otp_exp",
        "mailer_secure_email_change_enabled",
        "password_min_length",
        "security_update_password_require_current_password",
        "site_url",
        "uri_allow_list",
        ...EMAIL_TEMPLATES.flatMap((name) => [
          `mailer_subjects_${name}`,
          `mailer_templates_${name}_content`,
        ]),
      ].sort(),
    );
  });

  it("allows redirects to the web app only, dropping wildcard entries for other hosts", () => {
    const desired = desiredAuthSettings(input);
    expect(desired.uri_allow_list).toBe("https://app.example/**");
    const current = {
      uri_allow_list:
        "https://app-team.vercel.app/**, https://app-*-team.vercel.app/**,https://app.example/**",
    };
    // The list on the project differs, so it is replaced rather than extended.
    expect(changedSettings(desired, current).uri_allow_list).toBe("https://app.example/**");
    expect(allowListEntries(current.uri_allow_list)).toEqual([
      "https://app-team.vercel.app/**",
      "https://app-*-team.vercel.app/**",
      "https://app.example/**",
    ]);
    expect(allowListEntries(null)).toEqual([]);
  });

  it("refuses an email template that would mail a link with a caller-chosen redirect", () => {
    const withTemplate = (content: string): AuthSettingsInput => ({
      ...input,
      templates: { ...input.templates, magic_link: { subject: "Sign in", content } },
    });
    expect(() =>
      desiredAuthSettings(withTemplate('<a href="{{ .ConfirmationURL }}">open</a>')),
    ).toThrow(/magic_link email template must link to/);
    expect(() =>
      desiredAuthSettings(withTemplate(`${link("magiclink")} <a href="{{ .RedirectTo }}">x</a>`)),
    ).toThrow(/must not use ConfirmationURL or RedirectTo/);
  });

  it("sends only what differs, and nothing when the project is already right", () => {
    const current = { disable_signup: false, password_min_length: 6, smtp_max_frequency: 60 };
    const desired = desiredAuthSettings(input);
    const changes = changedSettings(desired, current);
    expect(changes.disable_signup).toBe(true);
    expect(changes.password_min_length).toBe(10);
    expect("smtp_max_frequency" in changes).toBe(false);
    expect(changedSettings(desired, { ...current, ...desired })).toEqual({});
  });

  it("summarises long values instead of printing them", () => {
    expect(describeSetting("x".repeat(500))).toBe("<500 characters>");
    expect(describeSetting(true)).toBe("true");
    expect(describeSetting(undefined)).toBe("(unset)");
  });

  it("the repository declares every email template, each linking through the web app", () => {
    const declared = readAuthDeclarations(readFileSync("supabase/config.toml", "utf8"));
    expect(declared.minimumPasswordLength).toBe(10);
    expect(declared.linkLifetimeSeconds).toBe(86_400);
    expect(Object.keys(declared.templates).sort()).toEqual([...EMAIL_TEMPLATES].sort());
    expect(declared.templates.invite).toEqual({
      subject: "You have been invited to Legiit Recommends",
      contentPath: "./supabase/templates/invite.html",
    });
    const templates = Object.fromEntries(
      EMAIL_TEMPLATES.map((name) => [
        name,
        {
          subject: declared.templates[name]!.subject,
          content: readFileSync(declared.templates[name]!.contentPath, "utf8"),
        },
      ]),
    ) as AuthSettingsInput["templates"];
    // Throws if any template lacks the first-party link or carries a requester-chosen redirect.
    const desired = desiredAuthSettings({
      siteUrl: "https://app.example",
      minimumPasswordLength: declared.minimumPasswordLength,
      linkLifetimeSeconds: declared.linkLifetimeSeconds,
      templates,
    });
    expect(String(desired.mailer_templates_recovery_content)).toContain(
      "https://app.example/auth/confirm?token_hash={{ .TokenHash }}&type=recovery",
    );
  });
});
