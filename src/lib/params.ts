export type SearchParams = Record<string, string | string[] | undefined>;

export function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export function pageNumber(value: string | string[] | undefined): number {
  const page = Number(first(value));
  return Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(value: string | string[] | undefined): string | null {
  const text = first(value);
  return UUID.test(text) ? text : null;
}

/** Escapes the characters that are wildcards in a PostgREST `ilike` pattern. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`).replace(/[,()]/g, " ")}%`;
}
