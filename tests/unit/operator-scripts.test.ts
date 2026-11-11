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
  classifyApplyFailure,
  dollarTag,
  migrationRequestSql,
  parseMigrationFileName,
  planMigrations,
  sqlLiteral,
  type LocalMigration,
} from "../../scripts/lib/migrations";
import {
  describeJobs,
  plannerState,
  scheduleProblems,
  type ScheduleStatus,
} from "../../scripts/lib/schedules";
import { REQUIRED_MAX_ROWS, maxRowsProblem } from "../../scripts/lib/data-api";
import { inviteFailureHint } from "../../scripts/lib/invitation";
import { ManagementError, retryRead } from "../../scripts/lib/management";
import {
  OPENAI_API_BASE_URL,
  endpointOverrideProblem,
  positivePrice,
} from "../../scripts/lib/smoke";
import { PAGE_SIZE } from "../../src/lib/batch";

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

  describe("a failed apply is judged from what the project records afterwards", () => {
    const pending = ["20260102000000", "20260103000000"];

    it("looks for a failing file when the request was refused and nothing is recorded", () => {
      // 400 is the Management API's answer to a statement error; an unrecognised status is
      // settled the same way, by rehearsing.
      for (const status of [400, 422, 500]) {
        expect(classifyApplyFailure(status, pending, ["20260101000000"])).toEqual({
          outcome: "sql_error",
        });
      }
    });

    it("reports success when the reply was lost but everything is recorded", () => {
      for (const status of [null, 400, 502, 504]) {
        expect(classifyApplyFailure(status, pending, ["20260101000000", ...pending])).toEqual({
          outcome: "applied",
        });
      }
    });

    it("treats gateway, network and token failures as the request's problem, not a file's", () => {
      const notApplied = {
        outcome: "not_applied",
        tooLarge: false,
        mayStillFinish: false,
        credentials: false,
      };
      expect(classifyApplyFailure(413, pending, [])).toEqual({ ...notApplied, tooLarge: true });
      expect(classifyApplyFailure(429, pending, [])).toEqual(notApplied);
      for (const status of [401, 403]) {
        expect(classifyApplyFailure(status, pending, [])).toEqual({
          ...notApplied,
          credentials: true,
        });
      }
      // A gateway that gave up waiting, or no reply at all: the database may still be working.
      for (const status of [null, 408, 502, 503, 504]) {
        expect(classifyApplyFailure(status, pending, [])).toEqual({
          ...notApplied,
          mayStillFinish: true,
        });
      }
    });

    it("flags a history that changed underneath a single transaction", () => {
      expect(classifyApplyFailure(400, pending, ["20260102000000"])).toEqual({
        outcome: "partial",
        recorded: ["20260102000000"],
      });
    });
  });
});

describe("schedule check", () => {
  const healthy: ScheduleStatus = {
    jobs: [
      { name: "lr-dispatch", present: true, active: true, schedule: "10 seconds" },
      { name: "lr-maintenance", present: true, active: true, schedule: "17 3 * * *" },
      { name: "lr-plan", present: true, active: true, schedule: "* * * * *" },
    ],
    planner: { seconds_since_run: 20, last_error: null },
  };
  const withJob = (name: string, change: Partial<ScheduleStatus["jobs"][number]>) => ({
    ...healthy,
    jobs: healthy.jobs.map((job) => (job.name === name ? { ...job, ...change } : job)),
  });

  it("finds nothing wrong with three active schedules and a recent planner run", () => {
    expect(scheduleProblems(healthy)).toEqual([]);
    expect(plannerState(healthy)).toEqual({ state: "fresh", seconds: 20 });
    expect(describeJobs(healthy)).toBe(
      "lr-dispatch (10 seconds), lr-maintenance (17 3 * * *), lr-plan (* * * * *)",
    );
  });

  it("reports a paused schedule and says a deploy will not resume it", () => {
    const paused = withJob("lr-plan", { active: false });
    const problems = scheduleProblems(paused);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/lr-plan schedule is paused/);
    expect(problems[0]).toMatch(/nothing is planned for launched campaigns/);
    expect(problems[0]).toMatch(/never resumes a paused\s+schedule/);
    expect(describeJobs(paused)).toContain("lr-plan (* * * * *, PAUSED)");
  });

  it("reports a missing schedule and how to put it back", () => {
    const missing = withJob("lr-dispatch", { present: false, active: false, schedule: null });
    const problems = scheduleProblems(missing);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/lr-dispatch schedule does not exist/);
    expect(problems[0]).toMatch(/queued work is not sent to the worker/);
    expect(describeJobs(missing)).toContain("lr-dispatch (MISSING)");
  });

  it("tells a planner that never ran, is stale or keeps failing from a healthy one", () => {
    expect(plannerState({ ...healthy, planner: null })).toEqual({ state: "never" });
    expect(
      plannerState({ ...healthy, planner: { seconds_since_run: null, last_error: null } }),
    ).toEqual({ state: "never" });
    expect(
      plannerState({ ...healthy, planner: { seconds_since_run: 900, last_error: null } }),
    ).toEqual({ state: "stale", seconds: 900 });
    expect(
      plannerState({ ...healthy, planner: { seconds_since_run: 5, last_error: "boom" } }),
    ).toEqual({ state: "failing", error: "boom" });
    // One missed run plus slack is still fresh; the limit is two and a half minutes.
    expect(
      plannerState({ ...healthy, planner: { seconds_since_run: 150, last_error: null } }).state,
    ).toBe("fresh");
    expect(
      plannerState({ ...healthy, planner: { seconds_since_run: 151, last_error: null } }).state,
    ).toBe("stale");
  });
});

describe("live smoke test guards", () => {
  it("only accepts OpenAI's own endpoint", () => {
    expect(endpointOverrideProblem(undefined)).toBeNull();
    expect(endpointOverrideProblem("")).toBeNull();
    expect(endpointOverrideProblem(OPENAI_API_BASE_URL)).toBeNull();
    expect(endpointOverrideProblem("https://api.openai.com/v1/")).toBeNull();
    for (const elsewhere of [
      "http://127.0.0.1:4010/v1",
      "http://host.docker.internal:4010/v1",
      "https://gateway.example/v1",
      "https://api.openai.com.evil.example/v1",
      "https://api.openai.com/v2",
    ]) {
      expect(endpointOverrideProblem(elsewhere)).toMatch(/only talks to\s+OpenAI itself/);
    }
  });

  it("refuses a price that would switch the spending cap off", () => {
    expect(positivePrice("The input price", 1.25)).toBe(1.25);
    expect(positivePrice("The input price", "0.4")).toBe(0.4);
    for (const bad of [0, -1, "0", "-0.5", "abc", "", null, undefined, Number.NaN, Infinity]) {
      expect(() => positivePrice("The output price", bad)).toThrow(/The output price must be/);
    }
  });
});

describe("hosted Auth settings", () => {
  const link = (type: string) =>
    `<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}">open</a>`;
  const input: AuthSettingsInput = {
    siteUrl: "https://app.example/",
    minimumPasswordLength: 10,
    linkLifetimeSeconds: 86_400,
    oneTimeCodeLength: 10,
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
      mailer_otp_length: 10,
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
        "mailer_otp_length",
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

  it("refuses a short one-time code, because every emailed link is only as strong as it", () => {
    for (const oneTimeCodeLength of [6, 7, 11, 8.5, Number.NaN]) {
      expect(() => desiredAuthSettings({ ...input, oneTimeCodeLength })).toThrow(
        /one-time code length/,
      );
    }
    expect(desiredAuthSettings({ ...input, oneTimeCodeLength: 8 }).mailer_otp_length).toBe(8);
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
    // The email code, not the SMS one further down in the same file.
    expect(declared.oneTimeCodeLength).toBe(10);
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
      oneTimeCodeLength: declared.oneTimeCodeLength,
      templates,
    });
    expect(String(desired.mailer_templates_recovery_content)).toContain(
      "https://app.example/auth/confirm?token_hash={{ .TokenHash }}&type=recovery",
    );
  });
});

describe("Data API row limit", () => {
  it("is the page size the web app reads long lists with", () => {
    expect(REQUIRED_MAX_ROWS).toBe(PAGE_SIZE);
  });

  it("accepts the default and anything above it, and refuses a lower or unknown limit", () => {
    expect(maxRowsProblem(1000)).toBeNull();
    expect(maxRowsProblem(5000)).toBeNull();
    expect(maxRowsProblem(999)).toMatch(/at most 999 rows per request/);
    expect(maxRowsProblem(100)).toMatch(/would stop after their first page/);
    for (const unknown of [undefined, null, "1000", Number.NaN]) {
      expect(maxRowsProblem(unknown)).toMatch(/could not be checked/);
    }
  });
});

describe("reads through the Management API", () => {
  const noWait = { sleep: () => Promise.resolve() };

  it("repeats a read the API failed to answer, and returns the answer when it comes", async () => {
    let calls = 0;
    const result = await retryRead(() => {
      calls += 1;
      if (calls < 3) throw new ManagementError(500, "Failed to retrieve project");
      return Promise.resolve(["20260101000000"]);
    }, noWait);
    expect(result).toEqual(["20260101000000"]);
    expect(calls).toBe(3);
  });

  it("gives up after three attempts with the last error", async () => {
    let calls = 0;
    await expect(
      retryRead(() => {
        calls += 1;
        return Promise.reject(new TypeError("fetch failed"));
      }, noWait),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
  });

  it("does not repeat a request the API refused for its token", async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      await expect(
        retryRead(() => {
          calls += 1;
          return Promise.reject(new ManagementError(status, "Unauthorized"));
        }, noWait),
      ).rejects.toThrow("Unauthorized");
      expect(calls).toBe(1);
    }
  });
});

describe("a refused invitation email", () => {
  const wayAround =
    "To get in without an email, run the command again with --link to get a one-time link, " +
    "which needs no email.";

  it("names the built-in service's team-only rule only when Supabase says that is the reason", () => {
    const hint = inviteFailureHint({ code: "email_address_not_authorized" });
    expect(hint).toContain("only to the people on the project's Supabase team");
    expect(hint).toContain("--link");
  });

  it("says the sending limit was reached only for the code that says so", () => {
    const hint = inviteFailureHint({ code: "over_email_send_rate_limit" });
    expect(hint).toContain("as many emails as it may for now");
    expect(hint).not.toContain("Supabase team");
    expect(hint).toContain("--link");
  });

  it("offers no link for an address Supabase rejects, because the link would be refused too", () => {
    for (const code of ["validation_failed", "email_address_invalid"]) {
      expect(inviteFailureHint({ code })).toBe(
        "Supabase does not accept this address. Check it for a typing mistake.",
      );
    }
  });

  it("gives no cause for a failure it cannot identify, only the way around it", () => {
    // What the Auth client hands over: a failing sender is a 500 without a code, and a 429
    // without the email code says nothing about which limit it was.
    const failingSender: { code?: string; status: number } = { status: 500 };
    const bareLimit: { code?: string; status: number } = { status: 429 };
    const others = [{}, { code: null }, { code: "over_request_rate_limit" }];
    for (const error of [failingSender, bareLimit, ...others]) {
      expect(inviteFailureHint(error)).toBe(wayAround);
    }
  });
});
