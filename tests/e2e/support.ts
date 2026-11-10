// Helpers shared by the end-to-end tests: access to the local stack for setup and assertions,
// and the local mail catcher for invitation and recovery links.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import pg from "pg";

export const OWNER = { email: "owner@e2e.lr.test", password: "E2E-owner-password-01" };
export const MEMBER = { email: "member@e2e.lr.test", password: "E2E-member-password-01" };
export const WORKSPACE_NAME = "E2E Workspace";
/** A key the provider double accepts. It is not a real credential. */
export const FAKE_API_KEY = "sk-fake-valid-e2e-0000000000000000";
export const BUSINESS = {
  name: "Harborview Bakehouse",
  website: "https://www.harborviewbakehouse.example",
};

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=["']?(.*?)["']?$/.exec(line.trim());
    if (match) values[match[1]!] = match[2]!;
  }
  return values;
}

export interface Stack {
  apiUrl: string;
  dbUrl: string;
  secretKey: string;
  publishableKey: string;
  mailUrl: string;
  workerSecret: string;
}

let cached: Stack | null = null;

/** Connection details of the local Supabase stack, read from `supabase status`. */
export function stack(): Stack {
  if (cached) return cached;
  let output: string;
  try {
    output = execFileSync("npx", ["supabase", "status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      "The local Supabase stack is not running. Start it with `npm run db:start` (see README → Testing).",
    );
  }
  const status = parseEnv(output);
  const functionsEnvPath = resolve(process.cwd(), "supabase/functions/.env");
  const functionsEnv = existsSync(functionsEnvPath)
    ? parseEnv(readFileSync(functionsEnvPath, "utf8"))
    : {};
  if (!/^https?:\/\//.test(functionsEnv.OPENAI_BASE_URL ?? "")) {
    throw new Error(
      "supabase/functions/.env must set OPENAI_BASE_URL to the provider double (for example http://host.docker.internal:4010/v1) " +
        "so the end-to-end tests never contact OpenAI. Restart the stack after changing it.",
    );
  }
  cached = {
    apiUrl: status.API_URL!,
    dbUrl: status.DB_URL!,
    secretKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY!,
    publishableKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY!,
    mailUrl: status.MAILPIT_URL ?? status.INBUCKET_URL!,
    workerSecret: functionsEnv.WORKER_SECRET ?? "",
  };
  return cached;
}

export async function sql<Row extends object = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: stack().dbUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as Row[];
  } finally {
    await client.end();
  }
}

interface MailSummary {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

export async function clearMail(): Promise<void> {
  await fetch(`${stack().mailUrl}/api/v1/messages`, { method: "DELETE" });
}

/** Waits for the newest email to `address` and returns the first link in it. */
export async function linkFromEmail(
  address: string,
  subjectIncludes: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${stack().mailUrl}/api/v1/messages?limit=50`)).json()) as {
      messages: MailSummary[];
    };
    const message = list.messages.find(
      (item) =>
        item.To.some((to) => to.Address === address) && item.Subject.includes(subjectIncludes),
    );
    if (message) {
      const full = (await (
        await fetch(`${stack().mailUrl}/api/v1/message/${message.ID}`)
      ).json()) as { HTML: string; Text: string };
      const match =
        /href="([^"]*\/auth\/confirm[^"]*)"/.exec(full.HTML) ??
        /(https?:\/\/\S*\/auth\/confirm\S*)/.exec(full.Text);
      if (!match) throw new Error(`The email to ${address} has no confirmation link.`);
      return match[1]!.replace(/&amp;/g, "&");
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`No "${subjectIncludes}" email arrived for ${address}.`);
}

export async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** A wall-clock time `offsetMinutes` from now in `timeZone`, formatted for a datetime-local input. */
export function localInput(timeZone: string, offsetMinutes: number): string {
  const instant = new Date(Date.now() + offsetMinutes * 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
