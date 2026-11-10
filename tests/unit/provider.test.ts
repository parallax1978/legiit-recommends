import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { describe, expect, it } from "vitest";
import { useBackgroundMode } from "@shared/core/capabilities.ts";
import { estimateSingleInputTokens, estimateTurnInputTokens } from "@shared/core/estimate.ts";
import { parseClassification } from "@shared/provider/classify.ts";
import { buildGenerationRequest, parseGeneration } from "@shared/provider/generate.ts";
import { buildRequestBody, classifyError, extractOutput, normalizeUsage, retryAfterMs } from "@shared/provider/openai.ts";
import { planProbe, probeModel } from "@shared/provider/probe.ts";
import { buildFreshCheckRequest, buildTurnRequest } from "@shared/provider/requests.ts";
import type { ProviderClient, ProviderOutcome, ResponsesRequest } from "@shared/provider/types.ts";
import { EMPTY_USAGE } from "@shared/provider/types.ts";
import packageJson from "../../package.json" with { type: "json" };
import denoJson from "../../supabase/functions/deno.json" with { type: "json" };

const apiError = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  APIError.generate(status, { error: body }, undefined, new Headers(headers));

describe("request building", () => {
  it("sends a conversation turn as a bare user message with chaining and storage", () => {
    const first = buildRequestBody(buildTurnRequest({ model: "m", params: {}, maxOutputTokens: 500, prompt: "Q1", previousResponseId: null, background: false, clientRequestId: "a" }));
    expect(first).toEqual({ model: "m", input: "Q1", store: true, max_output_tokens: 500 });
    const second = buildRequestBody(buildTurnRequest({ model: "m", params: { reasoning_effort: "low", verbosity: "high" }, maxOutputTokens: 500, prompt: "Q2", previousResponseId: "resp_1", background: true, clientRequestId: "b" }));
    expect(second).toEqual({ model: "m", input: "Q2", store: true, max_output_tokens: 500, previous_response_id: "resp_1", background: true, reasoning: { effort: "low" }, text: { verbosity: "high" } });
  });

  it("gives a fresh check no way to carry context", () => {
    const body = buildRequestBody(buildFreshCheckRequest({ model: "m", params: { temperature: 0.3, top_p: 0.9 }, maxOutputTokens: 300, question: "Best bakeries?", store: false, background: false, clientRequestId: "c" }));
    expect(body).toEqual({ model: "m", input: "Best bakeries?", store: false, max_output_tokens: 300, temperature: 0.3, top_p: 0.9 });
    for (const key of ["previous_response_id", "instructions", "metadata", "conversation", "user", "prompt_cache_key", "safety_identifier", "tools"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("omits unset parameters instead of sending defaults", () => {
    const body = buildRequestBody({ model: "m", input: "x", store: true, max_output_tokens: 16, params: {} });
    expect(Object.keys(body).sort()).toEqual(["input", "max_output_tokens", "model", "store"]);
  });

  it("keeps the edge function's SDK version in step with the tested one", () => {
    expect(denoJson.imports.openai).toBe(`npm:openai@${packageJson.devDependencies.openai}`);
    expect(denoJson.imports["@supabase/supabase-js"]).toBe(`npm:@supabase/supabase-js@${packageJson.dependencies["@supabase/supabase-js"]}`);
  });
});

describe("error classification", () => {
  const started = Date.now();
  it("separates rate limits from exhausted quota", () => {
    const limited = classifyError(apiError(429, { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" }, { "retry-after": "12" }), started);
    expect(limited).toMatchObject({ class: "rate_limited", uncertain: false, http_status: 429, retry_after_ms: 12000 });
    for (const body of [
      { message: "quota", type: "insufficient_quota", code: "insufficient_quota" },
      { message: "spend", type: "insufficient_quota", code: "project_spend_limit_exceeded" },
      { message: "credit", code: "credit_balance_exhausted" },
    ]) {
      expect(classifyError(apiError(429, body), started).class).toBe("quota_exhausted");
    }
    expect(classifyError(apiError(429, { message: "slow down", type: "rate_limit_error", code: "slow_down" }), started).class).toBe("rate_limited");
  });

  it("treats credential, model and request problems as actionable", () => {
    expect(classifyError(apiError(401, { message: "Incorrect API key", code: "invalid_api_key" }), started).class).toBe("invalid_credentials");
    expect(classifyError(apiError(403, { message: "Country not supported" }), started).class).toBe("permission_denied");
    expect(classifyError(apiError(404, { message: "The model `x` does not exist", code: "model_not_found" }), started).class).toBe("model_unavailable");
    expect(classifyError(apiError(400, { message: "Unsupported parameter: 'temperature'", code: "unsupported_parameter", param: "temperature" }), started))
      .toMatchObject({ class: "invalid_request", param: "temperature", code: "unsupported_parameter" });
  });

  it("recognizes missing conversation state", () => {
    expect(classifyError(apiError(400, { message: "Previous response with id 'resp_1' not found.", code: "previous_response_not_found", param: "previous_response_id" }), started).class).toBe("chain_expired");
    expect(classifyError(apiError(404, { message: "Response not found", param: "previous_response_id" }), started).class).toBe("chain_expired");
  });

  it("marks timeouts and dropped connections as possibly processed, refused connections as not sent", () => {
    expect(classifyError(new APIConnectionTimeoutError(), started)).toMatchObject({ class: "timeout", uncertain: true });
    expect(classifyError(new APIConnectionError({ message: "Connection error.", cause: new Error("socket hang up") }), started)).toMatchObject({ class: "connection_error", uncertain: true });
    expect(classifyError(new APIConnectionError({ message: "Connection error.", cause: new Error("connect ECONNREFUSED 127.0.0.1:1") }), started)).toMatchObject({ class: "connection_error", uncertain: false });
    expect(classifyError(apiError(503, { message: "overloaded", code: "server_is_overloaded" }, { "retry-after": "3" }), started)).toMatchObject({ class: "server_error", uncertain: false, retry_after_ms: 3000 });
    expect(classifyError(new Error("something odd"), started)).toMatchObject({ class: "connection_error", uncertain: true });
  });

  it("reads retry guidance from every header form", () => {
    expect(retryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(retryAfterMs(new Headers({ "retry-after": "2.5" }))).toBe(2500);
    const now = Date.parse("2026-11-10T00:00:00Z");
    expect(retryAfterMs(new Headers({ "retry-after": "Tue, 10 Nov 2026 00:00:30 GMT" }), now)).toBe(30000);
    expect(retryAfterMs(new Headers({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "6m0s" }))).toBe(360000);
    expect(retryAfterMs(new Headers({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "250ms" }))).toBe(250);
    expect(retryAfterMs(new Headers({ "x-ratelimit-remaining-requests": "5", "x-ratelimit-reset-requests": "1s" }))).toBeNull();
    expect(retryAfterMs(new Headers())).toBeNull();
  });
});

describe("response parsing", () => {
  it("normalizes usage including cache and reasoning details", () => {
    expect(normalizeUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 30, cache_write_tokens_details: { ttl_30m_tokens: 20, ttl_12h_tokens: 10 } },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 12 },
      total_tokens: 150,
    })).toEqual({ input_tokens: 100, cached_tokens: 40, cache_write_tokens: 30, cache_write_30m_tokens: 20, cache_write_12h_tokens: 10, output_tokens: 50, reasoning_tokens: 12, total_tokens: 150 });
    expect(normalizeUsage(null)).toEqual(EMPTY_USAGE);
  });

  it("takes the final answer text and flags refusals", () => {
    const message = (content: unknown[], phase?: string) => ({ type: "message", id: "m", role: "assistant", status: "completed", content, ...(phase ? { phase } : {}) });
    expect(extractOutput({ output: [
      { type: "reasoning", id: "r", summary: [] },
      message([{ type: "output_text", text: "thinking out loud", annotations: [] }], "commentary"),
      message([{ type: "output_text", text: "Final list", annotations: [] }], "final_answer"),
    ] as never })).toEqual({ text: "Final list", refusal: false });
    expect(extractOutput({ output: [message([{ type: "refusal", refusal: "I can't help with that." }])] as never })).toEqual({ text: "I can't help with that.", refusal: true });
    expect(extractOutput({ output: [] as never })).toEqual({ text: "", refusal: false });
  });
});

describe("estimates and execution mode", () => {
  it("reserves the whole chain for later turns", () => {
    const first = estimateTurnInputTokens("Hello there", null);
    const later = estimateTurnInputTokens("Hello there", { input_tokens: 500, output_tokens: 300 });
    expect(first).toBe(estimateSingleInputTokens("Hello there"));
    expect(later).toBe(first + 800);
  });

  it("chooses background mode only where it is supported and useful", () => {
    const base = { params: {}, maxOutputTokens: 1000, backgroundSupported: true, previousAttemptTimedOut: false };
    expect(useBackgroundMode({ ...base, mode: "auto" })).toBe(false);
    expect(useBackgroundMode({ ...base, mode: "sync", previousAttemptTimedOut: true })).toBe(false);
    expect(useBackgroundMode({ ...base, mode: "background" })).toBe(true);
    expect(useBackgroundMode({ ...base, mode: "background", backgroundSupported: false })).toBe(false);
    expect(useBackgroundMode({ ...base, mode: "auto", params: { reasoning_effort: "high" } })).toBe(true);
    expect(useBackgroundMode({ ...base, mode: "auto", maxOutputTokens: 20000 })).toBe(true);
    expect(useBackgroundMode({ ...base, mode: "auto", previousAttemptTimedOut: true })).toBe(true);
  });
});

describe("model verification", () => {
  function stubProvider(accept: (request: ResponsesRequest) => boolean): { provider: ProviderClient; sent: ResponsesRequest[] } {
    const sent: ResponsesRequest[] = [];
    let counter = 0;
    const result = (request: ResponsesRequest): ProviderOutcome => ({
      kind: "result",
      result: {
        status: "completed", response_id: `resp_${++counter}`, output_text: "OK", output_items: [], returned_model: `${request.model}-snapshot`,
        service_tier: "default", incomplete_reason: null, refusal: false, provider_request_id: null, http_status: 200, latency_ms: 1,
        usage: { ...EMPTY_USAGE, input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        echo: { reasoning_effort: "medium", verbosity: null, temperature: null, top_p: null, max_output_tokens: request.max_output_tokens },
      },
    });
    const rejected = (param: string): ProviderOutcome => ({
      kind: "failure",
      failure: { class: "invalid_request", uncertain: false, http_status: 400, type: "invalid_request_error", code: "unsupported_parameter", param, message: `Unsupported parameter: '${param}'. Expected a value <= 4096`, retry_after_ms: null, provider_request_id: null, response_id: null, latency_ms: 1 },
    });
    const provider: ProviderClient = {
      async createResponse(request) {
        sent.push(request);
        return accept(request) ? result(request) : rejected("x");
      },
      async retrieveResponse() { throw new Error("not used"); },
      async cancelResponse() { throw new Error("not used"); },
      async listModels() { return { ok: true, models: [] }; },
    };
    return { provider, sent };
  }

  it("discovers exactly what the provider accepts", async () => {
    const { provider, sent } = stubProvider((request) => {
      const effort = request.params.reasoning_effort;
      if (effort && !["none", "low", "medium"].includes(effort)) return false;
      if ((request.params.temperature !== undefined || request.params.top_p !== undefined) && effort !== "none") return false;
      if (request.params.verbosity) return false;
      if (request.max_output_tokens > 4096) return false;
      if (request.background) return false;
      return true;
    });
    const outcomes: string[] = [];
    const unused: string[] = [];
    const result = await probeModel(provider, "some-model", 8000, {
      onOutcome: async (key) => void outcomes.push(key),
      onUnused: async (key) => void unused.push(key),
    });
    expect(result.verified).toBe(true);
    expect(result.capabilities).toMatchObject({
      chaining: true,
      reasoning_efforts: ["none", "low", "medium"],
      default_reasoning_effort: "medium",
      temperature: "effort_none",
      top_p: "effort_none",
      verbosity: [],
      max_output_tokens_verified: 32,
      max_output_tokens_limit: 4096,
      background: false,
      returned_model: "some-model-snapshot",
    });
    // Every planned step was either sent (and accounted) or released.
    const planned = planProbe(8000).map((step) => step.key);
    expect([...outcomes, ...unused].sort()).toEqual([...planned].sort());
    expect(new Set(outcomes).size).toBe(outcomes.length);
    // The chain check really continued from the first response.
    expect(sent[1]!.previous_response_id).toBe("resp_1");
    expect(sent.every((request) => request.model === "some-model")).toBe(true);
  });

  it("fails verification when the model does not answer at all, and releases the rest", async () => {
    const { provider } = stubProvider(() => false);
    const unused: string[] = [];
    const result = await probeModel(provider, "broken", 100, { onOutcome: async () => undefined, onUnused: async (key) => void unused.push(key) });
    expect(result).toMatchObject({ verified: false, capabilities: null });
    expect(unused.length).toBe(planProbe(100).length - 1);
  });
});

describe("generation and classification parsing", () => {
  const context = { kind: "inclusion_request" as const, count: 3, values: { category: "bakeries" }, examples: [] };
  const target = { business_name: "Acme Bakery", website_url: "https://acme.example" };

  it("asks for placeholders and never sends the business to question generators", () => {
    const question = buildGenerationRequest({ ...context, kind: "fresh_check" }, "m", {}, 500);
    expect(question.instructions).toContain("Never mention any business");
    expect(question.instructions).not.toContain("{{business_name}}");
    expect(question.input).not.toContain("Acme");
    const inclusion = buildGenerationRequest(context, "m", {}, 500);
    expect(inclusion.instructions).toContain("{{business_name}}");
    expect(inclusion.store).toBe(false);
  });

  it("parses JSON, fenced JSON and plain lists, restoring placeholders", () => {
    const parsed = parseGeneration('```json\n{"variations": ["Please add Acme Bakery to the list.", "Include {{business_name}} too?", "Include {{business_name}} too?", "Use {{unknown}} here"]}\n```', context, target);
    expect(parsed.candidates).toEqual(["Please add {{business_name}} to the list.", "Include {{business_name}} too?"]);
    expect(parsed.rejected).toEqual([{ text: "Use {{unknown}} here", reason: "Unknown variable {{unknown}}." }]);
    expect(parseGeneration("1. First {{business_name}}\n- Second {{business_name}}", context, target).candidates).toEqual(["First {{business_name}}", "Second {{business_name}}"]);
  });

  it("drops generated questions that name the target", () => {
    const parsed = parseGeneration(JSON.stringify({ variations: ["Best bakeries nearby?", "Is Acme Bakery the best?", "What about acme.example?"] }), { ...context, kind: "fresh_check" }, target);
    expect(parsed.candidates).toEqual(["Best bakeries nearby?"]);
    expect(parsed.rejected).toHaveLength(2);
  });

  it("reads model classifications strictly", () => {
    expect(parseClassification('{"inclusion":"included","rank":3,"list_position":null,"reason":"Item 3."}')).toMatchObject({ inclusion: "included", rank: 3, list_position: null, list_kind: "numbered", mentioned: true });
    expect(parseClassification('{"inclusion":"included","rank":null,"list_position":2}')).toMatchObject({ rank: null, list_position: 2, list_kind: "bulleted" });
    expect(parseClassification('{"inclusion":"mentioned_only","rank":4}')).toMatchObject({ inclusion: "mentioned_only", rank: null, list_position: null });
    expect(parseClassification('{"inclusion":"not_mentioned"}')).toMatchObject({ mentioned: false });
    expect(parseClassification('{"inclusion":"probably"}')).toBeNull();
    expect(parseClassification("no json here")).toBeNull();
  });
});
