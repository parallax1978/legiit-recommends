// OpenAI Responses API integration (official SDK). Server-side only.
//
// Rules this adapter enforces:
//   * One call = one HTTP request. SDK retries are disabled (maxRetries: 0) so that every request
//     the application pays for is one the application recorded.
//   * Every outcome is normalized to a result, a pending background response, or a classified
//     failure. Callers never see SDK exceptions.
//   * The API key is used to construct the client and is never logged or returned.

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type { Response as OpenAIResponse, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type {
  CallOptions,
  ErrorClass,
  ProviderClient,
  ProviderFailure,
  ProviderModel,
  ProviderOutcome,
  ProviderUsage,
  ResponsesRequest,
} from "./types.ts";
import { EMPTY_USAGE } from "./types.ts";

export interface OpenAIProviderOptions {
  apiKey: string;
  /** Override for local test doubles. Production uses the SDK default (api.openai.com). */
  baseURL?: string;
  fetch?: typeof fetch;
}

// Billing and spend-limit conditions: retrying does not help, an owner has to act.
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "billing_hard_limit_reached",
  "billing_not_active",
]);

const NOT_SENT = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|connection refused|dns error|failed to lookup|name or service not known|certificate|getaddrinfo/i;

function toInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function normalizeUsage(usage: OpenAIResponse["usage"] | null | undefined): ProviderUsage {
  if (!usage) return { ...EMPTY_USAGE };
  const details = usage.input_tokens_details;
  const writes = details?.cache_write_tokens_details;
  return {
    input_tokens: toInt(usage.input_tokens),
    cached_tokens: toInt(details?.cached_tokens),
    cache_write_tokens: toInt(details?.cache_write_tokens),
    cache_write_30m_tokens: toInt(writes?.ttl_30m_tokens),
    cache_write_12h_tokens: toInt(writes?.ttl_12h_tokens),
    output_tokens: toInt(usage.output_tokens),
    reasoning_tokens: toInt(usage.output_tokens_details?.reasoning_tokens),
    total_tokens: toInt(usage.total_tokens),
  };
}

/** Assistant text of a response. Interim commentary is left out when a final answer exists. */
export function extractOutput(response: Pick<OpenAIResponse, "output">): { text: string; refusal: boolean } {
  const finals: string[] = [];
  const commentary: string[] = [];
  const refusals: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text") {
        (item.phase === "commentary" ? commentary : finals).push(part.text ?? "");
      } else if (part.type === "refusal") {
        refusals.push(part.refusal ?? "");
      }
    }
  }
  const text = finals.length > 0 ? finals.join("\n\n") : commentary.join("\n\n");
  if (text.trim().length > 0) return { text, refusal: false };
  return { text: refusals.join("\n\n"), refusal: refusals.length > 0 };
}

function parseDurationMs(value: string | null): number | null {
  // Formats seen on rate-limit headers: "1s", "6m0s", "250ms", "1h2m3s".
  if (!value) return null;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    matched = true;
    const amount = Number(match[1]);
    total += match[2] === "ms" ? amount : match[2] === "s" ? amount * 1000 : match[2] === "m" ? amount * 60000 : amount * 3600000;
  }
  return matched ? Math.round(total) : null;
}

/** Provider retry guidance from response headers, in milliseconds. */
export function retryAfterMs(headers: Headers | undefined | null, now: number = Date.now()): number | null {
  if (!headers) return null;
  const ms = headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Math.round(Number(ms)));
  const seconds = headers.get("retry-after");
  if (seconds) {
    if (Number.isFinite(Number(seconds))) return Math.max(0, Math.round(Number(seconds) * 1000));
    const date = Date.parse(seconds);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  // Fall back to whichever limit is exhausted.
  const waits: number[] = [];
  for (const scope of ["requests", "tokens"]) {
    if (headers.get(`x-ratelimit-remaining-${scope}`) === "0") {
      const reset = parseDurationMs(headers.get(`x-ratelimit-reset-${scope}`));
      if (reset !== null) waits.push(reset);
    }
  }
  return waits.length > 0 ? Math.max(...waits) : null;
}

function failure(partial: Partial<ProviderFailure> & { class: ErrorClass; message: string }, startedAt: number): ProviderFailure {
  return {
    uncertain: false,
    http_status: null,
    type: null,
    code: null,
    param: null,
    retry_after_ms: null,
    provider_request_id: null,
    response_id: null,
    latency_ms: Date.now() - startedAt,
    ...partial,
  };
}

/** Maps any thrown error to a classified failure. */
export function classifyError(error: unknown, startedAt: number): ProviderFailure {
  if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
    return failure(
      {
        class: "timeout",
        uncertain: true,
        message: "The request did not finish before its deadline. The provider may still have processed it.",
      },
      startedAt,
    );
  }
  if (error instanceof APIConnectionError) {
    const detail = `${error.message} ${(error.cause as Error | undefined)?.message ?? ""}`;
    const notSent = NOT_SENT.test(detail);
    return failure(
      {
        class: "connection_error",
        uncertain: !notSent,
        message: notSent
          ? "Could not connect to the provider."
          : "The connection to the provider was lost. The request may still have been processed.",
      },
      startedAt,
    );
  }
  if (error instanceof APIError && typeof error.status === "number") {
    const status = error.status;
    const code = error.code ?? null;
    const type = error.type ?? null;
    const param = error.param ?? null;
    const message = (error.message ?? "Provider error").slice(0, 1000);
    const base = {
      http_status: status,
      code,
      type,
      param,
      message,
      provider_request_id: error.requestID ?? null,
    };
    const chainGone =
      code === "previous_response_not_found" ||
      (param === "previous_response_id" && /not found|expired|no longer/i.test(message));

    if (status === 401) return failure({ ...base, class: "invalid_credentials" }, startedAt);
    if (status === 429) {
      if (type === "insufficient_quota" || (code !== null && QUOTA_CODES.has(code))) {
        return failure({ ...base, class: "quota_exhausted" }, startedAt);
      }
      return failure({ ...base, class: "rate_limited", retry_after_ms: retryAfterMs(error.headers) }, startedAt);
    }
    if (chainGone) return failure({ ...base, class: "chain_expired" }, startedAt);
    if (code === "model_not_found" || (status === 404 && /model/i.test(message))) {
      return failure({ ...base, class: "model_unavailable" }, startedAt);
    }
    if (status === 403) return failure({ ...base, class: "permission_denied" }, startedAt);
    if (status === 408 || status === 409) return failure({ ...base, class: "server_error" }, startedAt);
    if (status >= 500) {
      return failure({ ...base, class: "server_error", retry_after_ms: retryAfterMs(error.headers) }, startedAt);
    }
    return failure({ ...base, class: "invalid_request" }, startedAt);
  }
  const message = error instanceof Error ? error.message : String(error);
  return failure({ class: "connection_error", uncertain: true, message: message.slice(0, 1000) }, startedAt);
}

function normalizeResponse(
  response: OpenAIResponse,
  startedAt: number,
  requestId: string | null,
  httpStatus: number | null,
): ProviderOutcome {
  const latency = Date.now() - startedAt;
  const status = response.status;

  if (status === "queued" || status === "in_progress") {
    return {
      kind: "pending",
      pending: { status, response_id: response.id, provider_request_id: requestId, latency_ms: latency },
    };
  }

  if (status === "completed" || status === "incomplete") {
    const output = extractOutput(response);
    return {
      kind: "result",
      result: {
        status,
        response_id: response.id,
        output_text: output.text,
        output_items: (response.output ?? []) as unknown[],
        returned_model: typeof response.model === "string" ? response.model : null,
        service_tier: response.service_tier ?? null,
        incomplete_reason: status === "incomplete" ? (response.incomplete_details?.reason ?? "unknown") : null,
        refusal: output.refusal,
        provider_request_id: requestId,
        http_status: httpStatus,
        latency_ms: latency,
        usage: normalizeUsage(response.usage),
        echo: {
          reasoning_effort: response.reasoning?.effort ?? null,
          verbosity: response.text?.verbosity ?? null,
          temperature: response.temperature ?? null,
          top_p: response.top_p ?? null,
          max_output_tokens: response.max_output_tokens ?? null,
        },
      },
    };
  }

  // "failed" or "cancelled": the provider accepted the request but produced no usable answer.
  const errorCode = response.error?.code ?? null;
  const message = response.error?.message ?? `The response ended with status "${status ?? "unknown"}".`;
  const hasUsage = !!response.usage && toInt(response.usage.total_tokens) > 0;
  const cls: ErrorClass =
    status === "cancelled"
      ? "canceled"
      : errorCode === "rate_limit_exceeded"
        ? "rate_limited"
        : errorCode === "server_error" || errorCode === "vector_store_timeout" || errorCode === null
          ? "provider_failed"
          : "invalid_request";
  return {
    kind: "failure",
    failure: {
      class: cls,
      uncertain: false,
      http_status: httpStatus,
      type: response.error?.type ?? null,
      code: errorCode,
      param: response.error?.param ?? null,
      message: message.slice(0, 1000),
      retry_after_ms: null,
      provider_request_id: requestId,
      response_id: response.id,
      latency_ms: latency,
      ...(hasUsage ? { usage: normalizeUsage(response.usage) } : {}),
    },
  };
}

/** Builds the exact request body sent to POST /v1/responses. Exported for tests. */
export function buildRequestBody(request: ResponsesRequest): ResponseCreateParamsNonStreaming {
  const body: ResponseCreateParamsNonStreaming = {
    model: request.model,
    input: request.input,
    store: request.store,
    max_output_tokens: request.max_output_tokens,
  };
  if (request.previous_response_id) body.previous_response_id = request.previous_response_id;
  if (request.instructions) body.instructions = request.instructions;
  if (request.background) body.background = true;
  const { temperature, top_p, reasoning_effort, verbosity } = request.params ?? {};
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  if (top_p !== undefined && top_p !== null) body.top_p = top_p;
  if (reasoning_effort) body.reasoning = { effort: reasoning_effort };
  if (verbosity) body.text = { verbosity };
  return body;
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ProviderClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    // The application owns retries and accounts for every attempt.
    maxRetries: 0,
  });

  const requestOptions = (call: CallOptions, clientRequestId?: string) => ({
    timeout: call.timeoutMs,
    maxRetries: 0,
    ...(call.signal ? { signal: call.signal } : {}),
    ...(clientRequestId ? { headers: { "X-Client-Request-Id": clientRequestId } } : {}),
  });

  return {
    async createResponse(request, call) {
      const startedAt = Date.now();
      try {
        const { data, response, request_id } = await client.responses
          .create(buildRequestBody(request), requestOptions(call, request.client_request_id))
          .withResponse();
        return normalizeResponse(data, startedAt, request_id ?? null, response.status);
      } catch (error) {
        return { kind: "failure", failure: classifyError(error, startedAt) };
      }
    },

    async retrieveResponse(responseId, call) {
      const startedAt = Date.now();
      try {
        const { data, response, request_id } = await client.responses
          .retrieve(responseId, {}, requestOptions(call))
          .withResponse();
        return normalizeResponse(data, startedAt, request_id ?? null, response.status);
      } catch (error) {
        return { kind: "failure", failure: classifyError(error, startedAt) };
      }
    },

    async cancelResponse(responseId, call) {
      const startedAt = Date.now();
      try {
        const { data, response, request_id } = await client.responses
          .cancel(responseId, requestOptions(call))
          .withResponse();
        return normalizeResponse(data, startedAt, request_id ?? null, response.status);
      } catch (error) {
        return { kind: "failure", failure: classifyError(error, startedAt) };
      }
    },

    async listModels(call) {
      const startedAt = Date.now();
      try {
        const models: ProviderModel[] = [];
        for await (const model of client.models.list(requestOptions(call))) {
          models.push({
            model_id: model.id,
            owned_by: model.owned_by ?? null,
            created: typeof model.created === "number" ? model.created : null,
            shutdown_date: model.shutdown_date ?? null,
          });
        }
        return { ok: true, models };
      } catch (error) {
        return { ok: false, failure: classifyError(error, startedAt) };
      }
    },
  };
}
