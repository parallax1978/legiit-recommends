-- Legiit Recommends — list and summary queries for the web app.
-- All of these run with the caller's own row access (security invoker).

create or replace function public.campaign_summaries(p_workspace_id uuid)
returns table (
  id uuid,
  name text,
  description text,
  status public.campaign_status,
  paused_from public.campaign_status,
  pause_reason text,
  pause_detail text,
  archived_at timestamptz,
  created_at timestamptz,
  launched_at timestamptz,
  completed_at timestamptz,
  has_pending_changes boolean,
  revision_number integer,
  business_name text,
  website_url text,
  category text,
  model text,
  timezone text,
  start_at timestamptz,
  end_at timestamptz,
  conversations_per_day integer,
  total_conversation_limit integer,
  daily_budget_usd numeric,
  total_budget_usd numeric,
  conversations_planned bigint,
  runs_total bigint,
  runs_completed bigint,
  runs_in_progress bigint,
  runs_problem bigint,
  first_valid bigint,
  first_included bigint,
  final_valid bigint,
  final_included bigint,
  checks_completed bigint,
  next_slot_at timestamptz,
  spend_total_usd numeric,
  needs_review bigint,
  jobs_dead bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id, c.name, c.description, c.status, c.paused_from, c.pause_reason, c.pause_detail,
    c.archived_at, c.created_at, c.launched_at, c.completed_at,
    c.draft_revision_id is not null and c.status <> 'draft',
    r.revision_number, r.business_name, r.website_url, r.category, r.model, r.timezone,
    r.start_at, r.end_at, r.conversations_per_day, r.total_conversation_limit,
    r.daily_budget_usd, r.total_budget_usd,
    coalesce(j.conversations_planned, 0),
    coalesce(ru.runs_total, 0), coalesce(ru.runs_completed, 0), coalesce(ru.runs_in_progress, 0),
    coalesce(ru.runs_problem, 0),
    coalesce(ru.first_valid, 0), coalesce(ru.first_included, 0),
    coalesce(ru.final_valid, 0), coalesce(ru.final_included, 0),
    coalesce(fc.checks_completed, 0),
    j.next_slot_at,
    coalesce(l.spend, 0),
    coalesce(ru.turn_reviews, 0) + coalesce(fc.check_reviews, 0),
    coalesce(j.jobs_dead, 0)
  from public.campaigns c
  left join public.campaign_revisions r on r.id = coalesce(c.active_revision_id, c.draft_revision_id)
  left join lateral (
    select
      count(*) filter (where jb.kind = 'conversation' and jb.status not in ('skipped', 'canceled')) as conversations_planned,
      min(jb.scheduled_for) filter (where jb.status = 'pending') as next_slot_at,
      count(*) filter (where jb.status = 'dead') as jobs_dead
    from public.jobs jb where jb.campaign_id = c.id
  ) j on true
  left join lateral (
    select
      count(*) as runs_total,
      count(*) filter (where rn.status in ('completed', 'completed_early')) as runs_completed,
      count(*) filter (where rn.status in ('pending', 'in_progress')) as runs_in_progress,
      count(*) filter (where rn.status in ('failed', 'expired', 'incomplete', 'unresolved')) as runs_problem,
      count(*) filter (where t1.status = 'completed' and t1.inclusion in ('included', 'mentioned_only', 'not_mentioned')) as first_valid,
      count(*) filter (where t1.status = 'completed' and t1.inclusion = 'included') as first_included,
      count(*) filter (where rn.status = 'completed' and tf.status = 'completed' and tf.inclusion in ('included', 'mentioned_only', 'not_mentioned')) as final_valid,
      count(*) filter (where rn.status = 'completed' and tf.status = 'completed' and tf.inclusion = 'included') as final_included,
      count(*) filter (where t1.inclusion = 'ambiguous') + count(*) filter (where tf.inclusion = 'ambiguous' and tf.id is distinct from t1.id) as turn_reviews
    from public.runs rn
    left join public.run_turns t1 on t1.run_id = rn.id and t1.step_index = 1
    left join public.run_turns tf on tf.run_id = rn.id and tf.step_index = rn.steps_total
    where rn.campaign_id = c.id and rn.kind = 'scheduled'
  ) ru on true
  left join lateral (
    select
      count(*) filter (where f.status = 'completed') as checks_completed,
      count(*) filter (where f.status = 'completed' and f.inclusion = 'ambiguous') as check_reviews
    from public.fresh_checks f where f.campaign_id = c.id
  ) fc on true
  left join lateral (
    select sum(ul.cost_usd) as spend from public.usage_ledger ul where ul.campaign_id = c.id
  ) l on true
  where c.workspace_id = p_workspace_id
  order by c.created_at desc;
$$;

-- Workspace-wide numbers for the overview. Everything comes from recorded activity; a new
-- workspace gets zeros and empty lists.
create or replace function public.overview_summary(p_workspace_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'as_of', now(),
    'campaigns', (
      select jsonb_build_object(
        'total', count(*) filter (where c.archived_at is null),
        'draft', count(*) filter (where c.status = 'draft' and c.archived_at is null),
        'scheduled', count(*) filter (where c.status = 'scheduled'),
        'active', count(*) filter (where c.status in ('baseline', 'running', 'finalizing')),
        'paused', count(*) filter (where c.status = 'paused'),
        'completed', count(*) filter (where c.status = 'completed' and c.archived_at is null)
      )
      from public.campaigns c where c.workspace_id = p_workspace_id
    ),
    'conversations', (
      select jsonb_build_object(
        'completed', count(*) filter (where r.status in ('completed', 'completed_early')),
        'completed_7d', count(*) filter (where r.status in ('completed', 'completed_early') and r.completed_at > now() - interval '7 days'),
        'in_progress', count(*) filter (where r.status in ('pending', 'in_progress'))
      )
      from public.runs r where r.workspace_id = p_workspace_id and r.kind = 'scheduled'
    ),
    'fresh_checks', (
      select jsonb_build_object(
        'completed', count(*) filter (where f.status = 'completed'),
        'completed_7d', count(*) filter (where f.status = 'completed' and f.completed_at > now() - interval '7 days'),
        'valid', count(*) filter (where f.status = 'completed' and f.inclusion in ('included', 'mentioned_only', 'not_mentioned')),
        'included', count(*) filter (where f.status = 'completed' and f.inclusion = 'included')
      )
      from public.fresh_checks f where f.workspace_id = p_workspace_id
    ),
    'usage', (
      select jsonb_build_object(
        'today_usd', coalesce(sum(l.cost_usd) filter (where l.connection_day = (now() at time zone 'UTC')::date), 0),
        'last_7d_usd', coalesce(sum(l.cost_usd) filter (where l.connection_day > (now() at time zone 'UTC')::date - 7), 0),
        'last_30d_usd', coalesce(sum(l.cost_usd) filter (where l.connection_day > (now() at time zone 'UTC')::date - 30), 0),
        'requests_7d', count(*) filter (where l.connection_day > (now() at time zone 'UTC')::date - 7)
      )
      from public.usage_ledger l where l.workspace_id = p_workspace_id
    ),
    'attention', jsonb_build_object(
      'jobs_dead', (select count(*) from public.jobs j where j.workspace_id = p_workspace_id and j.status = 'dead'),
      'jobs_blocked', (select count(*) from public.jobs j where j.workspace_id = p_workspace_id and j.status = 'blocked'),
      'unresolved_attempts', (select count(*) from public.provider_attempts a
        where a.workspace_id = p_workspace_id and a.status = 'uncertain' and a.resolved_at is null),
      'connections_failing', (select count(*) from public.provider_connections pc
        where pc.workspace_id = p_workspace_id and pc.archived_at is null and pc.status = 'error'),
      'connections_ready', (select count(*) from public.provider_connections pc
        where pc.workspace_id = p_workspace_id and pc.archived_at is null and pc.status = 'ok'),
      'models_verified', (select count(*) from public.provider_models m
        where m.workspace_id = p_workspace_id and m.verification_status = 'verified'),
      'campaigns_paused_by_system', (select count(*) from public.campaigns c
        where c.workspace_id = p_workspace_id and c.status = 'paused' and c.pause_reason <> 'user'),
      'needs_review', (
        (select count(*) from public.run_turns t where t.workspace_id = p_workspace_id and t.inclusion = 'ambiguous')
        + (select count(*) from public.fresh_checks f where f.workspace_id = p_workspace_id and f.inclusion = 'ambiguous')
      )
    ),
    'upcoming', (
      select coalesce(jsonb_agg(u order by u.scheduled_for), '[]'::jsonb)
      from (
        select j.id, j.kind, j.scheduled_for, j.campaign_id, c.name as campaign_name
        from public.jobs j
        join public.campaigns c on c.id = j.campaign_id
        where j.workspace_id = p_workspace_id and j.status = 'pending'
          and c.status in ('baseline', 'running', 'finalizing')
        order by j.scheduled_for
        limit 8
      ) u
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'cost_usd', d.cost_usd, 'requests', d.requests) order by d.day), '[]'::jsonb)
      from (
        select l.connection_day as day, sum(l.cost_usd) as cost_usd, count(*) as requests
        from public.usage_ledger l
        where l.workspace_id = p_workspace_id and l.connection_day > (now() at time zone 'UTC')::date - 14
        group by l.connection_day
      ) d
    )
  );
$$;

-- How often each saved wording has been used by a campaign's conversations.
create or replace function public.variation_coverage(p_campaign_id uuid)
returns table (
  step_index integer,
  step_kind public.template_kind,
  template_id uuid,
  body text,
  in_current_revision boolean,
  uses bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with current_templates as (
    select st.step_index, s.kind, st.template_id, st.position
    from public.campaigns c
    join public.campaign_revision_step_templates st on st.revision_id = coalesce(c.active_revision_id, c.draft_revision_id)
    join public.campaign_revision_steps s on s.revision_id = st.revision_id and s.step_index = st.step_index
    where c.id = p_campaign_id
  ),
  used as (
    select t.step_index, t.step_kind, t.template_id, count(*) as uses
    from public.run_turns t
    join public.runs r on r.id = t.run_id
    where t.campaign_id = p_campaign_id and r.kind = 'scheduled' and t.template_id is not null
      and t.status not in ('pending', 'skipped', 'canceled')
    group by t.step_index, t.step_kind, t.template_id
  )
  select
    coalesce(ct.step_index, u.step_index),
    coalesce(ct.kind, u.step_kind),
    coalesce(ct.template_id, u.template_id),
    tv.body,
    ct.template_id is not null,
    coalesce(u.uses, 0)
  from current_templates ct
  full join used u on u.step_index = ct.step_index and u.template_id = ct.template_id
  left join public.templates tp on tp.id = coalesce(ct.template_id, u.template_id)
  left join public.template_versions tv on tv.id = tp.current_version_id
  order by 1, ct.position nulls last, 6 desc;
$$;

-- Per-day activity of a campaign in its own timezone, for charts.
create or replace function public.campaign_daily_activity(p_campaign_id uuid)
returns table (
  local_day date,
  conversations_completed bigint,
  conversations_other bigint,
  slots_skipped bigint,
  final_valid bigint,
  final_included bigint,
  cost_usd numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with days as (
    select j.slot_date as day,
      count(*) filter (where r.status in ('completed', 'completed_early')) as completed,
      count(*) filter (where r.id is not null and r.status not in ('completed', 'completed_early', 'pending')) as other,
      count(*) filter (where j.status = 'skipped') as skipped,
      count(*) filter (where r.status = 'completed' and tf.status = 'completed' and tf.inclusion in ('included', 'mentioned_only', 'not_mentioned')) as final_valid,
      count(*) filter (where r.status = 'completed' and tf.status = 'completed' and tf.inclusion = 'included') as final_included
    from public.jobs j
    left join public.runs r on r.job_id = j.id and r.kind = 'scheduled'
    left join public.run_turns tf on tf.run_id = r.id and tf.step_index = r.steps_total
    where j.campaign_id = p_campaign_id and j.kind = 'conversation' and j.status <> 'pending'
    group by j.slot_date
  ),
  costs as (
    select l.campaign_day as day, sum(l.cost_usd) as cost
    from public.usage_ledger l where l.campaign_id = p_campaign_id and not l.is_test
    group by l.campaign_day
  )
  select coalesce(d.day, k.day), coalesce(d.completed, 0), coalesce(d.other, 0), coalesce(d.skipped, 0),
         coalesce(d.final_valid, 0), coalesce(d.final_included, 0), coalesce(k.cost, 0)
  from days d
  full join costs k on k.day = d.day
  where coalesce(d.day, k.day) is not null
  order by 1;
$$;
