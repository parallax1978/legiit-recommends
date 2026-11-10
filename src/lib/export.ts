import "server-only";
import { getSession, type Session } from "@/lib/session";
import { createClient, type ServerClient } from "@/lib/supabase/server";

const PAGE = 1000;
/** Upper bound on rows per export, so one request cannot exhaust the function's memory. */
export const EXPORT_ROW_LIMIT = 50_000;

export interface ExportContext {
  supabase: ServerClient;
  session: Session;
}

/**
 * Exports run as the signed-in user: every query goes through row level security, so an id in
 * the URL never grants access to another workspace's data.
 */
export async function exportContext(): Promise<ExportContext | Response> {
  const session = await getSession();
  if (!session)
    return new Response("Sign in to export data.", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  return { supabase: await createClient(), session };
}

export function notFoundResponse(): Response {
  return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
}

/** Reads every row of a query in pages (the Data API returns at most 1000 rows per request). */
export async function fetchAll<Row>(
  page: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>,
  limit = EXPORT_ROW_LIMIT,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error("The export could not be read.");
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export function fileSlug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "export"
  );
}

function headers(contentType: string, filename: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

export function csvResponse(filename: string, csv: string): Response {
  return new Response(csv, { headers: headers("text/csv; charset=utf-8", filename) });
}

export function jsonResponse(filename: string, value: unknown): Response {
  return new Response(JSON.stringify(value, null, 2), {
    headers: headers("application/json; charset=utf-8", filename),
  });
}

export const today = () => new Date().toISOString().slice(0, 10);
