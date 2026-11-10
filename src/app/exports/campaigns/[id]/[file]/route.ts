import { rowsOf } from "@/lib/batch";
import {
  EXPORT_ROW_LIMIT,
  csvResponse,
  exportContext,
  fetchAll,
  fileSlug,
  jsonResponse,
  notFoundResponse,
  today,
  unavailableResponse,
  type ExportContext,
} from "@/lib/export";
import { loadRevisionSteps } from "@/lib/queries/campaign";
import type { Row } from "@/lib/queries/types";
import { toCsv } from "@shared/core/csv.ts";

type Campaign = Row<"campaigns">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: RouteContext<"/exports/campaigns/[id]/[file]">,
) {
  const { id, file } = await context.params;
  const ctx = await exportContext();
  if (ctx instanceof Response) return ctx;
  if (!UUID.test(id)) return notFoundResponse();
  const { data: campaign, error } = await ctx.supabase
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  // A read that failed is not "no such campaign".
  if (error) return unavailableResponse();
  // Not found and not permitted look the same: an id alone reveals nothing.
  if (
    !campaign ||
    !ctx.session.workspaces.some((workspace) => workspace.id === campaign.workspace_id)
  )
    return notFoundResponse();
  const base = `${fileSlug(campaign.name)}-${today()}`;
  // A table export that stopped at the row limit says so in its file name: a CSV has no other
  // place for it, and a file that silently ends early reads as complete.
  const csvFile = (name: string, table: CsvTable) =>
    csvResponse(
      `${base}-${name}${table.truncated ? `-first-${EXPORT_ROW_LIMIT}-rows` : ""}.csv`,
      table.csv,
    );

  switch (file) {
    case "conversations.csv":
      return csvFile("conversations", await conversationsCsv(ctx, campaign));
    case "fresh-checks.csv":
      return csvFile("fresh-checks", await freshChecksCsv(ctx, campaign));
    case "usage.csv":
      return csvFile("usage", await usageCsv(ctx, campaign));
    case "transcripts.json":
      return jsonResponse(`${base}-transcripts.json`, await transcriptsJson(ctx, campaign));
    case "config.json":
      return jsonResponse(`${base}-config.json`, await configJson(ctx, campaign));
    default:
      return notFoundResponse();
  }
}

/** A CSV and whether it stops at the export row limit. */
interface CsvTable {
  csv: string;
  truncated: boolean;
}

async function revisionNumbers(
  ctx: ExportContext,
  campaignId: string,
): Promise<Map<string, number>> {
  const revisions = await rowsOf(
    "The export",
    ctx.supabase
      .from("campaign_revisions")
      .select("id, revision_number")
      .eq("campaign_id", campaignId),
  );
  return new Map(revisions.map((revision) => [revision.id, revision.revision_number]));
}

async function conversationsCsv(ctx: ExportContext, campaign: Campaign): Promise<CsvTable> {
  const [{ rows: runs, truncated: runsCut }, { rows: turns, truncated: turnsCut }, revisions] =
    await Promise.all([
      fetchAll((from, to) =>
        ctx.supabase
          .from("runs")
          .select("*")
          .eq("campaign_id", campaign.id)
          .order("created_at")
          .order("id")
          .range(from, to),
      ),
      fetchAll(
        (from, to) =>
          ctx.supabase
            .from("run_turns")
            .select(
              "run_id, step_index, status, inclusion, mentioned, rank, list_position, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, cost_usd, returned_model",
            )
            .eq("campaign_id", campaign.id)
            .order("run_id")
            .order("step_index")
            .range(from, to),
        EXPORT_ROW_LIMIT * 4,
      ),
      revisionNumbers(ctx, campaign.id),
    ]);
  const byRun = new Map<string, typeof turns>();
  for (const turn of turns) byRun.set(turn.run_id, [...(byRun.get(turn.run_id) ?? []), turn]);

  const csv = toCsv(
    runs.map((run) => {
      const own = byRun.get(run.id) ?? [];
      const first = own.find((turn) => turn.step_index === 1);
      const final = run.steps_total
        ? own.find((turn) => turn.step_index === run.steps_total)
        : undefined;
      const sum = (
        key: "input_tokens" | "cached_input_tokens" | "output_tokens" | "reasoning_tokens",
      ) => own.reduce((total, turn) => total + (turn[key] ?? 0), 0);
      return {
        run,
        first,
        final,
        cost: own.reduce((total, turn) => total + Number(turn.cost_usd ?? 0), 0),
        input: sum("input_tokens"),
        cached: sum("cached_input_tokens"),
        output: sum("output_tokens"),
        reasoning: sum("reasoning_tokens"),
      };
    }),
    [
      { header: "conversation_id", value: (row) => row.run.id },
      { header: "type", value: (row) => row.run.kind },
      {
        header: "number",
        value: (row) => (row.run.kind === "scheduled" ? row.run.ordinal + 1 : null),
      },
      { header: "status", value: (row) => row.run.status },
      { header: "revision", value: (row) => revisions.get(row.run.revision_id) ?? null },
      { header: "cohort", value: (row) => row.run.cohort_key },
      { header: "model_requested", value: (row) => row.run.model },
      {
        header: "model_returned",
        value: (row) => row.final?.returned_model ?? row.first?.returned_model ?? null,
      },
      { header: "model_settings", value: (row) => JSON.stringify(row.run.model_params ?? {}) },
      { header: "max_output_tokens", value: (row) => row.run.max_output_tokens },
      { header: "turns_completed", value: (row) => row.run.steps_completed },
      { header: "turns_total", value: (row) => row.run.steps_total },
      {
        header: "business_named_in_initial_question",
        value: (row) => row.run.target_in_initial_prompt,
      },
      { header: "first_response_status", value: (row) => row.first?.status ?? null },
      { header: "first_response_classification", value: (row) => row.first?.inclusion ?? null },
      { header: "first_response_rank", value: (row) => row.first?.rank ?? null },
      { header: "first_response_list_position", value: (row) => row.first?.list_position ?? null },
      { header: "final_response_status", value: (row) => row.final?.status ?? null },
      {
        header: "final_response_classification",
        value: (row) => (row.run.status === "completed" ? (row.final?.inclusion ?? null) : null),
      },
      {
        header: "final_response_rank",
        value: (row) => (row.run.status === "completed" ? (row.final?.rank ?? null) : null),
      },
      {
        header: "final_response_list_position",
        value: (row) =>
          row.run.status === "completed" ? (row.final?.list_position ?? null) : null,
      },
      { header: "selection_mode", value: (row) => row.run.selection_mode },
      { header: "selection_seed", value: (row) => row.run.selection_seed },
      {
        header: "combination_index",
        value: (row) =>
          row.run.combination_index === null ? null : Number(row.run.combination_index),
      },
      { header: "input_tokens", value: (row) => row.input },
      { header: "cached_input_tokens", value: (row) => row.cached },
      { header: "output_tokens", value: (row) => row.output },
      { header: "reasoning_tokens", value: (row) => row.reasoning },
      { header: "estimated_cost_usd", value: (row) => row.cost },
      { header: "scheduled_for_utc", value: (row) => row.run.scheduled_for },
      { header: "started_at_utc", value: (row) => row.run.started_at },
      { header: "completed_at_utc", value: (row) => row.run.completed_at },
      { header: "error", value: (row) => row.run.error_class },
      { header: "restart_of_conversation_id", value: (row) => row.run.restart_of_run_id },
    ],
  );
  // Without all of its turns a conversation's first and final columns would be blank.
  return { csv, truncated: runsCut || turnsCut };
}

async function freshChecksCsv(ctx: ExportContext, campaign: Campaign): Promise<CsvTable> {
  const [{ rows: checks, truncated }, groups, revisions] = await Promise.all([
    fetchAll((from, to) =>
      ctx.supabase
        .from("fresh_checks")
        .select("*")
        .eq("campaign_id", campaign.id)
        .order("created_at")
        .order("id")
        .range(from, to),
    ),
    rowsOf(
      "The export",
      ctx.supabase.from("comparison_groups").select("id, sequence").eq("campaign_id", campaign.id),
    ),
    revisionNumbers(ctx, campaign.id),
  ]);
  const sequence = new Map(groups.map((group) => [group.id, group.sequence]));
  const csv = toCsv(checks, [
    { header: "source", value: () => "OpenAI API" },
    { header: "fresh_check_id", value: (row) => row.id },
    { header: "comparison_group", value: (row) => sequence.get(row.comparison_group_id) ?? null },
    { header: "phase", value: (row) => row.phase },
    { header: "campaign_day", value: (row) => row.local_day },
    { header: "held_out_question", value: (row) => row.is_held_out },
    { header: "question_position", value: (row) => row.question_position },
    { header: "question_sent", value: (row) => row.rendered_prompt },
    { header: "status", value: (row) => row.status },
    { header: "not_counted_reason", value: (row) => row.exclusion_reason ?? row.incomplete_reason },
    {
      header: "classification",
      value: (row) => (row.status === "completed" ? row.inclusion : null),
    },
    { header: "rank", value: (row) => row.rank },
    { header: "list_position", value: (row) => row.list_position },
    { header: "revision", value: (row) => revisions.get(row.revision_id) ?? null },
    { header: "model_requested", value: (row) => row.model },
    { header: "model_returned", value: (row) => row.returned_model },
    { header: "model_settings", value: (row) => JSON.stringify(row.params ?? {}) },
    { header: "max_output_tokens", value: (row) => row.max_output_tokens },
    { header: "response_id", value: (row) => row.response_id },
    { header: "input_tokens", value: (row) => row.input_tokens },
    { header: "cached_input_tokens", value: (row) => row.cached_input_tokens },
    { header: "output_tokens", value: (row) => row.output_tokens },
    { header: "reasoning_tokens", value: (row) => row.reasoning_tokens },
    {
      header: "estimated_cost_usd",
      value: (row) => (row.cost_usd === null ? null : Number(row.cost_usd)),
    },
    { header: "scheduled_for_utc", value: (row) => row.scheduled_for },
    { header: "completed_at_utc", value: (row) => row.completed_at },
    { header: "response", value: (row) => row.output_text },
  ]);
  return { csv, truncated };
}

async function usageCsv(ctx: ExportContext, campaign: Campaign): Promise<CsvTable> {
  const { rows, truncated } = await fetchAll((from, to) =>
    ctx.supabase
      .from("usage_ledger")
      .select("*")
      .eq("campaign_id", campaign.id)
      .order("occurred_at")
      .order("id")
      .range(from, to),
  );
  const csv = toCsv(rows, [
    { header: "occurred_at_utc", value: (row) => row.occurred_at },
    { header: "connection_day_utc", value: (row) => row.connection_day },
    { header: "campaign_day", value: (row) => row.campaign_day },
    { header: "purpose", value: (row) => row.purpose },
    { header: "test", value: (row) => row.is_test },
    { header: "model_requested", value: (row) => row.model },
    { header: "model_returned", value: (row) => row.returned_model },
    { header: "input_tokens", value: (row) => row.input_tokens },
    { header: "cached_input_tokens", value: (row) => row.cached_input_tokens },
    { header: "cache_write_tokens", value: (row) => row.cache_write_tokens },
    { header: "output_tokens", value: (row) => row.output_tokens },
    { header: "reasoning_tokens", value: (row) => row.reasoning_tokens },
    { header: "estimated_cost_usd", value: (row) => Number(row.cost_usd) },
    {
      header: "basis",
      value: (row) =>
        row.basis === "reservation" ? "reserved amount (outcome unknown)" : "recorded usage",
    },
    { header: "price_version_id", value: (row) => row.price_id },
    { header: "request_id", value: (row) => row.attempt_id },
  ]);
  return { csv, truncated };
}

const TRANSCRIPT_RUN_LIMIT = 5_000;

async function transcriptsJson(ctx: ExportContext, campaign: Campaign) {
  const allTurns = () => ctx.supabase.from("run_turns").select("*");
  const [{ rows: runs, truncated }, revisions] = await Promise.all([
    fetchAll(
      (from, to) =>
        ctx.supabase
          .from("runs")
          .select("*")
          .eq("campaign_id", campaign.id)
          .order("created_at")
          .order("id")
          .range(from, to),
      TRANSCRIPT_RUN_LIMIT,
    ),
    revisionNumbers(ctx, campaign.id),
  ]);
  const runIds = new Set(runs.map((run) => run.id));
  // The turns of the exported conversations. When the conversation list was cut at its limit,
  // reading "the campaign's turns" up to a row limit would leave a random share of the exported
  // conversations without any: turns are then restricted to conversations created no later than
  // the last exported one (a conversation has at most 12 turns, so the limit below holds them).
  const lastCreatedAt = truncated ? runs.at(-1)?.created_at : undefined;
  const { rows: turns, truncated: turnsCut } = await fetchAll(
    (from, to) => {
      const query = lastCreatedAt
        ? (ctx.supabase
            .from("run_turns")
            .select("*, runs!inner(created_at)")
            .lte("runs.created_at", lastCreatedAt) as unknown as ReturnType<typeof allTurns>)
        : allTurns();
      return query
        .eq("campaign_id", campaign.id)
        .order("run_id")
        .order("step_index")
        .range(from, to);
    },
    TRANSCRIPT_RUN_LIMIT * 12 + 1000,
  );
  if (turnsCut) throw new Error("The transcripts could not be read completely.");
  const byRun = new Map<string, typeof turns>();
  for (const turn of turns)
    if (runIds.has(turn.run_id)) byRun.set(turn.run_id, [...(byRun.get(turn.run_id) ?? []), turn]);

  return {
    exported_at: new Date().toISOString(),
    source: "OpenAI API",
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
    truncated,
    conversations: runs.map((run) => ({
      id: run.id,
      type: run.kind,
      number: run.kind === "scheduled" ? run.ordinal + 1 : null,
      status: run.status,
      revision: revisions.get(run.revision_id) ?? null,
      model_requested: run.model,
      model_settings: run.model_params,
      max_output_tokens: run.max_output_tokens,
      target: run.target,
      selection: {
        mode: run.selection_mode,
        seed: run.selection_seed,
        combination_index: run.combination_index === null ? null : Number(run.combination_index),
        combination: run.combination,
      },
      business_named_in_initial_question: run.target_in_initial_prompt,
      business_in_first_response: run.target_in_first_response,
      scheduled_for: run.scheduled_for,
      started_at: run.started_at,
      completed_at: run.completed_at,
      error: run.error_class ? { class: run.error_class, message: run.error_message } : null,
      restart_of: run.restart_of_run_id,
      text_removed_at: run.content_purged_at,
      turns: (byRun.get(run.id) ?? []).map((turn) => ({
        turn: turn.step_index,
        kind: turn.step_kind,
        status: turn.status,
        template_id: turn.template_id,
        template_version_id: turn.template_version_id,
        user_message: turn.rendered_prompt,
        assistant_response: turn.output_text,
        response_id: turn.response_id,
        previous_response_id: turn.previous_response_id,
        response_status: turn.response_status,
        incomplete_reason: turn.incomplete_reason,
        refusal: turn.refusal,
        model_requested: turn.requested_model,
        model_returned: turn.returned_model,
        request_settings: turn.request_params,
        usage: {
          input_tokens: turn.input_tokens,
          cached_input_tokens: turn.cached_input_tokens,
          output_tokens: turn.output_tokens,
          reasoning_tokens: turn.reasoning_tokens,
          estimated_cost_usd: turn.cost_usd === null ? null : Number(turn.cost_usd),
        },
        latency_ms: turn.latency_ms,
        attempts: turn.attempt_count,
        classification: turn.inclusion
          ? {
              inclusion: turn.inclusion,
              mentioned: turn.mentioned,
              rank: turn.rank,
              list_position: turn.list_position,
            }
          : null,
        started_at: turn.started_at,
        completed_at: turn.completed_at,
      })),
    })),
  };
}

async function configJson(ctx: ExportContext, campaign: Campaign) {
  const revisions = await rowsOf(
    "The export",
    ctx.supabase
      .from("campaign_revisions")
      .select("*")
      .eq("campaign_id", campaign.id)
      .neq("state", "discarded")
      .order("revision_number"),
  );
  const detailed = [];
  for (const revision of revisions) {
    const steps = await loadRevisionSteps(ctx.supabase, revision.id);
    let questions: { position: number; body: string; is_held_out: boolean }[] = [];
    let questionSet: { name: string } | null = null;
    if (revision.probe_set_id) {
      const { data: set, error } = await ctx.supabase
        .from("probe_sets")
        .select("name, current_version_id")
        .eq("id", revision.probe_set_id)
        .maybeSingle();
      if (error) throw new Error("The export could not be loaded.");
      questionSet = set ? { name: set.name } : null;
      const versionId = revision.probe_set_version_id ?? set?.current_version_id;
      if (versionId) {
        questions = await rowsOf(
          "The export",
          ctx.supabase
            .from("probe_questions")
            .select("position, body, is_held_out")
            .eq("probe_set_version_id", versionId)
            .order("position"),
        );
      }
    }
    const {
      id,
      workspace_id: _workspace,
      campaign_id: _campaign,
      created_by: _createdBy,
      frozen_by: _frozenBy,
      ...config
    } = revision;
    detailed.push({
      revision_id: id,
      in_effect: id === campaign.active_revision_id,
      pending_changes: id === campaign.draft_revision_id && campaign.status !== "draft",
      ...config,
      conversation_steps: steps.map((step) => ({
        turn: step.index,
        kind: step.kind,
        label: step.label,
        wordings: step.wordings.map((wording) => ({
          template_id: wording.templateId,
          template_version_id: wording.versionId,
          version: wording.version,
          body: wording.body,
        })),
      })),
      fresh_check_question_set: questionSet ? { ...questionSet, questions } : null,
    });
  }
  return {
    exported_at: new Date().toISOString(),
    campaign: {
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      status: campaign.status,
      launched_at: campaign.launched_at,
      started_at: campaign.started_at,
      completed_at: campaign.completed_at,
      canceled_at: campaign.canceled_at,
    },
    revisions: detailed,
  };
}
