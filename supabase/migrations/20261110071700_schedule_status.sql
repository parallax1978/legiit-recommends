-- Legiit Recommends — let a deployment see whether the schedules are there and running.
--
-- The wake-up check proves that the database can reach the worker. It says nothing about the
-- three pg_cron schedules that plan and send work in the first place: one that was paused in
-- the dashboard stays paused through every deployment (pg_cron keeps a job's "active" flag when
-- the job is scheduled again), and a deployment would still end with "Backend deployed".
--
-- This reports, for the operator scripts only: whether each schedule exists and is active, and
-- when the planner last ran. Nothing here changes a schedule. A paused schedule is reported,
-- never switched back on: resuming it can start paid work, so that stays a person's decision.

create or replace function public.svc_schedule_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'jobs', (
      select jsonb_agg(jsonb_build_object(
        'name', e.name,
        'present', j.jobid is not null,
        'active', coalesce(j.active, false),
        'schedule', j.schedule
      ) order by e.name)
      from (values ('lr-dispatch'), ('lr-maintenance'), ('lr-plan')) as e(name)
      left join cron.job j on j.jobname = e.name
    ),
    -- The planner's heartbeat is written by the lr-plan schedule (and by nothing else while no
    -- work is running), so its age shows whether pg_cron is actually firing.
    'planner', (
      select jsonb_build_object(
        'seconds_since_run', extract(epoch from clock_timestamp() - h.last_started_at)::integer,
        'last_error', case
          when h.last_error_at is not null and (h.last_ok_at is null or h.last_error_at >= h.last_ok_at)
          then h.last_error
        end
      )
      from app_private.heartbeats h
      where h.name = 'plan'
    )
  );
$$;

-- New objects are closed by default (20261110071100): grant exactly what is needed.
revoke all on function public.svc_schedule_status() from public, anon, authenticated;
grant execute on function public.svc_schedule_status() to service_role;
