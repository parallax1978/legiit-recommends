-- Legiit Recommends — queue consumer protocol.
--
-- A worker invocation processes one unit:
--   1. svc_receive_work        read one message, claim the job (lease + fencing token)
--   2. svc_materialize_run     (first turn only) persist the selected templates and exact prompts
--   3. svc_begin_attempt       atomic gate: stop/pause, concurrency, rate caps, budget reservation
--   4. provider request        exactly one HTTP request, no hidden retries
--   5. svc_commit_result       one transaction: usage ledger, turn result, classification and the
--                              next durable action (next turn becomes visible in the queue)
--      or svc_fail_attempt     classify the failure: retry with backoff, block, pause, dead-letter
--
-- Stale workers (expired lease) can still record what their own request cost, but can never
-- change job, run or turn state: every state change checks the lease and fencing token.

create or replace function app_private.pause_job(p_job public.jobs, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.drop_job_message(p_job);
  update public.jobs
  set status = 'paused', status_reason = p_reason, queue_msg_id = null, next_attempt_at = null,
      lease_token = null, lease_expires_at = null, leased_by = null
  where id = p_job.id;
end;
$$;

create or replace function app_private.block_job(p_job public.jobs, p_reason text, p_until timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.drop_job_message(p_job);
  update public.jobs
  set status = 'blocked', status_reason = p_reason, blocked_until = p_until, queue_msg_id = null,
      next_attempt_at = null, lease_token = null, lease_expires_at = null, leased_by = null
  where id = p_job.id;
end;
$$;

-- Pauses a campaign for an operational reason that needs a person (bad model, bad configuration).
create or replace function app_private.auto_pause_campaign(p_campaign_id uuid, p_reason text, p_detail text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
begin
  select * into c from public.campaigns cp where cp.id = p_campaign_id for no key update;
  if not found or c.status not in ('scheduled', 'baseline', 'running', 'finalizing') then
    return;
  end if;
  update public.campaigns
  set paused_from = c.status, status = 'paused', pause_reason = p_reason, pause_detail = left(p_detail, 500)
  where id = p_campaign_id;
  perform app_private.pause_campaign_jobs(p_campaign_id, 'campaign_paused');
  perform app_private.audit(c.workspace_id, 'campaign.auto_paused', 'campaign', p_campaign_id,
    jsonb_build_object('reason', p_reason, 'detail', left(p_detail, 300)), 'worker');
end;
$$;

-- Queued work stops; requests already submitted keep resolving and are recorded when they do.
create or replace function app_private.pause_campaign_jobs(p_campaign_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_count integer := 0;
begin
  for v_job in
    select j.* from public.jobs j
    where j.campaign_id = p_campaign_id
      and j.kind <> 'test_conversation'
      and j.status in ('queued', 'waiting')
      and not exists (
        select 1 from public.provider_attempts a
        where a.job_id = j.id and a.status in ('started', 'in_flight')
      )
    for no key update
  loop
    perform app_private.pause_job(v_job, p_reason);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function app_private.resume_campaign_jobs(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_count integer := 0;
begin
  for v_job in
    select j.* from public.jobs j
    where j.campaign_id = p_campaign_id and j.status = 'paused'
    for no key update
  loop
    perform app_private.enqueue_job(v_job.id);
    update public.jobs set status_reason = null where id = v_job.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- After the workspace stop is released, work it had paused becomes eligible again.
create or replace function app_private.resume_stopped_jobs(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_count integer := 0;
begin
  for v_job in
    select j.* from public.jobs j
    join public.campaigns c on c.id = j.campaign_id
    where j.workspace_id = p_workspace_id
      and j.status = 'paused' and j.status_reason = 'emergency_stop'
      and (j.kind = 'test_conversation' or c.status in ('baseline', 'running', 'finalizing'))
    for no key update of j
  loop
    perform app_private.enqueue_job(v_job.id);
    update public.jobs set status_reason = null where id = v_job.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function app_private.backoff_seconds(p_attempts integer, p_retry_after_ms integer)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_base integer := app_private.setting_int('retry_base_seconds');
  v_max integer := app_private.setting_int('retry_max_seconds');
  v_exp numeric;
  v_delay numeric;
begin
  -- Exponential backoff with jitter: uniformly between half and the full exponential step.
  v_exp := least(v_base * power(2, greatest(p_attempts, 1) - 1), v_max);
  v_delay := v_exp / 2 + random() * v_exp / 2;
  -- Provider guidance wins when it asks for longer (plus a little jitter to avoid a thundering herd).
  if p_retry_after_ms is not null and p_retry_after_ms > 0 then
    v_delay := greatest(v_delay, least(p_retry_after_ms / 1000.0, 21600) + random() * 2);
  end if;
  return greatest(ceil(v_delay)::integer, 1);
end;
$$;

-- A request whose outcome is unknown: the provider may have processed and billed it.
create or replace function app_private.mark_attempt_uncertain(p_attempt_id uuid, p_class text, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.provider_attempts%rowtype;
begin
  update public.provider_attempts
  set status = 'uncertain',
      error_class = coalesce(error_class, p_class),
      error_message = coalesce(error_message, left(p_message, 1000)),
      finished_at = coalesce(finished_at, clock_timestamp())
  where id = p_attempt_id and status in ('started', 'in_flight')
  returning * into v_attempt;
  if not found then
    return;
  end if;
  -- The reservation stays counted against every cap until it is reconciled or resolved.
  update public.budget_reservations set status = 'unresolved' where id = v_attempt.reservation_id and status = 'held';
  update public.run_turns set status = 'uncertain' where id = v_attempt.run_turn_id and status = 'in_flight';
  update public.fresh_checks set status = 'uncertain' where id = v_attempt.fresh_check_id and status = 'in_flight';
end;
$$;

create or replace function app_private.next_turn(p_run_id uuid)
returns public.run_turns
language sql
stable
security definer
set search_path = ''
as $$
  select t.*
  from public.run_turns t
  where t.run_id = p_run_id and t.status in ('pending', 'in_flight', 'failed', 'uncertain')
  order by t.step_index
  limit 1;
$$;

-- Everything a worker needs to process one unit, as JSON.
create or replace function app_private.build_unit(p_job public.jobs, p_poll jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_unit jsonb;
  v_run public.runs%rowtype;
  v_turn public.run_turns%rowtype;
  v_prev public.run_turns%rowtype;
  v_rev public.campaign_revisions%rowtype;
  v_check public.fresh_checks%rowtype;
  v_question public.probe_questions%rowtype;
  v_vars jsonb;
begin
  v_unit := jsonb_build_object(
    'job_id', p_job.id,
    'kind', case when p_job.kind in ('conversation', 'test_conversation') then 'conversation' else 'check' end,
    'job_kind', p_job.kind,
    'workspace_id', p_job.workspace_id,
    'campaign_id', p_job.campaign_id,
    'connection_id', p_job.connection_id,
    'lease_token', p_job.lease_token,
    'fencing_token', p_job.fencing_token,
    'lease_expires_at', p_job.lease_expires_at,
    'attempts', p_job.attempts,
    'max_attempts', p_job.max_attempts,
    'last_error_class', p_job.last_error_class,
    'poll', p_poll
  );
  select * into v_rev from public.campaign_revisions r where r.id = p_job.revision_id;
  v_vars := app_private.revision_variables(v_rev);

  if p_job.kind in ('conversation', 'test_conversation') then
    select * into v_run from public.runs r where r.id = p_job.run_id;
    v_turn := app_private.next_turn(v_run.id);
    select * into v_prev
    from public.run_turns t
    where t.run_id = v_run.id and t.status = 'completed'
    order by t.step_index desc limit 1;

    v_unit := v_unit || jsonb_build_object(
      'run', jsonb_build_object(
        'id', v_run.id, 'kind', v_run.kind, 'ordinal', v_run.ordinal, 'status', v_run.status,
        'model', v_run.model, 'model_params', v_run.model_params,
        'max_output_tokens', v_run.max_output_tokens, 'execution_mode', v_run.execution_mode,
        'on_existing_inclusion', v_run.on_existing_inclusion, 'target', v_run.target,
        'selection_mode', v_run.selection_mode, 'selection_seed', v_run.selection_seed,
        'steps_total', v_run.steps_total, 'steps_completed', v_run.steps_completed,
        'last_response_id', v_run.last_response_id, 'last_response_at', v_run.last_response_at,
        'materialized', v_run.steps_total is not null
      ),
      'background_supported', coalesce((
        select (m.capabilities ->> 'background')::boolean from public.provider_models m
        where m.connection_id = p_job.connection_id and m.model_id = v_run.model
      ), false),
      'turn', case when v_turn.id is null then null else jsonb_build_object(
        'id', v_turn.id, 'step_index', v_turn.step_index, 'step_kind', v_turn.step_kind,
        'rendered_prompt', v_turn.rendered_prompt, 'attempt_count', v_turn.attempt_count,
        'status', v_turn.status
      ) end,
      'previous_usage', case when v_prev.id is null then null else jsonb_build_object(
        'input_tokens', v_prev.input_tokens, 'output_tokens', v_prev.output_tokens
      ) end
    );

    if v_run.steps_total is null then
      -- Not materialized yet: hand over the saved wordings so the worker can select and render.
      v_unit := v_unit || jsonb_build_object(
        'sequence', jsonb_build_object(
          'variables', v_vars,
          'steps', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'step_index', s.step_index,
              'kind', s.kind,
              'templates', (
                select coalesce(jsonb_agg(jsonb_build_object(
                  'template_id', st.template_id,
                  'template_version_id', tv.id,
                  'body', tv.body
                ) order by st.position), '[]'::jsonb)
                from public.campaign_revision_step_templates st
                join public.templates t on t.id = st.template_id
                join public.template_versions tv on tv.id = coalesce(st.template_version_id, t.current_version_id)
                where st.revision_id = s.revision_id and st.step_index = s.step_index
              )
            ) order by s.step_index), '[]'::jsonb)
            from public.campaign_revision_steps s
            where s.revision_id = v_rev.id
          )
        )
      );
    end if;
  else
    select * into v_check from public.fresh_checks f where f.id = p_job.fresh_check_id;
    select * into v_question from public.probe_questions q where q.id = v_check.probe_question_id;
    v_unit := v_unit || jsonb_build_object(
      'check', jsonb_build_object(
        'id', v_check.id, 'phase', v_check.phase, 'status', v_check.status,
        'question_body', v_question.body,
        -- Only non-identifying variables: a fresh check must never carry the target.
        'variables', v_vars - 'business_name' - 'website_url',
        'rendered_prompt', v_check.rendered_prompt,
        'model', v_check.model, 'params', v_check.params,
        'max_output_tokens', v_check.max_output_tokens, 'execution_mode', v_check.execution_mode,
        'store_response', v_check.store_response, 'attempt_count', v_check.attempt_count
      ),
      'background_supported', coalesce((
        select (m.capabilities ->> 'background')::boolean from public.provider_models m
        where m.connection_id = p_job.connection_id and m.model_id = v_check.model
      ), false),
      -- Kept locally for the leak guard and for classifying the answer. Never sent to the provider.
      'analysis_target', app_private.target_snapshot(v_rev)
    );
  end if;
  return v_unit;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. Receive
-- ---------------------------------------------------------------------------------------------

create or replace function public.svc_receive_work(p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue text := app_private.queue_name();
  v_lease integer := app_private.setting_int('lease_seconds');
  v_msg record;
  v_job public.jobs%rowtype;
  v_campaign public.campaigns%rowtype;
  v_ws public.workspaces%rowtype;
  v_conn public.provider_connections%rowtype;
  v_attempt public.provider_attempts%rowtype;
  v_stale record;
  v_poll jsonb;
  v_is_test boolean;
begin
  for i in 1 .. 20 loop
    select * into v_msg from pgmq.read(v_queue, v_lease, 1);
    if not found then
      return null;
    end if;

    select * into v_job from public.jobs j where j.id = (v_msg.message ->> 'job_id')::uuid for no key update;
    if not found
       or v_job.queue_msg_id is distinct from v_msg.msg_id
       or v_job.status not in ('queued', 'running', 'waiting') then
      -- Orphaned or duplicate message (job deleted, finished or re-enqueued elsewhere).
      perform pgmq.delete(v_queue, v_msg.msg_id);
      continue;
    end if;

    select * into v_campaign from public.campaigns c where c.id = v_job.campaign_id;
    select * into v_ws from public.workspaces w where w.id = v_job.workspace_id;
    select * into v_conn from public.provider_connections pc where pc.id = v_job.connection_id;
    v_is_test := v_job.kind = 'test_conversation';
    v_poll := null;

    -- A background response already accepted by the provider is always followed to its end,
    -- even while paused or stopped: it is in flight until its status resolves.
    select * into v_attempt
    from public.provider_attempts a
    where a.job_id = v_job.id and a.status = 'in_flight'
    order by a.started_at desc
    limit 1;
    if found then
      v_poll := jsonb_build_object(
        'attempt_id', v_attempt.id,
        'response_id', v_attempt.response_id,
        'poll_count', v_attempt.poll_count,
        'started_at', v_attempt.started_at
      );
    else
      -- The previous holder of this job never reported back: its request is ambiguous.
      for v_stale in
        select a.id from public.provider_attempts a
        where a.job_id = v_job.id and a.status = 'started'
      loop
        perform app_private.mark_attempt_uncertain(v_stale.id, 'worker_lost',
          'The worker handling this request stopped before recording its outcome.');
        v_job.attempts := v_job.attempts + 1;
      end loop;

      if not v_is_test then
        if v_campaign.status = 'canceled' then
          perform app_private.cancel_job(v_job, 'campaign_canceled');
          continue;
        elsif v_campaign.status = 'paused' then
          perform app_private.pause_job(v_job, 'campaign_paused');
          continue;
        elsif v_campaign.status not in ('baseline', 'running', 'finalizing') then
          perform app_private.cancel_job(v_job, 'campaign_not_active');
          continue;
        end if;
      end if;
      if v_ws.emergency_stop then
        perform app_private.pause_job(v_job, 'emergency_stop');
        continue;
      end if;
      if v_conn.status <> 'ok' then
        perform app_private.block_job(v_job, 'connection_' || coalesce(v_conn.status_code, 'not_ready'), null);
        continue;
      end if;
      if v_job.attempts >= v_job.max_attempts then
        update public.jobs set attempts = v_job.attempts where id = v_job.id;
        perform app_private.dead_letter(v_job, coalesce(v_job.last_error_class, 'max_attempts_exceeded'),
          coalesce(v_job.last_error_message, 'The maximum number of attempts was reached.'));
        continue;
      end if;
    end if;

    update public.jobs
    set status = 'running',
        lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + make_interval(secs => v_lease),
        leased_by = left(p_worker_id, 120),
        fencing_token = fencing_token + 1,
        attempts = v_job.attempts,
        next_attempt_at = null
    where id = v_job.id
    returning * into v_job;

    return app_private.build_unit(v_job, v_poll) || jsonb_build_object('msg_id', v_msg.msg_id);
  end loop;
  return null;
end;
$$;

-- Locks the job and reports whether the caller still holds it.
create or replace function app_private.holds_lease(p_job public.jobs, p_lease_token uuid, p_fencing_token bigint)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_job.id is not null
     and p_job.status = 'running'
     and p_job.lease_token is not distinct from p_lease_token
     and p_job.fencing_token = p_fencing_token;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Materialize a run: persist the selected wordings and the exact prompts, once.
-- ---------------------------------------------------------------------------------------------

-- p_plan: {combination_index, target_in_initial_prompt,
--          turns: [{step_index, step_kind, template_id, template_version_id, rendered_prompt}]}
create or replace function public.svc_materialize_run(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_plan jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_run public.runs%rowtype;
  v_turn jsonb;
  v_count integer;
begin
  -- Lock order: campaign, then job (a configuration failure pauses the campaign).
  perform 1 from public.campaigns c
  where c.id = (select j.campaign_id from public.jobs j where j.id = p_job_id)
  for no key update;
  select * into v_job from public.jobs j where j.id = p_job_id for no key update;
  if not app_private.holds_lease(v_job, p_lease_token, p_fencing_token) then
    return jsonb_build_object('ok', false, 'action', 'stale');
  end if;
  select * into v_run from public.runs r where r.id = v_job.run_id for no key update;

  if v_run.steps_total is null then
    v_count := jsonb_array_length(coalesce(p_plan -> 'turns', '[]'::jsonb));
    if v_count < 1 then
      perform app_private.dead_letter(v_job, 'invalid_configuration', 'The conversation has no steps to run.');
      return jsonb_build_object('ok', false, 'action', 'dead', 'reason', 'invalid_configuration');
    end if;
    for v_turn in select value from jsonb_array_elements(p_plan -> 'turns') loop
      if char_length(btrim(coalesce(v_turn ->> 'rendered_prompt', ''))) = 0
         or (v_turn ->> 'rendered_prompt') ~ '\{\{[^{}]*\}\}' then
        perform app_private.dead_letter(v_job, 'invalid_configuration',
          format('Step %s renders to an empty prompt or still contains an unresolved variable.', v_turn ->> 'step_index'));
        if v_job.kind <> 'test_conversation' then
          perform app_private.auto_pause_campaign(v_job.campaign_id, 'configuration',
            format('Step %s renders to an empty prompt or still contains an unresolved variable.', v_turn ->> 'step_index'));
        end if;
        return jsonb_build_object('ok', false, 'action', 'dead', 'reason', 'invalid_configuration');
      end if;
      insert into public.run_turns (
        workspace_id, run_id, campaign_id, step_index, step_kind, template_id, template_version_id, rendered_prompt
      )
      values (
        v_run.workspace_id, v_run.id, v_run.campaign_id,
        (v_turn ->> 'step_index')::integer,
        (v_turn ->> 'step_kind')::public.template_kind,
        (v_turn ->> 'template_id')::uuid,
        (v_turn ->> 'template_version_id')::uuid,
        v_turn ->> 'rendered_prompt'
      );
    end loop;

    update public.runs
    set steps_total = v_count,
        status = 'in_progress',
        started_at = coalesce(started_at, clock_timestamp()),
        combination_index = (p_plan ->> 'combination_index')::bigint,
        combination = (
          select jsonb_agg(jsonb_build_object(
            'step_index', (t.value ->> 'step_index')::integer,
            'template_id', t.value ->> 'template_id',
            'template_version_id', t.value ->> 'template_version_id'
          ) order by (t.value ->> 'step_index')::integer)
          from jsonb_array_elements(p_plan -> 'turns') t
        ),
        target_in_initial_prompt = coalesce((p_plan ->> 'target_in_initial_prompt')::boolean, false)
    where id = v_run.id;
  end if;

  return jsonb_build_object('ok', true) || app_private.build_unit(v_job, null);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Begin attempt: the single atomic gate in front of every paid request.
-- ---------------------------------------------------------------------------------------------

create or replace function public.svc_begin_attempt(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_mode text,
  p_est_input_tokens integer,
  p_max_output_tokens integer,
  p_request_params jsonb,
  p_rendered_prompt text default null,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_ids record;
  v_job public.jobs%rowtype;
  v_campaign public.campaigns%rowtype;
  v_ws public.workspaces%rowtype;
  v_conn public.provider_connections%rowtype;
  v_cap_rev public.campaign_revisions%rowtype;
  v_run public.runs%rowtype;
  v_turn public.run_turns%rowtype;
  v_check public.fresh_checks%rowtype;
  v_price public.model_prices;
  v_purpose public.attempt_purpose;
  v_model text;
  v_is_test boolean;
  v_is_conversation boolean;
  v_open integer;
  v_reqs integer;
  v_tokens bigint;
  v_oldest timestamptz;
  v_this_tokens integer := coalesce(p_est_input_tokens, 0) + coalesce(p_max_output_tokens, 0);
  v_rpm integer;
  v_tpm integer;
  v_amount numeric;
  v_block jsonb;
  v_attempt_id uuid := gen_random_uuid();
  v_reservation_id uuid := gen_random_uuid();
  v_attempt_number integer;
  v_window timestamptz;
begin
  select j.campaign_id, j.connection_id, j.workspace_id into v_ids from public.jobs j where j.id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'action', 'stale');
  end if;
  -- Lock order: campaign, connection, job. Reservations for a connection are fully serialized.
  --
  -- Row locks in these functions are FOR NO KEY UPDATE, never FOR UPDATE. They exclude each
  -- other exactly the same way, but they do not conflict with the FOR KEY SHARE locks that
  -- foreign-key checks take on parent rows. A commit that updates an attempt, or inserts a
  -- ledger row, key-share-locks its campaign and connection in whatever order the constraint
  -- triggers fire; with FOR UPDATE here that could deadlock against this function.
  select * into v_campaign from public.campaigns c where c.id = v_ids.campaign_id for no key update;
  select * into v_conn from public.provider_connections pc where pc.id = v_ids.connection_id for no key update;
  select * into v_job from public.jobs j where j.id = p_job_id for no key update;
  if not app_private.holds_lease(v_job, p_lease_token, p_fencing_token) then
    return jsonb_build_object('ok', false, 'action', 'stale');
  end if;
  select * into v_ws from public.workspaces w where w.id = v_job.workspace_id;

  v_is_test := v_job.kind = 'test_conversation';
  v_is_conversation := v_job.kind in ('conversation', 'test_conversation');

  if v_is_conversation then
    select * into v_run from public.runs r where r.id = v_job.run_id for no key update;
    v_turn := app_private.next_turn(v_run.id);
    if v_turn.id is null then
      return jsonb_build_object('ok', false, 'action', 'stale');
    end if;
    v_purpose := 'conversation_turn';
    v_model := v_run.model;
    select * into v_price from public.model_prices p where p.id = v_run.price_id;
    v_attempt_number := v_turn.attempt_count + 1;
  else
    select * into v_check from public.fresh_checks f where f.id = v_job.fresh_check_id for no key update;
    v_purpose := 'fresh_check';
    v_model := v_check.model;
    select * into v_price from public.model_prices p where p.id = v_check.price_id;
    v_attempt_number := v_check.attempt_count + 1;
  end if;

  -- Stop / pause / cancel ---------------------------------------------------------------------
  if v_ws.emergency_stop then
    perform app_private.pause_job(v_job, 'emergency_stop');
    return jsonb_build_object('ok', false, 'action', 'paused', 'reason', 'emergency_stop');
  end if;
  if not v_is_test then
    if v_campaign.status = 'canceled' then
      perform app_private.cancel_job(v_job, 'campaign_canceled');
      return jsonb_build_object('ok', false, 'action', 'canceled', 'reason', 'campaign_canceled');
    elsif v_campaign.status = 'paused' then
      perform app_private.pause_job(v_job, 'campaign_paused');
      return jsonb_build_object('ok', false, 'action', 'paused', 'reason', 'campaign_paused');
    end if;
  end if;
  if v_conn.status <> 'ok' then
    perform app_private.block_job(v_job, 'connection_' || coalesce(v_conn.status_code, 'not_ready'), null);
    return jsonb_build_object('ok', false, 'action', 'blocked', 'reason', 'connection_not_ready');
  end if;

  -- Price ---------------------------------------------------------------------------------------
  if v_price.id is null then
    perform app_private.dead_letter(v_job, 'price_missing',
      format('No price is recorded for model "%s". Add one under Settings → Model pricing.', v_model));
    if not v_is_test then
      perform app_private.auto_pause_campaign(v_job.campaign_id, 'configuration',
        format('No price is recorded for model "%s".', v_model));
    end if;
    return jsonb_build_object('ok', false, 'action', 'dead', 'reason', 'price_missing');
  end if;

  -- Connection concurrency ------------------------------------------------------------------------
  select count(*) into v_open
  from public.provider_attempts a
  where a.connection_id = v_conn.id
    and a.status in ('started', 'in_flight')
    and a.started_at > v_now - interval '30 minutes';
  if v_open >= v_conn.max_concurrent_requests then
    perform app_private.defer_job(v_job, 3 + floor(random() * 4)::integer, 'connection_busy');
    return jsonb_build_object('ok', false, 'action', 'deferred', 'reason', 'connection_busy');
  end if;

  -- Request and token rate caps, per connection and per campaign -------------------------------
  v_window := v_now - interval '60 seconds';
  select count(*), coalesce(sum(a.est_input_tokens + a.max_output_tokens), 0), min(a.started_at)
  into v_reqs, v_tokens, v_oldest
  from public.provider_attempts a
  where a.connection_id = v_conn.id and a.started_at > v_window;
  if (v_conn.requests_per_minute is not null and v_reqs + 1 > v_conn.requests_per_minute)
     or (v_conn.tokens_per_minute is not null and v_reqs > 0 and v_tokens + v_this_tokens > v_conn.tokens_per_minute) then
    perform app_private.defer_job(
      v_job, greatest(ceil(extract(epoch from (v_oldest + interval '61 seconds' - v_now)))::integer, 1), 'rate_cap');
    return jsonb_build_object('ok', false, 'action', 'deferred', 'reason', 'connection_rate_cap');
  end if;

  select r.* into v_cap_rev
  from public.campaign_revisions r
  where r.id = coalesce(v_campaign.active_revision_id, v_campaign.draft_revision_id);
  v_rpm := v_cap_rev.requests_per_minute;
  v_tpm := v_cap_rev.tokens_per_minute;
  if v_rpm is not null or v_tpm is not null then
    select count(*), coalesce(sum(a.est_input_tokens + a.max_output_tokens), 0), min(a.started_at)
    into v_reqs, v_tokens, v_oldest
    from public.provider_attempts a
    where a.campaign_id = v_campaign.id and a.started_at > v_window;
    if (v_rpm is not null and v_reqs + 1 > v_rpm)
       or (v_tpm is not null and v_reqs > 0 and v_tokens + v_this_tokens > v_tpm) then
      perform app_private.defer_job(
        v_job, greatest(ceil(extract(epoch from (v_oldest + interval '61 seconds' - v_now)))::integer, 1), 'rate_cap');
      return jsonb_build_object('ok', false, 'action', 'deferred', 'reason', 'campaign_rate_cap');
    end if;
  end if;

  -- Budget reservation ----------------------------------------------------------------------------
  v_amount := app_private.max_cost(v_price, p_est_input_tokens, p_max_output_tokens);
  v_block := app_private.budget_block(v_conn, v_campaign.id, v_amount, v_job.kind = 'check_final', v_now);
  if v_block is not null then
    if v_is_test then
      perform app_private.dead_letter(v_job, v_block ->> 'code', 'The request does not fit within the spending limits.');
      return jsonb_build_object('ok', false, 'action', 'dead', 'reason', v_block ->> 'code');
    elsif v_job.kind = 'check_daily'
          or (v_job.kind = 'conversation' and v_turn.step_index = 1 and v_run.steps_completed = 0) then
      -- Nothing has been spent on this slot yet: skip it visibly rather than hold it.
      perform app_private.finish_job(v_job, 'skipped', v_block ->> 'code');
      update public.runs set status = 'canceled', error_class = v_block ->> 'code', completed_at = clock_timestamp()
      where id = v_job.run_id;
      update public.run_turns set status = 'canceled' where run_id = v_job.run_id and status = 'pending';
      update public.fresh_checks set status = 'canceled', exclusion_reason = v_block ->> 'code', completed_at = clock_timestamp()
      where id = v_job.fresh_check_id;
      return jsonb_build_object('ok', false, 'action', 'skipped', 'reason', v_block ->> 'code');
    else
      -- Mid-conversation turns and baseline/final checks wait for budget.
      perform app_private.block_job(v_job, v_block ->> 'code', (v_block ->> 'until')::timestamptz);
      return jsonb_build_object('ok', false, 'action', 'blocked', 'reason', v_block ->> 'code');
    end if;
  end if;

  insert into public.provider_attempts (
    id, workspace_id, connection_id, campaign_id, purpose, is_test, job_id, run_id, run_turn_id, fresh_check_id,
    attempt_number, status, mode, requested_model, request_params, est_input_tokens, max_output_tokens,
    price_id, reservation_id, lease_token, fencing_token, started_at
  )
  values (
    v_attempt_id, v_job.workspace_id, v_conn.id, v_campaign.id, v_purpose, v_is_test, v_job.id,
    v_run.id, v_turn.id, v_check.id,
    v_attempt_number, 'started', case when p_mode = 'background' then 'background' else 'sync' end,
    v_model, coalesce(p_request_params, '{}'::jsonb), coalesce(p_est_input_tokens, 0), coalesce(p_max_output_tokens, 0),
    v_price.id, v_reservation_id, p_lease_token, p_fencing_token, clock_timestamp()
  );

  insert into public.budget_reservations (
    id, workspace_id, connection_id, campaign_id, attempt_id, purpose, is_final_check, amount_usd,
    connection_day, campaign_day
  )
  values (
    v_reservation_id, v_job.workspace_id, v_conn.id, v_campaign.id, v_attempt_id, v_purpose,
    v_job.kind = 'check_final', v_amount,
    (v_now at time zone 'UTC')::date,
    (v_now at time zone coalesce(v_cap_rev.timezone, 'UTC'))::date
  );

  if v_is_conversation then
    update public.run_turns
    set status = 'in_flight',
        attempt_count = v_attempt_number,
        previous_response_id = v_run.last_response_id,
        started_at = coalesce(started_at, clock_timestamp())
    where id = v_turn.id;
    update public.runs
    set status = 'in_progress', started_at = coalesce(started_at, clock_timestamp())
    where id = v_run.id and status in ('pending', 'failed');
  else
    update public.fresh_checks
    set status = 'in_flight',
        attempt_count = v_attempt_number,
        rendered_prompt = coalesce(p_rendered_prompt, rendered_prompt),
        started_at = coalesce(started_at, clock_timestamp())
    where id = v_check.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'attempt_id', v_attempt_id,
    'attempt_number', v_attempt_number,
    'reserved_usd', v_amount,
    'previous_response_id', v_run.last_response_id
  );
end;
$$;

-- A fresh check that must not run (e.g. its question would reveal the target) is excluded and
-- stays visible as excluded.
create or replace function public.svc_exclude_check(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_reason text,
  p_rendered_prompt text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs j where j.id = p_job_id for no key update;
  if not app_private.holds_lease(v_job, p_lease_token, p_fencing_token) then
    return jsonb_build_object('ok', false, 'action', 'stale');
  end if;
  update public.fresh_checks
  set status = 'excluded', exclusion_reason = left(p_reason, 200),
      rendered_prompt = coalesce(p_rendered_prompt, rendered_prompt), completed_at = clock_timestamp()
  where id = v_job.fresh_check_id;
  perform app_private.finish_job(v_job, 'succeeded', 'check_excluded');
  perform app_private.audit(v_job.workspace_id, 'check.excluded', 'fresh_check', v_job.fresh_check_id,
    jsonb_build_object('reason', left(p_reason, 200), 'campaign_id', v_job.campaign_id), 'worker');
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Background responses: accepted by the provider, then polled by response id.
-- ---------------------------------------------------------------------------------------------

create or replace function public.svc_attempt_in_flight(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_attempt_id uuid,
  p_response_id text,
  p_poll_in_seconds integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  -- The response id is recorded even for a stale worker, so the request can be reconciled.
  update public.provider_attempts
  set status = 'in_flight', response_id = p_response_id
  where id = p_attempt_id and job_id = p_job_id and status in ('started', 'uncertain');

  select * into v_job from public.jobs j where j.id = p_job_id for no key update;
  if not app_private.holds_lease(v_job, p_lease_token, p_fencing_token) then
    return jsonb_build_object('ok', false, 'action', 'stale');
  end if;
  perform app_private.defer_job(v_job, greatest(p_poll_in_seconds, 1), 'awaiting_background_response');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.svc_poll_pending(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_attempt_id uuid,
  p_poll_in_seconds integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  update public.provider_attempts
  set poll_count = poll_count + 1, last_polled_at = clock_timestamp()
  where id = p_attempt_id and job_id = p_job_id;

  select * into v_job from public.jobs j where j.id = p_job_id for no key update;
  if not app_private.holds_lease(v_job, p_lease_token, p_fencing_token) then
    return jsonb_build_object('ok', false, 'action', 'stale');
  end if;
  perform app_private.defer_job(v_job, greatest(p_poll_in_seconds, 1), 'awaiting_background_response');
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Classifications
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.record_classification(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_subject_type text,
  p_subject_id uuid,
  p_method text,
  p_c jsonb,
  p_created_by uuid default null,
  p_attempt_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev uuid;
  v_id uuid;
  v_inclusion text := p_c ->> 'inclusion';
  v_mentioned boolean;
  v_rank integer := (p_c ->> 'rank')::integer;
  v_position integer := (p_c ->> 'list_position')::integer;
  v_list_kind text := coalesce(p_c ->> 'list_kind', 'none');
begin
  if v_inclusion not in ('included', 'mentioned_only', 'not_mentioned', 'ambiguous') then
    perform app_private.fail('invalid_classification', 'Unknown classification.');
  end if;
  v_mentioned := case when v_inclusion = 'not_mentioned' then false
                      else coalesce((p_c ->> 'mentioned')::boolean, true) end;
  if v_inclusion <> 'included' then
    v_rank := null;
    v_position := null;
  end if;
  -- A rank exists only for numbered lists; never promote a bullet position to a rank.
  if v_rank is not null and v_list_kind <> 'numbered' then
    v_rank := null;
  end if;

  update public.classifications
  set is_current = false
  where subject_type = p_subject_type and subject_id = p_subject_id and is_current
  returning id into v_prev;

  insert into public.classifications (
    workspace_id, campaign_id, subject_type, subject_id, method, detector_version, mentioned, inclusion,
    rank, list_position, list_kind, list_length, matched_spans, reason, note, supersedes_id, attempt_id, created_by
  )
  values (
    p_workspace_id, p_campaign_id, p_subject_type, p_subject_id, p_method, p_c ->> 'detector_version',
    v_mentioned, v_inclusion, v_rank, v_position, v_list_kind, (p_c ->> 'list_length')::integer,
    coalesce(p_c -> 'matched_spans', '[]'::jsonb), left(p_c ->> 'reason', 500), left(p_c ->> 'note', 1000),
    v_prev, p_attempt_id, p_created_by
  )
  returning id into v_id;

  if p_subject_type = 'run_turn' then
    update public.run_turns
    set classification_id = v_id, mentioned = v_mentioned, inclusion = v_inclusion, rank = v_rank, list_position = v_position
    where id = p_subject_id;
  elsif p_subject_type = 'fresh_check' then
    update public.fresh_checks
    set classification_id = v_id, mentioned = v_mentioned, inclusion = v_inclusion, rank = v_rank, list_position = v_position
    where id = p_subject_id;
  else
    update public.manual_checks
    set classification_id = v_id, mentioned = v_mentioned, inclusion = v_inclusion, rank = v_rank, list_position = v_position
    where id = p_subject_id;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Accounting shared by commits, failures and ad-hoc requests
-- ---------------------------------------------------------------------------------------------

-- Records returned usage for an attempt: settles its reservation and appends to the ledger.
create or replace function app_private.settle_attempt(p_attempt_id uuid, p_usage jsonb)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.provider_attempts%rowtype;
  v_res public.budget_reservations%rowtype;
  v_price public.model_prices;
  v_cost numeric;
begin
  select * into v_attempt from public.provider_attempts a where a.id = p_attempt_id;
  select * into v_res from public.budget_reservations r where r.id = v_attempt.reservation_id for no key update;
  select * into v_price from public.model_prices p where p.id = v_attempt.price_id;

  v_cost := coalesce(app_private.usage_cost(
    v_price,
    (p_usage ->> 'input_tokens')::integer,
    (p_usage ->> 'cached_tokens')::integer,
    (p_usage ->> 'cache_write_tokens')::integer,
    (p_usage ->> 'cache_write_30m_tokens')::integer,
    (p_usage ->> 'cache_write_12h_tokens')::integer,
    (p_usage ->> 'output_tokens')::integer
  ), 0);

  update public.provider_attempts
  set input_tokens = (p_usage ->> 'input_tokens')::integer,
      cached_input_tokens = (p_usage ->> 'cached_tokens')::integer,
      cache_write_tokens = (p_usage ->> 'cache_write_tokens')::integer,
      cache_write_30m_tokens = (p_usage ->> 'cache_write_30m_tokens')::integer,
      cache_write_12h_tokens = (p_usage ->> 'cache_write_12h_tokens')::integer,
      output_tokens = (p_usage ->> 'output_tokens')::integer,
      reasoning_tokens = (p_usage ->> 'reasoning_tokens')::integer,
      total_tokens = (p_usage ->> 'total_tokens')::integer,
      cost_usd = v_cost
  where id = p_attempt_id;

  update public.budget_reservations
  set status = 'settled', settled_cost_usd = v_cost, closed_at = clock_timestamp()
  where id = v_res.id and status in ('held', 'unresolved');

  insert into public.usage_ledger (
    workspace_id, connection_id, campaign_id, attempt_id, purpose, is_test, model, returned_model,
    input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
    cost_usd, price_id, basis, connection_day, campaign_day
  )
  values (
    v_attempt.workspace_id, v_attempt.connection_id, v_attempt.campaign_id, v_attempt.id, v_attempt.purpose,
    v_attempt.is_test, v_attempt.requested_model, v_attempt.returned_model,
    coalesce((p_usage ->> 'input_tokens')::integer, 0),
    coalesce((p_usage ->> 'cached_tokens')::integer, 0),
    coalesce((p_usage ->> 'cache_write_tokens')::integer, 0),
    coalesce((p_usage ->> 'output_tokens')::integer, 0),
    coalesce((p_usage ->> 'reasoning_tokens')::integer, 0),
    v_cost, v_attempt.price_id, 'usage',
    coalesce(v_res.connection_day, (now() at time zone 'UTC')::date), v_res.campaign_day
  )
  on conflict (attempt_id) do nothing;

  return v_cost;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5a. Commit a provider result
-- ---------------------------------------------------------------------------------------------

-- p_result: {status: 'completed'|'incomplete', response_id, output_text, output_items,
--            returned_model, service_tier, incomplete_reason, refusal, provider_request_id,
--            http_status, latency_ms, usage: {...}}
-- p_classification: detector output for completed answers, or null.
create or replace function public.svc_commit_result(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_attempt_id uuid,
  p_result jsonb,
  p_classification jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.provider_attempts%rowtype;
  v_job public.jobs%rowtype;
  v_campaign public.campaigns%rowtype;
  v_ws public.workspaces%rowtype;
  v_run public.runs%rowtype;
  v_turn public.run_turns%rowtype;
  v_usage jsonb := coalesce(p_result -> 'usage', '{}'::jsonb);
  v_completed boolean := (p_result ->> 'status') = 'completed';
  v_was_uncertain boolean;
  v_cost numeric;
  v_mentioned boolean;
  v_next text;
begin
  select * into v_attempt from public.provider_attempts a where a.id = p_attempt_id and a.job_id = p_job_id for no key update;
  if not found then
    return jsonb_build_object('ok', false, 'action', 'unknown_attempt');
  end if;
  select * into v_job from public.jobs j where j.id = p_job_id for no key update;

  -- Accounting is recorded for the attempt's own request regardless of who holds the job now.
  if v_attempt.status in ('started', 'in_flight', 'uncertain') then
    v_was_uncertain := v_attempt.status = 'uncertain';
    update public.provider_attempts
    set status = case when v_completed then 'succeeded'::public.attempt_status else 'incomplete'::public.attempt_status end,
        response_id = coalesce(p_result ->> 'response_id', response_id),
        provider_request_id = p_result ->> 'provider_request_id',
        http_status = (p_result ->> 'http_status')::integer,
        returned_model = p_result ->> 'returned_model',
        service_tier = p_result ->> 'service_tier',
        response_status = p_result ->> 'status',
        error_class = null,
        error_message = null,
        finished_at = clock_timestamp(),
        latency_ms = (p_result ->> 'latency_ms')::integer,
        resolved_at = case when v_was_uncertain then clock_timestamp() else resolved_at end,
        resolution = case when v_was_uncertain then 'reconciled' else resolution end
    where id = p_attempt_id;
    v_cost := app_private.settle_attempt(p_attempt_id, v_usage);
  else
    v_cost := v_attempt.cost_usd;
  end if;

  if not app_private.holds_lease(v_job, p_lease_token, p_fencing_token) then
    return jsonb_build_object('ok', false, 'action', 'stale', 'cost_usd', v_cost);
  end if;

  select * into v_campaign from public.campaigns c where c.id = v_job.campaign_id;
  select * into v_ws from public.workspaces w where w.id = v_job.workspace_id;

  if v_job.kind in ('conversation', 'test_conversation') then
    select * into v_run from public.runs r where r.id = v_job.run_id for no key update;
    select * into v_turn from public.run_turns t where t.id = v_attempt.run_turn_id for no key update;

    update public.run_turns
    set status = case when v_completed then 'completed'::public.turn_status else 'incomplete'::public.turn_status end,
        response_id = p_result ->> 'response_id',
        output_text = p_result ->> 'output_text',
        output_items = p_result -> 'output_items',
        response_status = p_result ->> 'status',
        incomplete_reason = p_result ->> 'incomplete_reason',
        refusal = coalesce((p_result ->> 'refusal')::boolean, false),
        requested_model = v_attempt.requested_model,
        returned_model = p_result ->> 'returned_model',
        request_params = v_attempt.request_params,
        service_tier = p_result ->> 'service_tier',
        input_tokens = (v_usage ->> 'input_tokens')::integer,
        cached_input_tokens = (v_usage ->> 'cached_tokens')::integer,
        cache_write_tokens = (v_usage ->> 'cache_write_tokens')::integer,
        output_tokens = (v_usage ->> 'output_tokens')::integer,
        reasoning_tokens = (v_usage ->> 'reasoning_tokens')::integer,
        total_tokens = (v_usage ->> 'total_tokens')::integer,
        cost_usd = v_cost,
        latency_ms = (p_result ->> 'latency_ms')::integer,
        completed_at = clock_timestamp()
    where id = v_turn.id;

    if v_completed and p_classification is not null then
      perform app_private.record_classification(
        v_job.workspace_id, v_job.campaign_id, 'run_turn', v_turn.id, 'rules', p_classification);
      v_mentioned := coalesce((p_classification ->> 'mentioned')::boolean, false);
    end if;

    update public.runs
    set steps_completed = steps_completed + case when v_completed then 1 else 0 end,
        last_response_id = coalesce(p_result ->> 'response_id', last_response_id),
        last_response_at = clock_timestamp(),
        -- Recorded before the inclusion request is ever sent.
        target_in_first_response = case when v_turn.step_index = 1 and v_completed
          then coalesce(v_mentioned, false) else target_in_first_response end,
        error_class = null,
        error_message = null
    where id = v_run.id;

    if not v_completed then
      -- An incomplete answer ends the conversation: later turns would build on a truncated reply.
      update public.run_turns set status = 'skipped' where run_id = v_run.id and status = 'pending';
      update public.runs set status = 'incomplete', completed_at = clock_timestamp(),
        error_class = 'incomplete_response', error_message = p_result ->> 'incomplete_reason'
      where id = v_run.id;
      perform app_private.finish_job(v_job, 'succeeded', 'run_incomplete');
      v_next := 'done';
    elsif v_turn.step_index = 1 and coalesce(v_mentioned, false) and v_run.on_existing_inclusion = 'finish_early' then
      update public.run_turns set status = 'skipped' where run_id = v_run.id and status = 'pending';
      update public.runs set status = 'completed_early', completed_at = clock_timestamp() where id = v_run.id;
      perform app_private.finish_job(v_job, 'succeeded', 'target_already_present');
      v_next := 'done';
    elsif v_turn.step_index >= v_run.steps_total then
      update public.runs set status = 'completed', completed_at = clock_timestamp() where id = v_run.id;
      perform app_private.finish_job(v_job, 'succeeded');
      v_next := 'done';
    elsif v_job.kind <> 'test_conversation' and v_campaign.status = 'canceled' then
      perform app_private.cancel_job(v_job, 'campaign_canceled');
      v_next := 'canceled';
    elsif (v_job.kind <> 'test_conversation' and v_campaign.status = 'paused') or v_ws.emergency_stop then
      -- The completed turn is saved; the next turn waits for resume.
      update public.jobs set attempts = 0 where id = v_job.id;
      perform app_private.pause_job(v_job, case when v_ws.emergency_stop then 'emergency_stop' else 'campaign_paused' end);
      v_next := 'paused';
    else
      -- Same transaction as the turn result: the next turn becomes visible in the queue now.
      update public.jobs set attempts = 0, last_error_class = null, last_error_message = null where id = v_job.id;
      perform app_private.defer_job(v_job, 0, null);
      v_next := 'continue';
    end if;
  else
    update public.fresh_checks
    set status = case when v_completed then 'completed'::public.check_status else 'incomplete'::public.check_status end,
        response_id = p_result ->> 'response_id',
        output_text = p_result ->> 'output_text',
        output_items = p_result -> 'output_items',
        response_status = p_result ->> 'status',
        incomplete_reason = p_result ->> 'incomplete_reason',
        refusal = coalesce((p_result ->> 'refusal')::boolean, false),
        returned_model = p_result ->> 'returned_model',
        service_tier = p_result ->> 'service_tier',
        input_tokens = (v_usage ->> 'input_tokens')::integer,
        cached_input_tokens = (v_usage ->> 'cached_tokens')::integer,
        cache_write_tokens = (v_usage ->> 'cache_write_tokens')::integer,
        output_tokens = (v_usage ->> 'output_tokens')::integer,
        reasoning_tokens = (v_usage ->> 'reasoning_tokens')::integer,
        total_tokens = (v_usage ->> 'total_tokens')::integer,
        cost_usd = v_cost,
        latency_ms = (p_result ->> 'latency_ms')::integer,
        exclusion_reason = null,
        completed_at = clock_timestamp()
    where id = v_job.fresh_check_id;

    if v_completed and p_classification is not null then
      perform app_private.record_classification(
        v_job.workspace_id, v_job.campaign_id, 'fresh_check', v_job.fresh_check_id, 'rules', p_classification);
    end if;
    perform app_private.finish_job(v_job, 'succeeded');
    v_next := 'done';
  end if;

  return jsonb_build_object('ok', true, 'next', v_next, 'cost_usd', v_cost);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5b. Record a failed or ambiguous attempt and decide what happens next
-- ---------------------------------------------------------------------------------------------

-- p_error: {class, uncertain, http_status, type, code, param, message, retry_after_ms,
--           provider_request_id, response_id, latency_ms, usage}
-- Classes: rate_limited, server_error, connection_error, timeout, provider_failed (retryable);
--          quota_exhausted, invalid_credentials (connection needs attention);
--          model_unavailable, permission_denied, invalid_request (configuration needs attention);
--          chain_expired (conversation state gone: explicit restart required).
create or replace function public.svc_fail_attempt(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_attempt_id uuid,
  p_error jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class text := coalesce(p_error ->> 'class', 'server_error');
  v_uncertain boolean := coalesce((p_error ->> 'uncertain')::boolean, false);
  v_message text := left(coalesce(p_error ->> 'message', 'The provider request failed.'), 1000);
  v_attempt public.provider_attempts%rowtype;
  v_job public.jobs%rowtype;
  v_campaign public.campaigns%rowtype;
  v_is_test boolean;
  v_delay integer;
begin
  select * into v_attempt from public.provider_attempts a where a.id = p_attempt_id and a.job_id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'action', 'unknown_attempt');
  end if;
  -- Lock order everywhere: campaign, then connection, then job.
  if v_class in ('model_unavailable', 'permission_denied', 'invalid_request') then
    perform 1 from public.campaigns c where c.id = v_attempt.campaign_id for no key update;
  end if;
  if v_class in ('quota_exhausted', 'invalid_credentials') then
    perform 1 from public.provider_connections pc where pc.id = v_attempt.connection_id for no key update;
  end if;
  select * into v_attempt from public.provider_attempts a where a.id = p_attempt_id for no key update;
  select * into v_job from public.jobs j where j.id = p_job_id for no key update;

  -- Also reconciles an attempt that was presumed lost when its worker now reports a definite outcome.
  if v_attempt.status in ('started', 'in_flight')
     or (v_attempt.status = 'uncertain' and v_attempt.resolved_at is null and not v_uncertain) then
    update public.provider_attempts
    set status = case when v_uncertain then 'uncertain'::public.attempt_status
                      when v_class = 'canceled' then 'canceled'::public.attempt_status
                      else 'failed'::public.attempt_status end,
        resolved_at = case when v_attempt.status = 'uncertain' then clock_timestamp() else resolved_at end,
        resolution = case when v_attempt.status = 'uncertain' then 'reconciled' else resolution end,
        http_status = (p_error ->> 'http_status')::integer,
        error_class = v_class,
        error_type = left(p_error ->> 'type', 200),
        error_code = left(p_error ->> 'code', 200),
        error_param = left(p_error ->> 'param', 200),
        error_message = v_message,
        retry_after_ms = (p_error ->> 'retry_after_ms')::integer,
        provider_request_id = p_error ->> 'provider_request_id',
        response_id = coalesce(p_error ->> 'response_id', response_id),
        finished_at = clock_timestamp(),
        latency_ms = (p_error ->> 'latency_ms')::integer
    where id = p_attempt_id;

    if jsonb_typeof(p_error -> 'usage') = 'object' then
      -- The provider reported usage for a failed response: it is billed, so it is recorded.
      perform app_private.settle_attempt(p_attempt_id, p_error -> 'usage');
    elsif v_uncertain then
      update public.budget_reservations set status = 'unresolved'
      where id = v_attempt.reservation_id and status = 'held';
    else
      update public.budget_reservations set status = 'released', closed_at = clock_timestamp()
      where id = v_attempt.reservation_id and status in ('held', 'unresolved');
    end if;
  end if;

  if not app_private.holds_lease(v_job, p_lease_token, p_fencing_token) then
    return jsonb_build_object('ok', false, 'action', 'stale');
  end if;

  update public.run_turns
  set status = case when v_uncertain then 'uncertain'::public.turn_status else 'failed'::public.turn_status end
  where id = v_attempt.run_turn_id and status in ('in_flight', 'uncertain');
  update public.fresh_checks
  set status = case when v_uncertain then 'uncertain'::public.check_status else 'failed'::public.check_status end
  where id = v_attempt.fresh_check_id and status in ('in_flight', 'uncertain');

  v_is_test := v_job.kind = 'test_conversation';
  select * into v_campaign from public.campaigns c where c.id = v_job.campaign_id;
  update public.jobs
  set last_error_class = v_class, last_error_message = v_message
  where id = v_job.id
  returning * into v_job;

  if not v_is_test and v_campaign.status = 'canceled' then
    perform app_private.cancel_job(v_job, 'campaign_canceled');
    return jsonb_build_object('ok', true, 'action', 'canceled');
  end if;

  if v_class in ('quota_exhausted', 'invalid_credentials') then
    -- Not retried: an owner must fix the credential or billing. Other jobs on this connection
    -- stop being dispatched until a connection test succeeds.
    update public.provider_connections
    set status = 'error', status_code = v_class, status_message = v_message, last_tested_at = clock_timestamp()
    where id = v_attempt.connection_id;
    perform app_private.audit(v_job.workspace_id, 'connection.error', 'connection', v_attempt.connection_id,
      jsonb_build_object('code', v_class, 'message', left(v_message, 300)), 'worker');
    if v_is_test then
      perform app_private.dead_letter(v_job, v_class, v_message);
      return jsonb_build_object('ok', true, 'action', 'dead');
    end if;
    perform app_private.block_job(v_job, 'connection_' || v_class, null);
    return jsonb_build_object('ok', true, 'action', 'blocked');

  elsif v_class in ('model_unavailable', 'permission_denied', 'invalid_request') then
    perform app_private.dead_letter(v_job, v_class, v_message);
    if not v_is_test then
      perform app_private.auto_pause_campaign(
        v_job.campaign_id,
        case when v_class = 'invalid_request' then 'configuration' else 'model_unavailable' end,
        v_message
      );
    end if;
    return jsonb_build_object('ok', true, 'action', 'dead');

  elsif v_class = 'chain_expired' then
    -- Never continue as an unrelated fresh conversation: the run must be restarted explicitly.
    perform app_private.dead_letter(v_job, 'chain_expired',
      'The stored conversation state is no longer available at the provider. Restart this run to begin a new conversation.');
    return jsonb_build_object('ok', true, 'action', 'dead');
  end if;

  -- Retryable: exponential backoff with jitter, honoring provider retry guidance.
  update public.jobs set attempts = attempts + 1 where id = v_job.id returning * into v_job;
  if v_job.attempts >= v_job.max_attempts then
    perform app_private.dead_letter(v_job, v_class, v_message);
    return jsonb_build_object('ok', true, 'action', 'dead');
  end if;
  v_delay := app_private.backoff_seconds(v_job.attempts, (p_error ->> 'retry_after_ms')::integer);
  perform app_private.defer_job(v_job, v_delay, 'retry_' || v_class);
  return jsonb_build_object('ok', true, 'action', 'retry', 'delay_seconds', v_delay, 'attempts', v_job.attempts);
end;
$$;

-- Releases a claimed unit without doing anything (e.g. the worker is about to hit its deadline).
create or replace function public.svc_release_work(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_delay_seconds integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs j where j.id = p_job_id for no key update;
  if not app_private.holds_lease(v_job, p_lease_token, p_fencing_token) then
    return jsonb_build_object('ok', false, 'action', 'stale');
  end if;
  perform app_private.defer_job(v_job, greatest(p_delay_seconds, 0), 'released');
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Ad-hoc paid requests (model verification, variation generation, classification)
-- ---------------------------------------------------------------------------------------------

-- p_requests: [{est_input_tokens, max_output_tokens, request_params}]
-- Reserves budget for every request up front. Returns {ok, attempt_ids} or {ok:false, code, message}.
create or replace function public.svc_begin_adhoc(
  p_workspace_id uuid,
  p_actor uuid,
  p_connection_id uuid,
  p_purpose public.attempt_purpose,
  p_model text,
  p_requests jsonb,
  p_campaign_id uuid default null,
  p_generation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_ws public.workspaces%rowtype;
  v_conn public.provider_connections%rowtype;
  v_price public.model_prices;
  v_cap_rev public.campaign_revisions%rowtype;
  v_req jsonb;
  v_amount numeric;
  v_total numeric := 0;
  v_block jsonb;
  v_attempt_id uuid;
  v_reservation_id uuid;
  v_ids uuid[] := '{}'::uuid[];
  v_min_role public.workspace_role;
begin
  v_min_role := case when p_purpose = 'model_probe' then 'owner' else 'admin' end::public.workspace_role;
  perform app_private.require_actor_role(p_workspace_id, p_actor, v_min_role);
  if p_purpose not in ('model_probe', 'variation_generation', 'classification') then
    return jsonb_build_object('ok', false, 'code', 'invalid_purpose', 'message', 'Unsupported request type.');
  end if;

  select * into v_ws from public.workspaces w where w.id = p_workspace_id;
  if p_campaign_id is not null then
    perform 1 from public.campaigns c where c.id = p_campaign_id and c.workspace_id = p_workspace_id for no key update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'Campaign not found.');
    end if;
  end if;
  select * into v_conn from public.provider_connections pc
  where pc.id = p_connection_id and pc.workspace_id = p_workspace_id
  for no key update;
  if not found or v_conn.archived_at is not null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'Connection not found.');
  end if;
  if v_ws.emergency_stop then
    return jsonb_build_object('ok', false, 'code', 'emergency_stop',
      'message', 'The workspace stop is active. An owner must release it before paid requests can run.');
  end if;
  if v_conn.status <> 'ok' then
    return jsonb_build_object('ok', false, 'code', 'connection_not_ready',
      'message', 'The connection is not ready: ' || coalesce(v_conn.status_message, v_conn.status_code, 'no API key configured'));
  end if;

  v_price := app_private.current_price(p_workspace_id, p_model);
  if v_price.id is null then
    return jsonb_build_object('ok', false, 'code', 'price_missing',
      'message', format('No price is recorded for model "%s". Add one under Settings → Model pricing first.', p_model));
  end if;

  for v_req in select value from jsonb_array_elements(coalesce(p_requests, '[]'::jsonb)) loop
    v_total := v_total + app_private.max_cost(
      v_price, (v_req ->> 'est_input_tokens')::integer, (v_req ->> 'max_output_tokens')::integer);
  end loop;
  v_block := app_private.budget_block(v_conn, p_campaign_id, v_total, false, v_now);
  if v_block is not null then
    return jsonb_build_object('ok', false, 'code', v_block ->> 'code',
      'message', 'This request does not fit within the spending limits.');
  end if;

  if p_campaign_id is not null then
    select r.* into v_cap_rev
    from public.campaigns c
    join public.campaign_revisions r on r.id = coalesce(c.active_revision_id, c.draft_revision_id)
    where c.id = p_campaign_id;
  end if;

  for v_req in select value from jsonb_array_elements(coalesce(p_requests, '[]'::jsonb)) loop
    v_attempt_id := gen_random_uuid();
    v_reservation_id := gen_random_uuid();
    v_amount := app_private.max_cost(
      v_price, (v_req ->> 'est_input_tokens')::integer, (v_req ->> 'max_output_tokens')::integer);

    insert into public.provider_attempts (
      id, workspace_id, connection_id, campaign_id, purpose, generation_id, attempt_number, status, mode,
      requested_model, request_params, est_input_tokens, max_output_tokens, price_id, reservation_id, created_by
    )
    values (
      v_attempt_id, p_workspace_id, p_connection_id, p_campaign_id, p_purpose, p_generation_id, 1, 'started', 'sync',
      p_model, coalesce(v_req -> 'request_params', '{}'::jsonb),
      coalesce((v_req ->> 'est_input_tokens')::integer, 0), coalesce((v_req ->> 'max_output_tokens')::integer, 0),
      v_price.id, v_reservation_id, p_actor
    );
    insert into public.budget_reservations (
      id, workspace_id, connection_id, campaign_id, attempt_id, purpose, amount_usd, connection_day, campaign_day
    )
    values (
      v_reservation_id, p_workspace_id, p_connection_id, p_campaign_id, v_attempt_id, p_purpose, v_amount,
      (v_now at time zone 'UTC')::date,
      case when p_campaign_id is not null then (v_now at time zone coalesce(v_cap_rev.timezone, 'UTC'))::date end
    );
    v_ids := v_ids || v_attempt_id;
  end loop;

  return jsonb_build_object('ok', true, 'attempt_ids', to_jsonb(v_ids), 'reserved_usd', v_total);
end;
$$;

-- p_outcome: {status: 'succeeded'|'incomplete'|'failed'|'uncertain'|'unused', usage, response_id,
--             returned_model, http_status, error_class, error_code, error_param, error_message,
--             provider_request_id, latency_ms, request_params}
create or replace function public.svc_finish_adhoc(p_attempt_id uuid, p_outcome jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.provider_attempts%rowtype;
  v_status text := coalesce(p_outcome ->> 'status', 'failed');
begin
  select * into v_attempt from public.provider_attempts a where a.id = p_attempt_id for no key update;
  if not found or v_attempt.status <> 'started' or v_attempt.job_id is not null then
    return;
  end if;

  update public.provider_attempts
  set status = case v_status
        when 'succeeded' then 'succeeded'
        when 'incomplete' then 'incomplete'
        when 'uncertain' then 'uncertain'
        when 'unused' then 'canceled'
        else 'failed' end::public.attempt_status,
      request_params = case when p_outcome ? 'request_params' then p_outcome -> 'request_params' else request_params end,
      response_id = p_outcome ->> 'response_id',
      returned_model = p_outcome ->> 'returned_model',
      service_tier = p_outcome ->> 'service_tier',
      response_status = p_outcome ->> 'response_status',
      http_status = (p_outcome ->> 'http_status')::integer,
      error_class = p_outcome ->> 'error_class',
      error_type = left(p_outcome ->> 'error_type', 200),
      error_code = left(p_outcome ->> 'error_code', 200),
      error_param = left(p_outcome ->> 'error_param', 200),
      error_message = left(p_outcome ->> 'error_message', 1000),
      provider_request_id = p_outcome ->> 'provider_request_id',
      finished_at = clock_timestamp(),
      latency_ms = (p_outcome ->> 'latency_ms')::integer
  where id = p_attempt_id;

  if jsonb_typeof(p_outcome -> 'usage') = 'object' then
    perform app_private.settle_attempt(p_attempt_id, p_outcome -> 'usage');
  elsif v_status = 'uncertain' then
    update public.budget_reservations set status = 'unresolved' where id = v_attempt.reservation_id and status = 'held';
  else
    update public.budget_reservations set status = 'released', closed_at = clock_timestamp()
    where id = v_attempt.reservation_id and status = 'held';
  end if;
end;
$$;

-- Stores a model-based classification produced after the answer was generated.
create or replace function public.svc_record_model_classification(
  p_actor uuid,
  p_subject_type text,
  p_subject_id uuid,
  p_classification jsonb,
  p_attempt_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_campaign_id uuid;
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
  perform app_private.require_actor_role(v_workspace_id, p_actor, 'admin');
  return app_private.record_classification(
    v_workspace_id, v_campaign_id, p_subject_type, p_subject_id, 'model', p_classification, p_actor, p_attempt_id);
end;
$$;
