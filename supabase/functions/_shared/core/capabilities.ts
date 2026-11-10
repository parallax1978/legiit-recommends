// What a model accepts, as discovered by verification (see provider/probe.ts).
//
// Nothing here is assumed from a model's name: the profile is built from real requests made with
// the workspace's own key, and the campaign form only offers what the profile says is supported.

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const VERBOSITY_LEVELS = ["low", "medium", "high"] as const;
export type Verbosity = (typeof VERBOSITY_LEVELS)[number];

/** "effort_none": accepted only together with reasoning effort "none". */
export type SamplingSupport = "always" | "effort_none" | "never";

export interface CapabilityProfile {
  probe_version: number;
  probed_at: string;
  /** Multi-turn chaining with previous_response_id and stored responses works. */
  chaining: boolean;
  reasoning_efforts: ReasoningEffort[];
  default_reasoning_effort: ReasoningEffort | null;
  temperature: SamplingSupport;
  top_p: SamplingSupport;
  verbosity: Verbosity[];
  /** Largest output cap that was accepted during verification. */
  max_output_tokens_verified: number;
  /** Provider-reported ceiling, when the provider stated one. */
  max_output_tokens_limit: number | null;
  background: boolean;
  returned_model: string | null;
  notes: string[];
}

export interface ModelParams {
  temperature?: number;
  top_p?: number;
  reasoning_effort?: ReasoningEffort;
  verbosity?: Verbosity;
}

export type ExecutionMode = "auto" | "sync" | "background";

const PARAM_KEYS = ["temperature", "top_p", "reasoning_effort", "verbosity"];

/**
 * Returns a human-readable problem when `params` are not supported by the profile, else null.
 * Twin of app_private.params_problem (the database check is authoritative at launch).
 */
export function paramsProblem(
  capabilities: CapabilityProfile | null | undefined,
  params: ModelParams | Record<string, unknown> | null | undefined,
  maxOutputTokens: number | null | undefined,
  needsChaining: boolean,
  executionMode: ExecutionMode,
): string | null {
  if (!capabilities) return "This model has not been verified for this connection.";
  const p = (params ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!PARAM_KEYS.includes(key)) return `Unknown model parameter "${key}".`;
  }
  const effort = p.reasoning_effort as string | undefined;
  if (effort != null && !capabilities.reasoning_efforts.includes(effort as ReasoningEffort)) {
    return `This model does not accept reasoning effort "${effort}".`;
  }
  for (const key of ["temperature", "top_p"] as const) {
    if (p[key] == null) continue;
    const support = capabilities[key] ?? "never";
    if (support === "never") return `This model does not accept the ${key} parameter.`;
    if (support === "effort_none" && effort !== "none") {
      return `This model accepts ${key} only when reasoning effort is "none".`;
    }
    const value = p[key];
    if (typeof value !== "number" || Number.isNaN(value)) return `${key} must be a number.`;
    if (key === "temperature" && (value < 0 || value > 2)) return "temperature must be between 0 and 2.";
    if (key === "top_p" && (value <= 0 || value > 1)) return "top_p must be greater than 0 and at most 1.";
  }
  if (p.verbosity != null && !capabilities.verbosity.includes(p.verbosity as Verbosity)) {
    return `This model does not accept verbosity "${String(p.verbosity)}".`;
  }
  if (maxOutputTokens != null) {
    if (maxOutputTokens < 16) return "Maximum output tokens must be at least 16.";
    if (capabilities.max_output_tokens_limit != null && maxOutputTokens > capabilities.max_output_tokens_limit) {
      return `Maximum output tokens cannot exceed ${capabilities.max_output_tokens_limit} for this model.`;
    }
    if (maxOutputTokens > capabilities.max_output_tokens_verified) {
      return `Output caps above ${capabilities.max_output_tokens_verified} tokens have not been verified for this model. An owner can verify it again with a higher cap in Settings.`;
    }
  }
  if (needsChaining && !capabilities.chaining) {
    return "Multi-turn chaining with stored responses is not available for this model on this connection.";
  }
  if (executionMode === "background" && !capabilities.background) {
    return "Background responses are not available for this model on this connection.";
  }
  return null;
}

/**
 * Whether a request should run as a provider background response (accepted immediately, then
 * polled by response id) instead of a single synchronous call.
 *
 * "auto" uses background mode when the model is asked to think hard, when the output cap is
 * large, or when a previous synchronous attempt at the same unit ran out of time.
 */
export function useBackgroundMode(input: {
  mode: ExecutionMode;
  params: ModelParams | null | undefined;
  maxOutputTokens: number;
  backgroundSupported: boolean;
  previousAttemptTimedOut: boolean;
}): boolean {
  if (input.mode === "sync") return false;
  if (!input.backgroundSupported) return false;
  if (input.mode === "background") return true;
  const effort = input.params?.reasoning_effort;
  return (
    input.previousAttemptTimedOut ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max" ||
    input.maxOutputTokens >= 16000
  );
}
