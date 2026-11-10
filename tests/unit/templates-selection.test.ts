import { describe, expect, it } from "vitest";
import { selectCombination, totalCombinations } from "@shared/core/selection.ts";
import {
  allowedVariables,
  extractVariables,
  hasRenderingProblem,
  renderTemplate,
  templateProblem,
  unresolvedVariables,
} from "@shared/core/templates.ts";

describe("templates", () => {
  const values = {
    business_name: "Acme Bakery",
    website_url: "https://acme.example",
    category: "bakeries",
    location: "Leeds",
    language: "English",
  };

  it("renders every supported variable and tolerates inner whitespace", () => {
    expect(
      renderTemplate(
        "Best {{category}} in {{ location }}? Add {{business_name}} ({{website_url}}) in {{language}}.",
        values,
      ),
    ).toBe("Best bakeries in Leeds? Add Acme Bakery (https://acme.example) in English.");
  });

  it("leaves unknown placeholders in place so they are caught, never silently dropped", () => {
    const rendered = renderTemplate("Compare with {{competitor}}", values);
    expect(rendered).toBe("Compare with {{competitor}}");
    expect(hasRenderingProblem(rendered)).toBe(true);
    expect(templateProblem("Compare with {{competitor}}", "initial_question")).toBe(
      "Unknown variable {{competitor}}.",
    );
  });

  it("reports variables without a value as unresolved", () => {
    expect(
      unresolvedVariables("Best {{category}} in {{location}}", {
        category: "bakeries",
        location: "  ",
      }),
    ).toEqual(["location"]);
    expect(unresolvedVariables("Best {{category}}", { category: "bakeries" })).toEqual([]);
    expect(hasRenderingProblem("   ")).toBe(true);
  });

  it("rejects empty, malformed and over-long prompts", () => {
    expect(templateProblem("", "initial_question")).toMatch(/empty/);
    expect(templateProblem("Open {{category", "initial_question")).toMatch(/unclosed or stray/);
    expect(templateProblem("x".repeat(4001), "initial_question")).toMatch(/longer than 4000/);
    expect(templateProblem("{{Business Name}}", "inclusion_request")).toMatch(
      /not a valid variable/,
    );
    expect(templateProblem("Add {{business_name}}", "inclusion_request")).toBeNull();
  });

  it("never allows target variables in fresh-check questions", () => {
    expect(allowedVariables("fresh_check")).toEqual(["category", "location", "language"]);
    expect(templateProblem("Is {{business_name}} good?", "fresh_check")).toMatch(
      /must not mention the target/,
    );
    expect(templateProblem("Visit {{website_url}}?", "fresh_check")).toMatch(
      /must not mention the target/,
    );
    expect(templateProblem("Best {{category}} in {{location}}?", "fresh_check")).toBeNull();
  });

  it("extracts unique, sorted variable names", () => {
    expect(extractVariables("{{location}} {{category}} {{ location }}")).toEqual([
      "category",
      "location",
    ]);
  });
});

describe("variation selection", () => {
  const counts = [4, 3, 2];
  const total = Number(totalCombinations(counts));

  it("is deterministic for the same seed and ordinal", () => {
    const a = selectCombination({ mode: "balanced", seed: "s1", ordinal: 7, counts });
    const b = selectCombination({ mode: "balanced", seed: "s1", ordinal: 7, counts });
    expect(a).toEqual(b);
    const r1 = selectCombination({ mode: "seeded_random", seed: "s1", ordinal: 7, counts });
    const r2 = selectCombination({ mode: "seeded_random", seed: "s1", ordinal: 7, counts });
    expect(r1).toEqual(r2);
  });

  it("balanced mode uses every combination exactly once per cycle and each wording equally", () => {
    for (const seed of ["s1", "another-seed", "0", "ünïcödé"]) {
      const seen = new Set<string>();
      const perStep = counts.map((count) => new Array<number>(count).fill(0));
      for (let n = 0; n < total; n += 1) {
        const pick = selectCombination({ mode: "balanced", seed, ordinal: n, counts });
        seen.add(pick.indices.join("-"));
        pick.indices.forEach((index, step) => (perStep[step]![index]! += 1));
        expect(pick.cycle).toBe(0n);
      }
      expect(seen.size).toBe(total);
      perStep.forEach((uses, step) =>
        expect(new Set(uses)).toEqual(new Set([total / counts[step]!])),
      );
    }
  });

  it("repeats combinations after the library is exhausted", () => {
    const first = selectCombination({ mode: "balanced", seed: "s1", ordinal: 3, counts });
    const again = selectCombination({ mode: "balanced", seed: "s1", ordinal: 3 + total, counts });
    expect(again.indices).toEqual(first.indices);
    expect(again.cycle).toBe(1n);
  });

  it("different seeds give different orders", () => {
    const order = (seed: string) =>
      Array.from({ length: total }, (_, n) =>
        selectCombination({ mode: "balanced", seed, ordinal: n, counts }).indices.join(""),
      );
    expect(order("s1")).not.toEqual(order("s2"));
  });

  it("consecutive runs vary in more than the first step", () => {
    const picks = Array.from(
      { length: 6 },
      (_, n) =>
        selectCombination({ mode: "balanced", seed: "s1", ordinal: n, counts: [5, 5, 5] }).indices,
    );
    expect(new Set(picks.map((p) => p[1])).size).toBeGreaterThan(1);
    expect(new Set(picks.map((p) => p[2])).size).toBeGreaterThan(1);
  });

  it("seeded random stays within range and covers the space over time", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 400; n += 1) {
      const pick = selectCombination({ mode: "seeded_random", seed: "s9", ordinal: n, counts });
      pick.indices.forEach((index, step) => {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(counts[step]!);
      });
      seen.add(pick.indices.join("-"));
    }
    expect(seen.size).toBe(total);
  });

  it("handles a single combination and very large libraries", () => {
    expect(
      selectCombination({ mode: "balanced", seed: "s", ordinal: 5, counts: [1, 1, 1] }).indices,
    ).toEqual([0, 0, 0]);
    const big = selectCombination({
      mode: "balanced",
      seed: "s",
      ordinal: 12345,
      counts: new Array(12).fill(500),
    });
    expect(big.indices).toHaveLength(12);
    expect(big.totalCombinations).toBe(500n ** 12n);
  });

  it("rejects invalid input", () => {
    expect(() => selectCombination({ mode: "balanced", seed: "s", ordinal: -1, counts })).toThrow();
    expect(() =>
      selectCombination({ mode: "balanced", seed: "s", ordinal: 0, counts: [2, 0] }),
    ).toThrow();
    expect(() =>
      selectCombination({ mode: "balanced", seed: "s", ordinal: 0, counts: [] }),
    ).toThrow();
  });
});
