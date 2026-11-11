import { expect, test, type Page } from "@playwright/test";
import { BUSINESS, OWNER, localInput, signIn, sql } from "./support";

// Runs after the journey and builds on what it left behind: a canceled campaign with real
// conversations and fresh checks. Covers the lifecycle paths the journey does not.
test.describe.configure({ mode: "serial" });

const ORIGINAL = "Bakehouse visibility";
const COPY = "Bakehouse visibility (copy)";
const ZONE = "America/New_York";
let page: Page;
let copyPath = "";

const count = async (query: string, params: unknown[] = []) =>
  Number((await sql<{ n: string }>(query, params))[0]!.n);

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signIn(page, OWNER);
  await expect(page).toHaveURL(/\/overview/);
});

test.afterAll(async () => {
  await page.close();
});

test("a duplicate keeps the configuration but not the schedule, and can be scheduled for later", async () => {
  await page.goto("/campaigns");
  await page.getByRole("button", { name: `Actions for ${ORIGINAL}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+\/edit/);
  copyPath = new URL(page.url()).pathname.replace(/\/edit$/, "");

  await expect(page.locator("#c-name")).toHaveValue(COPY);
  await expect(page.locator("#c-business")).toHaveValue(BUSINESS.name);
  await expect(page.locator("#c-per-day")).toHaveValue("1440");
  await expect(page.locator("#c-start")).toHaveValue("");

  // Start two days from now: launching must schedule it without sending anything.
  await page.locator("#c-start").fill(localInput(ZONE, 2 * 24 * 60));
  await page.locator("#c-end-mode").selectOption("duration");
  await page.locator("#c-duration").fill("1");
  await page.getByRole("button", { name: "Save and review" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByText("The configuration is complete")).toBeVisible();
  await page.getByRole("button", { name: "Launch campaign" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Launch campaign" }).click();
  await expect(page).toHaveURL(new RegExp(`${copyPath}$`), { timeout: 60_000 });
  await expect(page.getByText("Scheduled", { exact: true }).first()).toBeVisible();

  expect(
    (
      await sql<{ status: string }>("select status::text from public.campaigns where name = $1", [
        COPY,
      ])
    )[0]!.status,
  ).toBe("scheduled");
  expect(
    await count(
      "select count(*)::text as n from public.provider_attempts a join public.campaigns c on c.id = a.campaign_id where c.name = $1",
      [COPY],
    ),
  ).toBe(0);
});

test("editing a launched campaign creates a new revision for future work, or can be discarded", async () => {
  await page.goto(`${copyPath}/edit`);
  await expect(page.getByText("This campaign has been launched")).toBeVisible();
  await page.locator("#c-per-day").fill("720");
  await page.getByRole("button", { name: "Save and review changes" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByRole("heading", { name: "Review pending changes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What changes" })).toBeVisible();
  await expect(page.getByText("Conversations per day", { exact: true }).first()).toBeVisible();

  // Until applied, the running configuration is untouched.
  const before = await sql<{ revision_number: number; conversations_per_day: number }>(
    "select r.revision_number, r.conversations_per_day from public.campaigns c join public.campaign_revisions r on r.id = c.active_revision_id where c.name = $1",
    [COPY],
  );
  expect(before[0]).toEqual({ revision_number: 1, conversations_per_day: 1440 });

  await page.getByRole("button", { name: "Apply changes" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Apply changes" }).click();
  await expect(page).toHaveURL(new RegExp(`${copyPath}$`), { timeout: 60_000 });

  const revisions = await sql<{
    revision_number: number;
    state: string;
    conversations_per_day: number;
  }>(
    "select r.revision_number, r.state, r.conversations_per_day from public.campaign_revisions r join public.campaigns c on c.id = r.campaign_id where c.name = $1 order by r.revision_number",
    [COPY],
  );
  // Revision 1 is kept exactly as it was launched.
  expect(revisions).toEqual([
    { revision_number: 1, state: "frozen", conversations_per_day: 1440 },
    { revision_number: 2, state: "frozen", conversations_per_day: 720 },
  ]);
  await page.goto(`${copyPath}?tab=configuration`);
  await expect(page.getByText("Revision 2 is in effect")).toBeVisible();
  await expect(page.getByText("Superseded")).toBeVisible();

  // A second edit is saved as pending changes and then thrown away.
  await page.goto(`${copyPath}/edit`);
  await page.locator("#c-per-day").fill("100");
  await page.getByRole("button", { name: "Save and review changes" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(new RegExp(`${copyPath}$`), { timeout: 60_000 });
  const after = await sql<{
    revision_number: number;
    conversations_per_day: number;
    pending: boolean;
  }>(
    "select r.revision_number, r.conversations_per_day, c.draft_revision_id is not null as pending from public.campaigns c join public.campaign_revisions r on r.id = c.active_revision_id where c.name = $1",
    [COPY],
  );
  expect(after[0]).toEqual({ revision_number: 2, conversations_per_day: 720, pending: false });
});

test("manual observations stay a separate dataset and model classification is paid for and recorded", async () => {
  const original = (
    await sql<{ id: string }>("select id from public.campaigns where name = $1", [ORIGINAL])
  )[0]!.id;
  const apiChecks = await count(
    "select count(*)::text as n from public.fresh_checks where campaign_id = $1",
    [original],
  );

  await page.goto(`/fresh-checks?campaign=${original}`);
  await page.getByRole("button", { name: "Record an observation" }).click();
  await page.getByLabel("Date observed").fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Source", { exact: true }).fill("ChatGPT web app, free plan");
  await page.getByLabel("Question asked").fill("Best artisan bakeries in Portland, Maine?");
  await page
    .getByLabel("Response", { exact: true })
    .fill(
      `Here are a few:\n1. Alder & Finch\n2. **${BUSINESS.name}** – known for sourdough\n3. Juniper Field`,
    );
  await page.getByRole("button", { name: "Record observation" }).click();
  const observation = page
    .getByRole("listitem")
    .filter({ hasText: "Manual · ChatGPT web app, free plan" });
  await expect(observation).toBeVisible();
  await expect(observation.getByText("Included", { exact: true })).toBeVisible();
  await expect(observation.getByText("Ranked #2")).toBeVisible();

  // It is stored apart from API measurements and does not change them.
  expect(
    await count("select count(*)::text as n from public.manual_checks where campaign_id = $1", [
      original,
    ]),
  ).toBe(1);
  expect(
    await count("select count(*)::text as n from public.fresh_checks where campaign_id = $1", [
      original,
    ]),
  ).toBe(apiChecks);

  // Optional model-based classification of a stored answer: one extra, recorded request.
  await page.locator('a[href^="/fresh-checks/"]').first().click();
  await expect(page).toHaveURL(/\/fresh-checks\/[0-9a-f-]+/);
  await page.getByRole("button", { name: "Classify with model" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Classify with model" }).click();
  await expect(page.getByText("Classified by the model")).toBeVisible({ timeout: 60_000 });
  expect(
    await count(
      "select count(*)::text as n from public.usage_ledger where purpose = 'classification'",
    ),
  ).toBe(1);
  // The request that produced the answer is unchanged: the fresh check itself still has one attempt.
  const checkId = new URL(page.url()).pathname.split("/").pop();
  expect(
    await count(
      "select count(*)::text as n from public.provider_attempts where fresh_check_id = $1 and purpose = 'fresh_check'",
      [checkId],
    ),
  ).toBe(1);
});

test("the emergency stop blocks paid work until an owner releases it", async () => {
  await page.goto("/settings?tab=workspace");
  await page.getByRole("button", { name: "Stop all provider requests" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Stop everything" }).click();
  const banner = page.getByRole("alert").filter({ hasText: "Emergency stop is on" });
  await expect(banner.first()).toBeVisible();

  const tests = () =>
    count(
      "select count(*)::text as n from public.jobs j join public.campaigns c on c.id = j.campaign_id where c.name = $1 and j.kind = 'test_conversation'",
      [COPY],
    );
  const before = await tests();
  await page.goto(copyPath);
  await expect(banner.first()).toBeVisible();
  await page.getByRole("button", { name: "Test conversation" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Run test conversation" })
    .click();
  await expect(page.getByText(/workspace stop is active/)).toBeVisible();
  expect(await tests()).toBe(before);

  await page.goto("/settings?tab=workspace");
  await page.getByRole("button", { name: "Release" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Release and resume" }).click();
  await expect(page.getByText("Emergency stop released")).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test("a canceled campaign can be archived, restored from the archive view and deleted by the owner", async () => {
  await page.goto(copyPath);
  await page.getByRole("button", { name: "Cancel campaign" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel campaign" }).click();
  await expect(page.getByText("Canceled", { exact: true }).first()).toBeVisible();

  await page.goto("/campaigns");
  await page.getByRole("button", { name: `Actions for ${COPY}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByRole("link", { name: COPY, exact: true })).toHaveCount(0);

  await page.goto("/campaigns?status=archived");
  await expect(page.getByRole("link", { name: COPY, exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Campaigns" }).getByText("Archived", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: `Actions for ${COPY}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete campaign" }).click();
  // Wait for the outcome itself: while the dialog is open the list behind it is hidden from
  // assistive technology, so the link count alone would pass too early.
  await expect(page.getByText("Campaign deleted.")).toBeVisible();
  await expect(page.getByRole("link", { name: COPY, exact: true })).toHaveCount(0);
  expect(
    await count("select count(*)::text as n from public.campaigns where name = $1", [COPY]),
  ).toBe(0);
  // The original campaign and its recorded results are untouched.
  expect(
    await count("select count(*)::text as n from public.campaigns where name = $1", [ORIGINAL]),
  ).toBe(1);
});

test("a signed-in person can change their password after confirming the current one", async () => {
  const replacement = "E2E-owner-password-02";
  const form = async (current: string, next: string) => {
    await page.goto("/settings?tab=profile");
    await page.getByLabel("Current password").fill(current);
    await page.getByLabel("New password", { exact: true }).fill(next);
    await page.getByLabel("Confirm new password").fill(next);
    await page.getByRole("button", { name: "Change password" }).click();
  };

  // A session alone is not enough: the current password has to be right.
  await form("not-the-current-password", replacement);
  await expect(page.getByText("Your current password is not correct.")).toBeVisible();

  await form(OWNER.password, replacement);
  await expect(page.getByText("Password changed.")).toBeVisible();

  // The old password no longer works; the new one does.
  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn(page, OWNER);
  await expect(page.getByRole("alert").filter({ hasText: "do not match" })).toBeVisible();
  await signIn(page, { email: OWNER.email, password: replacement });
  await expect(page).toHaveURL(/\/overview/);

  // Put the original back so the suites that follow can sign in.
  await form(replacement, OWNER.password);
  await expect(page.getByText("Password changed.")).toBeVisible();
});

test("a new campaign launches on three answers: how long, how many a day, and a total budget", async () => {
  const name = "Quick launch";
  await page.goto("/campaigns");
  await page.getByRole("link", { name: "New campaign" }).first().click();
  await page.getByLabel("Campaign name").fill(name);
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+\/edit/);
  const path = new URL(page.url()).pathname.replace(/\/edit$/, "");

  await page.locator("#c-business").fill(BUSINESS.name);
  await page.locator("#c-website").fill(BUSINESS.website);
  // Prompts written on the spot, with no category, market or language to fill in.
  const prompts = [
    "What are the best bakeries for sourdough?",
    'Please add "{{business_name}}" to that list.',
    "Can you show me the complete revised list?",
  ];
  for (const [step, body] of prompts.entries()) {
    await page.getByRole("button", { name: "Write new" }).nth(step).click();
    await page.locator("#new-prompt-body").fill(body);
    await page.getByRole("button", { name: "Save prompt" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.locator("#c-connection").selectOption({ label: "Main project" });
  await page.locator("#c-model").selectOption("fake-chat-1");
  await expect(page.locator("#model-max-output")).toHaveValue("2000");

  // Fresh checks stay off, but their question set is one click away: it is made from the
  // campaign's own question and chosen, without leaving the form.
  await page.getByRole("button", { name: "Make a set from this campaign's question" }).click();
  await expect(page.getByText("Question set created and chosen.")).toBeVisible();
  const [made] = await sql<{ id: string; questions: string }>(
    `select s.id, (select string_agg(q.body, '|' order by q.position) from public.probe_questions q
                    where q.probe_set_version_id = s.current_version_id) as questions
     from public.probe_sets s where s.name = $1`,
    [`${name} questions`],
  );
  expect(made!.questions).toBe("What are the best bakeries for sourdough?");
  await expect(page.locator("#c-probe-set")).toHaveValue(made!.id);

  // The three answers. Nothing else is touched: no start, timezone, days, hours, concurrency,
  // missed-slot rule, fresh checks, daily budget, category or language.
  await page.locator("#c-duration").fill("2");
  await page.locator("#c-per-day").fill("1");
  await page.locator("#c-total-budget").fill("5");

  await page.getByRole("button", { name: "Save and review" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByText("The configuration is complete")).toBeVisible();
  await expect(page.getByText(/Starts when you launch and runs for 2 days/)).toBeVisible();
  await expect(page.getByText("When you launch", { exact: true })).toBeVisible();
  await expect(page.getByText("No separate daily limit", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Launch campaign" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Launch campaign" }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 60_000 });

  const browserZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [launched] = await sql<Record<string, unknown>>(
    `select c.status::text as status, r.timezone, r.max_concurrency, r.missed_slot_behavior,
            r.max_output_tokens, r.daily_budget_usd, r.category, r.language,
            r.baseline_samples + r.daily_checks + r.final_samples as checks,
            extract(epoch from (now() - r.start_at))::int as started_seconds_ago,
            r.end_at = ((r.start_at at time zone r.timezone) + interval '2 days') at time zone r.timezone as two_days
     from public.campaigns c join public.campaign_revisions r on r.id = c.active_revision_id
     where c.name = $1`,
    [name],
  );
  expect(launched).toMatchObject({
    status: "running",
    timezone: browserZone,
    max_concurrency: 1,
    missed_slot_behavior: "skip",
    max_output_tokens: 2000,
    daily_budget_usd: null,
    category: null,
    language: null,
    checks: 0,
    two_days: true,
  });
  expect(Number(launched!.started_seconds_ago)).toBeLessThan(120);

  // A later edit can be applied: the start the campaign took at its launch is sent back by the
  // form to the minute, and that must not count as moving a start that has passed.
  // Through the Edit link, as a person would: the router shows the editor again with the form
  // it held before the launch, and that form has to start over from what is stored now.
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${path}/edit$`));
  await expect(page.getByText("This campaign has been launched")).toBeVisible();
  await expect(page.locator("#c-start")).toBeDisabled();
  await expect(page.locator("#c-start")).not.toHaveValue("");
  await expect(page.locator("#c-duration")).toHaveValue("2");
  await page.locator("#c-per-day").fill("2");
  await page.getByRole("button", { name: "Save and review changes" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByText("The configuration is complete")).toBeVisible();
  await page.getByRole("button", { name: "Apply changes" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Apply changes" }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 60_000 });
  const [edited] = await sql<Record<string, unknown>>(
    `select r.revision_number, r.conversations_per_day,
            r.start_at = first.start_at as same_start, r.end_at = first.end_at as same_end
     from public.campaigns c
     join public.campaign_revisions r on r.id = c.active_revision_id
     join public.campaign_revisions first on first.campaign_id = c.id and first.revision_number = 1
     where c.name = $1`,
    [name],
  );
  expect(edited).toEqual({
    revision_number: 2,
    conversations_per_day: 2,
    same_start: true,
    same_end: true,
  });

  // Leave nothing behind for the suites that follow: they pick up the newest campaign.
  await page.getByRole("button", { name: "Cancel campaign" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel campaign" }).click();
  await expect(page.getByText("Canceled", { exact: true }).first()).toBeVisible();
  await page.goto("/campaigns");
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  await page.goto("/campaigns?status=archived");
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete campaign" }).click();
  await expect(page.getByText("Campaign deleted.")).toBeVisible();
  expect(
    await count("select count(*)::text as n from public.campaigns where name = $1", [name]),
  ).toBe(0);
});
