import { devices, expect, test } from "@playwright/test";
import { OWNER, signIn } from "./support";

// Runs after the journey (one worker, files in alphabetical order), so every screen has real
// rows, charts and transcripts to lay out at phone size.
const { defaultBrowserType: _browser, ...phone } = devices["iPhone 13"];
test.use(phone);

test("every main screen fits a phone without sideways scrolling", async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page).toHaveURL(/\/overview/);

  await page.goto("/campaigns");
  const campaign = await page
    .getByRole("region", { name: "Campaigns" })
    .locator('a[href^="/campaigns/"]')
    .first()
    .getAttribute("href");
  await page.goto("/conversations");
  const conversation = await page
    .locator('a[href^="/conversations/"]')
    .first()
    .getAttribute("href");
  await page.goto("/fresh-checks");
  const check = await page.locator('a[href^="/fresh-checks/"]').first().getAttribute("href");
  expect(campaign && conversation && check).toBeTruthy();

  const paths = [
    "/overview",
    "/campaigns",
    "/campaigns/new",
    `${campaign}`,
    `${campaign}?tab=results`,
    `${campaign}?tab=conversations`,
    `${campaign}?tab=activity`,
    `${campaign}?tab=configuration`,
    "/conversations",
    `${conversation}`,
    "/fresh-checks",
    `${check}`,
    "/results",
    "/library",
    "/library?tab=question-sets",
    "/usage",
    "/settings?tab=workspace",
    "/settings?tab=members",
    "/settings?tab=connections",
    "/settings?tab=pricing",
    "/settings?tab=status",
  ];
  for (const path of paths) {
    await page.goto(path);
    await expect(page.locator("main h1").first(), path).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

test("the navigation drawer works on a phone", async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page).toHaveURL(/\/overview/);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer.getByRole("link", { name: "Fresh Checks" })).toBeVisible();
  await drawer.getByRole("link", { name: "Usage" }).click();
  await expect(page).toHaveURL(/\/usage/);
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
});
