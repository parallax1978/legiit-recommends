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
  return (
    (previous.input_tokens ?? 0) + (previous.output_tokens ?? 0) + own + REQUEST_OVERHEAD_TOKENS
  );
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

// Costs are computed in exact integer arithmetic so they match the database's numeric results to
// the last digit: prices in millionths of a dollar per million tokens, multipliers in
// ten-thousandths, results in hundred-millionths of a dollar (1e-8 USD).
const UNIT = 100_000_000n;

function micro(price: number | null | undefined): bigint {
  return BigInt(Math.round((price ?? 0) * 1_000_000));
}

function tenThousandths(multiplier: number | null | undefined): bigint {
  return BigInt(Math.round((multiplier ?? 1) * 10_000));
}

function longContextMultipliers(price: PriceRow, inputTokens: number): [bigint, bigint] {
  if (
    price.long_context_threshold_tokens != null &&
    inputTokens > price.long_context_threshold_tokens
  ) {
    return [
      tenThousandths(price.long_context_input_multiplier),
      tenThousandths(price.long_context_output_multiplier),
    ];
  }
  return [10_000n, 10_000n];
}

function tokens(count: number | null | undefined): bigint {
  return BigInt(Math.max(0, Math.round(count ?? 0)));
}

/**
 * Worst-case cost of one request: every input token at the most expensive input-side rate
 * (including prompt-cache writes), the full output cap, and the long-context surcharge.
 * Rounded up to 1e-8 USD, like the database.
 */
export function maxCostUsd(price: PriceRow, inputTokens: number, maxOutputTokens: number): number {
  const rates = [
    micro(price.input_usd_per_mtok),
    micro(price.cache_write_30m_usd_per_mtok),
    micro(price.cache_write_12h_usd_per_mtok),
  ];
  const inputRate = rates.reduce((highest, rate) => (rate > highest ? rate : highest), 0n);
  const [inMult, outMult] = longContextMultipliers(price, inputTokens);
  const numerator =
    tokens(inputTokens) * inputRate * inMult +
    tokens(maxOutputTokens) * micro(price.output_usd_per_mtok) * outMult;
  return Number((numerator + UNIT - 1n) / UNIT) / 1e8;
}

/** Usage-based cost estimate from returned token counts. Not an invoice. */
export function usageCostUsd(price: PriceRow, usage: UsageTokens): number {
  const input = tokens(usage.input_tokens);
  const cachedRaw = tokens(usage.cached_tokens);
  const cached = cachedRaw < input ? cachedRaw : input;
  const cw30 = tokens(usage.cache_write_30m_tokens);
  const cw12 = tokens(usage.cache_write_12h_tokens);
  const cwReported = tokens(usage.cache_write_tokens);
  const cwTotal = cwReported > cw30 + cw12 ? cwReported : cw30 + cw12;
  const cwOther = cwTotal - cw30 - cw12;
  const uncachedRaw = input - cached - cwTotal;
  const uncached = uncachedRaw > 0n ? uncachedRaw : 0n;
  const [inMult, outMult] = longContextMultipliers(price, usage.input_tokens);
  const inputRate = micro(price.input_usd_per_mtok);
  const orInput = (rate: number | null) => (rate == null ? inputRate : micro(rate));
  const numerator =
    (uncached * inputRate +
      cached * orInput(price.cached_input_usd_per_mtok) +
      (cw30 + cwOther) * orInput(price.cache_write_30m_usd_per_mtok) +
      cw12 * orInput(price.cache_write_12h_usd_per_mtok)) *
      inMult +
    tokens(usage.output_tokens) * micro(price.output_usd_per_mtok) * outMult;
  // Round half up, as numeric round() does.
  return Number((numerator + UNIT / 2n) / UNIT) / 1e8;
}
