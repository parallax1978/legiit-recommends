"use server";

import { parsePromptCsv } from "@shared/core/csv.ts";
import { TEMPLATE_KINDS, templateProblem, type TemplateKind } from "@shared/core/templates.ts";
import { fail, type ActionResult } from "@/lib/result";
import { isUuid, mutate, operate } from "./helpers";

const INVALID = fail("That item could not be found.", "not_found");

function plain<T>(result: ActionResult<T>): ActionResult {
  return result.ok ? { ok: true, message: result.message } : result;
}

function isKind(value: unknown): value is TemplateKind {
  return typeof value === "string" && (TEMPLATE_KINDS as readonly string[]).includes(value);
}

export interface NewPrompt {
  body: string;
  label?: string | null;
}

/** Adds wordings to the library. Each is validated here and again by the database. */
export async function createTemplates(input: {
  workspaceId: string;
  kind: string;
  items: NewPrompt[];
  collection?: string | null;
  source?: "manual" | "csv_import" | "ai_generated";
  generationId?: string | null;
  skipDuplicates?: boolean;
}): Promise<ActionResult<string[]>> {
  if (!isUuid(input.workspaceId) || !isKind(input.kind)) return INVALID;
  const kind = input.kind;
  const items = input.items
    .map((item) => ({ body: item.body.trim(), label: item.label?.trim() || null }))
    .filter((item) => item.body.length > 0);
  if (items.length === 0) return fail("Enter at least one prompt.", "invalid");
  if (items.length > 500) return fail("Add at most 500 prompts at a time.", "invalid");
  for (const [index, item] of items.entries()) {
    const problem = templateProblem(item.body, kind);
    if (problem)
      return fail(
        items.length === 1 ? problem : `Prompt ${index + 1}: ${problem}`,
        "invalid_template",
      );
  }
  const result = await mutate<string[]>(
    (db) =>
      db.rpc("create_templates", {
        p_workspace_id: input.workspaceId,
        p_kind: kind,
        p_items: items,
        p_collection: input.collection?.trim() || undefined,
        p_source: input.source ?? "manual",
        p_generation_id: input.generationId ?? undefined,
        p_skip_duplicates: input.skipDuplicates ?? false,
      }),
    {},
  );
  if (!result.ok) return result;
  const added = result.data?.length ?? 0;
  const skipped = items.length - added;
  return {
    ok: true,
    data: result.data ?? [],
    message: `${added} prompt${added === 1 ? "" : "s"} added${skipped > 0 ? `, ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : ""}.`,
  };
}

/** Parses an uploaded CSV on the server and returns the rows for review. Nothing is saved yet. */
export async function parsePromptImport(
  kind: string,
  csvText: string,
): Promise<ActionResult<{ body: string; label: string | null; problem: string | null }[]>> {
  if (!isKind(kind)) return INVALID;
  if (csvText.length > 2_000_000) return fail("The file is larger than 2 MB.", "too_large");
  const rows = parsePromptCsv(csvText);
  if (rows.length === 0)
    return fail(
      'No prompts were found. Use one prompt per row, or a header row with a "body" column.',
      "empty",
    );
  if (rows.length > 500)
    return fail("The file has more than 500 prompts. Split it into smaller files.", "too_many");
  return {
    ok: true,
    data: rows.map((row) => ({ ...row, problem: templateProblem(row.body, kind) })),
  };
}

export async function updateTemplate(input: {
  templateId: string;
  kind: string;
  body: string;
  label: string;
  collection: string;
}): Promise<ActionResult> {
  if (!isUuid(input.templateId) || !isKind(input.kind)) return INVALID;
  const problem = templateProblem(input.body, input.kind);
  if (problem) return fail(problem, "invalid_template");
  return plain(
    await mutate(
      (db) =>
        db.rpc("update_template", {
          p_template_id: input.templateId,
          p_body: input.body.trim(),
          p_label: input.label.trim() || undefined,
          p_collection: input.collection.trim() || undefined,
        }),
      { success: "Saved as a new version. Launched campaigns keep the version they started with." },
    ),
  );
}

export async function setTemplatesArchived(
  templateIds: string[],
  archived: boolean,
): Promise<ActionResult> {
  if (templateIds.length === 0 || !templateIds.every(isUuid)) return INVALID;
  return plain(
    await mutate(
      (db) =>
        db.rpc("set_templates_archived", { p_template_ids: templateIds, p_archived: archived }),
      {
        success: archived
          ? "Archived. Campaigns that already use it are not affected."
          : "Restored.",
      },
    ),
  );
}

export async function deleteTemplate(templateId: string): Promise<ActionResult> {
  if (!isUuid(templateId)) return INVALID;
  return plain(
    await mutate((db) => db.rpc("delete_template", { p_template_id: templateId }), {
      success: "Prompt deleted.",
    }),
  );
}

export async function saveProbeSet(input: {
  workspaceId: string;
  probeSetId: string | null;
  name: string;
  description: string;
  questions: { body: string; is_held_out: boolean }[];
}): Promise<ActionResult<{ probe_set_id: string; version_id: string; new_version: boolean }>> {
  if (!isUuid(input.workspaceId) || (input.probeSetId !== null && !isUuid(input.probeSetId)))
    return INVALID;
  const name = input.name.trim();
  if (name.length < 1 || name.length > 120)
    return fail("Enter a name between 1 and 120 characters.", "invalid");
  const questions = input.questions
    .map((question) => ({ body: question.body.trim(), is_held_out: question.is_held_out }))
    .filter((question) => question.body.length > 0);
  if (questions.length === 0) return fail("Add at least one question.", "invalid");
  for (const [index, question] of questions.entries()) {
    const problem = templateProblem(question.body, "fresh_check");
    if (problem) return fail(`Question ${index + 1}: ${problem}`, "invalid_template");
  }
  if (questions.every((question) => question.is_held_out))
    return fail("At least one question must be a regular (not held-out) question.", "invalid");
  const result = await mutate<{ probe_set_id: string; version_id: string; new_version: boolean }>(
    (db) =>
      db.rpc("save_probe_set", {
        p_workspace_id: input.workspaceId,
        p_probe_set_id: (input.probeSetId ?? null) as string,
        p_name: name,
        p_description: input.description.trim(),
        p_questions: questions,
      }) as never,
    {},
  );
  if (!result.ok) return result;
  return {
    ok: true,
    data: result.data,
    message: result.data?.new_version
      ? "Question set saved as a new version. Campaigns that already launched keep their version until you apply changes to them."
      : "Question set saved.",
  };
}

export async function setProbeSetArchived(
  probeSetId: string,
  archived: boolean,
): Promise<ActionResult> {
  if (!isUuid(probeSetId)) return INVALID;
  return plain(
    await mutate(
      (db) =>
        db.rpc("set_probe_set_archived", { p_probe_set_id: probeSetId, p_archived: archived }),
      { success: archived ? "Question set archived." : "Question set restored." },
    ),
  );
}

export interface GenerationResult {
  generation_id: string;
  candidates: string[];
  rejected: { text: string; reason: string }[];
  truncated: boolean;
}

/** Asks the model for candidate wordings. Costs money; the request is recorded under Usage. */
export async function generateVariations(input: {
  workspaceId: string;
  connectionId: string;
  model: string;
  kind: string;
  count: number;
  guidance: string;
  examples: string[];
  values: { category: string; location: string; language: string };
}): Promise<ActionResult<GenerationResult>> {
  if (!isUuid(input.workspaceId) || !isUuid(input.connectionId) || !isKind(input.kind))
    return fail("Choose a connection and a prompt type.", "invalid");
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 50)
    return fail("Choose how many variations to generate, between 1 and 50.", "invalid");
  return operate<GenerationResult>(
    "variations.generate",
    {
      workspace_id: input.workspaceId,
      connection_id: input.connectionId,
      model: input.model,
      kind: input.kind,
      count: input.count,
      guidance: input.guidance,
      examples: input.examples,
      values: input.values,
    },
    {
      success: (data) =>
        `${data.candidates.length} candidate${data.candidates.length === 1 ? "" : "s"} generated. Review them before saving.`,
    },
  );
}
