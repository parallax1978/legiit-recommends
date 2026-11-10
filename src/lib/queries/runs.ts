import "server-only";
import type { ServerClient } from "@/lib/supabase/server";

export interface RunListFilters {
  workspaceId: string;
  campaignId?: string | null;
  status?: string;
  kind?: string;
  /** Classification of the final (or first) response. */
  inclusion?: string;
}

export interface RunListRow {
  id: string;
  campaignId: string;
  campaignName: string;
  kind: string;
  ordinal: number;
  status: string;
  model: string | null;
  stepsTotal: number | null;
  stepsCompleted: number;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorClass: string | null;
  targetInFirstResponse: boolean | null;
  restartOfRunId: string | null;
  first: { inclusion: string | null; rank: number | null; listPosition: number | null } | null;
  final: { inclusion: string | null; rank: number | null; listPosition: number | null } | null;
  costUsd: number;
  contentPurged: boolean;
}

export const RUN_PAGE_SIZE = 25;

/** One page of conversations, newest first, with first/final classification and cost. */
export async function listRuns(
  supabase: ServerClient,
  filters: RunListFilters,
  page: number,
  pageSize = RUN_PAGE_SIZE,
): Promise<{ rows: RunListRow[]; total: number }> {
  let ids: string[] | null = null;
  if (filters.inclusion) {
    // Runs with at least one response classified this way.
    let turns = supabase
      .from("run_turns")
      .select("run_id")
      .eq("workspace_id", filters.workspaceId)
      .eq("inclusion", filters.inclusion)
      .limit(2000);
    if (filters.campaignId) turns = turns.eq("campaign_id", filters.campaignId);
    const { data } = await turns;
    ids = [...new Set((data ?? []).map((turn) => turn.run_id))];
    if (ids.length === 0) return { rows: [], total: 0 };
  }

  let query = supabase
    .from("runs")
    .select(
      "id, campaign_id, kind, ordinal, status, model, steps_total, steps_completed, scheduled_for, started_at, completed_at, error_class, target_in_first_response, restart_of_run_id, content_purged_at, created_at, campaigns(name)",
      { count: "exact" },
    )
    .eq("workspace_id", filters.workspaceId)
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (filters.campaignId) query = query.eq("campaign_id", filters.campaignId);
  if (filters.status) {
    if (filters.status === "problem")
      query = query.in("status", ["failed", "incomplete", "expired", "unresolved"]);
    else if (filters.status === "done")
      query = query.in("status", ["completed", "completed_early"]);
    else if (filters.status === "active") query = query.in("status", ["pending", "in_progress"]);
    else query = query.eq("status", filters.status as never);
  }
  if (filters.kind === "test" || filters.kind === "scheduled")
    query = query.eq("kind", filters.kind);
  if (ids) query = query.in("id", ids);

  const { data: runs, count, error } = await query;
  if (error) throw new Error("Conversations could not be loaded.");
  const runIds = (runs ?? []).map((run) => run.id);
  const { data: turns } = runIds.length
    ? await supabase
        .from("run_turns")
        .select("run_id, step_index, status, inclusion, rank, list_position, cost_usd")
        .in("run_id", runIds)
    : { data: [] };

  const rows = (runs ?? []).map((run): RunListRow => {
    const own = (turns ?? []).filter((turn) => turn.run_id === run.id);
    const firstTurn = own.find((turn) => turn.step_index === 1 && turn.status === "completed");
    const finalTurn = run.steps_total
      ? own.find((turn) => turn.step_index === run.steps_total && turn.status === "completed")
      : undefined;
    return {
      id: run.id,
      campaignId: run.campaign_id,
      campaignName: run.campaigns?.name ?? "Campaign",
      kind: run.kind,
      ordinal: run.ordinal,
      status: run.status,
      model: run.model,
      stepsTotal: run.steps_total,
      stepsCompleted: run.steps_completed,
      scheduledFor: run.scheduled_for,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      errorClass: run.error_class,
      targetInFirstResponse: run.target_in_first_response,
      restartOfRunId: run.restart_of_run_id,
      first: firstTurn
        ? {
            inclusion: firstTurn.inclusion,
            rank: firstTurn.rank,
            listPosition: firstTurn.list_position,
          }
        : null,
      final: finalTurn
        ? {
            inclusion: finalTurn.inclusion,
            rank: finalTurn.rank,
            listPosition: finalTurn.list_position,
          }
        : null,
      costUsd: own.reduce((total, turn) => total + Number(turn.cost_usd ?? 0), 0),
      contentPurged: Boolean(run.content_purged_at),
    };
  });
  return { rows, total: count ?? rows.length };
}
