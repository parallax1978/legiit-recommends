-- Legiit Recommends — launching a campaign needs three answers, not sixteen.
--
-- A draft could not be launched until every setting had been entered by hand: category,
-- language, output cap, start, end, timezone, active days and hours, conversations per day,
-- concurrency, missed-slot behaviour, existing-inclusion behaviour, both budgets and the three
-- fresh-check counts. Most of those have an obvious value, two only fill placeholders in
-- prompts, and a start time is something the person launching usually means as "now".
--
-- After this migration a draft needs from its owner: how long it runs, how many conversations a
-- day, and a total budget (besides the business, the prompts and the model).
--
--   * Standard values. A new draft starts with every day of the week, the whole day, one
--     conversation at a time, missed slots skipped, the full sequence when the business already
--     appears, and fresh checks off. The output cap follows the chosen model: what that model
--     was verified for, up to 2,000 tokens. A setting saved blank takes its standard value
--     again. Existing drafts get the same values once, here.
--   * Category and language are optional. They only fill {{category}} and {{language}}; a
--     prompt that uses a placeholder the campaign has no value for was already reported.
--   * A daily budget is optional. Budget checks already treated a campaign without one as
--     capped by its total and by the connection's daily limit.
--   * The start may be left open. The campaign then starts when it is launched, and a length in
--     days (now stored, as duration_days) is counted from that moment. Both are written to the
--     revision when it is frozen, so everything after launch reads fixed instants as before.
--   * The timezone is still the user's, but the interface may fill in the browser's:
--     suggest_campaign_timezone sets it only on a draft that has none.
--
-- Launching is unchanged in what matters: nothing starts until an owner or admin presses
-- Launch, and a frozen revision never changes.

alter table public.campaign_revisions
  add column duration_days integer check (duration_days is null or duration_days between 1 and 1095);

comment on column public.campaign_revisions.duration_days is
  'Length of the campaign in days when schedule_end_mode is ''duration''. With an open start it is counted from the moment of launch.';

-- "A frozen revision is complete" no longer counts the optional settings: category and language
-- (placeholders only) and the daily budget (the total still caps the campaign). The check was
-- created without a name, so it is found by what it says.
do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.campaign_revisions'::regclass
    and c.contype = 'c'
    and pg_catalog.pg_get_constraintdef(c.oid) like '%frozen_at IS NOT NULL%'
    and pg_catalog.pg_get_constraintdef(c.oid) like '%category IS NOT NULL%';
  if v_name is null then
    raise exception 'The completeness check on campaign_revisions was not found.';
  end if;
  execute format('alter table public.campaign_revisions drop constraint %I', v_name);
end;
$$;

alter table public.campaign_revisions
  add constraint campaign_revisions_frozen_complete check (
    state <> 'frozen'
    or (
      frozen_at is not null
      and business_name is not null and website_url is not null
      and connection_id is not null and model is not null
      and max_output_tokens is not null and start_at is not null and end_at is not null
      and timezone is not null and active_weekdays is not null
      and active_start_minute is not null and active_end_minute is not null
      and conversations_per_day is not null and max_concurrency is not null
      and missed_slot_behavior is not null
      and total_budget_usd is not null
      and baseline_samples is not null and daily_checks is not null and final_samples is not null
      and on_existing_inclusion is not null and selection_seed is not null
      and price_id is not null
      and (missed_slot_behavior <> 'catch_up'
           or (catch_up_max_delay_minutes is not null and catch_up_max_per_day is not null))
      and ((baseline_samples + daily_checks + final_samples) = 0
           or (probe_set_version_id is not null and check_price_id is not null and comparison_group_id is not null))
    )
  );

-- Whole days between a revision's start and end, as its timezone's calendar counts them.
create or replace function app_private.schedule_days(p_rev public.campaign_revisions)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when p_rev.schedule_end_mode = 'duration'
         and p_rev.start_at is not null and p_rev.end_at is not null and p_rev.end_at > p_rev.start_at
         and p_rev.timezone is not null
         and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_rev.timezone)
    then least(1095, greatest(1, round(extract(epoch from (
           (p_rev.end_at at time zone p_rev.timezone) - (p_rev.start_at at time zone p_rev.timezone)
         )) / 86400.0)::integer))
  end;
$$;

-- When a revision runs. A stored start and end are used as they are. An open start means the
-- given moment (the launch, or now for a preview), to the minute, which is how a start is
-- entered and shown everywhere else; an open end in duration mode is that many days later on
-- the campaign's own clock, so the campaign ends at the hour it started.
create or replace function app_private.effective_schedule(
  p_rev public.campaign_revisions,
  p_now timestamptz
)
returns table (start_at timestamptz, end_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select s.start_at,
         coalesce(
           p_rev.end_at,
           case
             when p_rev.schedule_end_mode = 'duration' and p_rev.duration_days is not null
                  and p_rev.timezone is not null
                  and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_rev.timezone)
             then ((s.start_at at time zone p_rev.timezone) + make_interval(days => p_rev.duration_days))
                    at time zone p_rev.timezone
           end
         )
  from (select coalesce(p_rev.start_at, date_trunc('minute', p_now)) as start_at) s;
$$;

-- Gives a draft the standard value of every setting it has left blank. The output cap depends
-- on the model, so it is filled once a verified model has been chosen.
create or replace function app_private.fill_revision_defaults(p_revision_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.campaign_revisions r
  set active_weekdays = coalesce(r.active_weekdays, array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
      active_start_minute = coalesce(r.active_start_minute, 0),
      active_end_minute = coalesce(r.active_end_minute, 1440),
      max_concurrency = coalesce(r.max_concurrency, 1),
      missed_slot_behavior = coalesce(r.missed_slot_behavior, 'skip'),
      on_existing_inclusion = coalesce(r.on_existing_inclusion, 'continue'),
      baseline_samples = coalesce(r.baseline_samples, 0),
      daily_checks = coalesce(r.daily_checks, 0),
      final_samples = coalesce(r.final_samples, 0),
      max_output_tokens = coalesce(r.max_output_tokens, (
        select least((m.capabilities ->> 'max_output_tokens_verified')::integer, 2000)
        from public.provider_models m
        where m.connection_id = r.connection_id and m.model_id = r.model
          and m.verification_status = 'verified'
      ))
  where r.id = p_revision_id
    and r.state = 'draft'
    and (r.active_weekdays is null or r.active_start_minute is null or r.active_end_minute is null
         or r.max_concurrency is null or r.missed_slot_behavior is null
         or r.on_existing_inclusion is null or r.baseline_samples is null or r.daily_checks is null
         or r.final_samples is null or r.max_output_tokens is null);
$$;

-- Everything that prevents a revision from being used. p_scope: 'launch' | 'apply' | 'test'.
-- Returns [{code, field, message}].
create or replace function app_private.revision_problems(
  p_revision_id uuid,
  p_scope text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rev public.campaign_revisions%rowtype;
  v_campaign public.campaigns%rowtype;
  v_conn public.provider_connections%rowtype;
  v_model public.provider_models%rowtype;
  v_check record;
  v_vars jsonb;
  v_out jsonb := '[]'::jsonb;
  v_row record;
  v_var text;
  v_problem text;
  v_est record;
  v_full boolean := p_scope in ('launch', 'apply');
  v_checks_enabled boolean;
  v_version_id uuid;
  v_terms text[];
  v_term text;
  v_step_count integer;
  v_schedule record;
begin
  select * into v_rev from public.campaign_revisions r where r.id = p_revision_id;
  if not found then
    return jsonb_build_array(jsonb_build_object('code', 'not_found', 'field', null, 'message', 'Campaign configuration not found.'));
  end if;
  select * into v_campaign from public.campaigns c where c.id = v_rev.campaign_id;
  v_vars := app_private.revision_variables(v_rev);

  -- Target ----------------------------------------------------------------------------------
  if nullif(btrim(coalesce(v_rev.business_name, '')), '') is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'business_name', 'message', 'Enter the business name.');
  end if;
  if nullif(btrim(coalesce(v_rev.website_url, '')), '') is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'website_url', 'message', 'Enter the business website URL.');
  elsif app_private.url_host(v_rev.website_url) is null or app_private.url_host(v_rev.website_url) !~ '^[^\s.]+(\.[^\s.]+)+$' then
    v_out := v_out || jsonb_build_object('code', 'invalid', 'field', 'website_url', 'message', 'Enter a valid website URL, for example https://example.com.');
  end if;
  -- Category, market and language only fill placeholders in prompts. A prompt that uses one
  -- the campaign has no value for is reported below, step by step; nothing else needs them.

  -- Sequence --------------------------------------------------------------------------------
  select count(*) into v_step_count from public.campaign_revision_steps s where s.revision_id = v_rev.id;
  if v_step_count < 3 then
    v_out := v_out || jsonb_build_object('code', 'steps_missing', 'field', 'steps', 'message', 'The conversation needs its three steps: question, inclusion request and revised-list request.');
  end if;
  if exists (
    select 1 from generate_series(1, v_step_count) g(i)
    where not exists (select 1 from public.campaign_revision_steps s where s.revision_id = v_rev.id and s.step_index = g.i)
  ) then
    v_out := v_out || jsonb_build_object('code', 'steps_not_contiguous', 'field', 'steps', 'message', 'Conversation steps must be numbered without gaps.');
  end if;

  for v_row in
    select s.step_index, s.kind, count(st.id) as template_count
    from public.campaign_revision_steps s
    left join public.campaign_revision_step_templates st
      on st.revision_id = s.revision_id and st.step_index = s.step_index
    where s.revision_id = v_rev.id
    group by s.step_index, s.kind
    order by s.step_index
  loop
    if v_row.template_count = 0 then
      v_out := v_out || jsonb_build_object('code', 'step_empty', 'field', 'steps.' || v_row.step_index,
        'message', format('Step %s has no prompt. Add at least one wording.', v_row.step_index));
    end if;
  end loop;

  for v_row in
    select st.step_index, s.kind, t.id as template_id, t.archived_at, t.kind as template_kind, tv.body, tv.variables
    from public.campaign_revision_step_templates st
    join public.campaign_revision_steps s on s.revision_id = st.revision_id and s.step_index = st.step_index
    join public.templates t on t.id = st.template_id
    left join public.template_versions tv on tv.id = coalesce(st.template_version_id, t.current_version_id)
    where st.revision_id = v_rev.id
    order by st.step_index, st.position
  loop
    if v_row.archived_at is not null and v_rev.state = 'draft' then
      v_out := v_out || jsonb_build_object('code', 'template_archived', 'field', 'steps.' || v_row.step_index,
        'message', format('Step %s uses an archived prompt. Remove it or restore it in the template library.', v_row.step_index));
    end if;
    if v_row.template_kind <> v_row.kind then
      v_out := v_out || jsonb_build_object('code', 'template_kind_mismatch', 'field', 'steps.' || v_row.step_index,
        'message', format('Step %s uses a prompt of a different type.', v_row.step_index));
    end if;
    v_problem := app_private.template_problem(v_row.body, v_row.kind);
    if v_problem is not null then
      v_out := v_out || jsonb_build_object('code', 'invalid_template', 'field', 'steps.' || v_row.step_index,
        'message', format('Step %s: %s', v_row.step_index, v_problem));
    else
      foreach v_var in array coalesce(v_row.variables, '{}'::text[]) loop
        if coalesce(v_vars ->> v_var, '') = '' then
          v_out := v_out || jsonb_build_object('code', 'unresolved_variable', 'field', 'steps.' || v_row.step_index,
            'message', format('Step %s uses {{%s}} but the campaign has no value for it.', v_row.step_index, v_var));
        end if;
      end loop;
      if char_length(btrim(app_private.render_template(v_row.body, v_vars))) = 0 then
        v_out := v_out || jsonb_build_object('code', 'empty_prompt', 'field', 'steps.' || v_row.step_index,
          'message', format('Step %s renders to an empty prompt.', v_row.step_index));
      end if;
    end if;
  end loop;

  -- Provider --------------------------------------------------------------------------------
  if v_rev.connection_id is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'connection_id', 'message', 'Choose an OpenAI connection.');
  else
    select * into v_conn from public.provider_connections c where c.id = v_rev.connection_id;
    if v_conn.archived_at is not null then
      v_out := v_out || jsonb_build_object('code', 'connection_archived', 'field', 'connection_id', 'message', 'The selected connection is archived.');
    elsif v_conn.status <> 'ok' then
      v_out := v_out || jsonb_build_object('code', 'connection_not_ready', 'field', 'connection_id',
        'message', case when v_conn.status = 'not_configured'
          then 'The selected connection has no API key yet. An owner must add one in Settings.'
          else 'The selected connection is failing: ' || coalesce(v_conn.status_message, v_conn.status_code, 'unknown error') end);
    end if;
    if v_conn.daily_budget_usd is null then
      v_out := v_out || jsonb_build_object('code', 'connection_cap_missing', 'field', 'connection_id', 'message', 'The selected connection has no daily spending limit. An owner must set one in Settings.');
    end if;
    if v_full and v_rev.max_concurrency is not null and v_rev.max_concurrency > v_conn.max_concurrent_requests then
      v_out := v_out || jsonb_build_object('code', 'concurrency_exceeds_connection', 'field', 'max_concurrency',
        'message', format('Concurrency cannot exceed the connection limit of %s.', v_conn.max_concurrent_requests));
    end if;
  end if;

  if nullif(btrim(coalesce(v_rev.model, '')), '') is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'model', 'message', 'Choose a model.');
  elsif v_rev.connection_id is not null then
    select * into v_model from public.provider_models m
    where m.connection_id = v_rev.connection_id and m.model_id = v_rev.model;
    if not found or v_model.verification_status <> 'verified' then
      v_out := v_out || jsonb_build_object('code', 'model_not_verified', 'field', 'model',
        'message', format('Model "%s" has not been verified for this connection. An owner can verify it in Settings.', v_rev.model));
    else
      v_problem := app_private.params_problem(v_model.capabilities, v_rev.model_params, v_rev.max_output_tokens, true, v_rev.execution_mode);
      if v_problem is not null then
        v_out := v_out || jsonb_build_object('code', 'unsupported_parameter', 'field', 'model_params', 'message', v_problem);
      end if;
    end if;
    if (app_private.current_price(v_rev.workspace_id, v_rev.model)).id is null then
      v_out := v_out || jsonb_build_object('code', 'price_missing', 'field', 'model',
        'message', format('No price is recorded for model "%s". An owner must add one under Settings → Model pricing before paid requests can run.', v_rev.model));
    end if;
  end if;
  -- The cap comes with the model: its standard value is filled in when a verified model is
  -- chosen. Until there is a model to cap, "choose a model" is the one thing to ask for.
  if v_rev.max_output_tokens is null and nullif(btrim(coalesce(v_rev.model, '')), '') is not null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'max_output_tokens', 'message', 'Enter the maximum output tokens per turn.');
  end if;

  if not v_full then
    return v_out;
  end if;

  -- Schedule --------------------------------------------------------------------------------
  -- A draft may leave the start open: the campaign then starts when it is launched, and a
  -- length in days is counted from that moment. A campaign that is already launched has no
  -- such moment ahead of it, so its pending changes have to name the start.
  if p_scope = 'apply' and v_rev.start_at is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'start_at', 'message', 'Choose a start time: this campaign has already been launched.');
  end if;
  select * into v_schedule from app_private.effective_schedule(v_rev, p_now);
  if v_schedule.end_at is null then
    -- With a length in days already entered, only the timezone (reported below) is missing.
    if not (v_rev.schedule_end_mode = 'duration' and v_rev.duration_days is not null) then
      v_out := v_out || jsonb_build_object('code', 'required', 'field', 'end_at', 'message', 'Enter how long the campaign runs: a number of days, or an end time.');
    end if;
  elsif v_schedule.end_at <= p_now then
    v_out := v_out || jsonb_build_object('code', 'end_in_past', 'field', 'end_at', 'message', 'The end time has already passed.');
  end if;
  if v_rev.timezone is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'timezone', 'message', 'Choose the campaign timezone.');
  elsif not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_rev.timezone) then
    v_out := v_out || jsonb_build_object('code', 'invalid', 'field', 'timezone', 'message', 'Choose a valid IANA timezone.');
  end if;
  if v_rev.active_weekdays is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'active_weekdays', 'message', 'Choose at least one active weekday.');
  end if;
  if v_rev.active_start_minute is null or v_rev.active_end_minute is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'active_hours', 'message', 'Choose the active hours.');
  end if;
  if v_rev.conversations_per_day is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'conversations_per_day', 'message', 'Enter the number of conversations per day.');
  end if;
  if v_rev.max_concurrency is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'max_concurrency', 'message', 'Enter the conversation concurrency.');
  end if;
  if v_rev.missed_slot_behavior is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'missed_slot_behavior', 'message', 'Choose what happens to missed slots.');
  elsif v_rev.missed_slot_behavior = 'catch_up'
        and (v_rev.catch_up_max_delay_minutes is null or v_rev.catch_up_max_per_day is null) then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'catch_up', 'message', 'Catch-up needs both a maximum delay and a maximum number per day.');
  end if;
  if v_rev.on_existing_inclusion is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'on_existing_inclusion', 'message', 'Choose what happens when the business already appears in the first answer.');
  end if;
  if p_scope = 'apply' and v_campaign.started_at is not null then
    if v_rev.start_at is distinct from (
      select r.start_at from public.campaign_revisions r where r.id = v_campaign.active_revision_id
    ) then
      v_out := v_out || jsonb_build_object('code', 'start_locked', 'field', 'start_at', 'message', 'The start time cannot change after the campaign has started.');
    end if;
  end if;

  -- Budgets ---------------------------------------------------------------------------------
  -- A daily budget is optional: without one only the total (and the connection's own daily
  -- limit) caps the campaign.
  if v_rev.total_budget_usd is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'total_budget_usd', 'message', 'Enter a total budget.');
  end if;

  -- Fresh checks ----------------------------------------------------------------------------
  if v_rev.baseline_samples is null or v_rev.daily_checks is null or v_rev.final_samples is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'checks', 'message', 'Enter the baseline, daily and final fresh-check counts (0 turns a phase off).');
  end if;
  v_checks_enabled := coalesce(v_rev.baseline_samples, 0) + coalesce(v_rev.daily_checks, 0) + coalesce(v_rev.final_samples, 0) > 0;

  if v_checks_enabled then
    if v_rev.probe_set_id is null then
      v_out := v_out || jsonb_build_object('code', 'required', 'field', 'probe_set_id', 'message', 'Choose a fresh-check question set.');
    else
      v_version_id := coalesce(
        v_rev.probe_set_version_id,
        (select s.current_version_id from public.probe_sets s where s.id = v_rev.probe_set_id)
      );
      if v_version_id is null or not exists (
        select 1 from public.probe_questions q where q.probe_set_version_id = v_version_id
      ) then
        v_out := v_out || jsonb_build_object('code', 'probe_set_empty', 'field', 'probe_set_id', 'message', 'The selected question set has no questions.');
      end if;

      v_terms := array_remove(
        array[v_rev.business_name, app_private.url_host(v_rev.website_url)]
          || coalesce(v_rev.business_aliases, '{}'::text[])
          || coalesce((select array_agg(app_private.url_host(d)) from unnest(v_rev.domain_aliases) d), '{}'::text[]),
        null
      );

      for v_row in
        select q.position, q.body, q.variables, q.is_held_out,
               app_private.render_template(q.body, v_vars) as rendered
        from public.probe_questions q
        where q.probe_set_version_id = v_version_id
        order by q.position
      loop
        foreach v_var in array coalesce(v_row.variables, '{}'::text[]) loop
          if coalesce(v_vars ->> v_var, '') = '' then
            v_out := v_out || jsonb_build_object('code', 'unresolved_variable', 'field', 'probe_set_id',
              'message', format('Fresh-check question %s uses {{%s}} but the campaign has no value for it.', v_row.position, v_var));
          end if;
        end loop;
        foreach v_term in array v_terms loop
          if app_private.contains_term(v_row.rendered, v_term) then
            v_out := v_out || jsonb_build_object('code', 'check_leaks_target', 'field', 'probe_set_id',
              'message', format('Fresh-check question %s mentions the target ("%s"). Fresh checks must not name the business.', v_row.position, v_term));
            exit;
          end if;
        end loop;
        if v_row.is_held_out and exists (
          select 1
          from public.campaign_revision_step_templates st
          join public.templates t on t.id = st.template_id
          join public.template_versions tv on tv.id = coalesce(st.template_version_id, t.current_version_id)
          where st.revision_id = v_rev.id and st.step_index = 1
            and regexp_replace(lower(btrim(app_private.render_template(tv.body, v_vars))), '\s+', ' ', 'g')
              = regexp_replace(lower(btrim(v_row.rendered)), '\s+', ' ', 'g')
        ) then
          v_out := v_out || jsonb_build_object('code', 'held_out_overlap', 'field', 'probe_set_id',
            'message', format('Held-out question %s is also used as a campaign question. Held-out questions must not appear in conversations.', v_row.position));
        end if;
      end loop;
    end if;

    select * into v_check from app_private.check_settings(v_rev);
    if v_check.model is not null and v_rev.connection_id is not null then
      if v_check.model is distinct from v_rev.model then
        select * into v_model from public.provider_models m
        where m.connection_id = v_rev.connection_id and m.model_id = v_check.model;
        if not found or v_model.verification_status <> 'verified' then
          v_out := v_out || jsonb_build_object('code', 'model_not_verified', 'field', 'check_model',
            'message', format('Fresh-check model "%s" has not been verified for this connection.', v_check.model));
        end if;
      end if;
      if v_model.capabilities is not null then
        v_problem := app_private.params_problem(v_model.capabilities, v_check.params, v_check.max_output_tokens, false, 'auto');
        if v_problem is not null then
          v_out := v_out || jsonb_build_object('code', 'unsupported_parameter', 'field', 'check_params',
            'message', 'Fresh-check settings: ' || v_problem);
        end if;
      end if;
      if (app_private.current_price(v_rev.workspace_id, v_check.model)).id is null then
        v_out := v_out || jsonb_build_object('code', 'price_missing', 'field', 'check_model',
          'message', format('No price is recorded for fresh-check model "%s".', v_check.model));
      end if;
    end if;
  end if;

  -- Budget sanity ---------------------------------------------------------------------------
  select * into v_est from app_private.revision_estimates(v_rev);
  if v_est.est_run_max_cost_usd is not null and v_rev.daily_budget_usd is not null
     and v_est.est_run_max_cost_usd > v_rev.daily_budget_usd then
    v_out := v_out || jsonb_build_object('code', 'budget_below_single_run', 'field', 'daily_budget_usd',
      'message', format('The daily budget ($%s) is lower than the maximum cost of a single conversation ($%s).',
        round(v_rev.daily_budget_usd, 2), round(v_est.est_run_max_cost_usd, 4)));
  end if;
  if v_est.est_run_max_cost_usd is not null and v_rev.total_budget_usd is not null
     and v_est.est_run_max_cost_usd > v_rev.total_budget_usd then
    v_out := v_out || jsonb_build_object('code', 'budget_below_single_run', 'field', 'total_budget_usd',
      'message', format('The total budget ($%s) is lower than the maximum cost of a single conversation ($%s).',
        round(v_rev.total_budget_usd, 2), round(v_est.est_run_max_cost_usd, 4)));
  end if;

  return v_out;
end;
$$;

create or replace function public.create_campaign(
  p_workspace_id uuid,
  p_name text,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign_id uuid;
  v_revision_id uuid;
begin
  perform app_private.require_role(p_workspace_id, 'admin');
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
    perform app_private.fail('invalid_name', 'Enter a campaign name between 1 and 120 characters.');
  end if;

  insert into public.campaigns (workspace_id, name, description, created_by)
  values (p_workspace_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), (select auth.uid()))
  returning id into v_campaign_id;

  -- A new draft is asked for its length in days rather than for an end date, and starts
  -- with the standard value of every setting that has one.
  insert into public.campaign_revisions (
    workspace_id, campaign_id, revision_number, selection_seed, schedule_end_mode, created_by
  )
  values (p_workspace_id, v_campaign_id, 1, app_private.new_seed(), 'duration', (select auth.uid()))
  returning id into v_revision_id;
  perform app_private.fill_revision_defaults(v_revision_id);

  insert into public.campaign_revision_steps (workspace_id, revision_id, step_index, kind)
  values
    (p_workspace_id, v_revision_id, 1, 'initial_question'),
    (p_workspace_id, v_revision_id, 2, 'inclusion_request'),
    (p_workspace_id, v_revision_id, 3, 'revision_request');

  update public.campaigns set draft_revision_id = v_revision_id where id = v_campaign_id;

  perform app_private.audit(p_workspace_id, 'campaign.created', 'campaign', v_campaign_id,
    jsonb_build_object('name', btrim(p_name)));
  return v_campaign_id;
end;
$$;

-- Copies a revision's configuration and steps into a new draft revision.
create or replace function app_private.copy_revision(
  p_source_revision_id uuid,
  p_target_campaign_id uuid,
  p_revision_number integer,
  p_for_duplicate boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src public.campaign_revisions%rowtype;
  v_new_id uuid;
begin
  select * into v_src from public.campaign_revisions r where r.id = p_source_revision_id;

  insert into public.campaign_revisions (
    workspace_id, campaign_id, revision_number, state,
    business_name, website_url, business_aliases, domain_aliases, category, location, language,
    connection_id, model, model_params, max_output_tokens, execution_mode,
    check_model, check_params, check_max_output_tokens,
    start_at, end_at, schedule_end_mode, duration_days, timezone, active_weekdays, active_start_minute, active_end_minute,
    conversations_per_day, total_conversation_limit, max_concurrency, requests_per_minute, tokens_per_minute,
    jitter_seconds, missed_slot_behavior, catch_up_max_delay_minutes, catch_up_max_per_day,
    daily_budget_usd, total_budget_usd,
    probe_set_id, baseline_samples, daily_checks, final_samples,
    on_existing_inclusion, selection_mode, selection_seed, created_by
  )
  values (
    v_src.workspace_id, p_target_campaign_id, p_revision_number, 'draft',
    v_src.business_name, v_src.website_url, v_src.business_aliases, v_src.domain_aliases,
    v_src.category, v_src.location, v_src.language,
    v_src.connection_id, v_src.model, v_src.model_params, v_src.max_output_tokens, v_src.execution_mode,
    v_src.check_model, v_src.check_params, v_src.check_max_output_tokens,
    -- A duplicated campaign needs its own schedule; an edit keeps the running one.
    case when p_for_duplicate then null else v_src.start_at end,
    case when p_for_duplicate then null else v_src.end_at end,
    v_src.schedule_end_mode,
    -- Revisions saved before a length in days was stored carry it only as the distance
    -- between their start and end.
    coalesce(v_src.duration_days, app_private.schedule_days(v_src)),
    v_src.timezone, v_src.active_weekdays, v_src.active_start_minute, v_src.active_end_minute,
    v_src.conversations_per_day, v_src.total_conversation_limit, v_src.max_concurrency,
    v_src.requests_per_minute, v_src.tokens_per_minute,
    v_src.jitter_seconds, v_src.missed_slot_behavior, v_src.catch_up_max_delay_minutes, v_src.catch_up_max_per_day,
    v_src.daily_budget_usd, v_src.total_budget_usd,
    v_src.probe_set_id, v_src.baseline_samples, v_src.daily_checks, v_src.final_samples,
    v_src.on_existing_inclusion, v_src.selection_mode,
    case when p_for_duplicate then app_private.new_seed() else v_src.selection_seed end,
    (select auth.uid())
  )
  returning id into v_new_id;

  insert into public.campaign_revision_steps (workspace_id, revision_id, step_index, kind, label)
  select s.workspace_id, v_new_id, s.step_index, s.kind, s.label
  from public.campaign_revision_steps s
  where s.revision_id = p_source_revision_id;

  -- Template versions are re-pinned when the new revision is frozen.
  insert into public.campaign_revision_step_templates (workspace_id, revision_id, step_index, position, template_id)
  select st.workspace_id, v_new_id, st.step_index, st.position, st.template_id
  from public.campaign_revision_step_templates st
  where st.revision_id = p_source_revision_id;

  return v_new_id;
end;
$$;

-- Saves the working copy. See 20261110070400 for the shape of p_patch.
create or replace function public.save_campaign_draft(p_campaign_id uuid, p_patch jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_rev public.campaign_revisions%rowtype;
  v_new public.campaign_revisions%rowtype;
  v_revision_id uuid;
  v_config jsonb;
  v_step jsonb;
  v_template_id uuid;
  v_position integer;
  v_index integer := 0;
  v_kind public.template_kind;
  v_allowed constant text[] := array[
    'business_name', 'website_url', 'business_aliases', 'domain_aliases', 'category', 'location', 'language',
    'connection_id', 'model', 'model_params', 'max_output_tokens', 'execution_mode',
    'check_model', 'check_params', 'check_max_output_tokens',
    'start_at', 'end_at', 'schedule_end_mode', 'duration_days', 'timezone', 'active_weekdays', 'active_start_minute', 'active_end_minute',
    'conversations_per_day', 'total_conversation_limit', 'max_concurrency', 'requests_per_minute', 'tokens_per_minute',
    'jitter_seconds', 'missed_slot_behavior', 'catch_up_max_delay_minutes', 'catch_up_max_per_day',
    'daily_budget_usd', 'total_budget_usd',
    'probe_set_id', 'baseline_samples', 'daily_checks', 'final_samples',
    'on_existing_inclusion', 'selection_mode', 'selection_seed'
  ];
begin
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id for no key update;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(v_campaign.workspace_id, 'admin');
  if v_campaign.archived_at is not null then
    perform app_private.fail('campaign_archived', 'Restore this campaign from the archive before editing it.');
  end if;

  v_revision_id := coalesce(v_campaign.draft_revision_id, public.begin_campaign_edit(p_campaign_id));
  select * into v_rev from public.campaign_revisions r where r.id = v_revision_id for no key update;

  if p_patch ? 'name' then
    if char_length(btrim(coalesce(p_patch ->> 'name', ''))) not between 1 and 120 then
      perform app_private.fail('invalid_name', 'Enter a campaign name between 1 and 120 characters.');
    end if;
    update public.campaigns set name = btrim(p_patch ->> 'name') where id = p_campaign_id;
  end if;
  if p_patch ? 'description' then
    update public.campaigns
    set description = nullif(left(btrim(coalesce(p_patch ->> 'description', '')), 2000), '')
    where id = p_campaign_id;
  end if;

  if jsonb_typeof(p_patch -> 'config') = 'object' then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_config
    from jsonb_each(p_patch -> 'config') e
    where e.key = any (v_allowed);

    if v_config ? 'timezone' and (v_config ->> 'timezone') is not null and not exists (
      select 1 from pg_catalog.pg_timezone_names z where z.name = v_config ->> 'timezone'
    ) then
      perform app_private.fail('invalid_timezone', 'Choose a valid IANA timezone.');
    end if;

    begin
      v_new := jsonb_populate_record(v_rev, v_config);

      -- The start of a campaign that has started is fixed. The form sends it back the way it
      -- shows it, to the minute on the campaign's clock: a value that reads the same is the
      -- stored start, not a change to it. A real change is stored, and refused when applied.
      if v_campaign.started_at is not null and v_rev.start_at is not null
         and v_new.start_at is not null and v_rev.timezone is not null
         and to_char(v_new.start_at at time zone v_rev.timezone, 'YYYY-MM-DD HH24:MI')
           = to_char(v_rev.start_at at time zone v_rev.timezone, 'YYYY-MM-DD HH24:MI') then
        v_new.start_at := v_rev.start_at;
      end if;

      -- An output cap carried over from another model may be more than the new model was
      -- verified for. Unless this save sets the cap itself, the new model's standard one
      -- replaces it (it is filled in below).
      if (v_new.model is distinct from v_rev.model or v_new.connection_id is distinct from v_rev.connection_id)
         and v_new.max_output_tokens is not distinct from v_rev.max_output_tokens
         and v_new.max_output_tokens > (
           select (m.capabilities ->> 'max_output_tokens_verified')::integer
           from public.provider_models m
           where m.connection_id = v_new.connection_id and m.model_id = v_new.model
             and m.verification_status = 'verified'
         ) then
        v_new.max_output_tokens := null;
      end if;

      -- A length in days fixes the end as soon as there is a start to count from, on the
      -- campaign's own clock; with an open start the end stays open until the launch. A caller
      -- that still sends an end instead of a length keeps it, and the length is noted from it.
      if coalesce(v_new.schedule_end_mode, 'end_time') = 'duration' then
        if v_new.duration_days is null then
          v_new.duration_days := app_private.schedule_days(v_new);
        elsif v_new.start_at is not null and v_new.timezone is not null then
          v_new.end_at := ((v_new.start_at at time zone v_new.timezone) + make_interval(days => v_new.duration_days))
                            at time zone v_new.timezone;
        else
          v_new.end_at := null;
        end if;
      end if;
      update public.campaign_revisions r
      set business_name = nullif(btrim(v_new.business_name), ''),
          website_url = nullif(btrim(v_new.website_url), ''),
          business_aliases = coalesce((
            select array_agg(distinct btrim(a)) from unnest(v_new.business_aliases) a where btrim(a) <> ''
          ), '{}'::text[]),
          domain_aliases = coalesce((
            select array_agg(distinct lower(btrim(a))) from unnest(v_new.domain_aliases) a where btrim(a) <> ''
          ), '{}'::text[]),
          category = nullif(btrim(v_new.category), ''),
          location = nullif(btrim(v_new.location), ''),
          language = nullif(btrim(v_new.language), ''),
          connection_id = v_new.connection_id,
          model = nullif(btrim(v_new.model), ''),
          model_params = coalesce(v_new.model_params, '{}'::jsonb),
          max_output_tokens = v_new.max_output_tokens,
          execution_mode = coalesce(v_new.execution_mode, 'auto'),
          check_model = nullif(btrim(v_new.check_model), ''),
          check_params = v_new.check_params,
          check_max_output_tokens = v_new.check_max_output_tokens,
          start_at = v_new.start_at,
          end_at = v_new.end_at,
          schedule_end_mode = coalesce(v_new.schedule_end_mode, 'end_time'),
          duration_days = v_new.duration_days,
          timezone = v_new.timezone,
          active_weekdays = (select array_agg(distinct d order by d) from unnest(v_new.active_weekdays) d),
          active_start_minute = v_new.active_start_minute,
          active_end_minute = v_new.active_end_minute,
          conversations_per_day = v_new.conversations_per_day,
          total_conversation_limit = v_new.total_conversation_limit,
          max_concurrency = v_new.max_concurrency,
          requests_per_minute = v_new.requests_per_minute,
          tokens_per_minute = v_new.tokens_per_minute,
          jitter_seconds = coalesce(v_new.jitter_seconds, 0),
          missed_slot_behavior = v_new.missed_slot_behavior,
          catch_up_max_delay_minutes = v_new.catch_up_max_delay_minutes,
          catch_up_max_per_day = v_new.catch_up_max_per_day,
          daily_budget_usd = v_new.daily_budget_usd,
          total_budget_usd = v_new.total_budget_usd,
          probe_set_id = v_new.probe_set_id,
          baseline_samples = v_new.baseline_samples,
          daily_checks = v_new.daily_checks,
          final_samples = v_new.final_samples,
          on_existing_inclusion = v_new.on_existing_inclusion,
          selection_mode = coalesce(v_new.selection_mode, 'balanced'),
          selection_seed = coalesce(nullif(btrim(v_new.selection_seed), ''), r.selection_seed, app_private.new_seed())
      where r.id = v_revision_id;
    exception
      when foreign_key_violation then
        perform app_private.fail('invalid_reference', 'The selected connection or question set does not belong to this workspace.');
      when check_violation then
        perform app_private.fail('invalid_value', 'One of the campaign settings is out of range. ' || sqlerrm);
      when invalid_text_representation or datetime_field_overflow or invalid_datetime_format
        or numeric_value_out_of_range or invalid_parameter_value then
        perform app_private.fail('invalid_value', 'One of the campaign settings has an invalid value.');
    end;
  end if;

  if jsonb_typeof(p_patch -> 'steps') = 'array' then
    if jsonb_array_length(p_patch -> 'steps') > 12 then
      perform app_private.fail('too_many_steps', 'A conversation can have at most 12 steps.');
    end if;
    delete from public.campaign_revision_steps where revision_id = v_revision_id;

    for v_step in select value from jsonb_array_elements(p_patch -> 'steps') loop
      v_index := v_index + 1;
      v_kind := (case v_index
        when 1 then 'initial_question'
        when 2 then 'inclusion_request'
        when 3 then 'revision_request'
        else 'extra_step'
      end)::public.template_kind;
      insert into public.campaign_revision_steps (workspace_id, revision_id, step_index, kind, label)
      values (
        v_campaign.workspace_id, v_revision_id, v_index, v_kind,
        nullif(left(btrim(coalesce(v_step ->> 'label', '')), 120), '')
      );

      v_position := 0;
      for v_template_id in
        select (t.value #>> '{}')::uuid
        from jsonb_array_elements(coalesce(v_step -> 'template_ids', '[]'::jsonb)) with ordinality as t(value, ord)
        order by t.ord
      loop
        v_position := v_position + 1;
        if v_position > 500 then
          perform app_private.fail('too_many_templates', 'A step can use at most 500 wordings.');
        end if;
        if not exists (
          select 1 from public.templates t
          where t.id = v_template_id and t.workspace_id = v_campaign.workspace_id and t.kind = v_kind
        ) then
          perform app_private.fail('invalid_template', format('Step %s references a prompt that does not exist or has a different type.', v_index));
        end if;
        insert into public.campaign_revision_step_templates (workspace_id, revision_id, step_index, position, template_id)
        values (v_campaign.workspace_id, v_revision_id, v_index, v_position, v_template_id)
        on conflict (revision_id, step_index, template_id) do nothing;
      end loop;
    end loop;

    if v_index < 3 then
      perform app_private.fail('steps_missing', 'The conversation needs its three steps: question, inclusion request and revised-list request.');
    end if;
  end if;

  -- A setting left blank takes its standard value, so that clearing a field can never be
  -- what stands between a campaign and its launch.
  perform app_private.fill_revision_defaults(v_revision_id);
  return v_revision_id;
end;
$$;

create or replace function app_private.freeze_revision(
  p_revision_id uuid,
  p_scope text,
  p_validation jsonb,
  p_now timestamptz
)
returns public.campaign_revisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rev public.campaign_revisions%rowtype;
  v_campaign public.campaigns%rowtype;
  v_problems jsonb;
  v_check record;
  v_est record;
  v_price public.model_prices;
  v_check_price public.model_prices;
  v_version_id uuid;
  v_group_id uuid;
  v_signature text;
  v_checks_enabled boolean;
begin
  select * into v_rev from public.campaign_revisions r where r.id = p_revision_id for no key update;
  if v_rev.state <> 'draft' then
    perform app_private.fail('revision_not_draft', 'This configuration has already been applied.');
  end if;
  select * into v_campaign from public.campaigns c where c.id = v_rev.campaign_id;

  v_problems := app_private.revision_problems(p_revision_id, p_scope, p_now);
  if jsonb_array_length(v_problems) > 0 then
    raise exception using
      errcode = 'P0001',
      message = v_problems -> 0 ->> 'message',
      detail = 'campaign_invalid',
      hint = v_problems::text;
  end if;

  -- A draft may leave its start open and give its length in days. Both are settled at this
  -- moment, after the checks above have judged exactly these values, and while the row is
  -- still a draft: from here on the revision holds fixed instants like any other.
  if v_rev.start_at is null or v_rev.end_at is null then
    update public.campaign_revisions r
    set start_at = s.start_at, end_at = s.end_at
    from app_private.effective_schedule(v_rev, p_now) s
    where r.id = p_revision_id
    returning r.* into v_rev;
  end if;

  -- Pin exact template versions.
  perform set_config('app.freezing_revision', p_revision_id::text, true);
  update public.campaign_revision_step_templates st
  set template_version_id = t.current_version_id
  from public.templates t
  where st.revision_id = p_revision_id and t.id = st.template_id;

  v_checks_enabled := v_rev.baseline_samples + v_rev.daily_checks + v_rev.final_samples > 0;
  select * into v_check from app_private.check_settings(v_rev);
  v_price := app_private.current_price(v_rev.workspace_id, v_rev.model);
  v_check_price := app_private.current_price(v_rev.workspace_id, v_check.model);

  if v_checks_enabled then
    select s.current_version_id into v_version_id from public.probe_sets s where s.id = v_rev.probe_set_id;
    v_signature := md5(concat_ws('|',
      v_version_id::text, v_check.model, v_check.params::text, v_check.max_output_tokens::text,
      v_rev.baseline_samples::text, v_rev.daily_checks::text, v_rev.final_samples::text, v_rev.selection_seed
    ));
    select g.id into v_group_id
    from public.comparison_groups g
    where g.campaign_id = v_rev.campaign_id and g.signature = v_signature;
    if v_group_id is null then
      insert into public.comparison_groups (
        workspace_id, campaign_id, sequence, signature, probe_set_version_id, model, params, max_output_tokens,
        baseline_samples, daily_checks, final_samples, selection_seed, started_mid_campaign, first_revision_id
      )
      values (
        v_rev.workspace_id, v_rev.campaign_id,
        (select coalesce(max(g.sequence), 0) + 1 from public.comparison_groups g where g.campaign_id = v_rev.campaign_id),
        v_signature, v_version_id, v_check.model, v_check.params, v_check.max_output_tokens,
        v_rev.baseline_samples, v_rev.daily_checks, v_rev.final_samples, v_rev.selection_seed,
        v_campaign.baseline_completed_at is not null,
        p_revision_id
      )
      returning id into v_group_id;
    end if;
  end if;

  update public.campaign_revisions
  set probe_set_version_id = case when v_checks_enabled then v_version_id else null end
  where id = p_revision_id
  returning * into v_rev;
  select * into v_est from app_private.revision_estimates(v_rev);

  update public.campaign_revisions
  set state = 'frozen',
      frozen_at = p_now,
      frozen_by = (select auth.uid()),
      price_id = v_price.id,
      check_price_id = case when v_checks_enabled then v_check_price.id else null end,
      comparison_group_id = v_group_id,
      cohort_key = md5(concat_ws('|', v_rev.model, v_rev.model_params::text, v_rev.max_output_tokens::text)),
      est_run_max_cost_usd = v_est.est_run_max_cost_usd,
      est_check_max_cost_usd = v_est.est_check_max_cost_usd,
      final_check_set_aside_usd = coalesce(v_rev.final_samples * v_est.est_check_max_cost_usd, 0),
      validation = coalesce(p_validation, '{}'::jsonb)
  where id = p_revision_id
  returning * into v_rev;

  perform set_config('app.freezing_revision', '', true);
  return v_rev;
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
  v_start timestamptz;
  v_end timestamptz;
  v_first_slot timestamptz;
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

  -- A draft that leaves its start open is planned as if it were launched now.
  select s.start_at, s.end_at into v_start, v_end from app_private.effective_schedule(v_rev, now()) s;

  if v_start is not null and v_end is not null and v_rev.timezone is not null
     and v_rev.active_weekdays is not null and v_rev.active_start_minute is not null
     and v_rev.active_end_minute is not null and v_rev.conversations_per_day is not null
     and v_end > v_start
     and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_rev.timezone) then
    v_first := (v_start at time zone v_rev.timezone)::date;
    v_last := (v_end at time zone v_rev.timezone)::date;
    -- Bound the walk: three years of days is plenty for a preview.
    v_last := least(v_last, v_first + 1095);

    for v_day in select d::date from generate_series(v_first, v_last, interval '1 day') d loop
      if v_day = v_first or v_day = v_last then
        -- Partial days: count the exact slots inside [start, end).
        select count(*) into v_conv
        from app_private.day_slots(v_rev, v_day, v_rev.conversations_per_day, 0, 'conversation') s
        where s.slot_at >= v_start and s.slot_at < v_end;
        select count(*) into v_checks
        from app_private.day_slots(v_rev, v_day, coalesce(v_rev.daily_checks, 0), 0.5, 'check_daily') s
        where s.slot_at >= v_start and s.slot_at < v_end;
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

      -- Conversations sit on an even grid across each day's active hours, so the first one is
      -- the next point of that grid, not the start itself.
      if v_first_slot is null and v_conv > 0 then
        select min(s.slot_at) into v_first_slot
        from app_private.day_slots(v_rev, v_day, v_rev.conversations_per_day, 0, 'conversation') s
        where s.slot_at >= v_start and s.slot_at < v_end;
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
    'timezone', v_rev.timezone,
    -- What the plan above assumed: the stored times, or a launch at this moment.
    'starts_at_launch', v_rev.start_at is null,
    'schedule_end_mode', v_rev.schedule_end_mode,
    'duration_days', v_rev.duration_days,
    'planned_start_at', v_start,
    'planned_end_at', v_end,
    'first_conversation_at', v_first_slot
  );
end;
$$;

-- Lets the interface fill in the browser's timezone on a draft that has none. It never replaces
-- a timezone that is already set, and it only touches a draft that has not been launched.
create or replace function public.suggest_campaign_timezone(p_campaign_id uuid, p_timezone text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns%rowtype;
begin
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id for no key update;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(v_campaign.workspace_id, 'admin');
  if v_campaign.status <> 'draft' or v_campaign.draft_revision_id is null or v_campaign.archived_at is not null then
    return false;
  end if;
  if p_timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone
  ) then
    return false;
  end if;
  update public.campaign_revisions r
  set timezone = p_timezone
  where r.id = v_campaign.draft_revision_id and r.state = 'draft' and r.timezone is null;
  return found;
end;
$$;

-- New objects are closed by default (20261110071100): grant exactly what is needed. The function
-- checks the caller's role itself. The helpers above stay internal.
revoke all on function public.suggest_campaign_timezone(uuid, text) from public, anon, authenticated;
grant execute on function public.suggest_campaign_timezone(uuid, text) to authenticated;
revoke all on function app_private.schedule_days(public.campaign_revisions) from public, anon, authenticated;
revoke all on function app_private.effective_schedule(public.campaign_revisions, timestamptz) from public, anon, authenticated;
revoke all on function app_private.fill_revision_defaults(uuid) from public, anon, authenticated;

-- Existing drafts, once. Frozen revisions are not touched: they never change.
--   * a length in days that was only stored as the distance between start and end;
--   * a draft with neither a start nor an end is asked for a length in days, not for a date;
--   * the standard value of every setting left blank.
update public.campaign_revisions r
set duration_days = app_private.schedule_days(r)
where r.state = 'draft' and r.duration_days is null and app_private.schedule_days(r) is not null;

update public.campaign_revisions r
set schedule_end_mode = 'duration'
where r.state = 'draft' and r.schedule_end_mode = 'end_time' and r.start_at is null and r.end_at is null;

do $$
declare
  v_id uuid;
begin
  for v_id in select r.id from public.campaign_revisions r where r.state = 'draft' loop
    perform app_private.fill_revision_defaults(v_id);
  end loop;
end;
$$;
