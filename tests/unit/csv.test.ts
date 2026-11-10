import { describe, expect, it } from "vitest";
import { neutralizeFormula, parseCsv, parsePromptCsv, toCsv } from "@shared/core/csv.ts";

describe("CSV export", () => {
  it("neutralizes cells a spreadsheet would evaluate", () => {
    for (const payload of [
      '=HYPERLINK("http://evil.test")',
      "+1+1",
      "-2+3",
      "@SUM(A1:A2)",
      "\t=1",
      "\r=1",
      "  =cmd|' /C calc'!A0",
    ]) {
      expect(neutralizeFormula(payload).startsWith("'")).toBe(true);
    }
    expect(neutralizeFormula("Plain text - with a dash")).toBe("Plain text - with a dash");
    expect(neutralizeFormula("3 + 4")).toBe("3 + 4");
  });

  it("escapes formulas inside exported rows but keeps real numbers numeric", () => {
    const csv = toCsv(
      [{ name: "=1+1", note: 'He said "hi", twice', cost: -0.25, ok: true, none: null }],
      [
        { header: "name", value: (row) => row.name },
        { header: "note", value: (row) => row.note },
        { header: "cost", value: (row) => row.cost },
        { header: "ok", value: (row) => row.ok },
        { header: "none", value: (row) => row.none },
      ],
      { bom: false },
    );
    expect(csv).toBe('name,note,cost,ok,none\r\n\'=1+1,"He said ""hi"", twice",-0.25,true,\r\n');
  });

  it("round-trips quoted fields with commas, quotes and line breaks", () => {
    const rows = [{ a: "line one\nline two", b: 'quote " and, comma' }];
    const csv = toCsv(rows, [
      { header: "a", value: (row) => row.a },
      { header: "b", value: (row) => row.b },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["line one\nline two", 'quote " and, comma'],
    ]);
  });
});

describe("prompt CSV import", () => {
  it("reads a header row with body and label columns", () => {
    expect(
      parsePromptCsv('label,body\nShort,What are the best {{category}}?\n,"Second, with comma"\n'),
    ).toEqual([
      { body: "What are the best {{category}}?", label: "Short" },
      { body: "Second, with comma", label: null },
    ]);
  });

  it("reads a single column without a header and skips blank lines", () => {
    expect(parsePromptCsv("First prompt\r\n\r\nSecond prompt\r\n")).toEqual([
      { body: "First prompt", label: null },
      { body: "Second prompt", label: null },
    ]);
  });

  it("removes the apostrophe an earlier export added in front of a formula-like prompt", () => {
    expect(parsePromptCsv('body\n"\'=not a formula, just text"\n')).toEqual([
      { body: "=not a formula, just text", label: null },
    ]);
  });
});
