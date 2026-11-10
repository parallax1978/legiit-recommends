import { exportContext, jsonResponse, notFoundResponse } from "@/lib/export";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One conversation as JSON: the exact messages, answers, ids, usage and every request sent. */
export async function GET(_request: Request, context: RouteContext<"/exports/conversations/[id]">) {
  const { id } = await context.params;
  const ctx = await exportContext();
  if (ctx instanceof Response) return ctx;
  if (!UUID.test(id)) return notFoundResponse();
  const { data: run } = await ctx.supabase.from("runs").select("*").eq("id", id).maybeSingle();
  if (!run || !ctx.session.workspaces.some((workspace) => workspace.id === run.workspace_id))
    return notFoundResponse();

  const [
    { data: campaign },
    { data: revision },
    { data: turns },
    { data: attempts },
    { data: classifications },
  ] = await Promise.all([
    ctx.supabase.from("campaigns").select("id, name").eq("id", run.campaign_id).maybeSingle(),
    ctx.supabase
      .from("campaign_revisions")
      .select("revision_number")
      .eq("id", run.revision_id)
      .maybeSingle(),
    ctx.supabase.from("run_turns").select("*").eq("run_id", run.id).order("step_index"),
    ctx.supabase.from("provider_attempts").select("*").eq("run_id", run.id).order("started_at"),
    ctx.supabase
      .from("classifications")
      .select(
        "subject_id, method, detector_version, inclusion, mentioned, rank, list_position, list_kind, matched_spans, reason, note, is_current, created_at",
      )
      .eq("campaign_id", run.campaign_id)
      .eq("subject_type", "run_turn"),
  ]);
  const turnIds = new Set((turns ?? []).map((turn) => turn.id));

  return jsonResponse(`conversation-${run.id}.json`, {
    exported_at: new Date().toISOString(),
    source: "OpenAI API",
    campaign,
    conversation: {
      id: run.id,
      type: run.kind,
      number: run.kind === "scheduled" ? run.ordinal + 1 : null,
      status: run.status,
      revision: revision?.revision_number ?? null,
      model_requested: run.model,
      model_settings: run.model_params,
      max_output_tokens: run.max_output_tokens,
      execution_mode: run.execution_mode,
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
    },
    turns: (turns ?? []).map((turn) => ({
      turn: turn.step_index,
      kind: turn.step_kind,
      status: turn.status,
      template_id: turn.template_id,
      template_version_id: turn.template_version_id,
      user_message: turn.rendered_prompt,
      assistant_response: turn.output_text,
      output_items: turn.output_items,
      response_id: turn.response_id,
      previous_response_id: turn.previous_response_id,
      response_status: turn.response_status,
      incomplete_reason: turn.incomplete_reason,
      refusal: turn.refusal,
      model_requested: turn.requested_model,
      model_returned: turn.returned_model,
      request_settings: turn.request_params,
      service_tier: turn.service_tier,
      usage: {
        input_tokens: turn.input_tokens,
        cached_input_tokens: turn.cached_input_tokens,
        cache_write_tokens: turn.cache_write_tokens,
        output_tokens: turn.output_tokens,
        reasoning_tokens: turn.reasoning_tokens,
        total_tokens: turn.total_tokens,
        estimated_cost_usd: turn.cost_usd === null ? null : Number(turn.cost_usd),
      },
      latency_ms: turn.latency_ms,
      started_at: turn.started_at,
      completed_at: turn.completed_at,
      classifications: (classifications ?? [])
        .filter((item) => item.subject_id === turn.id)
        .map(({ subject_id: _subject, ...rest }) => rest),
    })),
    requests: (attempts ?? [])
      .filter((attempt) => !attempt.run_turn_id || turnIds.has(attempt.run_turn_id))
      .map((attempt) => ({
        turn: (turns ?? []).find((turn) => turn.id === attempt.run_turn_id)?.step_index ?? null,
        attempt: attempt.attempt_number,
        status: attempt.status,
        mode: attempt.mode,
        model_requested: attempt.requested_model,
        model_returned: attempt.returned_model,
        request_settings: attempt.request_params,
        response_id: attempt.response_id,
        provider_request_id: attempt.provider_request_id,
        http_status: attempt.http_status,
        error: attempt.error_class
          ? {
              class: attempt.error_class,
              type: attempt.error_type,
              code: attempt.error_code,
              message: attempt.error_message,
            }
          : null,
        retry_after_ms: attempt.retry_after_ms,
        usage: {
          input_tokens: attempt.input_tokens,
          cached_input_tokens: attempt.cached_input_tokens,
          output_tokens: attempt.output_tokens,
          reasoning_tokens: attempt.reasoning_tokens,
          estimated_cost_usd: attempt.cost_usd === null ? null : Number(attempt.cost_usd),
        },
        started_at: attempt.started_at,
        finished_at: attempt.finished_at,
        latency_ms: attempt.latency_ms,
        resolution: attempt.resolution,
      })),
  });
}
