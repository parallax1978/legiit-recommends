// Supabase Management API client for the operator scripts.
//
// Everything a deployment needs can be done over HTTPS with a Supabase access token: running
// SQL, reading the project's API keys and changing Auth settings. That makes deployment possible
// from a machine that cannot open a direct database connection or does not know the database
// password (for example a project created through a hosting integration).

import { env, fail } from "./env";

const API = "https://api.supabase.com";

/** The 20-character project ref, from SUPABASE_PROJECT_REF or a hosted SUPABASE_URL. */
export function projectRef(): string | undefined {
  const explicit = env("SUPABASE_PROJECT_REF");
  if (explicit) return explicit;
  const url = env("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL");
  const match = url ? /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url) : null;
  return match?.[1];
}

export interface ManagementClient {
  ref: string;
  /** One request. A GET is repeated a few times when the API fails to answer it properly. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Runs SQL as the `postgres` role. A multi-statement query is one transaction. Sent once. */
  sql<Row extends object = Record<string, unknown>>(
    query: string,
    parameters?: unknown[],
  ): Promise<Row[]>;
  /** Runs a query that changes nothing, repeating it when the API fails to answer properly. */
  read<Row extends object = Record<string, unknown>>(
    query: string,
    parameters?: unknown[],
  ): Promise<Row[]>;
}

export class ManagementError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ManagementError";
  }
}

/**
 * Repeats a request that changes nothing. The Management API occasionally fails one request
 * out of many ("Failed to retrieve project", a gateway error) and answers the next normally;
 * a deployment should not stop for that. A rejected token (401, 403) is not repeated.
 */
export async function retryRead<T>(
  run: () => Promise<T>,
  options: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const status = error instanceof ManagementError ? error.status : null;
      if (attempt >= attempts || status === 401 || status === 403) throw error;
      await sleep(options.delayMs ?? 2000);
    }
  }
}

export function managementClient(): ManagementClient {
  const ref =
    projectRef() ??
    fail("Set SUPABASE_PROJECT_REF to the project ref (the subdomain of your project URL).");
  if (!/^[a-z0-9]{20}$/.test(ref)) fail(`"${ref}" does not look like a Supabase project ref.`);
  const token =
    env("SUPABASE_ACCESS_TOKEN") ??
    fail(
      "Set SUPABASE_ACCESS_TOKEN to a Supabase access token for the project's organization " +
        "(Dashboard → Account → Access Tokens).",
    );

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}/v1/projects/${ref}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep the raw text
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : text.slice(0, 500);
      throw new ManagementError(response.status, message || `HTTP ${response.status}`);
    }
    return parsed as T;
  }

  const sql = <Row extends object>(query: string, parameters?: unknown[]) =>
    request<Row[]>("POST", "/database/query", { query, ...(parameters ? { parameters } : {}) });
  return {
    ref,
    request: (method, path, body) =>
      method.toUpperCase() === "GET"
        ? retryRead(() => request(method, path))
        : request(method, path, body),
    sql,
    read: (query, parameters) => retryRead(() => sql(query, parameters)),
  };
}

/**
 * The project's secret (service) key, read through the Management API. Used when the operator
 * supplies an access token instead of copying the key by hand. The value is never printed.
 */
export async function secretKeyFromApi(): Promise<string | undefined> {
  if (!env("SUPABASE_ACCESS_TOKEN") || !projectRef()) return undefined;
  const keys = await managementClient().request<
    { name?: string; type?: string; api_key?: string }[]
  >("GET", "/api-keys?reveal=true");
  const usable = keys.filter((key) => typeof key.api_key === "string" && key.api_key.length > 0);
  const secret =
    usable.find((key) => key.type === "secret" && key.name === "default") ??
    usable.find((key) => key.type === "secret") ??
    usable.find((key) => key.name === "service_role");
  return secret?.api_key;
}
