-- Legiit Recommends — make the outcome of worker wake-ups visible.
--
-- The dispatcher wakes the queue consumer with an HTTP request (pg_net) and used to discard
-- the request id. If those requests were rejected — the worker secret in Vault no longer
-- matching the function's, the function not deployed, a wrong base URL — nothing ran, while
-- the status page showed the scheduler and dispatcher as healthy and the consumers as
-- "Activated" (which only means the two settings exist). The cause was visible nowhere.
--
-- Each wake-up is now recorded with its request id, the status page receives a summary of
-- the last fifteen minutes (accepted, rejected with the HTTP status, failed, still pending),
-- and the trusted backend can send one wake-up on demand and read its outcome, which
-- `npm run queues:activate` does after every activation.

create table app_private.worker_wakes (
  request_id bigint primary key,
  requested_at timestamptz not null default clock_timestamp(),
  source text not null default 'dispatch' check (source in ('dispatch', 'check'))
);
create index worker_wakes_requested_at_idx on app_private.worker_wakes (requested_at);
alter table app_private.worker_wakes enable row level security;

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
    -- The request id is kept so that the outcome can be read back from pg_net's response table.
    insert into app_private.worker_wakes (request_id, source)
    select net.http_post(
      url := rtrim(v_url, '/') || '/functions/v1/worker',
      body := jsonb_build_object('source', 'dispatch'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
      timeout_milliseconds := 10000
    ), 'dispatch'
    -- pg_net numbers its requests from its own sequence. Should that ever start again (the
    -- extension being re-created), a reused number must not stop the dispatcher.
    on conflict (request_id) do update
      set requested_at = excluded.requested_at, source = excluded.source;
  end loop;
  delete from app_private.worker_wakes where requested_at < clock_timestamp() - interval '1 day';
  return v_wakes;
end;
$$;

-- What happened to the wake-ups of the last `p_window`. pg_net keeps responses for a few
-- hours, which is longer than any window used here.
create or replace function app_private.wake_summary(p_window interval default interval '15 minutes')
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with recent as (
    select w.request_id, w.requested_at, r.id as response_id, r.status_code, r.timed_out, r.error_msg
    from app_private.worker_wakes w
    left join net._http_response r on r.id = w.request_id
    where w.requested_at > clock_timestamp() - p_window
  )
  select jsonb_build_object(
    'window_minutes', (extract(epoch from p_window) / 60)::integer,
    'requested', count(*),
    'accepted', count(*) filter (where status_code between 200 and 299),
    'rejected', count(*) filter (where status_code >= 300),
    'failed', count(*) filter (where response_id is not null and status_code is null),
    -- A request that has had no response for a minute is not coming back.
    'unanswered', count(*) filter (where response_id is null and requested_at < clock_timestamp() - interval '1 minute'),
    'last_accepted_at', max(requested_at) filter (where status_code between 200 and 299),
    'last_problem', (
      select jsonb_build_object(
        'at', p.requested_at,
        'status_code', p.status_code,
        'error', case when p.timed_out then 'timed out' else nullif(left(p.error_msg, 200), '') end
      )
      from recent p
      where p.response_id is not null and (p.status_code is null or p.status_code >= 300)
      order by p.requested_at desc
      limit 1
    )
  )
  from recent;
$$;

-- Sends one wake-up now, whether or not anything is queued, and returns its request id.
-- The request leaves when the calling transaction commits.
create or replace function public.svc_wake_check()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_id bigint;
begin
  select d.decrypted_secret into v_url from vault.decrypted_secrets d where d.name = 'lr_functions_base_url';
  select d.decrypted_secret into v_secret from vault.decrypted_secrets d where d.name = 'lr_worker_secret';
  if v_url is null or v_secret is null then
    perform app_private.fail('not_activated', 'Queue consumers are not activated yet.');
  end if;
  v_id := net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/worker',
    body := jsonb_build_object('source', 'check'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
    timeout_milliseconds := 10000
  );
  insert into app_private.worker_wakes (request_id, source) values (v_id, 'check')
  on conflict (request_id) do update
    set requested_at = excluded.requested_at, source = excluded.source;
  return v_id;
end;
$$;

-- The outcome of a wake-up sent by this application (never of any other pg_net request).
create or replace function public.svc_wake_result(p_request_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'done', true,
        'status_code', r.status_code,
        'timed_out', r.timed_out,
        'error', nullif(left(r.error_msg, 200), '')
      )
      from net._http_response r
      where r.id = p_request_id
        and exists (select 1 from app_private.worker_wakes w where w.request_id = p_request_id)
    ),
    jsonb_build_object('done', false)
  );
$$;

-- New objects are closed by default (20261110071100): grant exactly what is needed.
revoke all on function app_private.wake_summary(interval) from public, anon, authenticated, service_role;
revoke all on function public.svc_wake_check() from public, anon, authenticated;
revoke all on function public.svc_wake_result(bigint) from public, anon, authenticated;
grant execute on function public.svc_wake_check() to service_role;
grant execute on function public.svc_wake_result(bigint) to service_role;

-- The status function gains the wake-up summary. Replacing it keeps its owner and grants.
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
    -- "Activated" only says the settings exist. This says whether the worker answered.
    'wakes', app_private.wake_summary(interval '15 minutes'),
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
            -- A setting the model declined during verification is how its profile is learned.
            and not (a.purpose = 'model_probe' and a.error_class = 'invalid_request')
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
