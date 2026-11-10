-- Legiit Recommends — queue helpers, budget checks, slot planning and dispatch.
--
-- Durable execution model:
--   * pg_cron runs plan_all() every minute and dispatch() every few seconds.
--   * plan_all() materializes deterministic slots as `jobs` rows and advances campaign phases.
--   * dispatch() turns due jobs into queue messages (pgmq) and wakes Edge Function workers
--     through pg_net. A worker processes exactly one unit (one turn, one check or one poll).
--   * All state lives in Postgres. A lost worker only delays work: the queue message becomes
--     visible again after its visibility timeout and the job resumes from persisted state.

create or replace function app_private.queue_name()
returns text language sql immutable set search_path = '' as $$ select 'lr_work' $$;

create or replace function app_private.beat(
  p_name text,
  p_started timestamptz,
  p_error text default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into app_private.heartbeats as h (name, last_started_at, last_ok_at, last_error_at, last_error, last_duration_ms, runs, details)
  values (
    p_name, p_started,
    case when p_error is null then clock_timestamp() end,
    case when p_error is not null then clock_timestamp() end,
    p_error,
    (extract(epoch from clock_timestamp() - p_started) * 1000)::integer,
    1, coalesce(p_details, '{}'::jsonb)
  )
  on conflict (name) do update
    set last_started_at = excluded.last_started_at,
        last_ok_at = coalesce(excluded.last_ok_at, h.last_ok_at),
        last_error_at = coalesce(excluded.last_error_at, h.last_error_at),
        last_error = case when excluded.last_error is not null then excluded.last_error else h.last_error end,
        last_duration_ms = excluded.last_duration_ms,
        runs = h.runs + 1,
        details = excluded.details;
$$;

-- ---------------------------------------------------------------------------------------------
-- Queue helpers. Invariant: a job in (queued, running, waiting) owns exactly one queue message.
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.enqueue_job(p_job_id uuid, p_delay_seconds integer default 0)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg_id bigint;
begin
  select s into v_msg_id
  from pgmq.send(app_private.queue_name(), jsonb_build_object('job_id', p_job_id), greatest(p_delay_seconds, 0)) as s;

  update public.jobs
  set status = case when p_delay_seconds > 0 then 'waiting'::public.job_status else 'queued'::public.job_status end,
      queue_msg_id = v_msg_id,
      next_attempt_at = case when p_delay_seconds > 0 then now() + make_interval(secs => p_delay_seconds) end,
      blocked_until = null,
      lease_token = null,
      lease_expires_at = null,
      leased_by = null
  where id = p_job_id;
end;
$$;

create or replace function app_private.drop_job_message(p_job public.jobs)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job.queue_msg_id is not null then
    perform pgmq.delete(app_private.queue_name(), p_job.queue_msg_id);
  end if;
end;
$$;

-- Hide the job's message for p_seconds and release the lease.
create or replace function app_private.defer_job(p_job public.jobs, p_seconds integer, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job.queue_msg_id is not null then
    perform pgmq.set_vt(app_private.queue_name(), p_job.queue_msg_id, greatest(p_seconds, 0));
  end if;
  update public.jobs
  set status = case when p_seconds > 0 then 'waiting'::public.job_status else 'queued'::public.job_status end,
      status_reason = p_reason,
      next_attempt_at = case when p_seconds > 0 then clock_timestamp() + make_interval(secs => p_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      leased_by = null
  where id = p_job.id;
end;
$$;

-- Terminal states -------------------------------------------------------------------------------

create or replace function app_private.finish_job(p_job public.jobs, p_status public.job_status, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.drop_job_message(p_job);
  update public.jobs
  set status = p_status,
      status_reason = p_reason,
      queue_msg_id = null,
      next_attempt_at = null,
      blocked_until = null,
      lease_token = null,
      lease_expires_at = null,
      leased_by = null,
      finished_at = clock_timestamp()
  where id = p_job.id;
end;
$$;

-- Cancels a job and whatever it had not finished.
create or replace function app_private.cancel_job(p_job public.jobs, p_reason text, p_run_status public.run_status default 'canceled')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.finish_job(p_job, 'canceled', p_reason);
  if p_job.run_id is not null then
    update public.run_turns
    set status = 'canceled'
    where run_id = p_job.run_id and status in ('pending', 'failed');
    update public.runs
    set status = p_run_status, completed_at = clock_timestamp(), error_class = p_reason
    where id = p_job.run_id and status in ('pending', 'in_progress', 'failed');
  end if;
  if p_job.fresh_check_id is not null then
    update public.fresh_checks
    set status = 'canceled', exclusion_reason = p_reason, completed_at = clock_timestamp()
    where id = p_job.fresh_check_id and status in ('pending', 'failed');
  end if;
end;
$$;

-- Moves a job to the dead-letter/review queue. The queue message is archived, not deleted.
create or replace function app_private.dead_letter(p_job public.jobs, p_class text, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_job.queue_msg_id is not null then
    perform pgmq.archive(app_private.queue_name(), p_job.queue_msg_id);
  end if;
  update public.jobs
  set status = 'dead',
      status_reason = p_class,
      last_error_class = p_class,
      last_error_message = left(p_message, 1000),
      queue_msg_id = null,
      next_attempt_at = null,
      lease_token = null,
      lease_expires_at = null,
      leased_by = null,
      finished_at = clock_timestamp()
  where id = p_job.id;

  if p_job.run_id is not null then
    update public.runs
    set status = case when p_class = 'chain_expired' then 'expired'::public.run_status else 'failed'::public.run_status end,
        error_class = p_class,
        error_message = left(p_message, 1000)
    where id = p_job.run_id and status in ('pending', 'in_progress', 'failed');
  end if;
  if p_job.fresh_check_id is not null then
    update public.fresh_checks
    set status = 'failed', exclusion_reason = p_class
    where id = p_job.fresh_check_id and status in ('pending', 'in_flight', 'failed', 'uncertain');
  end if;

  perform app_private.audit(p_job.workspace_id, 'job.dead_lettered', 'job', p_job.id,
    jsonb_build_object('class', p_class, 'message', left(p_message, 300), 'kind', p_job.kind,
      'campaign_id', p_job.campaign_id),
    'worker');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Budget
-- ---------------------------------------------------------------------------------------------

-- Returns NULL when `p_amount` fits under every applicable cap, otherwise
-- {code, until} where `until` is when the cap resets (NULL = needs a human).
-- Callers must hold the connection row lock (and the campaign row lock when p_campaign_id is
-- set) so that concurrent reservations are serialized.
create or replace function app_private.budget_block(
  p_connection public.provider_connections,
  p_campaign_id uuid,
  p_amount numeric,
  p_is_final_check boolean,
  p_now timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_conn_day date := (p_now at time zone 'UTC')::date;
  v_used numeric;
  v_rev public.campaign_revisions%rowtype;
  v_campaign_day date;
  v_total_cap numeric;
begin
  if p_amount is null then
    return jsonb_build_object('code', 'price_missing', 'until', null);
  end if;

  -- Connection: daily (UTC day) --------------------------------------------------------------
  if p_connection.daily_budget_usd is null then
    return jsonb_build_object('code', 'connection_daily_cap_missing', 'until', null);
  end if;
  select coalesce((select sum(l.cost_usd) from public.usage_ledger l
                   where l.connection_id = p_connection.id and l.connection_day = v_conn_day), 0)
       + coalesce((select sum(r.amount_usd) from public.budget_reservations r
                   where r.connection_id = p_connection.id and r.connection_day = v_conn_day
                     and r.status in ('held', 'unresolved')), 0)
  into v_used;
  if v_used + p_amount > p_connection.daily_budget_usd then
    return jsonb_build_object('code', 'connection_daily_budget_exhausted',
      'until', ((v_conn_day + 1)::timestamp at time zone 'UTC'));
  end if;

  -- Connection: total --------------------------------------------------------------------------
  if p_connection.total_budget_usd is not null then
    select coalesce((select sum(l.cost_usd) from public.usage_ledger l where l.connection_id = p_connection.id), 0)
         + coalesce((select sum(r.amount_usd) from public.budget_reservations r
                     where r.connection_id = p_connection.id and r.status in ('held', 'unresolved')), 0)
    into v_used;
    if v_used + p_amount > p_connection.total_budget_usd then
      return jsonb_build_object('code', 'connection_total_budget_exhausted', 'until', null);
    end if;
  end if;

  if p_campaign_id is null then
    return null;
  end if;

  -- Campaign caps come from the configuration in force (active revision, or the draft for a
  -- campaign that has not launched yet).
  select r.* into v_rev
  from public.campaigns c
  join public.campaign_revisions r on r.id = coalesce(c.active_revision_id, c.draft_revision_id)
  where c.id = p_campaign_id;
  if not found then
    return null;
  end if;

  if v_rev.daily_budget_usd is not null then
    v_campaign_day := (p_now at time zone coalesce(v_rev.timezone, 'UTC'))::date;
    select coalesce((select sum(l.cost_usd) from public.usage_ledger l
                     where l.campaign_id = p_campaign_id and l.campaign_day = v_campaign_day), 0)
         + coalesce((select sum(r.amount_usd) from public.budget_reservations r
                     where r.campaign_id = p_campaign_id and r.campaign_day = v_campaign_day
                       and r.status in ('held', 'unresolved')), 0)
    into v_used;
    if v_used + p_amount > v_rev.daily_budget_usd then
      return jsonb_build_object('code', 'campaign_daily_budget_exhausted',
        'until', ((v_campaign_day + 1)::timestamp at time zone coalesce(v_rev.timezone, 'UTC')));
    end if;
  end if;

  if v_rev.total_budget_usd is not null then
    select coalesce((select sum(l.cost_usd) from public.usage_ledger l where l.campaign_id = p_campaign_id), 0)
         + coalesce((select sum(r.amount_usd) from public.budget_reservations r
                     where r.campaign_id = p_campaign_id and r.status in ('held', 'unresolved')), 0)
    into v_used;
    -- Money set aside for the final fresh checks is not available to anything else.
    v_total_cap := v_rev.total_budget_usd
      - case when p_is_final_check then 0 else coalesce(v_rev.final_check_set_aside_usd, 0) end;
    if v_used + p_amount > v_total_cap then
      return jsonb_build_object('code', 'campaign_total_budget_exhausted', 'until', null);
    end if;
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Slots
-- ---------------------------------------------------------------------------------------------

-- Deterministic slots for one local calendar day: `p_count` slots spread evenly across the
-- active window, each shifted by a bounded, seed-derived jitter that keeps it inside its own
-- interval. The same inputs always produce the same slots.
create or replace function app_private.day_slots(
  p_rev public.campaign_revisions,
  p_day date,
  p_count integer,
  p_offset numeric,
  p_salt text
)
returns table (slot_index integer, slot_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_span numeric;
  v_spacing numeric;
  v_jitter_max integer;
  v_jitter integer;
begin
  if p_count is null or p_count <= 0 or p_rev.active_weekdays is null or p_rev.timezone is null then
    return;
  end if;
  if not (extract(isodow from p_day)::smallint = any (p_rev.active_weekdays)) then
    return;
  end if;
  v_start := (p_day::timestamp + make_interval(mins => p_rev.active_start_minute)) at time zone p_rev.timezone;
  v_end := (p_day::timestamp + make_interval(mins => p_rev.active_end_minute)) at time zone p_rev.timezone;
  v_span := extract(epoch from (v_end - v_start));
  if v_span <= 0 then
    return;
  end if;
  v_spacing := v_span / p_count;
  v_jitter_max := greatest(least(p_rev.jitter_seconds, floor(v_spacing * (1 - p_offset))::integer - 1), 0);

  for i in 0 .. p_count - 1 loop
    v_jitter := case
      when v_jitter_max > 0 then (
        (hashtextextended(concat_ws(':', p_rev.selection_seed, p_salt, p_day::text, i::text), 0) & 9223372036854775807)
        % (v_jitter_max + 1)
      )::integer
      else 0
    end;
    slot_index := i;
    slot_at := v_start + make_interval(secs => (floor((i + p_offset) * v_spacing) + v_jitter)::double precision);
    return next;
  end loop;
end;
$$;

create or replace function app_private.create_check_jobs(
  p_campaign_id uuid,
  p_revision_id uuid,
  p_kind public.job_kind,
  p_count integer,
  p_now timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rev public.campaign_revisions%rowtype;
  v_inserted integer := 0;
begin
  select * into v_rev from public.campaign_revisions r where r.id = p_revision_id;
  if coalesce(p_count, 0) <= 0 or v_rev.comparison_group_id is null then
    return 0;
  end if;
  insert into public.jobs (workspace_id, campaign_id, revision_id, connection_id, kind, slot_date, slot_index, scheduled_for)
  select v_rev.workspace_id, p_campaign_id, p_revision_id, v_rev.connection_id, p_kind,
         (p_now at time zone v_rev.timezone)::date, g.i, p_now
  from generate_series(0, p_count - 1) as g(i)
  on conflict (revision_id, kind, slot_date, slot_index) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- Jobs that still have work to do.
create or replace function app_private.unresolved_job_count(p_campaign_id uuid, p_kinds public.job_kind[])
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.jobs j
  where j.campaign_id = p_campaign_id
    and j.kind = any (p_kinds)
    and j.status in ('pending', 'queued', 'running', 'waiting', 'paused', 'blocked');
$$;

-- Explicitly closes work that cannot finish before the campaign completes, so that final checks
-- never start silently on top of unresolved conversations.
create or replace function app_private.close_unresolved_jobs(
  p_campaign_id uuid,
  p_kinds public.job_kind[],
  p_include_active boolean,
  p_now timestamptz
)
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
      and j.kind = any (p_kinds)
      and (
        j.status in ('pending', 'paused', 'blocked')
        or (p_include_active and j.status in ('queued', 'waiting', 'running'))
      )
    for update
  loop
    update public.provider_attempts
    set status = 'uncertain', error_class = 'unresolved_at_campaign_end', finished_at = p_now
    where job_id = v_job.id and status in ('started', 'in_flight');
    update public.budget_reservations r
    set status = 'unresolved'
    from public.provider_attempts a
    where a.job_id = v_job.id and a.error_class = 'unresolved_at_campaign_end'
      and r.id = a.reservation_id and r.status = 'held';

    update public.run_turns set status = 'uncertain' where run_id = v_job.run_id and status = 'in_flight';
    update public.fresh_checks set status = 'uncertain' where id = v_job.fresh_check_id and status = 'in_flight';
    perform app_private.cancel_job(v_job, 'unresolved_at_campaign_end', 'unresolved');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Planner: campaign phase machine + slot materialization
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.plan_campaign(p_campaign_id uuid, p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  v_rev public.campaign_revisions%rowtype;
  v_horizon interval := make_interval(mins => app_private.setting_int('planning_horizon_minutes'));
  v_finalize_wait interval := make_interval(mins => app_private.setting_int('finalize_wait_minutes'));
  v_from timestamptz;
  v_to timestamptz;
  v_day date;
  v_slot record;
  v_count integer;
  v_inserted integer;
  v_guard integer := 0;
  v_conversation_kinds constant public.job_kind[] := array['conversation', 'check_daily', 'check_baseline']::public.job_kind[];
begin
  select * into c from public.campaigns cp where cp.id = p_campaign_id for update;
  if not found or c.status not in ('scheduled', 'baseline', 'running', 'finalizing') then
    return;
  end if;
  select * into v_rev from public.campaign_revisions r where r.id = c.active_revision_id;

  loop
    v_guard := v_guard + 1;
    exit when v_guard > 6;

    if c.status = 'scheduled' then
      exit when p_now < v_rev.start_at;
      c.started_at := p_now;
      if v_rev.baseline_samples > 0 and v_rev.comparison_group_id is not null then
        c.status := 'baseline';
        perform app_private.create_check_jobs(c.id, v_rev.id, 'check_baseline', v_rev.baseline_samples, p_now);
        perform app_private.audit(c.workspace_id, 'campaign.baseline_started', 'campaign', c.id,
          jsonb_build_object('samples', v_rev.baseline_samples), 'system');
      else
        c.status := 'running';
        c.baseline_completed_at := p_now;
        -- No baseline: every slot from the configured start time is eligible.
        c.planned_through := least(v_rev.start_at, p_now) - interval '1 microsecond';
        perform app_private.audit(c.workspace_id, 'campaign.started', 'campaign', c.id, '{}'::jsonb, 'system');
      end if;

    elsif c.status = 'baseline' then
      if app_private.unresolved_job_count(c.id, array['check_baseline']::public.job_kind[]) = 0 then
        c.status := 'running';
        c.baseline_completed_at := p_now;
        -- Conversations begin only after the baseline: earlier slots are not scheduled.
        c.planned_through := p_now;
        perform app_private.audit(c.workspace_id, 'campaign.baseline_completed', 'campaign', c.id, '{}'::jsonb, 'system');
      elsif p_now >= v_rev.end_at then
        c.status := 'finalizing';
        c.conversations_ended_at := p_now;
      else
        exit;
      end if;

    elsif c.status = 'running' then
      select count(*) into v_count
      from public.jobs j
      where j.campaign_id = c.id and j.kind = 'conversation' and j.status not in ('skipped', 'canceled');

      if p_now >= v_rev.end_at then
        c.status := 'finalizing';
        c.conversations_ended_at := p_now;
        perform app_private.audit(c.workspace_id, 'campaign.conversations_ended', 'campaign', c.id,
          jsonb_build_object('reason', 'end_time'), 'system');
      elsif v_rev.total_conversation_limit is not null
            and v_count >= v_rev.total_conversation_limit
            and app_private.unresolved_job_count(c.id, array['conversation']::public.job_kind[]) = 0 then
        c.status := 'finalizing';
        c.conversations_ended_at := p_now;
        perform app_private.audit(c.workspace_id, 'campaign.conversations_ended', 'campaign', c.id,
          jsonb_build_object('reason', 'total_limit'), 'system');
      else
        v_from := coalesce(c.planned_through, p_now);
        v_to := least(p_now + v_horizon, v_rev.end_at);
        if v_to > v_from then
          for v_day in
            select d::date
            from generate_series(
              (v_from at time zone v_rev.timezone)::date,
              (v_to at time zone v_rev.timezone)::date,
              interval '1 day'
            ) as d
          loop
            for v_slot in
              select s.slot_index, s.slot_at
              from app_private.day_slots(v_rev, v_day, v_rev.conversations_per_day, 0, 'conversation') s
              where s.slot_at > v_from and s.slot_at <= v_to
                and s.slot_at >= v_rev.start_at and s.slot_at < v_rev.end_at
              order by s.slot_at
            loop
              exit when v_rev.total_conversation_limit is not null and v_count >= v_rev.total_conversation_limit;
              insert into public.jobs (workspace_id, campaign_id, revision_id, connection_id, kind, slot_date, slot_index, scheduled_for)
              values (c.workspace_id, c.id, v_rev.id, v_rev.connection_id, 'conversation', v_day, v_slot.slot_index, v_slot.slot_at)
              on conflict (revision_id, kind, slot_date, slot_index) do nothing;
              get diagnostics v_inserted = row_count;
              v_count := v_count + v_inserted;
            end loop;

            if v_rev.comparison_group_id is not null and v_rev.daily_checks > 0 then
              insert into public.jobs (workspace_id, campaign_id, revision_id, connection_id, kind, slot_date, slot_index, scheduled_for)
              select c.workspace_id, c.id, v_rev.id, v_rev.connection_id, 'check_daily', v_day, s.slot_index, s.slot_at
              from app_private.day_slots(v_rev, v_day, v_rev.daily_checks, 0.5, 'check_daily') s
              where s.slot_at > v_from and s.slot_at <= v_to
                and s.slot_at >= v_rev.start_at and s.slot_at < v_rev.end_at
              on conflict (revision_id, kind, slot_date, slot_index) do nothing;
            end if;
          end loop;
          c.planned_through := v_to;
        end if;
        exit;
      end if;

    elsif c.status = 'finalizing' then
      -- 1. Final checks wait for conversation work to resolve.
      if c.final_checks_started_at is null then
        if app_private.unresolved_job_count(c.id, v_conversation_kinds) > 0 then
          if p_now >= c.conversations_ended_at + v_finalize_wait then
            -- Record what could not finish as unresolved instead of waiting forever.
            perform app_private.close_unresolved_jobs(
              c.id, v_conversation_kinds, p_now >= c.conversations_ended_at + 2 * v_finalize_wait, p_now
            );
          end if;
          exit when app_private.unresolved_job_count(c.id, v_conversation_kinds) > 0;
        end if;
        if v_rev.final_samples > 0 and v_rev.comparison_group_id is not null then
          perform app_private.create_check_jobs(c.id, v_rev.id, 'check_final', v_rev.final_samples, p_now);
        end if;
        c.final_checks_started_at := p_now;
        perform app_private.audit(c.workspace_id, 'campaign.final_checks_started', 'campaign', c.id,
          jsonb_build_object('samples', v_rev.final_samples), 'system');
      end if;

      -- 2. Complete once the final checks have resolved.
      if app_private.unresolved_job_count(c.id, array['check_final']::public.job_kind[]) > 0 then
        if p_now >= c.final_checks_started_at + v_finalize_wait then
          perform app_private.close_unresolved_jobs(
            c.id, array['check_final']::public.job_kind[],
            p_now >= c.final_checks_started_at + 2 * v_finalize_wait, p_now
          );
        end if;
        exit when app_private.unresolved_job_count(c.id, array['check_final']::public.job_kind[]) > 0;
      end if;
      c.status := 'completed';
      c.completed_at := p_now;
      perform app_private.audit(c.workspace_id, 'campaign.completed', 'campaign', c.id, '{}'::jsonb, 'system');
      exit;

    else
      exit;
    end if;
  end loop;

  update public.campaigns
  set status = c.status,
      started_at = c.started_at,
      baseline_completed_at = c.baseline_completed_at,
      planned_through = c.planned_through,
      conversations_ended_at = c.conversations_ended_at,
      final_checks_started_at = c.final_checks_started_at,
      completed_at = c.completed_at
  where id = c.id;
end;
$$;

-- Re-sends queue messages for jobs that should have one but do not (defensive outbox recovery).
create or replace function app_private.recover_stalled(p_now timestamptz default now())
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
    where j.status in ('queued', 'waiting', 'running')
      and (j.status <> 'running' or j.lease_expires_at < p_now - interval '60 seconds')
      and j.updated_at < p_now - interval '60 seconds'
      and not exists (select 1 from pgmq.q_lr_work q where q.msg_id = j.queue_msg_id)
    for update skip locked
  loop
    perform app_private.enqueue_job(v_job.id);
    update public.jobs set status_reason = 'requeued_after_lost_message' where id = v_job.id;
    v_count := v_count + 1;
  end loop;

  -- Ad-hoc requests (model verification, generation, classification) have no job to recover
  -- them. One left without an outcome means the function running it stopped: its cost is unknown.
  perform app_private.mark_attempt_uncertain(a.id, 'operation_interrupted',
    'The operation stopped before recording the outcome of this request.')
  from public.provider_attempts a
  where a.job_id is null and a.status = 'started' and a.started_at < p_now - interval '15 minutes';

  return v_count;
end;
$$;

create or replace function app_private.plan_all(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_id uuid;
  v_campaigns integer := 0;
  v_recovered integer;
begin
  for v_id in
    select c.id from public.campaigns c
    where c.status in ('scheduled', 'baseline', 'running', 'finalizing')
    order by c.id
    for update skip locked
  loop
    perform app_private.plan_campaign(v_id, p_now);
    v_campaigns := v_campaigns + 1;
  end loop;

  v_recovered := app_private.recover_stalled(p_now);

  update public.workspace_invitations
  set status = 'expired'
  where status = 'pending' and expires_at <= p_now;

  perform app_private.beat('plan', v_started, null,
    jsonb_build_object('campaigns', v_campaigns, 'recovered', v_recovered));
  return jsonb_build_object('campaigns', v_campaigns, 'recovered', v_recovered);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Dispatcher
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.target_snapshot(p_rev public.campaign_revisions)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'business_name', p_rev.business_name,
    'website_url', p_rev.website_url,
    'business_aliases', to_jsonb(coalesce(p_rev.business_aliases, '{}'::text[])),
    'domain_aliases', to_jsonb(coalesce(p_rev.domain_aliases, '{}'::text[]))
  );
$$;

-- Creates the run for a conversation job with a full snapshot of its settings.
create or replace function app_private.create_run(
  p_job public.jobs,
  p_rev public.campaign_revisions,
  p_kind text,
  p_restart_of uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_ordinal integer;
begin
  select coalesce(max(r.ordinal) + 1, 0) into v_ordinal
  from public.runs r where r.revision_id = p_rev.id and r.kind = p_kind;

  insert into public.runs (
    workspace_id, campaign_id, revision_id, job_id, connection_id, kind, ordinal, status,
    model, model_params, max_output_tokens, execution_mode, price_id, cohort_key, target,
    on_existing_inclusion, selection_mode, selection_seed, restart_of_run_id, scheduled_for
  )
  values (
    p_job.workspace_id, p_job.campaign_id, p_rev.id, p_job.id, p_rev.connection_id, p_kind, v_ordinal, 'pending',
    p_rev.model, p_rev.model_params, p_rev.max_output_tokens, p_rev.execution_mode,
    coalesce(p_rev.price_id, (app_private.current_price(p_rev.workspace_id, p_rev.model)).id),
    coalesce(p_rev.cohort_key, md5(concat_ws('|', p_rev.model, p_rev.model_params::text, p_rev.max_output_tokens::text))),
    app_private.target_snapshot(p_rev),
    coalesce(p_rev.on_existing_inclusion, 'continue'), p_rev.selection_mode, p_rev.selection_seed,
    p_restart_of, p_job.scheduled_for
  )
  returning id into v_run_id;

  update public.jobs set run_id = v_run_id where id = p_job.id;
  return v_run_id;
end;
$$;

-- Creates the fresh-check record for a check job and allocates its question. Questions rotate
-- in a seeded order so every question in the set receives the same number of samples.
create or replace function app_private.create_fresh_check(
  p_job public.jobs,
  p_rev public.campaign_revisions,
  p_now timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group public.comparison_groups%rowtype;
  v_conn public.provider_connections%rowtype;
  v_phase public.check_phase;
  v_question public.probe_questions%rowtype;
  v_total integer;
  v_n integer;
  v_id uuid;
begin
  select * into v_group from public.comparison_groups g where g.id = p_rev.comparison_group_id;
  select * into v_conn from public.provider_connections c where c.id = p_rev.connection_id;
  v_phase := case p_job.kind
    when 'check_baseline' then 'baseline'
    when 'check_daily' then 'daily'
    else 'final'
  end::public.check_phase;

  select count(*) into v_total from public.probe_questions q where q.probe_set_version_id = v_group.probe_set_version_id;
  select count(*) into v_n from public.fresh_checks f where f.comparison_group_id = v_group.id and f.phase = v_phase;

  select q.* into v_question
  from public.probe_questions q
  where q.probe_set_version_id = v_group.probe_set_version_id
  order by md5(v_group.selection_seed || ':' || q.id::text), q.id
  offset (v_n % v_total)
  limit 1;

  insert into public.fresh_checks (
    workspace_id, campaign_id, revision_id, comparison_group_id, job_id, connection_id, phase,
    probe_question_id, question_position, is_held_out, local_day,
    model, params, max_output_tokens, execution_mode, store_response, price_id, scheduled_for
  )
  values (
    p_job.workspace_id, p_job.campaign_id, p_rev.id, v_group.id, p_job.id, p_rev.connection_id, v_phase,
    v_question.id, v_question.position, v_question.is_held_out, (p_now at time zone p_rev.timezone)::date,
    v_group.model, v_group.params, v_group.max_output_tokens, p_rev.execution_mode,
    v_conn.store_fresh_check_responses, p_rev.check_price_id, p_job.scheduled_for
  )
  returning id into v_id;

  update public.jobs set fresh_check_id = v_id where id = p_job.id;
  return v_id;
end;
$$;

create or replace function app_private.dispatch_campaign(p_campaign_id uuid, p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  v_rev public.campaign_revisions%rowtype;
  v_job_rev public.campaign_revisions%rowtype;
  v_ws public.workspaces%rowtype;
  v_conn public.provider_connections%rowtype;
  v_job public.jobs%rowtype;
  v_grace interval := make_interval(mins => app_private.setting_int('missed_slot_grace_minutes'));
  v_today date;
  v_catch_ups integer;
  v_capacity integer;
  v_committed numeric;
  v_block jsonb;
  v_started integer := 0;
begin
  select * into c from public.campaigns cp where cp.id = p_campaign_id for update;
  if not found or c.status not in ('baseline', 'running', 'finalizing') then
    return 0;
  end if;
  select * into v_rev from public.campaign_revisions r where r.id = c.active_revision_id;
  select * into v_ws from public.workspaces w where w.id = c.workspace_id;
  v_today := (p_now at time zone v_rev.timezone)::date;

  -- (a) Missed slots: skip, or allow a bounded catch-up, exactly as the campaign specifies.
  select count(*) into v_catch_ups
  from public.jobs j
  where j.campaign_id = c.id and j.is_catch_up
    and (coalesce(j.dispatched_at, p_now) at time zone v_rev.timezone)::date = v_today;

  for v_job in
    select j.* from public.jobs j
    where j.campaign_id = c.id and j.status = 'pending'
      and j.kind in ('conversation', 'check_daily')
      and j.scheduled_for < p_now - v_grace
    order by j.scheduled_for
    for update
  loop
    select * into v_job_rev from public.campaign_revisions r where r.id = v_job.revision_id;
    if v_job_rev.missed_slot_behavior = 'catch_up'
       and p_now - v_job.scheduled_for <= make_interval(mins => v_job_rev.catch_up_max_delay_minutes) then
      if v_job.is_catch_up then
        continue;
      elsif v_catch_ups < v_job_rev.catch_up_max_per_day then
        update public.jobs set is_catch_up = true where id = v_job.id;
        v_catch_ups := v_catch_ups + 1;
        continue;
      end if;
    end if;
    update public.jobs
    set status = 'skipped', status_reason = 'missed_slot', finished_at = p_now
    where id = v_job.id;
  end loop;

  -- (b) Nothing new is dispatched while stopped or while the connection is failing.
  select * into v_conn from public.provider_connections pc where pc.id = v_rev.connection_id for update;
  if v_ws.emergency_stop or v_conn.status <> 'ok' then
    return 0;
  end if;

  -- (c) Conversations, bounded by the campaign's concurrency.
  if c.status in ('running', 'finalizing') then
    select v_rev.max_concurrency - count(*) into v_capacity
    from public.jobs j
    where j.campaign_id = c.id and j.kind = 'conversation' and j.status in ('queued', 'running', 'waiting');

    -- Worst-case cost still owed to conversations already under way.
    select coalesce(sum(r.est_run_max_cost_usd), 0) into v_committed
    from public.jobs j
    join public.campaign_revisions r on r.id = j.revision_id
    where j.campaign_id = c.id and j.kind = 'conversation'
      and j.status in ('queued', 'running', 'waiting', 'paused', 'blocked');

    for v_job in
      select j.* from public.jobs j
      where j.campaign_id = c.id and j.status = 'pending' and j.kind = 'conversation'
        and j.scheduled_for <= p_now
      order by j.scheduled_for, j.slot_index
      limit greatest(v_capacity, 0)
      for update
    loop
      select * into v_job_rev from public.campaign_revisions r where r.id = v_job.revision_id;

      -- A conversation that cannot fit the budget even on its own is skipped, visibly.
      v_block := app_private.budget_block(v_conn, c.id, v_job_rev.est_run_max_cost_usd, false, p_now);
      if v_block is not null then
        update public.jobs
        set status = 'skipped', status_reason = v_block ->> 'code', finished_at = p_now
        where id = v_job.id;
        continue;
      end if;
      -- Do not start more conversations than the budget can carry to completion.
      exit when app_private.budget_block(
        v_conn, c.id, v_job_rev.est_run_max_cost_usd + v_committed, false, p_now
      ) is not null;

      perform app_private.create_run(v_job, v_job_rev, 'scheduled');
      perform app_private.enqueue_job(v_job.id);
      update public.jobs set dispatched_at = p_now where id = v_job.id;
      v_committed := v_committed + coalesce(v_job_rev.est_run_max_cost_usd, 0);
      v_started := v_started + 1;
    end loop;
  end if;

  -- (d) Fresh checks. Each is a single request; the connection gate bounds real concurrency.
  select greatest(v_conn.max_concurrent_requests * 2 - count(*), 0) into v_capacity
  from public.jobs j
  where j.campaign_id = c.id
    and j.kind in ('check_baseline', 'check_daily', 'check_final')
    and j.status in ('queued', 'running', 'waiting');

  for v_job in
    select j.* from public.jobs j
    where j.campaign_id = c.id and j.status = 'pending'
      and j.kind in ('check_baseline', 'check_daily', 'check_final')
      and j.scheduled_for <= p_now
    order by j.scheduled_for, j.slot_index
    limit v_capacity
    for update
  loop
    select * into v_job_rev from public.campaign_revisions r where r.id = v_job.revision_id;
    if v_job.kind = 'check_daily' then
      v_block := app_private.budget_block(v_conn, c.id, v_job_rev.est_check_max_cost_usd, false, p_now);
      if v_block is not null then
        update public.jobs
        set status = 'skipped', status_reason = v_block ->> 'code', finished_at = p_now
        where id = v_job.id;
        continue;
      end if;
    end if;
    perform app_private.create_fresh_check(v_job, v_job_rev, p_now);
    perform app_private.enqueue_job(v_job.id);
    update public.jobs set dispatched_at = p_now where id = v_job.id;
    v_started := v_started + 1;
  end loop;

  return v_started;
end;
$$;

-- Wakes queue consumers. Each HTTP call starts one Edge Function invocation that processes one
-- unit of work. Returns the number of wake-ups requested.
create or replace function app_private.wake_workers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_visible integer;
  v_running integer;
  v_wakes integer;
begin
  select count(*) into v_visible from pgmq.q_lr_work q where q.vt <= clock_timestamp();
  if v_visible = 0 then
    return 0;
  end if;

  select d.decrypted_secret into v_url from vault.decrypted_secrets d where d.name = 'lr_functions_base_url';
  select d.decrypted_secret into v_secret from vault.decrypted_secrets d where d.name = 'lr_worker_secret';
  if v_url is null or v_secret is null then
    -- Queue consumers have not been activated yet (see README: "Queue activation").
    return -1;
  end if;

  select count(*) into v_running
  from public.jobs j where j.status = 'running' and j.lease_expires_at > clock_timestamp();

  v_wakes := least(v_visible, greatest(app_private.setting_int('max_wakes_per_tick') - v_running, 0));
  for i in 1 .. v_wakes loop
    perform net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/worker',
      body := jsonb_build_object('source', 'dispatch'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
      timeout_milliseconds := 10000
    );
  end loop;
  return v_wakes;
end;
$$;

create or replace function app_private.dispatch(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_job public.jobs%rowtype;
  v_id uuid;
  v_dispatched integer := 0;
  v_released integer := 0;
  v_wakes integer;
begin
  -- Jobs that were blocked on budget or on the connection and may proceed again.
  for v_job in
    select j.* from public.jobs j
    join public.campaigns c on c.id = j.campaign_id
    join public.workspaces w on w.id = j.workspace_id
    join public.provider_connections pc on pc.id = j.connection_id
    where j.status = 'blocked'
      and j.blocked_until is not null and j.blocked_until <= p_now
      and (j.kind = 'test_conversation' or c.status in ('baseline', 'running', 'finalizing'))
      and not w.emergency_stop
      and pc.status = 'ok'
    for update of j skip locked
  loop
    perform app_private.enqueue_job(v_job.id);
    update public.jobs set status_reason = null where id = v_job.id;
    v_released := v_released + 1;
  end loop;

  for v_id in
    select c.id from public.campaigns c
    where c.status in ('baseline', 'running', 'finalizing')
      and exists (
        select 1 from public.jobs j
        where j.campaign_id = c.id and j.status = 'pending' and j.scheduled_for <= p_now
      )
    order by c.id
    for update of c skip locked
  loop
    v_dispatched := v_dispatched + app_private.dispatch_campaign(v_id, p_now);
  end loop;

  v_wakes := app_private.wake_workers();
  perform app_private.beat('dispatch', v_started,
    case when v_wakes = -1 then 'queue_consumers_not_activated' end,
    jsonb_build_object('dispatched', v_dispatched, 'released', v_released, 'wakes', v_wakes));
  return jsonb_build_object('dispatched', v_dispatched, 'released', v_released, 'wakes', v_wakes);
end;
$$;

-- Cron entry points: never raise, always leave a heartbeat.
create or replace function app_private.cron_plan()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
begin
  perform app_private.plan_all(now());
exception when others then
  perform app_private.beat('plan', v_started, left(sqlerrm, 500));
end;
$$;

create or replace function app_private.cron_dispatch()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
begin
  perform app_private.dispatch(now());
exception when others then
  perform app_private.beat('dispatch', v_started, left(sqlerrm, 500));
end;
$$;

-- Service entry point: one scheduler pass. Used by workers to hand off the next unit quickly,
-- by operators for recovery, and by tests (p_now lets tests control time).
create or replace function public.svc_tick(p_now timestamptz default null, p_plan boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_plan jsonb := null;
begin
  if p_plan then
    v_plan := app_private.plan_all(v_now);
  end if;
  return jsonb_build_object('plan', v_plan, 'dispatch', app_private.dispatch(v_now));
end;
$$;

-- Stores where queue consumers live and the shared secret they expect. Service role only.
create or replace function public.svc_configure_worker(p_functions_base_url text, p_worker_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if coalesce(p_functions_base_url, '') !~* '^https?://' then
    perform app_private.fail('invalid_url', 'The functions base URL must start with http:// or https://.');
  end if;
  if char_length(coalesce(p_worker_secret, '')) < 24 then
    perform app_private.fail('weak_secret', 'The worker secret must be at least 24 characters long.');
  end if;

  select s.id into v_id from vault.secrets s where s.name = 'lr_functions_base_url';
  if v_id is null then
    perform vault.create_secret(p_functions_base_url, 'lr_functions_base_url', 'Legiit Recommends Edge Functions base URL');
  else
    perform vault.update_secret(v_id, p_functions_base_url);
  end if;

  select s.id into v_id from vault.secrets s where s.name = 'lr_worker_secret';
  if v_id is null then
    perform vault.create_secret(p_worker_secret, 'lr_worker_secret', 'Legiit Recommends queue consumer shared secret');
  else
    perform vault.update_secret(v_id, p_worker_secret);
  end if;
end;
$$;
