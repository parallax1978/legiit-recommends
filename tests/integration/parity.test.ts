// The database owns the authoritative template, token and cost logic. The TypeScript twins used
// by the worker and the UI must agree with it exactly.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paramsProblem, type CapabilityProfile } from "@shared/core/capabilities.ts";
import {
  MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
  estimateTextTokens,
  maxCostUsd,
  usageCostUsd,
  type PriceRow,
} from "@shared/core/estimate.ts";
import {
  extractVariables,
  renderTemplate,
  templateProblem,
  type TemplateKind,
} from "@shared/core/templates.ts";
import { closeConnections, resetDatabase, sql } from "./harness.ts";

beforeAll(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await closeConnections();
});

const TEXTS = [
  "",
  "What are the best {{category}} in {{location}}?",
  "Add {{ business_name }} ({{website_url}}) please.",
  "Stray {{ brace",
  "Unknown {{competitor}} here",
  "Bad name {{Business Name}}",
  "   ",
  "Café Zoë’s — naïve façade 日本語のテキスト 🎉🎉",
  "{{category}}{{category}} twice and {{language}}",
  "Tabs\t{{\tlocation\t}}\nnewline",
  "Closing only }} here",
  "x".repeat(4001),
];
const KINDS: TemplateKind[] = [
  "initial_question",
  "inclusion_request",
  "revision_request",
  "extra_step",
  "fresh_check",
];
const VALUES = {
  business_name: "Northwind Roasters",
  website_url: "https://northwindroasters.example",
  category: "coffee subscription services",
  location: "Portland \\1 & $1",
  language: "English",
};

describe("template logic", () => {
  it("validates templates identically", async () => {
    for (const text of TEXTS) {
      for (const kind of KINDS) {
        const [row] = await sql<{ problem: string | null }>(
          "select app_private.template_problem($1, $2::public.template_kind) as problem",
          [text, kind],
        );
        expect(templateProblem(text, kind), `${kind}: ${text.slice(0, 40)}`).toBe(row!.problem);
      }
    }
  });

  it("extracts variables identically", async () => {
    for (const text of TEXTS) {
      const [row] = await sql<{ vars: string[] }>(
        "select app_private.template_variables($1) as vars",
        [text],
      );
      expect(extractVariables(text), text.slice(0, 40)).toEqual(row!.vars);
    }
  });

  it("renders identically, including replacement-pattern characters in values", async () => {
    for (const text of TEXTS) {
      if (templateProblem(text, "inclusion_request")) continue;
      const [row] = await sql<{ rendered: string }>(
        "select app_private.render_template($1, $2::jsonb) as rendered",
        [text, JSON.stringify(VALUES)],
      );
      expect(renderTemplate(text, VALUES), text.slice(0, 40)).toBe(row!.rendered);
    }
  });
});

describe("token and cost estimates", () => {
  it("estimates tokens identically", async () => {
    for (const text of TEXTS) {
      const [row] = await sql<{ tokens: number }>(
        "select app_private.estimate_text_tokens($1) as tokens",
        [text],
      );
      expect(estimateTextTokens(text), text.slice(0, 40)).toBe(row!.tokens);
    }
    const [overheads] = await sql<{ message: number; request: number }>(
      "select app_private.message_overhead_tokens() as message, app_private.request_overhead_tokens() as request",
    );
    expect({ message: MESSAGE_OVERHEAD_TOKENS, request: REQUEST_OVERHEAD_TOKENS }).toEqual(
      overheads,
    );
  });

  it("computes reservation and usage costs identically for every seeded price", async () => {
    const prices = await sql<PriceRow & { id: string; model_id: string }>(
      "select * from public.model_prices where workspace_id is null order by model_id",
    );
    expect(prices.length).toBeGreaterThan(20);
    const cases = [
      { input: 0, output: 0, cached: 0, cw: 0, cw30: 0, cw12: 0 },
      { input: 137, output: 16, cached: 0, cw: 0, cw30: 0, cw12: 0 },
      { input: 2048, output: 913, cached: 1024, cw: 0, cw30: 0, cw12: 0 },
      { input: 5000, output: 1200, cached: 1024, cw: 2048, cw30: 2048, cw12: 0 },
      { input: 5000, output: 1200, cached: 0, cw: 3000, cw30: 1000, cw12: 1500 },
      { input: 300000, output: 8000, cached: 10000, cw: 0, cw30: 0, cw12: 0 }, // long context
      { input: 272001, output: 1, cached: 0, cw: 0, cw30: 0, cw12: 0 },
      { input: 1, output: 128000, cached: 5, cw: 0, cw30: 0, cw12: 0 }, // cached > input is clamped
    ];
    for (const raw of prices) {
      const price: PriceRow = {
        input_usd_per_mtok: Number(raw.input_usd_per_mtok),
        cached_input_usd_per_mtok:
          raw.cached_input_usd_per_mtok === null ? null : Number(raw.cached_input_usd_per_mtok),
        output_usd_per_mtok: Number(raw.output_usd_per_mtok),
        cache_write_30m_usd_per_mtok:
          raw.cache_write_30m_usd_per_mtok === null
            ? null
            : Number(raw.cache_write_30m_usd_per_mtok),
        cache_write_12h_usd_per_mtok:
          raw.cache_write_12h_usd_per_mtok === null
            ? null
            : Number(raw.cache_write_12h_usd_per_mtok),
        long_context_threshold_tokens: raw.long_context_threshold_tokens,
        long_context_input_multiplier:
          raw.long_context_input_multiplier === null
            ? null
            : Number(raw.long_context_input_multiplier),
        long_context_output_multiplier:
          raw.long_context_output_multiplier === null
            ? null
            : Number(raw.long_context_output_multiplier),
      };
      for (const c of cases) {
        const [row] = await sql<{ max_cost: string; usage_cost: string }>(
          `select app_private.max_cost(p, $2, $3) as max_cost,
                  app_private.usage_cost(p, $2, $4, $5, $6, $7, $3) as usage_cost
           from public.model_prices p where p.id = $1`,
          [raw.id, c.input, c.output, c.cached, c.cw, c.cw30, c.cw12],
        );
        const label = `${raw.model_id} ${JSON.stringify(c)}`;
        expect(maxCostUsd(price, c.input, c.output), label).toBeCloseTo(Number(row!.max_cost), 8);
        expect(
          usageCostUsd(price, {
            input_tokens: c.input,
            cached_tokens: c.cached,
            cache_write_tokens: c.cw,
            cache_write_30m_tokens: c.cw30,
            cache_write_12h_tokens: c.cw12,
            output_tokens: c.output,
          }),
          label,
        ).toBeCloseTo(Number(row!.usage_cost), 8);
        // A reservation is never smaller than what the same usage would cost.
        expect(Number(row!.max_cost) + 1e-9, label).toBeGreaterThanOrEqual(Number(row!.usage_cost));
      }
    }
  });
});

describe("parameter rules", () => {
  it("accepts and rejects the same parameter combinations", async () => {
    const profiles: CapabilityProfile[] = [
      {
        probe_version: 1,
        probed_at: "2026-11-10T00:00:00Z",
        chaining: true,
        reasoning_efforts: [],
        default_reasoning_effort: null,
        temperature: "always",
        top_p: "always",
        verbosity: [],
        max_output_tokens_verified: 2000,
        max_output_tokens_limit: null,
        background: false,
        returned_model: null,
        notes: [],
      },
      {
        probe_version: 1,
        probed_at: "2026-11-10T00:00:00Z",
        chaining: true,
        reasoning_efforts: ["none", "low", "high"],
        default_reasoning_effort: "low",
        temperature: "effort_none",
        top_p: "never",
        verbosity: ["low", "medium", "high"],
        max_output_tokens_verified: 4000,
        max_output_tokens_limit: 8192,
        background: true,
        returned_model: null,
        notes: [],
      },
      {
        probe_version: 1,
        probed_at: "2026-11-10T00:00:00Z",
        chaining: false,
        reasoning_efforts: ["low"],
        default_reasoning_effort: "low",
        temperature: "never",
        top_p: "never",
        verbosity: [],
        max_output_tokens_verified: 32,
        max_output_tokens_limit: null,
        background: false,
        returned_model: null,
        notes: [],
      },
    ];
    const params: Record<string, unknown>[] = [
      {},
      { temperature: 0.7 },
      { temperature: 2.5 },
      { temperature: 0.2, reasoning_effort: "none" },
      { temperature: 0.2, reasoning_effort: "low" },
      { top_p: 0.5 },
      { top_p: 0 },
      { reasoning_effort: "high" },
      { reasoning_effort: "max" },
      { verbosity: "high" },
      { verbosity: "extreme" },
      { frequency_penalty: 1 },
    ];
    const caps = [null, 8, 16, 1000, 3000, 5000, 9000];
    for (const profile of profiles) {
      for (const p of params) {
        for (const cap of caps) {
          for (const chaining of [true, false]) {
            for (const mode of ["auto", "background"] as const) {
              const [row] = await sql<{ problem: string | null }>(
                "select app_private.params_problem($1::jsonb, $2::jsonb, $3, $4, $5) as problem",
                [JSON.stringify(profile), JSON.stringify(p), cap, chaining, mode],
              );
              expect(
                paramsProblem(profile, p, cap, chaining, mode),
                JSON.stringify({ p, cap, chaining, mode }),
              ).toBe(row!.problem);
            }
          }
        }
      }
    }
  });
});
