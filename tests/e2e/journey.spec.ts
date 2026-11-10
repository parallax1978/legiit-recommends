import { expect, test, type Page } from "@playwright/test";
import {
  BUSINESS,
  FAKE_API_KEY,
  MEMBER,
  OWNER,
  WORKSPACE_NAME,
  linkFromEmail,
  localInput,
  signIn,
  sql,
} from "./support";

// One continuous journey through the product, in the order a new owner would follow it. The
// provider is the deterministic double (tests/support/fake-openai.ts): every "model answer"
// here is synthetic and no request reaches OpenAI.
test.describe.configure({ mode: "serial" });

const CAMPAIGN_NAME = "Bakehouse visibility";
const MODEL = "fake-chat-1";
const ZONE = "America/New_York";
let page: Page;
let campaignPath = "";

/** Reloads until the assertion passes: used while waiting for scheduled background work. */
async function eventually(check: () => Promise<void>, timeout = 300_000): Promise<void> {
  await expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout, intervals: [3_000, 5_000] });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test("the bootstrapped owner signs in and names the workspace", async () => {
  await signIn(page, OWNER);
  await expect(page).toHaveURL(/\/setup/);
  await expect(page.getByRole("heading", { name: "Name your workspace" })).toBeVisible();
  await page.getByLabel("Workspace name").fill(WORKSPACE_NAME);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/overview/);

  // A new installation starts empty: no campaigns, no seeded business or prompts.
  await expect(page.getByText(WORKSPACE_NAME).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Get started" })).toBeVisible();
  await expect(page.getByText("No campaigns yet")).toBeVisible();
  expect((await sql<{ n: string }>("select count(*)::text as n from public.campaigns"))[0]!.n).toBe(
    "0",
  );
  expect((await sql<{ n: string }>("select count(*)::text as n from public.templates"))[0]!.n).toBe(
    "0",
  );
});

test("the owner connects the provider, records prices and verifies a model", async () => {
  await page.goto("/settings?tab=connections");
  await expect(page.getByText("No OpenAI connection yet")).toBeVisible();
  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByLabel("Connection name").fill("Main project");
  await page.getByLabel("Daily spending limit (USD)").fill("20");
  await page.getByLabel("Concurrent requests").fill("4");
  await page.getByRole("button", { name: "Create connection" }).click();

  await page.getByRole("button", { name: "Add API key" }).click();
  await page.getByLabel("OpenAI API key").fill(FAKE_API_KEY);
  await page.getByRole("button", { name: "Verify and store" }).click();
  await expect(page.getByText("Connected").first()).toBeVisible({ timeout: 60_000 });

  // The key is shown only as a masked hint, and is stored in Vault rather than in a table.
  await expect(page.getByText("sk-…0000")).toBeVisible();
  expect(await page.content()).not.toContain(FAKE_API_KEY);
  const leaked = await sql<{ n: string }>(
    "select count(*)::text as n from public.provider_connections where to_jsonb(provider_connections)::text like $1",
    [`%${FAKE_API_KEY}%`],
  );
  expect(leaked[0]!.n).toBe("0");

  // A model without a recorded price cannot be verified: its cost could not be reserved.
  await page.locator("#model_id").selectOption(MODEL);
  await page.locator("#max_output_tokens").fill("2000");
  await page.getByRole("button", { name: "Verify model" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "No price is recorded for model" }),
  ).toBeVisible();

  await page.goto("/settings?tab=pricing");
  await page.getByRole("button", { name: "Add price version" }).click();
  await page.getByLabel("Model ID").fill(MODEL);
  await page.getByLabel("Input", { exact: true }).fill("1.25");
  await page.getByLabel("Output", { exact: true }).fill("10");
  await page.getByLabel("Source URL").fill("https://example.test/prices");
  await page.getByLabel("Checked on").fill(new Date().toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Save price version" }).click();
  await expect(page.getByRole("cell", { name: MODEL }).first()).toBeVisible();

  await page.goto("/settings?tab=connections");
  await page.locator("#model_id").selectOption(MODEL);
  await page.locator("#max_output_tokens").fill("2000");
  await page.getByRole("button", { name: "Verify model" }).click();
  await expect(
    page.locator("li").filter({ hasText: MODEL }).filter({ hasText: "Verified" }).first(),
  ).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByText("Supported (stored responses, continued by response ID)"),
  ).toBeVisible();

  // The data-sharing setting is a dated record of what the owner saw, not a switch.
  await page.getByRole("button", { name: "Update record" }).click();
  await page.getByLabel("Sharing inputs and outputs with OpenAI").selectOption("disabled");
  await page.getByLabel("Date you checked it").fill(new Date().toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Save record" }).click();
  await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
});

test("an admin writes prompts and a fresh-check question set", async () => {
  const prompts: Record<string, string[]> = {
    initial_question: [
      "What are the best {{category}} in {{location}}?",
      "Can you recommend good {{category}} around {{location}}?",
    ],
    inclusion_request: [
      'Please also consider "{{business_name}}" ({{website_url}}). Would you add it to the list?',
    ],
    revision_request: ["Thanks. Please give me the updated list."],
  };
  for (const [kind, bodies] of Object.entries(prompts)) {
    await page.goto(`/library?kind=${kind}`);
    await page.getByRole("button", { name: "Add prompt" }).first().click();
    for (const [index, body] of bodies.entries()) {
      await page.locator("#new-prompt-body").fill(body);
      if (index < bodies.length - 1) {
        await page.getByRole("button", { name: "Save and add another" }).click();
        await expect(page.locator("#new-prompt-body")).toHaveValue("");
      } else {
        await page.getByRole("button", { name: "Save prompt" }).click();
        await expect(page.locator("#new-prompt-body")).toBeHidden();
      }
    }
  }

  // Unknown variables are rejected before anything is saved.
  await page.goto("/library?kind=initial_question");
  await page.getByRole("button", { name: "Add prompt" }).first().click();
  await page.locator("#new-prompt-body").fill("Best {{city}} options?");
  await expect(page.getByText("Unknown variable {{city}}.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save prompt" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.goto("/library?tab=question-sets");
  await page.getByRole("button", { name: "New question set" }).first().click();
  await page.getByLabel("Name").fill("Bakery questions");
  const questions = [
    "Who are the top-rated {{category}} in {{location}}?",
    "Which {{category}} would you suggest near {{location}}?",
    "Where should I buy bread in {{location}}?",
  ];
  for (const [index, body] of questions.entries()) {
    if (index > 0) await page.getByRole("button", { name: "Add question" }).click();
    await page.getByLabel(`Question ${index + 1}`, { exact: true }).fill(body);
  }
  await page.getByRole("checkbox", { name: "Held-out question" }).nth(2).check();
  await page.getByRole("button", { name: "Save question set" }).click();
  await expect(page.getByRole("heading", { name: "Bakery questions" })).toBeVisible();
});

test("campaign setup starts empty, saves as a draft and shows the planned workload", async () => {
  await page.goto("/campaigns");
  await expect(page.getByText("No campaigns yet")).toBeVisible();
  await page.getByRole("link", { name: "New campaign" }).first().click();
  await page.getByLabel("Campaign name").fill(CAMPAIGN_NAME);
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+\/edit/);
  campaignPath = new URL(page.url()).pathname.replace(/\/edit$/, "");

  // Nothing is prepopulated: no business, schedule, volume or budget.
  for (const id of [
    "#c-business",
    "#c-website",
    "#c-category",
    "#c-timezone",
    "#c-start",
    "#c-per-day",
    "#c-total-limit",
    "#c-daily-budget",
    "#c-total-budget",
    "#c-baseline",
  ]) {
    await expect(page.locator(id), `${id} should start empty`).toHaveValue("");
  }
  await expect(page.getByText("No wording chosen for this step yet.")).toHaveCount(3);

  await page.locator("#c-business").fill(BUSINESS.name);
  await page.locator("#c-website").fill(BUSINESS.website);
  await page.locator("#c-aliases").fill("Harborview Bakery");
  await page.locator("#c-category").fill("artisan bakeries");
  await page.locator("#c-location").fill("Portland, Maine");
  await page.locator("#c-language").fill("English");
  for (let step = 0; step < 3; step += 1) {
    await page.getByRole("button", { name: "Choose from library" }).nth(step).click();
    await page.getByRole("button", { name: "Tick all shown" }).click();
    await page.getByRole("button", { name: "Done" }).click();
  }
  // The preview renders the exact messages from the campaign's own values.
  await expect(
    page
      .getByText(
        `Please also consider "${BUSINESS.name}" (${BUSINESS.website}). Would you add it to the list?`,
      )
      .first(),
  ).toBeVisible();

  await page.locator("#c-existing").selectOption("continue");
  await page.locator("#c-connection").selectOption({ label: "Main project" });
  await page.locator("#c-model").selectOption(MODEL);
  await page.locator("#model-max-output").fill("600");
  await page.locator("#c-timezone").fill(ZONE);
  await page.locator("#c-start").fill(localInput(ZONE, 0));
  await page.locator("#c-end-mode").selectOption("duration");
  await page.locator("#c-duration").fill("1");
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
    await page.getByRole("checkbox", { name: day }).check();
  await page.locator("#c-active-start").fill("00:00");
  await page.locator("#c-active-end").fill("24:00");
  await page.locator("#c-per-day").fill("1440");
  await page.locator("#c-total-limit").fill("3");
  await page.locator("#c-concurrency").fill("2");
  await page.locator("#c-missed").selectOption("skip");
  await page.locator("#c-probe-set").selectOption({ index: 1 });
  await page.locator("#c-baseline").fill("2");
  await page.locator("#c-daily").fill("0");
  await page.locator("#c-final").fill("2");
  await page.locator("#c-daily-budget").fill("5");
  await page.locator("#c-total-budget").fill("10");

  await page.getByRole("button", { name: "Save and review" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByText("The configuration is complete")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Planned schedule" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Estimated workload" })).toBeVisible();

  // Saving and reviewing never start paid work.
  expect(
    (await sql<{ status: string }>("select status::text from public.campaigns"))[0]!.status,
  ).toBe("draft");
  expect((await sql<{ n: string }>("select count(*)::text as n from public.jobs"))[0]!.n).toBe("0");
});

test("a test conversation runs the real three-turn sequence and is kept out of results", async () => {
  await page.goto(`${campaignPath}/review`);
  await page.getByRole("button", { name: "Test conversation" }).click();
  await page.getByRole("button", { name: "Run test conversation" }).click();
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]+/, { timeout: 60_000 });
  await eventually(async () => {
    await expect(page.getByText("3 of 3 completed")).toBeVisible({ timeout: 2_000 });
  }, 180_000);
  await expect(page.getByText("Test — excluded from results")).toBeVisible();

  // Each turn shows the exact message sent and the model's own answer, chained by response id.
  await expect(page.getByRole("heading", { name: /Turn 1 · Initial question/ })).toBeVisible();
  await expect(
    page.getByText(
      `Please also consider "${BUSINESS.name}" (${BUSINESS.website}). Would you add it to the list?`,
    ),
  ).toBeVisible();
  await expect(page.getByText("(new context)")).toBeVisible();
  await expect(page.getByText(/continues from/)).toHaveCount(2);
  await expect(page.locator("mark", { hasText: BUSINESS.name }).first()).toBeVisible();

  const turns = await sql<{
    step_index: number;
    response_id: string;
    previous_response_id: string | null;
    output_text: string;
  }>(
    "select t.step_index, t.response_id, t.previous_response_id, t.output_text from public.run_turns t join public.runs r on r.id = t.run_id where r.kind = 'test' order by t.step_index",
  );
  expect(turns).toHaveLength(3);
  expect(turns[0]!.previous_response_id).toBeNull();
  expect(turns[1]!.previous_response_id).toBe(turns[0]!.response_id);
  expect(turns[2]!.previous_response_id).toBe(turns[1]!.response_id);
  for (const turn of turns) expect(turn.output_text.length).toBeGreaterThan(0);
  expect(
    (await sql<{ status: string }>("select status::text from public.campaigns"))[0]!.status,
  ).toBe("draft");
});

test("launching starts the schedule: baseline checks, then conversations, with results", async () => {
  await page.goto(`${campaignPath}/review`);
  await page.getByRole("button", { name: "Launch campaign" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Launching starts paid requests");
  await page.getByRole("alertdialog").getByRole("button", { name: "Launch campaign" }).click();
  await expect(page).toHaveURL(new RegExp(`${campaignPath}$`), { timeout: 60_000 });

  // Background work is driven by Supabase Cron and the queue consumer, not by this browser.
  await eventually(async () => {
    await expect(page.getByRole("link", { name: "Conversation 1", exact: true })).toBeVisible({
      timeout: 2_000,
    });
    await expect(
      page.getByRole("region", { name: "Conversations" }).getByText("Completed").first(),
    ).toBeVisible({ timeout: 2_000 });
  }, 420_000);

  const baseline = await sql<{ status: string; rendered_prompt: string; completed_at: string }>(
    "select status::text, rendered_prompt, completed_at from public.fresh_checks where phase = 'baseline'",
  );
  expect(baseline).toHaveLength(2);
  const firstRun = await sql<{ started_at: string }>(
    "select started_at from public.runs where kind = 'scheduled' order by started_at limit 1",
  );
  for (const check of baseline) {
    expect(check.status).toBe("completed");
    // Fresh checks never carry the business, and the baseline finished before any conversation began.
    expect(check.rendered_prompt.toLowerCase()).not.toContain("harborview");
    expect(new Date(check.completed_at).getTime()).toBeLessThanOrEqual(
      new Date(firstRun[0]!.started_at).getTime(),
    );
  }

  await page.goto(`${campaignPath}?tab=results`);
  await expect(page.getByText("OpenAI API results")).toBeVisible();
  await expect(page.getByText("First response inclusion")).toBeVisible();
  await expect(page.getByText("Final response inclusion")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fresh-check comparison" })).toBeVisible();
  await expect(page.getByText("Held-out questions", { exact: true })).toBeVisible();

  await page.goto("/conversations?kind=test");
  await expect(page.getByRole("link", { name: "Test conversation" })).toHaveCount(1);
  await page.goto("/fresh-checks");
  await expect(page.getByRole("heading", { name: "Individual checks" })).toBeVisible();
  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "Estimated spend per day" })).toBeVisible();
  await expect(page.getByRole("cell", { name: MODEL })).toBeVisible();
});

test("pausing stops dispatch, and results, usage and transcripts can be exported", async () => {
  await page.goto(campaignPath);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

  // Give in-flight work a moment to settle, then confirm nothing new is dispatched while paused.
  await page.waitForTimeout(8_000);
  const dispatched = () =>
    sql<{ n: string }>(
      "select count(*)::text as n from public.jobs where dispatched_at is not null",
    );
  const before = (await dispatched())[0]!.n;
  await page.waitForTimeout(25_000);
  expect((await dispatched())[0]!.n).toBe(before);
  expect(
    (
      await sql<{ n: string }>(
        "select count(*)::text as n from public.jobs where status in ('queued', 'running')",
      )
    )[0]!.n,
  ).toBe("0");

  const campaignId = campaignPath.split("/").pop()!;
  const csv = await page.request.get(`/exports/campaigns/${campaignId}/conversations.csv`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-disposition"]).toContain("attachment");
  const csvText = await csv.text();
  expect(csvText).toContain("conversation_id,type,number,status");
  expect(csvText).toContain("first_response_classification");

  const transcripts = await page.request.get(`/exports/campaigns/${campaignId}/transcripts.json`);
  expect(transcripts.status()).toBe(200);
  const data = (await transcripts.json()) as {
    conversations: {
      type: string;
      turns: {
        user_message: string;
        assistant_response: string | null;
        response_id: string | null;
        previous_response_id: string | null;
      }[];
    }[];
  };
  const completed = data.conversations.filter(
    (conversation) =>
      conversation.turns.length === 3 &&
      conversation.turns.every((turn) => turn.assistant_response),
  );
  expect(completed.length).toBeGreaterThanOrEqual(2);
  for (const conversation of completed) {
    expect(conversation.turns[1]!.previous_response_id).toBe(conversation.turns[0]!.response_id);
    expect(conversation.turns[1]!.user_message).toContain(BUSINESS.name);
  }
  // Conversations never share a response chain.
  const firstIds = completed.map((conversation) => conversation.turns[0]!.response_id);
  expect(new Set(firstIds).size).toBe(firstIds.length);

  const exports = [csvText, JSON.stringify(data)];
  for (const path of [
    `/exports/campaigns/${campaignId}/fresh-checks.csv`,
    `/exports/campaigns/${campaignId}/usage.csv`,
    `/exports/campaigns/${campaignId}/config.json`,
  ]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    exports.push(await response.text());
  }
  for (const body of exports) expect(body).not.toContain(FAKE_API_KEY);

  // Stop the campaign so the local scheduler has nothing left to run.
  await page.getByRole("button", { name: "Cancel campaign" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel campaign" }).click();
  await expect(page.getByText("Canceled", { exact: true }).first()).toBeVisible();
});

test("an invited member accepts by email and can view and export, but not manage", async ({
  browser,
}) => {
  await page.goto("/settings?tab=members");
  await page.getByLabel("Email address").fill(MEMBER.email);
  await page.getByLabel("Role", { exact: true }).selectOption("member");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(
    page.getByRole("region", { name: "Pending invitations" }).getByText(MEMBER.email),
  ).toBeVisible();

  const context = await browser.newContext();
  const member = await context.newPage();
  await member.goto(await linkFromEmail(MEMBER.email, "invited"));
  await expect(member).toHaveURL(/\/accept-invite/);
  await member.getByLabel("Your name").fill("Morgan Member");
  await member.getByLabel("New password").fill(MEMBER.password);
  await member.getByLabel("Confirm password").fill(MEMBER.password);
  await member.getByRole("button", { name: "Accept invitation" }).click();
  await expect(member).toHaveURL(/\/overview/);
  await expect(member.getByText("Member", { exact: true }).first()).toBeVisible();

  // Members inspect and export; they are not offered management controls.
  await member.goto("/campaigns");
  await expect(member.getByRole("link", { name: CAMPAIGN_NAME })).toBeVisible();
  await expect(member.getByRole("link", { name: "New campaign" })).toHaveCount(0);
  await member.goto("/settings?tab=connections");
  await expect(member.getByText("Only owners can manage credentials")).toBeVisible();
  await expect(member.getByRole("button", { name: "Add connection" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Replace API key" })).toHaveCount(0);
  await member.goto(`${campaignPath}/edit`);
  await expect(member.getByText("You can view this campaign but not change it")).toBeVisible();
  const campaignId = campaignPath.split("/").pop()!;
  expect(
    (await member.request.get(`/exports/campaigns/${campaignId}/conversations.csv`)).status(),
  ).toBe(200);

  // Account recovery by email.
  await member.getByRole("button", { name: /Account menu/ }).click();
  await member.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(member).toHaveURL(/\/sign-in/);
  await member.goto("/forgot-password");
  await member.getByLabel("Email").fill(MEMBER.email);
  await member.getByRole("button", { name: "Send reset link" }).click();
  await expect(member.getByText("If an account exists for that address")).toBeVisible();
  await member.goto(await linkFromEmail(MEMBER.email, "Reset"));
  await expect(member).toHaveURL(/\/reset-password/);
  const newPassword = `${MEMBER.password}-changed`;
  await member.getByLabel("New password").fill(newPassword);
  await member.getByLabel("Confirm password").fill(newPassword);
  await member.getByRole("button", { name: "Save password" }).click();
  await expect(member).toHaveURL(/\/overview/);
  await member.getByRole("button", { name: /Account menu/ }).click();
  await member.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(member).toHaveURL(/\/sign-in/);
  // The new password works, and the old one no longer does.
  await signIn(member, MEMBER);
  await expect(member.getByRole("alert").filter({ hasText: "do not match" })).toBeVisible();
  await signIn(member, { email: MEMBER.email, password: newPassword });
  await expect(member).toHaveURL(/\/overview/);
  await context.close();
});
