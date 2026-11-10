// Reading more rows than fit in one request.
//
// Two limits of the Data API shape every list this app reads:
//   * a response holds at most 1000 rows, so a longer list has to be read in pages;
//   * a filter such as id=in.(…) travels in the URL, and gateways refuse URLs of about 8,000
//     characters. A UUID costs up to 39 of them, so a list of some 200 ids is already too long.
// Queries that ignore either limit work on a small workspace and then quietly return nothing,
// or half of the rows, once it grows. Everything that reads "all rows" or "rows for these ids"
// goes through the helpers below, which also turn a failed read into an error instead of an
// empty list.
//
// The page size equals the project's "Max rows" setting of the Data API (1000 by default, and
// what supabase/config.toml sets locally): a page shorter than that is taken as the last one.
// `npm run auth:configure` (part of every deployment) refuses a project where it is lower.

/** Rows per request when paging: the Data API's default maximum (see the note above). */
export const PAGE_SIZE = 1000;

/** Ids per request: 100 UUIDs are about 4,000 characters of URL, half of what gateways accept. */
export const ID_CHUNK = 100;

/** How many chunk requests run at the same time. */
const PARALLEL_CHUNKS = 5;

/**
 * The Data API's error code for an offset beyond the last row when an exact count was asked
 * for (HTTP 416). For a list with page numbers in its URL that is an empty page, not a fault.
 */
export const PAGE_OUT_OF_RANGE = "PGRST103";

/** Upper bound for a paged read, so one request for a screen cannot read without end. */
export const DEFAULT_ROW_LIMIT = 20_000;

interface QueryResult<Row> {
  data: Row[] | null;
  error: unknown;
}

/** The rows of a finished query. A failed query is an error, never an empty list. */
export async function rowsOf<Row>(
  what: string,
  query: PromiseLike<QueryResult<Row>>,
): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw readError(what, error);
  return data ?? [];
}

/**
 * The error to throw for a read that failed. The page only says that something could not be
 * loaded; the server log keeps the reason (a timeout, a URL that was too long, a permission),
 * which is what tells an operator that a list has outgrown a limit.
 */
export function readError(what: string, cause: unknown): Error {
  const detail = (cause ?? {}) as { code?: unknown; message?: unknown };
  console.error(
    "read_failed",
    what,
    typeof detail.code === "string" ? detail.code : "",
    typeof detail.message === "string" ? detail.message.slice(0, 300) : "",
  );
  return new Error(`${what} could not be loaded.`, { cause });
}

/**
 * Every row of a query, read in pages. `page` must apply `.range(from, to)` to a query with a
 * stable order (end the order with a unique column), or rows can repeat or go missing between
 * pages.
 */
export async function selectAll<Row>(
  what: string,
  page: (from: number, to: number) => PromiseLike<QueryResult<Row>>,
  limit = DEFAULT_ROW_LIMIT,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; from < limit; from += PAGE_SIZE) {
    const batch = await rowsOf(what, page(from, from + PAGE_SIZE - 1));
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Rows for a list of ids, asked for a chunk at a time so the list never has to fit in one URL.
 * `load` receives at most ID_CHUNK distinct ids and returns their rows (use `rowsOf`, or
 * `selectAll` when one id can match many rows). Results keep the order of the chunks.
 */
export async function inChunks<Row>(
  ids: readonly string[],
  load: (chunk: string[]) => Promise<Row[]>,
  chunkSize = ID_CHUNK,
): Promise<Row[]> {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += chunkSize) {
    chunks.push(unique.slice(index, index + chunkSize));
  }
  const rows: Row[] = [];
  for (let index = 0; index < chunks.length; index += PARALLEL_CHUNKS) {
    const loaded = await Promise.all(chunks.slice(index, index + PARALLEL_CHUNKS).map(load));
    for (const batch of loaded) rows.push(...batch);
  }
  return rows;
}
