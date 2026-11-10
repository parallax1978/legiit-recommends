// Optional AI generation of a reusable wording library.
//
// One explicit request produces a list of candidate wordings that a person reviews and edits
// before anything is saved. Scheduled runs never call this: they only pick from saved templates.
//
// Wordings are written with placeholders ({{business_name}}, {{category}}, …) so that a library
// can be reused. Questions (initial questions and fresh checks) are generated without being told
// the business at all, and any candidate that names it anyway is discarded.

import { mentionsTarget, type DetectionTarget } from "../core/detection.ts";
import {
  estimateTextTokens,
  MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
} from "../core/estimate.ts";
import {
  allowedVariables,
  templateProblem,
  type TemplateKind,
  type TemplateValues,
} from "../core/templates.ts";
import type { ResponsesRequest } from "./types.ts";
import type { ModelParams } from "../core/capabilities.ts";

export interface GenerationContext {
  kind: TemplateKind;
  count: number;
  /** Campaign values. Only the non-identifying ones are sent for question kinds. */
  values: TemplateValues;
  /** Existing wordings to vary (templates with placeholders). */
  examples: string[];
  /** Free-form guidance from the user, e.g. tone. */
  guidance?: string | null;
}

const KIND_BRIEF: Record<TemplateKind, string> = {
  initial_question:
    "questions a person would ask an AI assistant when looking for recommendations in the given category. They must be neutral: do not name or hint at any specific business.",
  inclusion_request:
    "follow-up messages in which the person asks the assistant to include one specific business, written with the placeholder {{business_name}} (and optionally {{website_url}}), in the list it just gave.",
  revision_request:
    "follow-up messages in which the person asks the assistant to show the complete revised list again.",
  extra_step: "follow-up messages that continue the same conversation naturally.",
  fresh_check:
    "standalone questions a person would ask an AI assistant when looking for recommendations in the given category. They must be neutral: do not name or hint at any specific business.",
};

function isQuestionKind(kind: TemplateKind): boolean {
  return kind === "initial_question" || kind === "fresh_check";
}

export function buildGenerationRequest(
  context: GenerationContext,
  model: string,
  params: ModelParams,
  maxOutputTokens: number,
): ResponsesRequest {
  const placeholders = allowedVariables(context.kind).map((name) => `{{${name}}}`);
  const identifying = !isQuestionKind(context.kind);
  const details: Record<string, string> = {};
  for (const key of ["category", "location", "language"] as const) {
    const value = (context.values[key] ?? "").toString().trim();
    if (value) details[key] = value;
  }

  const instructions = [
    "You write short, natural user messages for conversations with an AI assistant.",
    `Write ${context.count} distinct variations of ${KIND_BRIEF[context.kind]}`,
    `You may use these placeholders exactly as written and no others: ${placeholders.join(", ")}.`,
    identifying
      ? "Always refer to the business with the placeholder {{business_name}}; never write an actual business name."
      : "Never mention any business, brand, product or website by name.",
    details.language ? `Write in ${details.language}.` : "",
    "Vary length, tone and phrasing. Each variation is a single message of one to three sentences.",
    'Respond with JSON only, in the form {"variations": ["...", "..."]}.',
  ]
    .filter(Boolean)
    .join("\n");

  const input = JSON.stringify(
    {
      category: details.category ?? "{{category}}",
      location: details.location ?? null,
      examples: context.examples.slice(0, 20),
      guidance: context.guidance?.trim() || null,
    },
    null,
    2,
  );

  return {
    model,
    input,
    instructions,
    store: false,
    max_output_tokens: maxOutputTokens,
    params,
  };
}

export function estimateGenerationInputTokens(request: ResponsesRequest): number {
  return (
    REQUEST_OVERHEAD_TOKENS +
    estimateTextTokens(request.instructions ?? "") +
    estimateTextTokens(request.input) +
    2 * MESSAGE_OVERHEAD_TOKENS
  );
}

/** A reasonable output cap for the requested number of variations. */
export function generationOutputCap(count: number, reasoning: boolean): number {
  return Math.min(16000, 300 + count * 120 + (reasoning ? 2000 : 0));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ParsedGeneration {
  candidates: string[];
  rejected: { text: string; reason: string }[];
}

/** Extracts the variations, restores placeholders and drops anything invalid or leaking. */
export function parseGeneration(
  outputText: string,
  context: GenerationContext,
  target: DetectionTarget | null,
): ParsedGeneration {
  const candidates: string[] = [];
  const rejected: { text: string; reason: string }[] = [];
  const raw = extractStrings(outputText);
  const seen = new Set<string>();

  for (let text of raw) {
    text = text.trim();
    if (!text) continue;

    if (target && !isQuestionKind(context.kind)) {
      // If the model wrote the real name despite the instruction, turn it back into a placeholder.
      const name = (target.business_name ?? "").trim();
      if (name.length >= 2) {
        text = text.replace(
          new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu"),
          "{{business_name}}",
        );
      }
    }

    const problem = templateProblem(text, context.kind);
    if (problem) {
      rejected.push({ text, reason: problem });
      continue;
    }
    if (target && isQuestionKind(context.kind) && mentionsTarget(text, target)) {
      rejected.push({ text, reason: "Mentions the target business." });
      continue;
    }
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(text);
    if (candidates.length >= context.count) break;
  }
  return { candidates, rejected };
}

function extractStrings(outputText: string): string[] {
  const text = (outputText ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const attempts = [text];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace)
    attempts.push(text.slice(firstBrace, lastBrace + 1));
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket)
    attempts.push(text.slice(firstBracket, lastBracket + 1));

  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { variations?: unknown }).variations)
          ? (parsed as { variations: unknown[] }).variations
          : null;
      if (list) return list.filter((item): item is string => typeof item === "string");
    } catch {
      // try the next shape
    }
  }
  // Last resort: one variation per non-empty line, without list markers.
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
        .replace(/^"|",?$/g, "")
        .trim(),
    )
    .filter(
      (line) => line.length > 0 && !/^[{}\[\]]/.test(line) && !/^"?variations"?\s*:/.test(line),
    );
}
