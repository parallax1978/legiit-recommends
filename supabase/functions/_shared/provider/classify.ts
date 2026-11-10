// Optional model-based classification of an answer that the rules could not decide.
//
// It runs only on request, strictly after the answer exists, with its own budget reservation and
// ledger entry (purpose "classification"). Its result is stored as a classification with method
// "model" and can be overridden by a person. It is never part of generating conversations or
// fresh checks, so naming the target here cannot influence what is being measured.

import type { DetectionTarget, Inclusion, ListKind } from "../core/detection.ts";
import { estimateTextTokens, MESSAGE_OVERHEAD_TOKENS, REQUEST_OVERHEAD_TOKENS } from "../core/estimate.ts";
import type { ModelParams } from "../core/capabilities.ts";
import type { ResponsesRequest } from "./types.ts";

export const MODEL_CLASSIFIER_VERSION = "model-1";

const INSTRUCTIONS = [
  "You label whether a specific business is one of the recommended options in an answer written by an AI assistant.",
  "Use only the answer text. Do not judge whether the business deserves to be recommended.",
  'Labels: "included" = the business is itself one of the recommended options (for example an item in the list);',
  '"mentioned_only" = the business is named but is not one of the recommended options (declined, unverified, compared against, or mentioned in passing);',
  '"not_mentioned" = the business does not appear.',
  "rank: the number shown next to the business if the options are explicitly numbered, otherwise null. Never infer a rank from position alone.",
  "list_position: the one-based position of the business among the options if they are an unnumbered list, otherwise null.",
  'Respond with JSON only: {"inclusion": "...", "rank": null, "list_position": null, "reason": "one short sentence"}.',
].join("\n");

export function buildClassificationRequest(
  answerText: string,
  target: DetectionTarget,
  model: string,
  params: ModelParams,
  maxOutputTokens: number,
): ResponsesRequest {
  return {
    model,
    instructions: INSTRUCTIONS,
    input: JSON.stringify(
      {
        business: {
          name: target.business_name,
          also_known_as: target.business_aliases ?? [],
          website: target.website_url ?? null,
          other_domains: target.domain_aliases ?? [],
        },
        answer: answerText,
      },
      null,
      2,
    ),
    store: false,
    max_output_tokens: maxOutputTokens,
    params,
  };
}

export function estimateClassificationInputTokens(request: ResponsesRequest): number {
  return (
    REQUEST_OVERHEAD_TOKENS +
    estimateTextTokens(request.instructions ?? "") +
    estimateTextTokens(request.input) +
    2 * MESSAGE_OVERHEAD_TOKENS
  );
}

export interface ModelClassification {
  detector_version: string;
  mentioned: boolean;
  inclusion: Inclusion;
  rank: number | null;
  list_position: number | null;
  list_kind: ListKind;
  reason: string;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000 ? value : null;
}

/** Parses the classifier's JSON. Returns null when it cannot be read as a valid label. */
export function parseClassification(outputText: string): ModelClassification | null {
  const text = (outputText ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const inclusion = parsed.inclusion;
  if (inclusion !== "included" && inclusion !== "mentioned_only" && inclusion !== "not_mentioned") return null;
  const rank = inclusion === "included" ? positiveInt(parsed.rank) : null;
  const position = inclusion === "included" && rank === null ? positiveInt(parsed.list_position) : null;
  return {
    detector_version: MODEL_CLASSIFIER_VERSION,
    mentioned: inclusion !== "not_mentioned",
    inclusion,
    rank,
    list_position: position,
    list_kind: rank !== null ? "numbered" : position !== null ? "bulleted" : "none",
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : "Classified by model.",
  };
}
