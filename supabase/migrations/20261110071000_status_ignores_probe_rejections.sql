-- Legiit Recommends — the operational status no longer reports verification probes as errors.
--
-- Model verification deliberately asks for settings a model may not accept (each reasoning
-- effort, temperature, top_p, verbosity, background mode) and records which ones the provider
-- declines. Those declined probes were counted under "Provider errors, last 24 hours", so the
-- status page asked the owner to check something right after every successful verification.
-- They are part of the verified model's profile, not faults. Every other failed or uncertain
-- request is still counted, including probes that fail for any other reason (rate limits,
-- credential or quota errors, timeouts).
--
-- Replacing a function keeps its owner and grants, so the API allowlist is unchanged.

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
