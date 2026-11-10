// Token and cost estimation.
//
// The database owns the authoritative versions (app_private.estimate_text_tokens, max_cost,
// usage_cost): reservations and ledger entries are always computed there. These twins exist so
// the worker can tell the database how many input tokens a request may use, and so the UI can
// show estimates without a round trip. tests/integration/parity.test.ts keeps them in agreement.

/** Framing overhead assumed for each message and for each request. */
export const MESSAGE_OVERHEAD_TOKENS = 16;
export const REQUEST_OVERHEAD_TOKENS = 32;

const encoder = new TextEncoder();

/**
 * Conservative token estimate: one token per two UTF-8 bytes. Typical English text is nearer
 * four bytes per token, so this deliberately over-reserves.
 */
export function estimateTextTokens(text: string | null | undefined): number {
  return Math.ceil(encoder.encode(text ?? "").length / 2);
}

export interface PreviousUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * Input tokens for the next turn of a chained conversation. With previous_response_id the
 * provider bills the whole chain again as input, so the previous turn's input and output are
 * both part of this turn's input.
 */
export function estimateTurnInputTokens(prompt: string, previous: PreviousUsage | null): number {
  const own = estimateTextTokens(prompt) + MESSAGE_OVERHEAD_TOKENS;
  if (!previous) return REQUEST_OVERHEAD_TOKENS + own;
  return (previous.input_tokens ?? 0) + (previous.output_tokens ?? 0) + own + REQUEST_OVERHEAD_TOKENS;
}

export function estimateSingleInputTokens(prompt: string): number {
  return REQUEST_OVERHEAD_TOKENS + estimateTextTokens(prompt) + MESSAGE_OVERHEAD_TOKENS;
}

/** A row of public.model_prices (USD per million tokens). */
export interface PriceRow {
  input_usd_per_mtok: number;
  cached_input_usd_per_mtok: number | null;
  output_usd_per_mtok: number;
  cache_write_30m_usd_per_mtok: number | null;
  cache_write_12h_usd_per_mtok: number | null;
  long_context_threshold_tokens: number | null;
  long_context_input_multiplier: number | null;
  long_context_output_multiplier: number | null;
}

export interface UsageTokens {
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cache_write_30m_tokens: number;
  cache_write_12h_tokens: number;
  output_tokens: number;
}

function longContextMultipliers(price: PriceRow, inputTokens: number): [number, number] {
  if (price.long_context_threshold_tokens != null && inputTokens > price.long_context_threshold_tokens) {
    return [price.long_context_input_multiplier ?? 1, price.long_context_output_multiplier ?? 1];
  }
  return [1, 1];
}

/**
 * Worst-case cost of one request: every input token at the most expensive input-side rate
 * (including prompt-cache writes), the full output cap, and the long-context surcharge.
 * Rounded up to 1e-8 USD, like the database.
 */
export function maxCostUsd(price: PriceRow, inputTokens: number, maxOutputTokens: number): number {
  const inputRate = Math.max(
    price.input_usd_per_mtok,
    price.cache_write_30m_usd_per_mtok ?? 0,
    price.cache_write_12h_usd_per_mtok ?? 0,
  );
  const [inMult, outMult] = longContextMultipliers(price, inputTokens);
  const microUnits = (inputTokens * inputRate * inMult + maxOutputTokens * price.output_usd_per_mtok * outMult) * 100;
  return Math.ceil(Number(microUnits.toFixed(6))) / 1e8;
}

/** Usage-based cost estimate from returned token counts. Not an invoice. */
export function usageCostUsd(price: PriceRow, usage: UsageTokens): number {
  const input = usage.input_tokens;
  const cached = Math.min(usage.cached_tokens, input);
  const cw30 = usage.cache_write_30m_tokens;
  const cw12 = usage.cache_write_12h_tokens;
  const cwTotal = Math.max(usage.cache_write_tokens, cw30 + cw12);
  const cwOther = cwTotal - cw30 - cw12;
  const uncached = Math.max(input - cached - cwTotal, 0);
  const [inMult, outMult] = longContextMultipliers(price, input);
  const cost =
    (uncached * price.input_usd_per_mtok +
      cached * (price.cached_input_usd_per_mtok ?? price.input_usd_per_mtok) +
      (cw30 + cwOther) * (price.cache_write_30m_usd_per_mtok ?? price.input_usd_per_mtok) +
      cw12 * (price.cache_write_12h_usd_per_mtok ?? price.input_usd_per_mtok)) *
      inMult +
    usage.output_tokens * price.output_usd_per_mtok * outMult;
  return Math.round((cost / 1e6) * 1e8) / 1e8;
}
