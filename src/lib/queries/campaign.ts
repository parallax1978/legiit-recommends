import "server-only";
import { notFound } from "next/navigation";
import type { CampaignDraftInput } from "@/lib/actions/campaigns";
import { inChunks, readError, rowsOf, selectAll } from "@/lib/batch";
import { minutesToTime } from "@/lib/format";
import { uuidParam } from "@/lib/params";
import type { Session } from "@/lib/session";
import type { ServerClient } from "@/lib/supabase/server";
import { utcToZonedInput } from "@/lib/timezone";
import type { TemplateKind } from "@shared/core/templates.ts";
import type { Row } from "./types";

export type Campaign = Row<"campaigns">;
export type Revision = Row<"campaign_revisions">;

export interface RevisionStep {
  index: number;
  kind: TemplateKind;
  label: string | null;
  wordings: {
    templateId: string;
    versionId: string | null;
    version: number | null;
    body: string;
  }[];
}

/** A campaign of the current workspace, or a 404. Row level security also applies. */
export async function loadCampaign(
  supabase: ServerClient,
  session: Session,
  id: string,
): Promise<Campaign> {
  // Anything that is not a UUID cannot name a campaign; asking the database would be an error.
  if (!uuidParam(id)) notFound();
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();
  // "Could not be read" is not "does not exist": only the second is a 404.
  if (error) throw readError("The campaign", error);
  if (!data) notFound();
  return data;
}

export async function loadRevision(supabase: ServerClient, revisionId: string): Promise<Revision> {
  const { data, error } = await supabase
    .from("campaign_revisions")
    .select("*")
    .eq("id", revisionId)
    .maybeSingle();
  if (error) throw readError("The campaign's configuration", error);
  if (!data) notFound();
  return data;
}

/**
 * The steps of a revision with the exact wording each uses: the pinned version for a frozen
 * revision, the library's current version for a draft.
 */
export async function loadRevisionSteps(
  supabase: ServerClient,
  revisionId: string,
): Promise<RevisionStep[]> {
  const [steps, links] = await Promise.all([
    rowsOf(
      "The campaign's steps",
      supabase
        .from("campaign_revision_steps")
        .select("step_index, kind, label")
        .eq("revision_id", revisionId)
        .order("step_index"),
    ),
    // A step can use hundreds of wordings: read them in pages, in their order within the step.
    selectAll("The campaign's wordings", (from, to) =>
      supabase
        .from("campaign_revision_step_templates")
        .select("step_index, position, template_id, template_version_id")
        .eq("revision_id", revisionId)
        .order("position")
        .order("step_index")
        .range(from, to),
    ),
  ]);
  // Looked up in chunks, so the list of ids never has to fit in one request URL.
  const templates = await inChunks(
    links.map((link) => link.template_id),
    (chunk) =>
      rowsOf(
        "The campaign's wordings",
        supabase.from("templates").select("id, current_version_id").in("id", chunk),
      ),
  );
  const currentVersion = new Map(
    templates.map((template) => [template.id, template.current_version_id]),
  );
  const versionIds = links
    .map((link) => link.template_version_id ?? currentVersion.get(link.template_id))
    .filter((id): id is string => Boolean(id));
  const versions = await inChunks(versionIds, (chunk) =>
    rowsOf(
      "The campaign's wordings",
      supabase.from("template_versions").select("id, body, version").in("id", chunk),
    ),
  );
  const versionById = new Map(versions.map((version) => [version.id, version]));

  return steps.map((step) => ({
    index: step.step_index,
    kind: step.kind as TemplateKind,
    label: step.label,
    wordings: links
      .filter((link) => link.step_index === step.step_index)
      .map((link) => {
        const versionId = link.template_version_id ?? currentVersion.get(link.template_id) ?? null;
        const version = versionId ? versionById.get(versionId) : undefined;
        return {
          templateId: link.template_id,
          versionId,
          version: version?.version ?? null,
          body: version?.body ?? "",
        };
      }),
  }));
}

function stringParams(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== null && entry !== undefined) out[key] = String(entry);
    }
  }
  return out;
}

const text = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

/** Converts stored configuration into the editor's form values. Unset values stay blank. */
export function toDraftInput(
  campaign: Campaign,
  revision: Revision,
  steps: RevisionStep[],
): CampaignDraftInput {
  const zone = revision.timezone ?? "";
  const startLocal = zone ? utcToZonedInput(revision.start_at, zone) : "";
  const endLocal = zone ? utcToZonedInput(revision.end_at, zone) : "";
  const days =
    revision.start_at && revision.end_at
      ? Math.round((Date.parse(revision.end_at) - Date.parse(revision.start_at)) / 86_400_000)
      : null;
  const ordered = [...steps].sort((a, b) => a.index - b.index);
  const formSteps = ordered.map((step) => ({
    label: step.label ?? "",
    template_ids: step.wordings.map((wording) => wording.templateId),
  }));
  while (formSteps.length < 3) formSteps.push({ label: "", template_ids: [] });

  return {
    name: campaign.name,
    description: campaign.description ?? "",
    business_name: revision.business_name ?? "",
    website_url: revision.website_url ?? "",
    business_aliases: revision.business_aliases ?? [],
    domain_aliases: revision.domain_aliases ?? [],
    category: revision.category ?? "",
    location: revision.location ?? "",
    language: revision.language ?? "",
    steps: formSteps,
    selection_mode: revision.selection_mode,
    selection_seed: revision.selection_seed ?? "",
    on_existing_inclusion: revision.on_existing_inclusion ?? "",
    connection_id: revision.connection_id ?? "",
    model: revision.model ?? "",
    model_params: stringParams(revision.model_params),
    max_output_tokens: text(revision.max_output_tokens),
    execution_mode: revision.execution_mode,
    check_same_model: !revision.check_model,
    check_model: revision.check_model ?? "",
    check_params: stringParams(revision.check_params),
    check_max_output_tokens: text(revision.check_max_output_tokens),
    timezone: zone,
    start_local: startLocal,
    end_mode: revision.schedule_end_mode,
    end_local: endLocal,
    duration_days: revision.schedule_end_mode === "duration" && days !== null ? String(days) : "",
    active_weekdays: revision.active_weekdays ?? [],
    active_start: minutesToTime(revision.active_start_minute),
    active_end: minutesToTime(revision.active_end_minute),
    conversations_per_day: text(revision.conversations_per_day),
    total_conversation_limit: text(revision.total_conversation_limit),
    max_concurrency: text(revision.max_concurrency),
    requests_per_minute: text(revision.requests_per_minute),
    tokens_per_minute: text(revision.tokens_per_minute),
    jitter_seconds: revision.jitter_seconds ? String(revision.jitter_seconds) : "",
    missed_slot_behavior: revision.missed_slot_behavior ?? "",
    catch_up_max_delay_minutes: text(revision.catch_up_max_delay_minutes),
    catch_up_max_per_day: text(revision.catch_up_max_per_day),
    probe_set_id: revision.probe_set_id ?? "",
    baseline_samples: text(revision.baseline_samples),
    daily_checks: text(revision.daily_checks),
    final_samples: text(revision.final_samples),
    daily_budget_usd: text(revision.daily_budget_usd),
    total_budget_usd: text(revision.total_budget_usd),
  };
}

/** The question set a revision uses: the pinned version when frozen, the current one for a draft. */
export async function loadProbeSetSummary(supabase: ServerClient, revision: Revision) {
  if (!revision.probe_set_id) return null;
  const { data: set } = await supabase
    .from("probe_sets")
    .select("name, current_version_id")
    .eq("id", revision.probe_set_id)
    .maybeSingle();
  if (!set) return null;
  const versionId = revision.probe_set_version_id ?? set.current_version_id;
  if (!versionId)
    return { name: set.name, version: null, questions: 0, heldOut: 0, versionId: null };
  const [{ data: version }, { data: questions }] = await Promise.all([
    supabase.from("probe_set_versions").select("version").eq("id", versionId).maybeSingle(),
    supabase.from("probe_questions").select("is_held_out").eq("probe_set_version_id", versionId),
  ]);
  return {
    name: set.name,
    version: version?.version ?? null,
    questions: (questions ?? []).length,
    heldOut: (questions ?? []).filter((question) => question.is_held_out).length,
    versionId,
  };
}
