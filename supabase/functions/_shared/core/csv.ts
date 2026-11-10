// CSV building and parsing.
//
// Exported text cells are protected against spreadsheet formula injection: a cell that a
// spreadsheet would evaluate (starting with = + - @, or with a tab / carriage return) is prefixed
// with an apostrophe so it is displayed as text. Numbers are written as numbers.

export type CsvValue = string | number | boolean | null | undefined | Date;

const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function formatCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = neutralizeFormula(value instanceof Date ? value.toISOString() : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface CsvColumn<Row> {
  header: string;
  value: (row: Row) => CsvValue;
}

/** RFC 4180 output with CRLF line endings and a UTF-8 byte-order mark for spreadsheet apps. */
export function toCsv<Row>(
  rows: Row[],
  columns: CsvColumn<Row>[],
  options: { bom?: boolean } = {},
): string {
  const lines = [columns.map((column) => formatCell(column.header)).join(",")];
  for (const row of rows)
    lines.push(columns.map((column) => formatCell(column.value(row))).join(","));
  return (options.bom === false ? "" : "\uFEFF") + lines.join("\r\n") + "\r\n";
}

/** Parses CSV text (quoted fields, embedded newlines, CRLF or LF) into rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === "") {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

export interface ImportedPrompt {
  body: string;
  label: string | null;
}

/**
 * Reads prompts from CSV. With a header row, the "body" (or "prompt"/"template"/"text") column
 * is used and an optional "label" column. Without one, the first column is the prompt text.
 * A leading apostrophe added by an earlier export is removed again.
 */
export function parsePromptCsv(text: string): ImportedPrompt[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const bodyIndex = header.findIndex((cell) =>
    ["body", "prompt", "template", "text", "question"].includes(cell),
  );
  const labelIndex = header.findIndex((cell) => cell === "label" || cell === "name");
  const hasHeader = bodyIndex >= 0;
  const data = hasHeader ? rows.slice(1) : rows;
  const prompts: ImportedPrompt[] = [];
  for (const cells of data) {
    let body = (cells[hasHeader ? bodyIndex : 0] ?? "").trim();
    if (/^'[\s]*[=+\-@]/.test(body)) body = body.slice(1);
    if (!body) continue;
    const label = hasHeader && labelIndex >= 0 ? (cells[labelIndex] ?? "").trim() || null : null;
    prompts.push({ body, label });
  }
  return prompts;
}
