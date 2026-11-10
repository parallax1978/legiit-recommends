import { expect, test } from "@playwright/test";
import { OWNER, signIn, stack } from "./support";

test.describe("access control at the door", () => {
  test("protected pages and exports redirect to sign-in when signed out", async ({
    page,
    request,
  }) => {
    await page.goto("/campaigns");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fcampaigns/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    const exportResponse = await request.get("/exports/usage?from=2026-01-01&to=2026-01-31", {
      maxRedirects: 0,
    });
    expect(exportResponse.status()).toBe(307);
    expect(exportResponse.headers().location).toContain("/sign-in");
  });

  test("a wrong password is rejected without saying whether the account exists", async ({
    page,
  }) => {
    await signIn(page, { email: OWNER.email, password: "not-the-password" });
    await expect(page.getByRole("alert").filter({ hasText: "do not match" })).toBeVisible();
    await signIn(page, { email: "nobody@e2e.lr.test", password: "not-the-password" });
    await expect(page.getByRole("alert").filter({ hasText: "do not match" })).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("public sign-up is disabled", async ({ request }) => {
    const local = stack();
    const response = await request.post(`${local.apiUrl}/auth/v1/signup`, {
      headers: { apikey: local.publishableKey, "Content-Type": "application/json" },
      data: { email: "stranger@e2e.lr.test", password: "Some-password-12345" },
    });
    expect(response.ok()).toBe(false);
    expect(JSON.stringify(await response.json()).toLowerCase()).toContain("signup");
  });

  test("the browser cannot call privileged functions or write to tables directly", async ({
    request,
  }) => {
    const local = stack();
    const headers = {
      apikey: local.publishableKey,
      Authorization: `Bearer ${local.publishableKey}`,
      "Content-Type": "application/json",
    };
    for (const fn of [
      "svc_receive_work",
      "svc_get_connection_secret",
      "svc_tick",
      "svc_bootstrap_owner",
    ]) {
      const response = await request.post(`${local.apiUrl}/rest/v1/rpc/${fn}`, {
        headers,
        data: {},
      });
      expect(response.ok(), `${fn} must not be callable with the publishable key`).toBe(false);
    }
    const insert = await request.post(`${local.apiUrl}/rest/v1/campaigns`, {
      headers,
      data: { name: "x" },
    });
    expect(insert.ok()).toBe(false);
    const worker = await request.post(`${local.apiUrl}/functions/v1/worker`, { headers, data: {} });
    expect(worker.status()).toBe(401);
  });
});
