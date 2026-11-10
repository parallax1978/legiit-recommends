// The owner bootstrap command, run exactly as an operator runs it, against the local stack.

import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anonClient, closeConnections, resetDatabase, sql, stack } from "./harness.ts";

const SITE = "https://recommends.example";

function bootstrap(args: string[], env: Record<string, string> = {}): string {
  return execFileSync("npx", ["tsx", "scripts/bootstrap-owner.ts", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // One explicit environment: nothing is read from .env files on the machine.
      ENV_FILE: "/dev/null",
      SUPABASE_URL: stack.apiUrl,
      SUPABASE_SECRET_KEY: stack.secretKey,
      SITE_URL: SITE,
      OWNER_PASSWORD: "",
      ...env,
    },
  });
}

const address = (label: string) => `${label}-${Date.now().toString(36)}@lr.test`;

async function canSignIn(email: string, password: string): Promise<boolean> {
  const { data } = await anonClient().auth.signInWithPassword({ email, password });
  return data.session !== null;
}

async function plantUnconfirmed(email: string, password: string): Promise<string> {
  const created = await admin().auth.admin.createUser({ email, password, email_confirm: false });
  if (created.error || !created.data.user) throw new Error(created.error?.message);
  return created.data.user.id;
}

/** What the web app does when the person presses Continue on the link's page. */
async function openLink(output: string): Promise<{ type: string; signedIn: boolean }> {
  const url = new URL(/https:\/\/\S+\/auth\/confirm\S+/.exec(output)![0]);
  expect(url.origin).toBe(SITE);
  const type = url.searchParams.get("type")!;
  const { data } = await anonClient().auth.verifyOtp({
    type: type as "invite" | "recovery",
    token_hash: url.searchParams.get("token_hash")!,
  });
  return { type, signedIn: data.session !== null };
}

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeConnections();
});

describe("owner bootstrap command", () => {
  it("creates the account with a password and records one workspace grant", async () => {
    const email = address("owner");
    const output = bootstrap(["--email", email], { OWNER_PASSWORD: "Owner-password-123" });
    expect(output).toContain("Account created with the password from OWNER_PASSWORD.");
    expect(output).toContain("The owner names the workspace on first sign-in.");
    expect(await canSignIn(email, "Owner-password-123")).toBe(true);
    expect(
      await sql(
        "select count(*)::int as n from app_private.owner_bootstrap_grants where email = $1",
        [email],
      ),
    ).toEqual([{ n: 1 }]);
    // Nothing else is created: no workspace, no campaign.
    expect(await sql("select count(*)::int as n from public.workspaces")).toEqual([{ n: 0 }]);

    // Running it again changes nothing and does not touch the password.
    const again = bootstrap(["--email", email], { OWNER_PASSWORD: "Another-password-456" });
    expect(again).toContain("The account already existed; its password was not changed.");
    expect(await canSignIn(email, "Owner-password-123")).toBe(true);
    expect(await canSignIn(email, "Another-password-456")).toBe(false);
  });

  it("prints a one-time link instead of sending email, and a reset link once the account is confirmed", async () => {
    const email = address("linked");
    const first = bootstrap(["--email", email, "--link"]);
    expect(first).toContain("One-time link created. Opening it lets the owner choose a password.");
    expect(await openLink(first)).toEqual({ type: "invite", signedIn: true });
    // The link works once.
    expect((await openLink(first)).signedIn).toBe(false);

    const second = bootstrap(["--email", email, "--link"]);
    expect(second).toContain("lets the owner choose a new password");
    expect(await openLink(second)).toEqual({ type: "recovery", signedIn: true });
  });

  it("does not adopt the password of an account that was registered but never confirmed", async () => {
    // Password route: the planted password is replaced by the operator's.
    const first = address("squatted");
    await plantUnconfirmed(first, "Planted-password-123");
    const output = bootstrap(["--email", first], { OWNER_PASSWORD: "Owner-password-123" });
    expect(output).toContain("An unconfirmed account already existed for this address.");
    expect(await canSignIn(first, "Planted-password-123")).toBe(false);
    expect(await canSignIn(first, "Owner-password-123")).toBe(true);

    // Link route: once the owner opens the link the account is confirmed, and the planted
    // password must not work at that point either.
    const second = address("squatted-link");
    await plantUnconfirmed(second, "Planted-password-123");
    const linked = bootstrap(["--email", second, "--link"]);
    expect(await openLink(linked)).toEqual({ type: "invite", signedIn: true });
    expect(await canSignIn(second, "Planted-password-123")).toBe(false);
  });

  it("refuses contradictory or incomplete input without changing anything", async () => {
    const run = (args: string[], env: Record<string, string>) => {
      try {
        bootstrap(args, env);
        return "";
      } catch (error) {
        return String((error as { stderr?: string }).stderr ?? error);
      }
    };
    expect(run(["--email", "not-an-address"], {})).toContain("Pass the owner's email address");
    expect(
      run(["--email", address("x"), "--link"], { OWNER_PASSWORD: "Owner-password-123" }),
    ).toContain("Use either --link or OWNER_PASSWORD");
    expect(run(["--email", address("y"), "--link"], { SITE_URL: "" })).toContain(
      "--link needs SITE_URL",
    );
    expect(run(["--email", address("z")], { OWNER_PASSWORD: "short" })).toContain(
      "at least 10 characters",
    );
  });
});
