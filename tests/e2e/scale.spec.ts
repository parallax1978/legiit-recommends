import { expect, test, type Page } from "@playwright/test";
import { OWNER, signIn, sql } from "./support";

// Runs last and builds on what the earlier specs left behind. It grows the library past the
// two sizes where lists used to break without any error: more prompts than fit in one request
// URL as a list of ids (about 215), in a file larger than a server action accepts by default
// (1 MB). It also checks the conversations filter that used to send such an id list.
test.describe.configure({ mode: "serial" });

const PROMPTS = 280;
const marker = (index: number) => `scale-${String(index).padStart(3, "0")}`;
const wording = (index: number) => `${marker(index)} What would you suggest for {{category}}?`;
let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signIn(page, OWNER);
  await expect(page).toHaveURL(/\/overview/);
});

test.afterAll(async () => {
  await page.close();
});

test("a large CSV import arrives whole and every prompt keeps its wording", async () => {
  // Close to the 4000-character limit per prompt, so the file is well over 1 MB. Whole
  // sentences only: a variable cut in half would make the row invalid.
  const sentence = " Please weigh price, quality and service for {{category}}.";
  const filler = sentence.repeat(Math.floor((3900 - wording(0).length) / sentence.length));
  const body = (index: number) => `${wording(index)}${filler}`;
  const csv = [
    "body,label",
    ...Array.from({ length: PROMPTS }, (_, index) => `"${body(index)}",${marker(index)}`),
  ].join("\n");
  expect(csv.length).toBeGreaterThan(1_050_000);
  expect(csv.length).toBeLessThan(2_000_000);

  await page.goto("/library?kind=extra_step");
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page
    .getByLabel("CSV file")
    .setInputFiles({ name: "prompts.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByLabel("Or paste CSV text")).toHaveValue(/scale-279/);
  await page.getByRole("button", { name: "Review rows" }).click();
  await expect(page.getByText(`${PROMPTS} of ${PROMPTS} rows can be imported`)).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: `Import ${PROMPTS} prompts` }).click();

  // Every prompt is listed with its wording, the first and the last alike. With the wording
  // looked up through one long list of ids, all of them came back blank beyond about 215.
  const list = page.getByRole("region", { name: "Additional messages" });
  await expect(list).toContainText(wording(PROMPTS - 1), { timeout: 90_000 });
  await expect(list).toContainText(wording(0));
  await expect(list).toContainText(wording(140));

  const stored = await sql<{ n: string }>(
    "select count(*)::text as n from public.templates t join public.template_versions v on v.id = t.current_version_id where t.kind = 'extra_step' and t.label like 'scale-%' and v.body like 'scale-%'",
  );
  expect(Number(stored[0]!.n)).toBe(PROMPTS);

  // The export reads the same prompts and must not leave a body empty either.
  const exported = await (await page.request.get("/exports/library?kind=extra_step")).text();
  for (const index of [0, 99, 100, 199, 200, PROMPTS - 1]) {
    expect(exported).toContain(`${marker(index)} What would you suggest for`);
  }
});

test("the conversations list filters by classification in the database", async () => {
  // The workspace the owner sees: the first one they joined.
  const workspace = await sql<{ id: string }>(
    "select m.workspace_id as id from public.workspace_members m join auth.users u on u.id = m.user_id where u.email = $1 order by m.created_at limit 1",
    [OWNER.email],
  );
  const expected = await sql<{ inclusion: string; n: string }>(
    "select t.inclusion::text as inclusion, count(distinct t.run_id)::text as n from public.run_turns t where t.inclusion is not null and t.workspace_id = $1 group by 1",
    [workspace[0]!.id],
  );
  expect(expected.length).toBeGreaterThan(0);
  for (const { inclusion, n } of expected) {
    await page.goto(`/conversations?inclusion=${inclusion}`);
    const rows = page.locator("table tbody tr");
    await expect(rows).toHaveCount(Math.min(Number(n), 25));
    // Every listed conversation really has a response classified that way.
    const ids = await rows
      .locator('a[href^="/conversations/"]')
      .evaluateAll((links) => [
        ...new Set(links.map((link) => link.getAttribute("href")!.split("/")[2]!.split("?")[0]!)),
      ]);
    expect(ids.length).toBeGreaterThan(0);
    const matching = await sql<{ n: string }>(
      "select count(distinct run_id)::text as n from public.run_turns where run_id = any($1::uuid[]) and inclusion::text = $2",
      [ids, inclusion],
    );
    expect(Number(matching[0]!.n)).toBe(ids.length);
  }

  // A page number past the end (an old link, a filtered list that has shrunk) goes back to the
  // first page of the same filters instead of failing or claiming that nothing matches.
  const some = expected[0]!.inclusion;
  await page.goto(`/conversations?inclusion=${some}&page=99`);
  await expect(page).toHaveURL(new RegExp(`/conversations\\?inclusion=${some}$`));
  await expect(page.locator("table tbody tr").first()).toBeVisible();
  await page.goto("/fresh-checks?page=99");
  await expect(page).toHaveURL(/\/fresh-checks\?campaign=[0-9a-f-]{36}$/);
  await expect(page.getByText("could not be loaded")).toHaveCount(0);

  // A classification no response has: an empty list, not an error.
  const used = new Set(expected.map((row) => row.inclusion));
  const unused = ["ambiguous", "mentioned_only", "not_mentioned", "included"].find(
    (value) => !used.has(value),
  );
  if (unused) {
    await page.goto(`/conversations?inclusion=${unused}`);
    await expect(page.getByText("No conversations match these filters.")).toBeVisible();
  }
});

const ownerSessions = async () =>
  Number(
    (
      await sql<{ n: string }>(
        "select count(*)::text as n from auth.sessions s join auth.users u on u.id = s.user_id where u.email = $1",
        [OWNER.email],
      )
    )[0]!.n,
  );

test("signing out loads the sign-in page afresh, and ends that session only", async ({
  browser,
}) => {
  // The same person signed in somewhere else: another browser, or a colleague on the account.
  const elsewhere = await browser.newPage();
  await signIn(elsewhere, OWNER);
  await expect(elsewhere).toHaveURL(/\/overview/);
  const before = await ownerSessions();
  expect(before).toBeGreaterThanOrEqual(2);

  await page.goto("/settings?tab=profile");
  await expect(page.getByRole("heading", { name: "Password" })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __beforeSignOut: boolean }).__beforeSignOut = true;
  });
  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  // A full page load: nothing of the previous person's screens is left in the document.
  expect(
    await page.evaluate(
      () => (window as unknown as { __beforeSignOut?: boolean }).__beforeSignOut ?? false,
    ),
  ).toBe(false);
  await expect(page.locator("body")).not.toContainText(OWNER.email);
  const cookies = await page.context().cookies();
  expect(cookies.filter((cookie) => /-auth-token/.test(cookie.name))).toEqual([]);
  // The app is closed again.
  await page.goto("/overview");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Foverview$/);

  // Exactly one session ended. The other browser is still signed in for the Auth server too,
  // which the backend function asks on every call: a request through it still goes through.
  expect(await ownerSessions()).toBe(before - 1);
  await elsewhere.goto("/settings?tab=connections");
  await elsewhere.getByRole("button", { name: "Test connection" }).first().click();
  await expect(elsewhere.getByText(/Connection works\./)).toBeVisible({ timeout: 60_000 });
  await elsewhere.close();
});

test("a session that was ended elsewhere leads to the sign-in page, which says why", async ({
  browser,
}) => {
  const visitor = await browser.newPage();
  await signIn(visitor, OWNER);
  await expect(visitor).toHaveURL(/\/overview/);
  await visitor.goto("/settings?tab=connections");
  await expect(visitor.getByRole("button", { name: "Test connection" }).first()).toBeVisible();

  // What signing out everywhere, or an administrator revoking the session, does: the session
  // is gone for the Auth server while this browser still holds a token that reads as valid.
  await sql(
    "delete from auth.sessions where user_id = (select id from auth.users where email = $1)",
    [OWNER.email],
  );
  // Pages still load.
  await visitor.reload();
  await expect(visitor.getByRole("button", { name: "Test connection" }).first()).toBeVisible();

  // The first request that asks the Auth server ends it here too, with an explanation instead
  // of a refusal the person can do nothing with.
  await visitor.getByRole("button", { name: "Test connection" }).first().click();
  await expect(visitor).toHaveURL(/\/sign-in\?ended=1$/, { timeout: 60_000 });
  await expect(visitor.getByText("Your session has ended.")).toBeVisible();
  const cookies = await visitor.context().cookies();
  expect(cookies.filter((cookie) => /-auth-token/.test(cookie.name))).toEqual([]);

  // Signing in again is all it takes.
  await visitor.getByLabel("Email").fill(OWNER.email);
  await visitor.getByLabel("Password").fill(OWNER.password);
  await visitor.getByRole("button", { name: "Sign in" }).click();
  await expect(visitor).toHaveURL(/\/overview/);
  await visitor.close();
});
