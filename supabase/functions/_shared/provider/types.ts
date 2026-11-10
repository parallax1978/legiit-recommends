// Provider-neutral request/response contract.
//
// Campaign orchestration, accounting and result parsing depend only on these types. The OpenAI
// integration (openai.ts) is the single place that knows about the OpenAI SDK.

import type { ModelParams } from "../core/capabilities.ts";

export interface ProviderUsage {
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cache_write_30m_tokens: number;
  cache_write_12h_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

/** One request to the Responses API. */
export interface ResponsesRequest {
  model: string;
  /** The user message. */
  input: string;
  /** Continue a stored conversation. Only conversation turns after the first set this. */
  previous_response_id?: string | null;
  /** Whether the provider stores the response (required for chaining). */
  store: boolean;
  max_output_tokens: number;
  params: ModelParams;
  /** Run as a provider background response: accepted immediately, then polled by id. */
  background?: boolean;
  /**
   * Developer instructions. Used only by tooling requests (variation generation, model-based
   * classification). Conversation turns and fresh checks never set it.
   */
  instructions?: string;
  /** Opaque id sent as X-Client-Request-Id so an attempt can be traced at the provider. */
  client_request_id?: string;
}

export interface ProviderResult {
  status: "completed" | "incomplete";
  response_id: string;
  output_text: string;
  output_items: unknown[];
  returned_model: string | null;
  service_tier: string | null;
  incomplete_reason: string | null;
  refusal: boolean;
  provider_request_id: string | null;
  http_status: number | null;
  latency_ms: number;
  usage: ProviderUsage;
  /** Effective settings echoed by the provider (used by model verification). */
  echo: {
    reasoning_effort: string | null;
    verbosity: string | null;
    temperature: number | null;
    top_p: number | null;
    max_output_tokens: number | null;
  };
}

/** A background response the provider has accepted but not finished. */
export interface ProviderPending {
  status: "queued" | "in_progress";
  response_id: string;
  provider_request_id: string | null;
  latency_ms: number;
}

export type ErrorClass =
  // Retryable
  | "rate_limited"
  | "server_error"
  | "connection_error"
  | "timeout"
  | "provider_failed"
  // The connection needs an owner's attention
  | "quota_exhausted"
  | "invalid_credentials"
  // The configuration needs attention
  | "model_unavailable"
  | "permission_denied"
  | "invalid_request"
  // Stored conversation state is gone
  | "chain_expired"
  | "canceled";

export interface ProviderFailure {
  class: ErrorClass;
  /**
   * True when the provider may have processed (and billed) the request even though no result
   * was received: timeouts and connections that dropped after the request was sent.
   */
  uncertain: boolean;
  http_status: number | null;
  type: string | null;
  code: string | null;
  param: string | null;
  message: string;
  retry_after_ms: number | null;
  provider_request_id: string | null;
  response_id: string | null;
  latency_ms: number;
  /** Present when the provider reported usage for a response that still failed. */
  usage?: ProviderUsage;
}

export type ProviderOutcome =
  | { kind: "result"; result: ProviderResult }
  | { kind: "pending"; pending: ProviderPending }
  | { kind: "failure"; failure: ProviderFailure };

export interface ProviderModel {
  model_id: string;
  owned_by: string | null;
  created: number | null;
  shutdown_date: string | null;
}

export interface CallOptions {
  /** Hard deadline for this single HTTP request. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProviderClient {
  /** Exactly one HTTP request. Never retries. */
  createResponse(request: ResponsesRequest, options: CallOptions): Promise<ProviderOutcome>;
  /** Status of a stored or background response. Does not create a response and is not billed. */
  retrieveResponse(responseId: string, options: CallOptions): Promise<ProviderOutcome>;
  cancelResponse(responseId: string, options: CallOptions): Promise<ProviderOutcome>;
  /** Models visible to the key. Free; also serves as the connection test. */
  listModels(options: CallOptions): Promise<{ ok: true; models: ProviderModel[] } | { ok: false; failure: ProviderFailure }>;
}

export type ProviderFactory = (apiKey: string) => ProviderClient;

export const EMPTY_USAGE: ProviderUsage = {
  input_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
  cache_write_30m_tokens: 0,
  cache_write_12h_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
};
