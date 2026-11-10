// Request builders for the two kinds of measured traffic.
//
// They are deliberately separate and narrowly typed:
//
//   * A conversation turn carries one user message and (after the first turn) the id of the
//     previous response. No system or developer context is ever added, so the target business
//     enters the conversation only through the prompts the campaign owner wrote.
//
//   * A fresh check carries one question and nothing else. Its input type has no field through
//     which a target business, campaign, workspace or earlier conversation could be passed, so
//     independence does not depend on callers remembering to leave something out.

import type { ModelParams } from "../core/capabilities.ts";
import type { ResponsesRequest } from "./types.ts";

export interface TurnRequestInput {
  model: string;
  params: ModelParams;
  maxOutputTokens: number;
  /** The exact rendered user message for this turn. */
  prompt: string;
  /** Response id of the previous turn of the same run; null for the first turn. */
  previousResponseId: string | null;
  background: boolean;
  clientRequestId: string;
}

export function buildTurnRequest(input: TurnRequestInput): ResponsesRequest {
  return {
    model: input.model,
    input: input.prompt,
    previous_response_id: input.previousResponseId,
    // Turn chaining uses previous_response_id, which requires stored responses.
    store: true,
    max_output_tokens: input.maxOutputTokens,
    params: input.params,
    background: input.background,
    client_request_id: input.clientRequestId,
  };
}

export interface FreshCheckRequestInput {
  model: string;
  params: ModelParams;
  maxOutputTokens: number;
  /** The rendered question. Must already have passed the target-leak guard. */
  question: string;
  store: boolean;
  background: boolean;
  clientRequestId: string;
}

export function buildFreshCheckRequest(input: FreshCheckRequestInput): ResponsesRequest {
  return {
    model: input.model,
    input: input.question,
    store: input.store,
    max_output_tokens: input.maxOutputTokens,
    params: input.params,
    background: input.background,
    client_request_id: input.clientRequestId,
  };
}

/** The non-secret settings recorded with every attempt. */
export function describeRequest(request: ResponsesRequest): Record<string, unknown> {
  return {
    ...request.params,
    max_output_tokens: request.max_output_tokens,
    store: request.store,
    background: request.background === true,
    chained: Boolean(request.previous_response_id),
    has_instructions: Boolean(request.instructions),
  };
}
