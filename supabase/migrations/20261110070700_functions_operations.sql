-- Legiit Recommends — campaign controls, review-queue actions, classification corrections,
-- reporting and operational status.

-- ---------------------------------------------------------------------------------------------
-- Pause / resume / cancel
-- ---------------------------------------------------------------------------------------------

create or replace function public.pause_campaign(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  v_paused integer;
begin
  select * into c from public.campaigns cp where cp.id = p_campaign_id for no key update;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(c.workspace_id, 'admin');
  if c.status not in ('scheduled', 'baseline', 'running', 'finalizing') then
    perform app_private.fail('not_pausable', 'Only scheduled or running campaigns can be paused.');
  end if;

  update public.campaigns
  set paused_from = c.status, status = 'paused', pause_reason = 'user', pause_detail = null
  where id = p_campaign_id;
  v_paused := app_private.pause_campaign_jobs(p_campaign_id, 'campaign_paused');

  perform app_private.audit(c.workspace_id, 'campaign.paused', 'campaign', p_campaign_id,
    jsonb_build_object('from', c.status, 'jobs_paused', v_paused));
end;
$$;

create or replace function public.resume_campaign(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  v_now timestamptz := now();
  v_resumed integer;
begin
  select * into c from public.campaigns cp where cp.id = p_campaign_id for no key update;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(c.workspace_id, 'admin');
  if c.status <> 'paused' then
    perform app_private.fail('not_paused', 'This campaign is not paused.');
  end if;

  update public.campaigns
  set status = c.paused_from, paused_from = null, pause_reason = null, pause_detail = null
  where id = p_campaign_id;
  v_resumed := app_private.resume_campaign_jobs(p_campaign_id);

  perform app_private.audit(c.workspace_id, 'campaign.resumed', 'campaign', p_campaign_id,
    jsonb_build_object('to', c.paused_from, 'jobs_resumed', v_resumed, 'paused_for', c.pause_reason));

  -- Slots that passed while paused are handled by the campaign's missed-slot setting.
  perform app_private.plan_campaign(p_campaign_id, v_now);
  perform app_private.dispatch(v_now);
end;
$$;

create or replace function public.cancel_campaign(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  v_job public.jobs%rowtype;
  v_canceled integer := 0;
  v_in_flight integer := 0;
begin
  select * into c from public.campaigns cp where cp.id = p_campaign_id for no key update;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(c.workspace_id, 'admin');
  if c.status not in ('scheduled', 'baseline', 'running', 'paused', 'finalizing') then
    perform app_private.fail('not_cancelable', 'Only active campaigns can be canceled.');
  end if;

  update public.campaigns
  set status = 'canceled', paused_from = null, pause_reason = null, pause_detail = null,
      canceled_at = now(), canceled_by = (select auth.uid())
  where id = p_campaign_id;

  for v_job in
    select j.* from public.jobs j
    where j.campaign_id = p_campaign_id
      and j.kind <> 'test_conversation'
      and j.status in ('pending', 'queued', 'waiting', 'paused', 'blocked', 'running')
    for no key update
  loop
    if v_job.status = 'running' or exists (
      select 1 from public.provider_attempts a
      where a.job_id = v_job.id and a.status in ('started', 'in_flight')
    ) then
      -- Already submitted: it stays in flight until its status resolves, then stops.
      v_in_flight := v_in_flight + 1;
    else
      perform app_private.cancel_job(v_job, 'campaign_canceled');
      v_canceled := v_canceled + 1;
    end if;
  end loop;

  if c.draft_revision_id is not null then
    update public.campaigns set draft_revision_id = null where id = p_campaign_id;
    update public.campaign_revisions set state = 'discarded' where id = c.draft_revision_id and state = 'draft';
  end if;

  perform app_private.audit(c.workspace_id, 'campaign.canceled', 'campaign', p_campaign_id,
    jsonb_build_object('from', c.status, 'jobs_canceled', v_canceled, 'requests_in_flight', v_in_flight));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Test conversation: one complete sequence, clearly marked as a test, with its own budget check.
-- ---------------------------------------------------------------------------------------------

create or replace function public.request_test_conversation(p_campaign_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  v_ws public.workspaces%rowtype;
  v_rev public.campaign_revisions%rowtype;
  v_problems jsonb;
  v_job public.jobs%rowtype;
  v_run_id uuid;
  v_now timestamptz := now();
  v_day date := (now() at time zone 'UTC')::date;
begin
  select * into c from public.campaigns cp where cp.id = p_campaign_id for no key update;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(c.workspace_id, 'admin');
  select * into v_ws from public.workspaces w where w.id = c.workspace_id;
  if v_ws.emergency_stop then
    perform app_private.fail('emergency_stop', 'The workspace stop is active. An owner must release it before paid requests can run.');
  end if;

  select * into v_rev from public.campaign_revisions r
  where r.id = coalesce(c.draft_revision_id, c.active_revision_id);
  v_problems := app_private.revision_problems(v_rev.id, 'test', v_now);
  if jsonb_array_length(v_problems) > 0 then
    raise exception using
      errcode = 'P0001',
      message = v_problems -> 0 ->> 'message',
      detail = 'campaign_invalid',
      hint = v_problems::text;
  end if;
  if exists (
    select 1 from public.jobs j
    where j.campaign_id = p_campaign_id and j.kind = 'test_conversation'
      and j.status in ('queued', 'running', 'waiting')
    having count(*) >= 3
  ) then
    perform app_private.fail('too_many_tests', 'Wait for the running test conversations to finish first.');
  end if;

  insert into public.jobs (
    workspace_id, campaign_id, revision_id, connection_id, kind, slot_date, slot_index, scheduled_for, max_attempts
  )
  values (
    c.workspace_id, c.id, v_rev.id, v_rev.connection_id, 'test_conversation', v_day,
    (select coalesce(max(j.slot_index) + 1, 0) from public.jobs j
     where j.revision_id = v_rev.id and j.kind = 'test_conversation' and j.slot_date = v_day),
    v_now, 3
  )
  returning * into v_job;

  v_run_id := app_private.create_run(v_job, v_rev, 'test');
  perform app_private.enqueue_job(v_job.id);
  update public.jobs set dispatched_at = v_now where id = v_job.id;

  perform app_private.audit(c.workspace_id, 'campaign.test_requested', 'run', v_run_id,
    jsonb_build_object('campaign_id', c.id, 'revision_id', v_rev.id));
  perform app_private.wake_workers();
  return v_run_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Review queue
-- ---------------------------------------------------------------------------------------------

-- Retries a dead-lettered or blocked job from its persisted state (earlier turns are kept).
create or replace function public.retry_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids record;
  c public.campaigns%rowtype;
  v_job public.jobs%rowtype;
  v_run public.runs%rowtype;
begin
  select j.campaign_id, j.workspace_id into v_ids from public.jobs j where j.id = p_job_id;
  if not found then
    perform app_private.forbid('Job not found or access denied.');
  end if;
  perform app_private.require_role(v_ids.workspace_id, 'admin');
  select * into c from public.campaigns cp where cp.id = v_ids.campaign_id for no key update;
  select * into v_job from public.jobs j where j.id = p_job_id for no key update;

  if v_job.status not in ('dead', 'blocked') then
    perform app_private.fail('not_retryable', 'Only failed or blocked jobs can be retried.');
  end if;
  if v_job.run_id is not null then
    select * into v_run from public.runs r where r.id = v_job.run_id;
    if v_run.status = 'expired' then
      perform app_private.fail('chain_expired', 'This conversation can no longer be continued. Restart the run instead.');
    end if;
  end if;
  if v_job.kind <> 'test_conversation' and c.status not in ('baseline', 'running', 'finalizing', 'paused') then
    perform app_private.fail('campaign_not_active', 'The campaign is no longer active, so this job cannot be retried.');
  end if;

  update public.jobs
  set attempts = 0, finished_at = null, last_error_class = null, last_error_message = null, status_reason = null
  where id = p_job_id;
  update public.runs set status = 'in_progress', error_class = null, error_message = null
  where id = v_job.run_id and status = 'failed';
  update public.run_turns set status = 'pending' where run_id = v_job.run_id and status in ('failed', 'uncertain');
  update public.fresh_checks set status = 'pending', exclusion_reason = null
  where id = v_job.fresh_check_id and status in ('failed', 'uncertain');

  if v_job.kind <> 'test_conversation' and c.status = 'paused' then
    update public.jobs set status = 'paused', status_reason = 'campaign_paused', blocked_until = null where id = p_job_id;
  else
    perform app_private.enqueue_job(p_job_id);
    perform app_private.wake_workers();
  end if;

  perform app_private.audit(v_job.workspace_id, 'job.retried', 'job', p_job_id,
    jsonb_build_object('campaign_id', v_job.campaign_id, 'previous_status', v_job.status,
      'previous_error', v_job.last_error_class));
end;
$$;

-- Starts a brand-new conversation in place of one that cannot be continued. The old run is
-- kept as it is; nothing from it is replayed.
create or replace function public.restart_run(p_run_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  c public.campaigns%rowtype;
  v_old_job public.jobs%rowtype;
  v_rev public.campaign_revisions%rowtype;
  v_job public.jobs%rowtype;
  v_new_run uuid;
  v_now timestamptz := now();
  v_day date;
begin
  select * into v_run from public.runs r where r.id = p_run_id;
  if not found then
    perform app_private.forbid('Run not found or access denied.');
  end if;
  perform app_private.require_role(v_run.workspace_id, 'admin');
  select * into c from public.campaigns cp where cp.id = v_run.campaign_id for no key update;
  select * into v_old_job from public.jobs j where j.id = v_run.job_id;
  select * into v_rev from public.campaign_revisions r where r.id = v_run.revision_id;

  if v_run.status not in ('expired', 'failed', 'incomplete') then
    perform app_private.fail('not_restartable', 'Only expired, failed or incomplete runs can be restarted.');
  end if;
  if exists (select 1 from public.runs r where r.restart_of_run_id = p_run_id) then
    perform app_private.fail('already_restarted', 'This run has already been restarted.');
  end if;
  if v_run.kind = 'scheduled' and c.status not in ('baseline', 'running', 'finalizing', 'paused') then
    perform app_private.fail('campaign_not_active', 'The campaign is no longer active, so this run cannot be restarted.');
  end if;

  v_day := (v_now at time zone coalesce(v_rev.timezone, 'UTC'))::date;
  insert into public.jobs (
    workspace_id, campaign_id, revision_id, connection_id, kind, slot_date, slot_index, scheduled_for
  )
  values (
    v_run.workspace_id, v_run.campaign_id, v_run.revision_id, v_rev.connection_id, v_old_job.kind, v_day,
    -- Restart slots live above the range the planner uses.
    1000000 + (select count(*) from public.jobs j
               where j.revision_id = v_run.revision_id and j.kind = v_old_job.kind
                 and j.slot_date = v_day and j.slot_index >= 1000000),
    v_now
  )
  returning * into v_job;

  v_new_run := app_private.create_run(v_job, v_rev, v_run.kind, p_run_id);
  if v_run.kind = 'scheduled' and c.status = 'paused' then
    update public.jobs set status = 'paused', status_reason = 'campaign_paused' where id = v_job.id;
  else
    perform app_private.enqueue_job(v_job.id);
    update public.jobs set dispatched_at = v_now where id = v_job.id;
    perform app_private.wake_workers();
  end if;

  perform app_private.audit(v_run.workspace_id, 'run.restarted', 'run', v_new_run,
    jsonb_build_object('campaign_id', v_run.campaign_id, 'restart_of_run_id', p_run_id,
      'previous_status', v_run.status));
  return v_new_run;
end;
$$;

-- Owner decision on an ambiguous attempt whose cost is unknown.
create or replace function public.resolve_uncertain_attempt(p_attempt_id uuid, p_resolution text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.provider_attempts%rowtype;
  v_res public.budget_reservations%rowtype;
begin
  select * into v_attempt from public.provider_attempts a where a.id = p_attempt_id for no key update;
  if not found then
    perform app_private.forbid('Attempt not found or access denied.');
  end if;
  perform app_private.require_role(v_attempt.workspace_id, 'owner');
  if v_attempt.status <> 'uncertain' or v_attempt.resolved_at is not null then
    perform app_private.fail('not_unresolved', 'This attempt is not waiting for a decision.');
  end if;
  if p_resolution not in ('counted_as_spent', 'released') then
    perform app_private.fail('invalid_resolution', 'Choose to count the reserved amount as spent or to release it.');
  end if;
  select * into v_res from public.budget_reservations r where r.id = v_attempt.reservation_id for no key update;

  if p_resolution = 'counted_as_spent' then
    update public.budget_reservations
    set status = 'settled', settled_cost_usd = amount_usd, closed_at = now()
    where id = v_res.id;
    insert into public.usage_ledger (
      workspace_id, connection_id, campaign_id, attempt_id, purpose, is_test, model,
      cost_usd, price_id, basis, connection_day, campaign_day
    )
    values (
      v_attempt.workspace_id, v_attempt.connection_id, v_attempt.campaign_id, v_attempt.id, v_attempt.purpose,
      v_attempt.is_test, v_attempt.requested_model, v_res.amount_usd, v_attempt.price_id, 'reservation',
      v_res.connection_day, v_res.campaign_day
    )
    on conflict (attempt_id) do nothing;
    update public.provider_attempts set cost_usd = v_res.amount_usd where id = p_attempt_id;
  else
    update public.budget_reservations set status = 'released', closed_at = now() where id = v_res.id;
  end if;

  update public.provider_attempts
  set resolved_at = now(), resolved_by = (select auth.uid()), resolution = p_resolution
  where id = p_attempt_id;

  perform app_private.audit(v_attempt.workspace_id, 'attempt.resolved', 'attempt', p_attempt_id,
    jsonb_build_object('resolution', p_resolution, 'amount_usd', v_res.amount_usd,
      'campaign_id', v_attempt.campaign_id));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Classification corrections and manual observations
-- ---------------------------------------------------------------------------------------------

create or replace function public.correct_classification(
  p_subject_type text,
  p_subject_id uuid,
  p_inclusion text,
  p_rank integer default null,
  p_list_position integer default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_campaign_id uuid;
  v_prev public.classifications%rowtype;
  v_id uuid;
  v_list_kind text;
begin
  if p_subject_type = 'run_turn' then
    select t.workspace_id, t.campaign_id into v_workspace_id, v_campaign_id from public.run_turns t where t.id = p_subject_id;
  elsif p_subject_type = 'fresh_check' then
    select f.workspace_id, f.campaign_id into v_workspace_id, v_campaign_id from public.fresh_checks f where f.id = p_subject_id;
  elsif p_subject_type = 'manual_check' then
    select m.workspace_id, m.campaign_id into v_workspace_id, v_campaign_id from public.manual_checks m where m.id = p_subject_id;
  end if;
  if v_workspace_id is null then
    perform app_private.forbid('Response not found or access denied.');
  end if;
  perform app_private.require_role(v_workspace_id, 'admin');
  if p_inclusion not in ('included', 'mentioned_only', 'not_mentioned') then
    perform app_private.fail('invalid_classification', 'Choose included, mentioned only, or not mentioned.');
  end if;
  if p_rank is not null and p_rank < 1 or p_list_position is not null and p_list_position < 1 then
    perform app_private.fail('invalid_position', 'Rank and list position start at 1.');
  end if;

  select * into v_prev from public.classifications k
  where k.subject_type = p_subject_type and k.subject_id = p_subject_id and k.is_current;
  v_list_kind := case
    when p_inclusion <> 'included' then coalesce(v_prev.list_kind, 'none')
    when p_rank is not null then 'numbered'
    when p_list_position is not null then 'bulleted'
    else coalesce(v_prev.list_kind, 'none')
  end;

  v_id := app_private.record_classification(
    v_workspace_id, v_campaign_id, p_subject_type, p_subject_id, 'manual',
    jsonb_build_object(
      'inclusion', p_inclusion,
      'rank', p_rank,
      'list_position', p_list_position,
      'list_kind', v_list_kind,
      'list_length', v_prev.list_length,
      'matched_spans', coalesce(v_prev.matched_spans, '[]'::jsonb),
      'note', p_note
    ),
    (select auth.uid())
  );

  perform app_private.audit(v_workspace_id, 'classification.corrected', p_subject_type, p_subject_id,
    jsonb_build_object('campaign_id', v_campaign_id, 'from', v_prev.inclusion, 'to', p_inclusion,
      'from_method', v_prev.method, 'rank', p_rank, 'list_position', p_list_position,
      'classification_id', v_id, 'note', left(p_note, 300)));
  return v_id;
end;
$$;

-- Records a response observed outside the API (for example in the ChatGPT app). These rows are
-- a separate, labelled dataset and are never merged into API measurements.
create or replace function public.record_manual_check(
  p_campaign_id uuid,
  p_observed_on date,
  p_source_label text,
  p_question text,
  p_response_text text,
  p_classification jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  v_id uuid;
begin
  select * into c from public.campaigns cp where cp.id = p_campaign_id;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(c.workspace_id, 'admin');
  if p_observed_on is null or p_observed_on > (now() at time zone 'UTC')::date + 1 then
    perform app_private.fail('invalid_date', 'Enter the date the response was observed (not in the future).');
  end if;
  if char_length(btrim(coalesce(p_source_label, ''))) not between 1 and 120 then
    perform app_private.fail('invalid_source', 'Enter where the response came from, for example "ChatGPT web app".');
  end if;
  if char_length(btrim(coalesce(p_response_text, ''))) = 0 then
    perform app_private.fail('invalid_response', 'Paste the response text.');
  end if;

  insert into public.manual_checks (workspace_id, campaign_id, observed_on, source_label, question, response_text, recorded_by)
  values (
    c.workspace_id, c.id, p_observed_on, btrim(p_source_label),
    nullif(btrim(coalesce(p_question, '')), ''), p_response_text, (select auth.uid())
  )
  returning id into v_id;

  if p_classification is not null then
    perform app_private.record_classification(
      c.workspace_id, c.id, 'manual_check', v_id, 'rules', p_classification, (select auth.uid()));
  end if;
  perform app_private.audit(c.workspace_id, 'manual_check.recorded', 'manual_check', v_id,
    jsonb_build_object('campaign_id', c.id, 'observed_on', p_observed_on, 'source', btrim(p_source_label)));
  return v_id;
end;
$$;

create or replace function public.delete_manual_check(p_manual_check_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.manual_checks%rowtype;
begin
  select * into v_row from public.manual_checks m where m.id = p_manual_check_id;
  if not found then
    perform app_private.forbid('Record not found or access denied.');
  end if;
  perform app_private.require_role(v_row.workspace_id, 'admin');
  delete from public.classifications where subject_type = 'manual_check' and subject_id = p_manual_check_id;
  delete from public.manual_checks where id = p_manual_check_id;
  perform app_private.audit(v_row.workspace_id, 'manual_check.deleted', 'manual_check', p_manual_check_id,
    jsonb_build_object('campaign_id', v_row.campaign_id));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Reporting (security invoker: row level security applies to the caller)
-- ---------------------------------------------------------------------------------------------

-- Conversation results per model/settings cohort. Test conversations are excluded.
-- "first" = the answer to the initial question; "final" = the last answer of a full sequence.
create or replace function public.campaign_conversation_metrics(p_campaign_id uuid)
returns table (
  cohort_key text,
  model text,
  model_params jsonb,
  max_output_tokens integer,
  revision_numbers integer[],
  runs_total bigint,
  runs_completed bigint,
  runs_completed_early bigint,
  runs_in_progress bigint,
  runs_incomplete bigint,
  runs_failed bigint,
  runs_canceled bigint,
  runs_expired bigint,
  runs_unresolved bigint,
  target_in_initial_prompt bigint,
  first_valid bigint,
  first_included bigint,
  first_mentioned_only bigint,
  first_not_mentioned bigint,
  first_needs_review bigint,
  final_valid bigint,
  final_included bigint,
  final_mentioned_only bigint,
  final_not_mentioned bigint,
  final_needs_review bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    r.cohort_key,
    r.model,
    r.model_params,
    r.max_output_tokens,
    array_agg(distinct rev.revision_number order by rev.revision_number),
    count(*),
    count(*) filter (where r.status = 'completed'),
    count(*) filter (where r.status = 'completed_early'),
    count(*) filter (where r.status in ('pending', 'in_progress')),
    count(*) filter (where r.status = 'incomplete'),
    count(*) filter (where r.status = 'failed'),
    count(*) filter (where r.status = 'canceled'),
    count(*) filter (where r.status = 'expired'),
    count(*) filter (where r.status = 'unresolved'),
    count(*) filter (where r.target_in_initial_prompt),
    count(*) filter (where t1.status = 'completed' and t1.inclusion in ('included', 'mentioned_only', 'not_mentioned')),
    count(*) filter (where t1.status = 'completed' and t1.inclusion = 'included'),
    count(*) filter (where t1.status = 'completed' and t1.inclusion = 'mentioned_only'),
    count(*) filter (where t1.status = 'completed' and t1.inclusion = 'not_mentioned'),
    count(*) filter (where t1.status = 'completed' and t1.inclusion = 'ambiguous'),
    count(*) filter (where r.status = 'completed' and tf.status = 'completed' and tf.inclusion in ('included', 'mentioned_only', 'not_mentioned')),
    count(*) filter (where r.status = 'completed' and tf.status = 'completed' and tf.inclusion = 'included'),
    count(*) filter (where r.status = 'completed' and tf.status = 'completed' and tf.inclusion = 'mentioned_only'),
    count(*) filter (where r.status = 'completed' and tf.status = 'completed' and tf.inclusion = 'not_mentioned'),
    count(*) filter (where r.status = 'completed' and tf.status = 'completed' and tf.inclusion = 'ambiguous')
  from public.runs r
  join public.campaign_revisions rev on rev.id = r.revision_id
  left join public.run_turns t1 on t1.run_id = r.id and t1.step_index = 1
  left join public.run_turns tf on tf.run_id = r.id and tf.step_index = r.steps_total
  where r.campaign_id = p_campaign_id and r.kind = 'scheduled'
  group by r.cohort_key, r.model, r.model_params, r.max_output_tokens
  order by min(r.created_at);
$$;

-- Fresh-check results per comparison group, phase, question type and (for daily checks) day.
create or replace function public.campaign_check_metrics(p_campaign_id uuid)
returns table (
  comparison_group_id uuid,
  group_sequence integer,
  phase public.check_phase,
  is_held_out boolean,
  local_day date,
  total bigint,
  valid bigint,
  included bigint,
  mentioned_only bigint,
  not_mentioned bigint,
  needs_review bigint,
  incomplete bigint,
  failed bigint,
  excluded bigint,
  canceled bigint,
  pending bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    f.comparison_group_id,
    g.sequence,
    f.phase,
    f.is_held_out,
    case when f.phase = 'daily' then f.local_day end,
    count(*),
    count(*) filter (where f.status = 'completed' and f.inclusion in ('included', 'mentioned_only', 'not_mentioned')),
    count(*) filter (where f.status = 'completed' and f.inclusion = 'included'),
    count(*) filter (where f.status = 'completed' and f.inclusion = 'mentioned_only'),
    count(*) filter (where f.status = 'completed' and f.inclusion = 'not_mentioned'),
    count(*) filter (where f.status = 'completed' and (f.inclusion = 'ambiguous' or f.inclusion is null)),
    count(*) filter (where f.status = 'incomplete'),
    count(*) filter (where f.status in ('failed', 'uncertain')),
    count(*) filter (where f.status = 'excluded'),
    count(*) filter (where f.status = 'canceled'),
    count(*) filter (where f.status in ('pending', 'in_flight'))
  from public.fresh_checks f
  join public.comparison_groups g on g.id = f.comparison_group_id
  where f.campaign_id = p_campaign_id
  group by f.comparison_group_id, g.sequence, f.phase, f.is_held_out,
           case when f.phase = 'daily' then f.local_day end
  order by g.sequence, f.phase, f.is_held_out, 5;
$$;

-- Daily usage totals. Costs are usage-based estimates, not invoices.
create or replace function public.usage_daily(
  p_workspace_id uuid,
  p_from date,
  p_to date,
  p_campaign_id uuid default null
)
returns table (
  usage_day date,
  purpose public.attempt_purpose,
  model text,
  is_test boolean,
  requests bigint,
  input_tokens bigint,
  cached_input_tokens bigint,
  output_tokens bigint,
  reasoning_tokens bigint,
  cost_usd numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.connection_day, l.purpose, l.model, l.is_test,
         count(*), sum(l.input_tokens)::bigint, sum(l.cached_input_tokens)::bigint,
         sum(l.output_tokens)::bigint, sum(l.reasoning_tokens)::bigint, sum(l.cost_usd)
  from public.usage_ledger l
  where l.workspace_id = p_workspace_id
    and l.connection_day between p_from and p_to
    and (p_campaign_id is null or l.campaign_id = p_campaign_id)
  group by l.connection_day, l.purpose, l.model, l.is_test
  order by l.connection_day, l.purpose, l.model;
$$;

-- Spend and reservations against each cap, for campaigns and connections.
create or replace function public.budget_status(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_utc_day date := (now() at time zone 'UTC')::date;
begin
  perform app_private.require_role(p_workspace_id, 'member');
  return jsonb_build_object(
    'as_of', v_now,
    'connections', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'connection_id', pc.id,
        'name', pc.name,
        'daily_budget_usd', pc.daily_budget_usd,
        'total_budget_usd', pc.total_budget_usd,
        'spent_today_usd', coalesce((select sum(l.cost_usd) from public.usage_ledger l
          where l.connection_id = pc.id and l.connection_day = v_utc_day), 0),
        'reserved_today_usd', coalesce((select sum(r.amount_usd) from public.budget_reservations r
          where r.connection_id = pc.id and r.connection_day = v_utc_day and r.status = 'held'), 0),
        'unresolved_today_usd', coalesce((select sum(r.amount_usd) from public.budget_reservations r
          where r.connection_id = pc.id and r.connection_day = v_utc_day and r.status = 'unresolved'), 0),
        'spent_total_usd', coalesce((select sum(l.cost_usd) from public.usage_ledger l where l.connection_id = pc.id), 0),
        'open_total_usd', coalesce((select sum(r.amount_usd) from public.budget_reservations r
          where r.connection_id = pc.id and r.status in ('held', 'unresolved')), 0)
      ) order by pc.created_at), '[]'::jsonb)
      from public.provider_connections pc
      where pc.workspace_id = p_workspace_id and pc.archived_at is null
    ),
    'campaigns', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'campaign_id', c.id,
        'name', c.name,
        'status', c.status,
        'timezone', r.timezone,
        'daily_budget_usd', r.daily_budget_usd,
        'total_budget_usd', r.total_budget_usd,
        'final_check_set_aside_usd', r.final_check_set_aside_usd,
        'spent_today_usd', coalesce((select sum(l.cost_usd) from public.usage_ledger l
          where l.campaign_id = c.id and l.campaign_day = (v_now at time zone coalesce(r.timezone, 'UTC'))::date), 0),
        'reserved_today_usd', coalesce((select sum(b.amount_usd) from public.budget_reservations b
          where b.campaign_id = c.id and b.status in ('held', 'unresolved')
            and b.campaign_day = (v_now at time zone coalesce(r.timezone, 'UTC'))::date), 0),
        'spent_total_usd', coalesce((select sum(l.cost_usd) from public.usage_ledger l where l.campaign_id = c.id), 0),
        'open_total_usd', coalesce((select sum(b.amount_usd) from public.budget_reservations b
          where b.campaign_id = c.id and b.status in ('held', 'unresolved')), 0),
        'budget_skips', (select count(*) from public.jobs j
          where j.campaign_id = c.id and j.status = 'skipped' and j.status_reason like '%budget%'),
        'budget_blocked', (select count(*) from public.jobs j
          where j.campaign_id = c.id and j.status = 'blocked' and j.status_reason like '%budget%')
      ) order by c.created_at desc), '[]'::jsonb)
      from public.campaigns c
      join public.campaign_revisions r on r.id = coalesce(c.active_revision_id, c.draft_revision_id)
      where c.workspace_id = p_workspace_id and c.archived_at is null
    )
  );
end;
$$;

-- Planned work and worst-case cost for the configuration that would be launched (or is running).
create or replace function public.campaign_plan_preview(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  v_rev public.campaign_revisions%rowtype;
  v_est record;
  v_day date;
  v_first date;
  v_last date;
  v_days jsonb := '[]'::jsonb;
  v_conv integer;
  v_checks integer;
  v_total_conv bigint := 0;
  v_total_daily_checks bigint := 0;
  v_max_day_conv integer := 0;
  v_active_days integer := 0;
  v_limit_day date;
  v_listed integer := 0;
  v_run_cost numeric;
  v_check_cost numeric;
  v_observed record;
  v_max_cost numeric;
  v_max_daily_cost numeric;
  v_check_count bigint;
begin
  select * into c from public.campaigns cp where cp.id = p_campaign_id;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(c.workspace_id, 'member');
  select * into v_rev from public.campaign_revisions r
  where r.id = coalesce(c.draft_revision_id, c.active_revision_id);
  select * into v_est from app_private.revision_estimates(v_rev);
  v_run_cost := coalesce(v_rev.est_run_max_cost_usd, v_est.est_run_max_cost_usd);
  v_check_cost := coalesce(v_rev.est_check_max_cost_usd, v_est.est_check_max_cost_usd);

  if v_rev.start_at is not null and v_rev.end_at is not null and v_rev.timezone is not null
     and v_rev.active_weekdays is not null and v_rev.active_start_minute is not null
     and v_rev.active_end_minute is not null and v_rev.conversations_per_day is not null
     and v_rev.end_at > v_rev.start_at
     and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_rev.timezone) then
    v_first := (v_rev.start_at at time zone v_rev.timezone)::date;
    v_last := (v_rev.end_at at time zone v_rev.timezone)::date;
    -- Bound the walk: three years of days is plenty for a preview.
    v_last := least(v_last, v_first + 1095);

    for v_day in select d::date from generate_series(v_first, v_last, interval '1 day') d loop
      if v_day = v_first or v_day = v_last then
        -- Partial days: count the exact slots inside [start, end).
        select count(*) into v_conv
        from app_private.day_slots(v_rev, v_day, v_rev.conversations_per_day, 0, 'conversation') s
        where s.slot_at >= v_rev.start_at and s.slot_at < v_rev.end_at;
        select count(*) into v_checks
        from app_private.day_slots(v_rev, v_day, coalesce(v_rev.daily_checks, 0), 0.5, 'check_daily') s
        where s.slot_at >= v_rev.start_at and s.slot_at < v_rev.end_at;
      elsif extract(isodow from v_day)::smallint = any (v_rev.active_weekdays) then
        v_conv := v_rev.conversations_per_day;
        v_checks := coalesce(v_rev.daily_checks, 0);
      else
        v_conv := 0;
        v_checks := 0;
      end if;

      if v_rev.total_conversation_limit is not null then
        if v_total_conv + v_conv >= v_rev.total_conversation_limit and v_limit_day is null and v_conv > 0 then
          v_limit_day := v_day;
        end if;
        v_conv := greatest(least(v_conv, v_rev.total_conversation_limit - v_total_conv), 0)::integer;
      end if;

      v_total_conv := v_total_conv + v_conv;
      -- Scheduled checks continue until the conversations end.
      if v_limit_day is null or v_day <= v_limit_day then
        v_total_daily_checks := v_total_daily_checks + v_checks;
      else
        v_checks := 0;
      end if;
      v_max_day_conv := greatest(v_max_day_conv, v_conv);
      if v_conv > 0 or v_checks > 0 then
        v_active_days := v_active_days + 1;
        if v_listed < 120 then
          v_days := v_days || jsonb_build_object('date', v_day, 'conversations', v_conv, 'checks', v_checks);
          v_listed := v_listed + 1;
        end if;
      end if;
    end loop;
  end if;

  select count(*) filter (where r.status in ('completed', 'completed_early')) as runs,
         avg(run_cost.cost) filter (where r.status in ('completed', 'completed_early')) as avg_run_cost
  into v_observed
  from public.runs r
  left join lateral (
    select sum(t.cost_usd) as cost from public.run_turns t where t.run_id = r.id
  ) run_cost on true
  where r.campaign_id = p_campaign_id;

  v_check_count := coalesce(v_rev.baseline_samples, 0) + v_total_daily_checks + coalesce(v_rev.final_samples, 0);
  v_max_cost := v_total_conv * v_run_cost + v_check_count * v_check_cost;
  v_max_daily_cost := v_max_day_conv * v_run_cost
    + (coalesce(v_rev.daily_checks, 0) + greatest(coalesce(v_rev.baseline_samples, 0), coalesce(v_rev.final_samples, 0))) * v_check_cost;

  return jsonb_build_object(
    'revision_id', v_rev.id,
    'revision_state', v_rev.state,
    'days', v_days,
    'days_listed', v_listed,
    'active_days', v_active_days,
    'planned_conversations', v_total_conv,
    'limit_reached_on', v_limit_day,
    'steps', v_est.steps,
    'baseline_checks', coalesce(v_rev.baseline_samples, 0),
    'scheduled_checks', v_total_daily_checks,
    'final_checks', coalesce(v_rev.final_samples, 0),
    'provider_requests', v_total_conv * v_est.steps + v_check_count,
    'est_run_max_cost_usd', v_run_cost,
    'est_check_max_cost_usd', v_check_cost,
    'max_cost_usd', v_max_cost,
    'max_daily_cost_usd', v_max_daily_cost,
    'final_check_set_aside_usd', coalesce(v_rev.final_samples, 0) * v_check_cost,
    'daily_budget_usd', v_rev.daily_budget_usd,
    'total_budget_usd', v_rev.total_budget_usd,
    'total_budget_shortfall', v_max_cost is not null and v_rev.total_budget_usd is not null and v_max_cost > v_rev.total_budget_usd,
    'daily_budget_shortfall', v_max_daily_cost is not null and v_rev.daily_budget_usd is not null and v_max_daily_cost > v_rev.daily_budget_usd,
    'conversations_within_total_budget', case
      when v_run_cost is null or v_run_cost = 0 or v_rev.total_budget_usd is null then null
      else floor(greatest(v_rev.total_budget_usd - v_check_count * coalesce(v_check_cost, 0), 0) / v_run_cost) end,
    'conversations_within_daily_budget', case
      when v_run_cost is null or v_run_cost = 0 or v_rev.daily_budget_usd is null then null
      else floor(greatest(v_rev.daily_budget_usd - coalesce(v_rev.daily_checks, 0) * coalesce(v_check_cost, 0), 0) / v_run_cost) end,
    'observed_runs', coalesce(v_observed.runs, 0),
    'observed_avg_run_cost_usd', v_observed.avg_run_cost,
    'observed_estimate_usd', case when v_observed.avg_run_cost is null then null
      else v_total_conv * v_observed.avg_run_cost end,
    'start_at', v_rev.start_at,
    'end_at', v_rev.end_at,
    'timezone', v_rev.timezone
  );
end;
$$;

-- Health of the background machinery, scoped to what a workspace member may see.
create or replace function public.operational_status(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_metrics record;
begin
  perform app_private.require_role(p_workspace_id, 'member');
  select m.queue_length, m.queue_visible_length, m.oldest_msg_age_sec into v_metrics
  from pgmq.metrics(app_private.queue_name()) m;

  return jsonb_build_object(
    'as_of', v_now,
    'scheduler', (
      select coalesce(jsonb_object_agg(h.name, jsonb_build_object(
        'last_started_at', h.last_started_at,
        'last_ok_at', h.last_ok_at,
        'last_error_at', h.last_error_at,
        'last_error', case when h.last_error_at is not null and (h.last_ok_at is null or h.last_error_at >= h.last_ok_at)
                           then h.last_error end,
        'seconds_since_ok', extract(epoch from v_now - h.last_ok_at)::integer,
        'last_duration_ms', h.last_duration_ms
      )), '{}'::jsonb)
      from app_private.heartbeats h
    ),
    'consumers_activated', (
      select count(*) = 2 from vault.secrets s where s.name in ('lr_functions_base_url', 'lr_worker_secret')
    ),
    'queue', jsonb_build_object(
      'length', coalesce(v_metrics.queue_length, 0),
      'visible', coalesce(v_metrics.queue_visible_length, 0),
      'oldest_message_age_seconds', v_metrics.oldest_msg_age_sec
    ),
    'workspace', jsonb_build_object(
      'emergency_stop', (select w.emergency_stop from public.workspaces w where w.id = p_workspace_id),
      'jobs', (
        select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
        from (
          select j.status, count(*) as n from public.jobs j
          where j.workspace_id = p_workspace_id
            and j.status in ('pending', 'queued', 'running', 'waiting', 'paused', 'blocked', 'dead')
          group by j.status
        ) s
      ),
      'stalled_leases', (
        select count(*) from public.jobs j
        where j.workspace_id = p_workspace_id and j.status = 'running'
          and j.lease_expires_at < v_now - interval '60 seconds'
      ),
      'overdue_pending', (
        select count(*) from public.jobs j
        join public.campaigns c on c.id = j.campaign_id
        where j.workspace_id = p_workspace_id and j.status = 'pending'
          and j.scheduled_for < v_now - interval '10 minutes'
          and c.status in ('baseline', 'running', 'finalizing')
      ),
      'unresolved_attempts', (
        select count(*) from public.provider_attempts a
        where a.workspace_id = p_workspace_id and a.status = 'uncertain' and a.resolved_at is null
      ),
      'in_flight_requests', (
        select count(*) from public.provider_attempts a
        where a.workspace_id = p_workspace_id and a.status in ('started', 'in_flight')
      ),
      'provider_errors_24h', (
        select coalesce(jsonb_object_agg(e.error_class, e.n), '{}'::jsonb)
        from (
          select coalesce(a.error_class, 'unknown') as error_class, count(*) as n
          from public.provider_attempts a
          where a.workspace_id = p_workspace_id
            and a.status in ('failed', 'uncertain')
            and a.started_at > v_now - interval '24 hours'
          group by 1
        ) e
      ),
      'connections', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', pc.id, 'name', pc.name, 'status', pc.status, 'status_code', pc.status_code,
          'status_message', pc.status_message, 'last_tested_at', pc.last_tested_at, 'last_ok_at', pc.last_ok_at
        ) order by pc.created_at), '[]'::jsonb)
        from public.provider_connections pc
        where pc.workspace_id = p_workspace_id and pc.archived_at is null
      ),
      'paused_campaigns', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id, 'name', c.name, 'pause_reason', c.pause_reason, 'pause_detail', c.pause_detail
        ) order by c.updated_at desc), '[]'::jsonb)
        from public.campaigns c
        where c.workspace_id = p_workspace_id and c.status = 'paused' and c.pause_reason <> 'user'
      ),
      'budget_exhausted', (
        select coalesce(jsonb_agg(distinct jsonb_build_object(
          'campaign_id', j.campaign_id, 'reason', j.status_reason
        )), '[]'::jsonb)
        from public.jobs j
        where j.workspace_id = p_workspace_id
          and j.status_reason like '%budget%'
          and ((j.status = 'blocked') or (j.status = 'skipped' and j.finished_at > v_now - interval '24 hours'))
      )
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Retention and housekeeping
-- ---------------------------------------------------------------------------------------------

-- Removes stored prompt and answer text older than each workspace's retention period. Counts,
-- classifications, usage and audit records are kept.
create or replace function app_private.apply_retention(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws record;
  v_run_ids uuid[];
  v_check_ids uuid[];
  v_count integer := 0;
begin
  for v_ws in
    select w.id, w.retention_days from public.workspaces w where w.retention_days is not null
  loop
    select coalesce(array_agg(r.id), '{}') into v_run_ids
    from public.runs r
    where r.workspace_id = v_ws.id
      and r.content_purged_at is null
      and r.status not in ('pending', 'in_progress')
      and coalesce(r.completed_at, r.updated_at) < p_now - make_interval(days => v_ws.retention_days);

    select coalesce(array_agg(f.id), '{}') into v_check_ids
    from public.fresh_checks f
    where f.workspace_id = v_ws.id
      and f.content_purged_at is null
      and f.status not in ('pending', 'in_flight')
      and coalesce(f.completed_at, f.updated_at) < p_now - make_interval(days => v_ws.retention_days);

    if cardinality(v_run_ids) > 0 then
      update public.classifications k
      set matched_spans = '[]'::jsonb
      where k.subject_type = 'run_turn'
        and k.subject_id in (select t.id from public.run_turns t where t.run_id = any (v_run_ids));
      update public.run_turns
      set rendered_prompt = null, output_text = null, output_items = null
      where run_id = any (v_run_ids);
      update public.runs set content_purged_at = p_now where id = any (v_run_ids);
    end if;

    if cardinality(v_check_ids) > 0 then
      update public.classifications k
      set matched_spans = '[]'::jsonb
      where k.subject_type = 'fresh_check' and k.subject_id = any (v_check_ids);
      update public.fresh_checks
      set rendered_prompt = null, output_text = null, output_items = null, content_purged_at = p_now
      where id = any (v_check_ids);
    end if;

    if cardinality(v_run_ids) + cardinality(v_check_ids) > 0 then
      perform app_private.audit(v_ws.id, 'retention.applied', 'workspace', v_ws.id,
        jsonb_build_object('runs', cardinality(v_run_ids), 'fresh_checks', cardinality(v_check_ids),
          'retention_days', v_ws.retention_days), 'system');
    end if;
    v_count := v_count + cardinality(v_run_ids) + cardinality(v_check_ids);
  end loop;
  return v_count;
end;
$$;

create or replace function app_private.cron_maintenance()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_purged integer;
begin
  v_purged := app_private.apply_retention(now());
  delete from cron.job_run_details where end_time < now() - interval '2 days';
  delete from pgmq.a_lr_work where archived_at < now() - interval '90 days';
  perform app_private.beat('maintenance', v_started, null, jsonb_build_object('purged', v_purged));
exception when others then
  perform app_private.beat('maintenance', v_started, left(sqlerrm, 500));
end;
$$;
