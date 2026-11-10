/**
 * LIVE smoke test against the real OpenAI API. It spends real money.
 *
 *   OPENAI_API_KEY=sk-... LIVE_SMOKE_MODEL=<model id> LIVE_SMOKE_MAX_USD=0.25 npm run smoke:live
 *
 * It is never run by the test suites or CI. It sends, through the same provider adapter the
 * Edge Functions use:
 *   1. a model listing (free) to confirm the key works and the model is visible to it;
 *   2. one three-turn conversation chained with previous_response_id and stored responses;
 *   3. one fresh check: a single question in a new context.
 * Before each request its worst-case cost is added to a running total and the run stops if the
 * total would exceed LIVE_SMOKE_MAX_USD. Prices come from the project's price table when
 * SUPABASE_URL and SUPABASE_SECRET_KEY are set, or from LIVE_SMOKE_INPUT_USD_PER_MTOK and
 * LIVE_SMOKE_OUTPUT_USD_PER_MTOK. Without a price above zero the test refuses to run.
 *
 * It only ever talks to https://api.openai.com/v1 and refuses to start when OPENAI_BASE_URL
 * points anywhere else, so a pass cannot come from a gateway or from the test double.
 *
 * Optional: LIVE_SMOKE_QUESTION, LIVE_SMOKE_BUSINESS, LIVE_SMOKE_MAX_OUTPUT_TOKENS (default 400).
 */
import { randomUUID } from "node:crypto";
import {
  estimateSingleInputTokens,
  estimateTurnInputTokens,
  maxCostUsd,
  usageCostUsd,
  type PriceRow,
} from "../supabase/functions/_shared/core/estimate.ts";
import { createOpenAIProvider } from "../supabase/functions/_shared/provider/openai.ts";
import {
  buildFreshCheckRequest,
  buildTurnRequest,
} from "../supabase/functions/_shared/provider/requests.ts";
import type {
  ProviderOutcome,
  ProviderResult,
  ResponsesRequest,
} from "../supabase/functions/_shared/provider/types.ts";
import { adminClient, env, fail, loadEnvFiles, requireEnv } from "./lib/env";
import { OPENAI_API_BASE_URL, endpointOverrideProblem, positivePrice } from "./lib/smoke";

async function loadPrice(model: string): Promise<PriceRow> {
  const input = env("LIVE_SMOKE_INPUT_USD_PER_MTOK");
  const output = env("LIVE_SMOKE_OUTPUT_USD_PER_MTOK");
  if (input && output) {
    return {
      input_usd_per_mtok: Number(input),
      cached_input_usd_per_mtok: null,
      output_usd_per_mtok: Number(output),
      cache_write_30m_usd_per_mtok: null,
      cache_write_12h_usd_per_mtok: null,
      long_context_threshold_tokens: null,
      long_context_input_multiplier: null,
      long_context_output_multiplier: null,
    };
  }
  if (env("SUPABASE_URL") && (env("SUPABASE_SECRET_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY"))) {
    const admin = await adminClient();
    const { data } = await admin
      .from("model_prices")
      .select("*")
      .eq("provider", "openai")
      .eq("model_id", model)
      .is("workspace_id", null)
      .order("version", { ascending: false })
      .limit(1);
    if (data?.[0]) return data[0] as PriceRow;
  }
  fail(
    `No price is known for "${model}", so the spending cap cannot be enforced. ` +
      "Set LIVE_SMOKE_INPUT_USD_PER_MTOK and LIVE_SMOKE_OUTPUT_USD_PER_MTOK from the provider's price list, " +
      "or point SUPABASE_URL / SUPABASE_SECRET_KEY at a project whose price table lists the model.",
  );
}

async function main() {
  loadEnvFiles();
  const redirected = endpointOverrideProblem(env("OPENAI_BASE_URL"));
  if (redirected) fail(redirected);
  const apiKey = requireEnv("OPENAI_API_KEY", "Use a key limited to the model you want to test.");
  const model = requireEnv("LIVE_SMOKE_MODEL", "Set it to an exact model ID your key can use.");
  const cap = Number(
    requireEnv("LIVE_SMOKE_MAX_USD", "The most this run may spend, for example 0.25."),
  );
  if (!(cap > 0)) fail("LIVE_SMOKE_MAX_USD must be a positive number.");
  const maxOutput = Number(env("LIVE_SMOKE_MAX_OUTPUT_TOKENS") ?? 400);
  const question =
    env("LIVE_SMOKE_QUESTION") ??
    "What are some well-regarded project management tools for small teams?";
  const business = env("LIVE_SMOKE_BUSINESS") ?? "Example Planner (https://planner.example)";
  const price = await loadPrice(model);
  try {
    // The cap is computed from these two, wherever they came from (environment or price table).
    positivePrice("The input price", price.input_usd_per_mtok);
    positivePrice("The output price", price.output_usd_per_mtok);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  console.log("\n=== LIVE OpenAI smoke test: real requests, real charges ===");
  console.log(`Endpoint: ${OPENAI_API_BASE_URL}`);
  if (env("OPENAI_ORG_ID") || env("OPENAI_PROJECT_ID")) {
    console.log("Organization or project: taken from OPENAI_ORG_ID / OPENAI_PROJECT_ID.");
  }
  console.log(
    `Model: ${model} | spending cap: $${cap.toFixed(4)} | output cap per response: ${maxOutput} tokens\n`,
  );

  // The same adapter the Edge Functions use: one HTTP request per call, no hidden retries. The
  // endpoint is named outright, so nothing in the environment can send the run elsewhere.
  const provider = createOpenAIProvider({ apiKey, baseURL: OPENAI_API_BASE_URL });
  const listed = await provider.listModels({ timeoutMs: 30_000 });
  if (!listed.ok) {
    fail(
      `The key was rejected or the API was unreachable: ${listed.failure.class}: ${listed.failure.message}`,
    );
  }
  if (!listed.models.some((item) => item.model_id === model)) {
    fail(`Model "${model}" is not visible to this key. Nothing was spent.`);
  }
  console.log(`OK  Key accepted; ${listed.models.length} models visible, including ${model}.`);

  let spent = 0;
  const send = async (
    label: string,
    request: ResponsesRequest,
    estimatedInput: number,
  ): Promise<ProviderResult> => {
    const worstCase = maxCostUsd(price, estimatedInput, request.max_output_tokens);
    if (spent + worstCase > cap) {
      fail(
        `Stopping before "${label}": its worst-case cost ($${worstCase.toFixed(4)}) does not fit the remaining cap. ` +
          `Spent so far: $${spent.toFixed(4)}.`,
      );
    }
    const outcome: ProviderOutcome = await provider.createResponse(request, { timeoutMs: 120_000 });
    if (outcome.kind === "failure") {
      const billed = outcome.failure.uncertain ? " The request may still have been billed." : "";
      fail(
        `${label} failed: ${outcome.failure.class} (HTTP ${outcome.failure.http_status ?? "n/a"}): ${outcome.failure.message}.${billed}`,
      );
    }
    if (outcome.kind !== "result") fail(`${label} did not finish synchronously.`);
    const cost = usageCostUsd(price, outcome.result.usage);
    spent += cost;
    console.log(
      `OK  ${label}: ${outcome.result.status}, ${outcome.result.usage.input_tokens} in / ${outcome.result.usage.output_tokens} out tokens, ` +
        `about $${cost.toFixed(5)}, returned model ${outcome.result.returned_model ?? "?"}, response ${outcome.result.response_id}`,
    );
    return outcome.result;
  };

  const turns = [
    question,
    `Please also consider ${business}. Would you add it to the list?`,
    "Thanks. Please give me the updated list.",
  ];
  let previous: ProviderResult | null = null;
  for (const [index, prompt] of turns.entries()) {
    const estimate = estimateTurnInputTokens(
      prompt,
      previous
        ? {
            input_tokens: previous.usage.input_tokens,
            output_tokens: previous.usage.output_tokens,
          }
        : null,
    );
    previous = await send(
      `Conversation turn ${index + 1}`,
      buildTurnRequest({
        model,
        params: {},
        maxOutputTokens: maxOutput,
        prompt,
        previousResponseId: previous?.response_id ?? null,
        background: false,
        clientRequestId: randomUUID(),
      }),
      estimate,
    );
    if (previous.status !== "completed") {
      fail(
        `Turn ${index + 1} was ${previous.status} (${previous.incomplete_reason ?? "no reason given"}); raise LIVE_SMOKE_MAX_OUTPUT_TOKENS.`,
      );
    }
  }
  // The third turn can only know the earlier turns through the stored response chain.
  console.log("OK  Three chained turns completed with previous_response_id.");

  await send(
    "Fresh check (new context)",
    buildFreshCheckRequest({
      model,
      params: {},
      maxOutputTokens: maxOutput,
      question,
      store: false,
      background: false,
      clientRequestId: randomUUID(),
    }),
    estimateSingleInputTokens(question),
  );

  console.log(
    `\nLIVE smoke test passed. Estimated spend: $${spent.toFixed(5)} of the $${cap.toFixed(4)} cap ` +
      "(an estimate from token usage; your OpenAI invoice is authoritative).\n",
  );
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
