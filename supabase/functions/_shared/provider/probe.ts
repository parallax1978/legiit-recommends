// Model verification.
//
// The models endpoint says which model ids a key can see, but nothing about what each model
// accepts. Instead of assuming from the name, verification sends a handful of tiny real requests
// and records what the provider accepted: chaining with stored responses, each reasoning effort,
// sampling parameters, verbosity, the output cap the owner wants to use, and background mode.
//
// Every request here is a paid request: the caller reserves budget for the whole plan first and
// records each outcome in the usage ledger (see ops "model.verify").

import {
  REASONING_EFFORTS,
  VERBOSITY_LEVELS,
  type CapabilityProfile,
  type ModelParams,
  type ReasoningEffort,
  type SamplingSupport,
} from "../core/capabilities.ts";
import { estimateSingleInputTokens } from "../core/estimate.ts";
import type { ProviderClient, ProviderOutcome, ResponsesRequest } from "./types.ts";

export const PROBE_VERSION = 1;
const PROBE_PROMPT = "Reply with the single word OK.";
const FOLLOW_UP_PROMPT = "Reply with the single word OK again.";
const SMALL_CAP = 32;
// Chained requests are billed for the earlier turn as well.
const CHAIN_EXTRA_INPUT_TOKENS = 80;

export interface ProbeStep {
  key: string;
  est_input_tokens: number;
  max_output_tokens: number;
  request_params: Record<string, unknown>;
}

/**
 * The fixed list of requests verification may send, in order. Budget is reserved for all of
 * them up front; steps that turn out to be unnecessary are released unused.
 */
export function planProbe(verifyOutputCap: number): ProbeStep[] {
  const base = estimateSingleInputTokens(PROBE_PROMPT);
  const step = (
    key: string,
    params: Record<string, unknown>,
    cap = SMALL_CAP,
    extraInput = 0,
  ): ProbeStep => ({
    key,
    est_input_tokens: base + extraInput,
    max_output_tokens: cap,
    request_params: params,
  });
  return [
    step("base", { store: true }),
    step("chain", { store: true, chained: true }, SMALL_CAP, CHAIN_EXTRA_INPUT_TOKENS),
    ...REASONING_EFFORTS.map((effort) => step(`effort:${effort}`, { reasoning_effort: effort })),
    step("temperature", { temperature: 0.7 }),
    step("top_p", { top_p: 0.9 }),
    step("temperature:none", { temperature: 0.7, reasoning_effort: "none" }),
    step("top_p:none", { top_p: 0.9, reasoning_effort: "none" }),
    step("verbosity", { verbosity: "low" }),
    step("output_cap", { max_output_tokens: verifyOutputCap }, verifyOutputCap),
    step("background", { background: true, store: true }),
  ];
}

export interface ProbeHooks {
  /** Called with the outcome of each step that was actually sent. */
  onOutcome(
    key: string,
    outcome: ProviderOutcome,
    sentParams: Record<string, unknown>,
  ): Promise<void>;
  /** Called for planned steps that were not needed, so their reservation can be released. */
  onUnused(key: string): Promise<void>;
}

export interface ProbeResult {
  verified: boolean;
  capabilities: CapabilityProfile | null;
  error: string | null;
}

/** Accepted by the provider (it produced a response, even if cut short by the tiny cap). */
function accepted(outcome: ProviderOutcome): boolean {
  return outcome.kind === "result" || outcome.kind === "pending";
}

/** Rejected because the parameter or value is not supported, as opposed to a transient error. */
function rejectedAsUnsupported(outcome: ProviderOutcome): boolean {
  return outcome.kind === "failure" && outcome.failure.class === "invalid_request";
}

function parseOutputLimit(message: string): number | null {
  const match =
    /(?:<=|at most|less than or equal to|maximum(?: value)?(?: is| of)?|max(?:imum)? (?:output )?tokens?(?: is| of)?)\s*:?\s*(\d[\d,]{2,})/i.exec(
      message,
    );
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(value) && value >= 16 ? value : null;
}

export async function probeModel(
  provider: ProviderClient,
  model: string,
  verifyOutputCap: number,
  hooks: ProbeHooks,
  options: { timeoutMs: number; now?: () => Date } = { timeoutMs: 45000 },
): Promise<ProbeResult> {
  const used = new Set<string>();
  const notes: string[] = [];
  const call = { timeoutMs: options.timeoutMs };

  const send = async (
    key: string,
    params: ModelParams,
    extra: Partial<ResponsesRequest> = {},
    cap = SMALL_CAP,
    prompt = PROBE_PROMPT,
  ): Promise<ProviderOutcome> => {
    used.add(key);
    const request: ResponsesRequest = {
      model,
      input: prompt,
      store: true,
      max_output_tokens: cap,
      params,
      ...extra,
    };
    const outcome = await provider.createResponse(request, call);
    await hooks.onOutcome(key, outcome, {
      ...params,
      max_output_tokens: cap,
      store: request.store,
      background: request.background === true,
      chained: Boolean(request.previous_response_id),
    });
    return outcome;
  };

  const finish = async (result: ProbeResult): Promise<ProbeResult> => {
    for (const step of planProbe(verifyOutputCap)) {
      if (!used.has(step.key)) await hooks.onUnused(step.key);
    }
    return result;
  };

  // 1. The model answers a plain stored request at all.
  const base = await send("base", {});
  if (base.kind !== "result") {
    const message =
      base.kind === "failure"
        ? base.failure.message
        : "The provider did not return a finished response.";
    return finish({ verified: false, capabilities: null, error: message });
  }

  // 2. A second turn can continue from the stored first response.
  const chain = await send(
    "chain",
    {},
    { previous_response_id: base.result.response_id },
    SMALL_CAP,
    FOLLOW_UP_PROMPT,
  );
  const chaining = accepted(chain);
  if (!chaining && chain.kind === "failure") {
    notes.push(`Chaining with previous_response_id was rejected: ${chain.failure.message}`);
  }

  // 3. Which reasoning efforts, sampling parameters and verbosity the model accepts.
  const [effortOutcomes, temperature, topP, verbosity] = await Promise.all([
    Promise.all(
      REASONING_EFFORTS.map((effort) => send(`effort:${effort}`, { reasoning_effort: effort })),
    ),
    send("temperature", { temperature: 0.7 }),
    send("top_p", { top_p: 0.9 }),
    send("verbosity", { verbosity: "low" }),
  ]);
  const efforts: ReasoningEffort[] = [];
  REASONING_EFFORTS.forEach((effort, index) => {
    const outcome = effortOutcomes[index]!;
    if (accepted(outcome)) efforts.push(effort);
    else if (!rejectedAsUnsupported(outcome) && outcome.kind === "failure") {
      notes.push(`Reasoning effort "${effort}" could not be checked: ${outcome.failure.message}`);
    }
  });

  const samplingSupport = async (
    key: "temperature" | "top_p",
    first: ProviderOutcome,
    params: ModelParams,
  ): Promise<SamplingSupport> => {
    if (accepted(first)) return "always";
    if (!rejectedAsUnsupported(first) && first.kind === "failure") {
      notes.push(`${key} could not be checked: ${first.failure.message}`);
      return "never";
    }
    // Some reasoning models accept sampling parameters only with reasoning turned off.
    if (!efforts.includes("none")) return "never";
    const withNone = await send(`${key}:none`, { ...params, reasoning_effort: "none" });
    return accepted(withNone) ? "effort_none" : "never";
  };
  const temperatureSupport = await samplingSupport("temperature", temperature, {
    temperature: 0.7,
  });
  const topPSupport = await samplingSupport("top_p", topP, { top_p: 0.9 });

  // 4. The output cap the owner intends to use is accepted.
  let verifiedCap = SMALL_CAP;
  let limit: number | null = null;
  if (verifyOutputCap > SMALL_CAP) {
    const capOutcome = await send("output_cap", {}, {}, verifyOutputCap);
    if (accepted(capOutcome)) {
      verifiedCap = verifyOutputCap;
    } else if (capOutcome.kind === "failure") {
      limit = parseOutputLimit(capOutcome.failure.message);
      notes.push(
        `An output cap of ${verifyOutputCap} tokens was rejected: ${capOutcome.failure.message}`,
      );
    }
  }

  // 5. Background mode: accepted, then followed to a terminal status so its usage is recorded.
  let background = false;
  used.add("background");
  const backgroundRequest: ResponsesRequest = {
    model,
    input: PROBE_PROMPT,
    store: true,
    max_output_tokens: SMALL_CAP,
    params: {},
    background: true,
  };
  let backgroundOutcome = await provider.createResponse(backgroundRequest, call);
  if (accepted(backgroundOutcome)) {
    background = true;
    const deadline = Date.now() + 20000;
    while (backgroundOutcome.kind === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const polled = await provider.retrieveResponse(backgroundOutcome.pending.response_id, call);
      // A failed poll is not a failed response: keep waiting on the original.
      if (polled.kind !== "failure") backgroundOutcome = polled;
    }
    if (backgroundOutcome.kind === "pending") {
      const canceled = await provider.cancelResponse(backgroundOutcome.pending.response_id, call);
      if (canceled.kind !== "pending") backgroundOutcome = canceled;
    }
  } else if (backgroundOutcome.kind === "failure" && !rejectedAsUnsupported(backgroundOutcome)) {
    notes.push(`Background mode could not be checked: ${backgroundOutcome.failure.message}`);
  }
  await hooks.onOutcome("background", backgroundOutcome, {
    max_output_tokens: SMALL_CAP,
    store: true,
    background: true,
    chained: false,
  });

  const echoEffort = base.result.echo.reasoning_effort;
  const capabilities: CapabilityProfile = {
    probe_version: PROBE_VERSION,
    probed_at: (options.now?.() ?? new Date()).toISOString(),
    chaining,
    reasoning_efforts: efforts,
    default_reasoning_effort:
      echoEffort && (REASONING_EFFORTS as readonly string[]).includes(echoEffort)
        ? (echoEffort as ReasoningEffort)
        : null,
    temperature: temperatureSupport,
    top_p: topPSupport,
    verbosity: accepted(verbosity) ? [...VERBOSITY_LEVELS] : [],
    max_output_tokens_verified: verifiedCap,
    max_output_tokens_limit: limit,
    background,
    returned_model: base.result.returned_model,
    notes,
  };

  return finish({ verified: true, capabilities, error: null });
}
