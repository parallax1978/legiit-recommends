-- Legiit Recommends — campaign drafts, validation, immutable revisions and lifecycle.

-- ---------------------------------------------------------------------------------------------
-- Cost model (single source of truth for reservations, estimates and reconciliation)
-- ---------------------------------------------------------------------------------------------

-- Conservative token estimate for a piece of text: one token per two UTF-8 bytes. Typical
-- English text is closer to four bytes per token, so this over-reserves on purpose.
create or replace function app_private.estimate_text_tokens(p_text text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select ceil(octet_length(coalesce(p_text, '')) / 2.0)::integer;
$$;

-- Per-message and per-request framing overhead used by every estimate.
create or replace function app_private.message_overhead_tokens()
returns integer language sql immutable set search_path = '' as $$ select 16 $$;
create or replace function app_private.request_overhead_tokens()
returns integer language sql immutable set search_path = '' as $$ select 32 $$;

-- Worst-case cost of one request: every input token billed at the most expensive input rate
-- (including prompt-cache writes), the full output cap, and the long-context surcharge.
create or replace function app_private.max_cost(
  p_price public.model_prices,
  p_input_tokens integer,
  p_max_output_tokens integer
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_in_rate numeric;
  v_in_mult numeric := 1;
  v_out_mult numeric := 1;
begin
  if p_price.id is null then
    return null;
  end if;
  v_in_rate := greatest(
    p_price.input_usd_per_mtok,
    coalesce(p_price.cache_write_30m_usd_per_mtok, 0),
    coalesce(p_price.cache_write_12h_usd_per_mtok, 0)
  );
  if p_price.long_context_threshold_tokens is not null
     and coalesce(p_input_tokens, 0) > p_price.long_context_threshold_tokens then
    v_in_mult := p_price.long_context_input_multiplier;
    v_out_mult := p_price.long_context_output_multiplier;
  end if;
  return ceil(
    (
      coalesce(p_input_tokens, 0) * v_in_rate * v_in_mult
      + coalesce(p_max_output_tokens, 0) * p_price.output_usd_per_mtok * v_out_mult
    ) * 100
  ) / 100000000.0;
end;
$$;

-- Usage-based cost estimate from returned token counts.
create or replace function app_private.usage_cost(
  p_price public.model_prices,
  p_input_tokens integer,
  p_cached_tokens integer,
  p_cache_write_tokens integer,
  p_cache_write_30m_tokens integer,
  p_cache_write_12h_tokens integer,
  p_output_tokens integer
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_input integer := coalesce(p_input_tokens, 0);
  v_cached integer := least(coalesce(p_cached_tokens, 0), v_input);
  v_cw30 integer := coalesce(p_cache_write_30m_tokens, 0);
  v_cw12 integer := coalesce(p_cache_write_12h_tokens, 0);
  v_cw_total integer := greatest(coalesce(p_cache_write_tokens, 0), v_cw30 + v_cw12);
  v_cw_other integer;
  v_uncached integer;
  v_in_mult numeric := 1;
  v_out_mult numeric := 1;
  v_cost numeric;
begin
  if p_price.id is null then
    return null;
  end if;
  v_cw_other := v_cw_total - v_cw30 - v_cw12;
  v_uncached := greatest(v_input - v_cached - v_cw_total, 0);
  if p_price.long_context_threshold_tokens is not null and v_input > p_price.long_context_threshold_tokens then
    v_in_mult := p_price.long_context_input_multiplier;
    v_out_mult := p_price.long_context_output_multiplier;
  end if;
  v_cost :=
    (
      v_uncached * p_price.input_usd_per_mtok
      + v_cached * coalesce(p_price.cached_input_usd_per_mtok, p_price.input_usd_per_mtok)
      + (v_cw30 + v_cw_other) * coalesce(p_price.cache_write_30m_usd_per_mtok, p_price.input_usd_per_mtok)
      + v_cw12 * coalesce(p_price.cache_write_12h_usd_per_mtok, p_price.input_usd_per_mtok)
    ) * v_in_mult
    + coalesce(p_output_tokens, 0) * p_price.output_usd_per_mtok * v_out_mult;
  return round(v_cost / 1000000.0, 8);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Revision helpers
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.revision_variables(p_rev public.campaign_revisions)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'business_name', coalesce(btrim(p_rev.business_name), ''),
    'website_url', coalesce(btrim(p_rev.website_url), ''),
    'category', coalesce(btrim(p_rev.category), ''),
    'location', coalesce(btrim(p_rev.location), ''),
    'language', coalesce(btrim(p_rev.language), '')
  );
$$;

-- Host part of a website URL, lower-cased, without scheme, "www.", port or path.
create or replace function app_private.url_host(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      split_part(split_part(split_part(
        regexp_replace(lower(btrim(coalesce(p_url, ''))), '^[a-z][a-z0-9+.-]*://', ''),
      '/', 1), '?', 1), '#', 1),
      '^(www\.)|(:\d+)$', '', 'g'
    ),
    ''
  );
$$;

-- True when `p_text` contains `p_term` as a whole word (case-insensitive).
create or replace function app_private.contains_term(p_text text, p_term text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when char_length(btrim(coalesce(p_term, ''))) < 2 then false
    else coalesce(p_text, '') ~* (
      '(^|[^[:alnum:]])'
      || regexp_replace(btrim(p_term), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')
      || '($|[^[:alnum:]])'
    )
  end;
$$;

-- The effective fresh-check model settings for a revision.
create or replace function app_private.check_settings(p_rev public.campaign_revisions)
returns table (model text, params jsonb, max_output_tokens integer)
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_rev.check_model, p_rev.model),
         case when p_rev.check_model is null then coalesce(p_rev.check_params, p_rev.model_params)
              else coalesce(p_rev.check_params, '{}'::jsonb) end,
         coalesce(p_rev.check_max_output_tokens, p_rev.max_output_tokens);
$$;

-- Worst-case cost of one conversation and of one fresh check for a revision.
create or replace function app_private.revision_estimates(p_rev public.campaign_revisions)
returns table (est_run_max_cost_usd numeric, est_check_max_cost_usd numeric, steps integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vars jsonb := app_private.revision_variables(p_rev);
  v_price public.model_prices;
  v_check_price public.model_prices;
  v_check record;
  v_step record;
  v_context integer := app_private.request_overhead_tokens();
  v_input integer;
  v_run numeric := 0;
  v_steps integer := 0;
  v_question_tokens integer;
begin
  v_price := app_private.current_price(p_rev.workspace_id, p_rev.model);
  select * into v_check from app_private.check_settings(p_rev);
  v_check_price := app_private.current_price(p_rev.workspace_id, v_check.model);

  for v_step in
    select s.step_index,
           coalesce(max(app_private.estimate_text_tokens(app_private.render_template(tv.body, v_vars))), 0) as prompt_tokens
    from public.campaign_revision_steps s
    left join public.campaign_revision_step_templates st
      on st.revision_id = s.revision_id and st.step_index = s.step_index
    left join public.templates t on t.id = st.template_id
    left join public.template_versions tv on tv.id = coalesce(st.template_version_id, t.current_version_id)
    where s.revision_id = p_rev.id
    group by s.step_index
    order by s.step_index
  loop
    v_steps := v_steps + 1;
    v_input := v_context + v_step.prompt_tokens + app_private.message_overhead_tokens();
    v_run := v_run + coalesce(app_private.max_cost(v_price, v_input, p_rev.max_output_tokens), 0);
    v_context := v_input + coalesce(p_rev.max_output_tokens, 0);
  end loop;

  select coalesce(max(app_private.estimate_text_tokens(app_private.render_template(q.body, v_vars))), 0)
  into v_question_tokens
  from public.probe_questions q
  where q.probe_set_version_id = coalesce(
    p_rev.probe_set_version_id,
    (select s.current_version_id from public.probe_sets s where s.id = p_rev.probe_set_id)
  );

  est_run_max_cost_usd := case when v_price.id is null or p_rev.max_output_tokens is null then null else v_run end;
  est_check_max_cost_usd := app_private.max_cost(
    v_check_price,
    app_private.request_overhead_tokens() + v_question_tokens + app_private.message_overhead_tokens(),
    v_check.max_output_tokens
  );
  steps := v_steps;
  return next;
end;
$$;

-- Validates model parameters against the capability profile discovered for the model.
-- Returns NULL when compatible, otherwise a message.
create or replace function app_private.params_problem(
  p_capabilities jsonb,
  p_params jsonb,
  p_max_output_tokens integer,
  p_needs_chaining boolean,
  p_execution_mode text
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key text;
  v_effort text := p_params ->> 'reasoning_effort';
  v_limit integer := (p_capabilities ->> 'max_output_tokens_limit')::integer;
  v_verified integer := (p_capabilities ->> 'max_output_tokens_verified')::integer;
  v_support text;
begin
  for v_key in select jsonb_object_keys(coalesce(p_params, '{}'::jsonb)) loop
    if v_key not in ('temperature', 'top_p', 'reasoning_effort', 'verbosity') then
      return format('Unknown model parameter "%s".', v_key);
    end if;
  end loop;

  if v_effort is not null and not coalesce(p_capabilities -> 'reasoning_efforts' ? v_effort, false) then
    return format('This model does not accept reasoning effort "%s".', v_effort);
  end if;

  foreach v_key in array array['temperature', 'top_p'] loop
    if p_params ? v_key then
      v_support := coalesce(p_capabilities ->> v_key, 'never');
      if v_support = 'never' then
        return format('This model does not accept the %s parameter.', v_key);
      elsif v_support = 'effort_none' and v_effort is distinct from 'none' then
        return format('This model accepts %s only when reasoning effort is "none".', v_key);
      end if;
      if jsonb_typeof(p_params -> v_key) <> 'number' then
        return format('%s must be a number.', v_key);
      end if;
      if v_key = 'temperature' and ((p_params ->> v_key)::numeric < 0 or (p_params ->> v_key)::numeric > 2) then
        return 'temperature must be between 0 and 2.';
      end if;
      if v_key = 'top_p' and ((p_params ->> v_key)::numeric <= 0 or (p_params ->> v_key)::numeric > 1) then
        return 'top_p must be greater than 0 and at most 1.';
      end if;
    end if;
  end loop;

  if p_params ? 'verbosity' and not coalesce(p_capabilities -> 'verbosity' ? (p_params ->> 'verbosity'), false) then
    return format('This model does not accept verbosity "%s".', p_params ->> 'verbosity');
  end if;

  if p_max_output_tokens is not null then
    if p_max_output_tokens < 16 then
      return 'Maximum output tokens must be at least 16.';
    end if;
    if v_limit is not null and p_max_output_tokens > v_limit then
      return format('Maximum output tokens cannot exceed %s for this model.', v_limit);
    end if;
    if v_verified is not null and p_max_output_tokens > v_verified then
      return format('Output caps above %s tokens have not been verified for this model. An owner can verify it again with a higher cap in Settings.', v_verified);
    end if;
  end if;

  if p_needs_chaining and not coalesce((p_capabilities ->> 'chaining')::boolean, false) then
    return 'Multi-turn chaining with stored responses is not available for this model on this connection.';
  end if;
  if p_execution_mode = 'background' and not coalesce((p_capabilities ->> 'background')::boolean, false) then
    return 'Background responses are not available for this model on this connection.';
  end if;
  return null;
end;
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
  if v_full and nullif(btrim(coalesce(v_rev.category, '')), '') is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'category', 'message', 'Enter the category or topic.');
  end if;
  if v_full and nullif(btrim(coalesce(v_rev.language, '')), '') is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'language', 'message', 'Choose the language.');
  end if;

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
  if v_rev.max_output_tokens is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'max_output_tokens', 'message', 'Enter the maximum output tokens per turn.');
  end if;

  if not v_full then
    return v_out;
  end if;

  -- Schedule --------------------------------------------------------------------------------
  if v_rev.start_at is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'start_at', 'message', 'Choose a start time.');
  end if;
  if v_rev.end_at is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'end_at', 'message', 'Choose an end time or a duration.');
  elsif v_rev.end_at <= p_now then
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
  if v_rev.daily_budget_usd is null then
    v_out := v_out || jsonb_build_object('code', 'required', 'field', 'daily_budget_usd', 'message', 'Enter a daily budget.');
  end if;
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

-- ---------------------------------------------------------------------------------------------
-- Drafts
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.new_seed()
returns text
language sql
volatile
set search_path = ''
as $$
  select encode(extensions.gen_random_bytes(8), 'hex');
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

  insert into public.campaign_revisions (workspace_id, campaign_id, revision_number, selection_seed, created_by)
  values (p_workspace_id, v_campaign_id, 1, app_private.new_seed(), (select auth.uid()))
  returning id into v_revision_id;

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
    start_at, end_at, schedule_end_mode, timezone, active_weekdays, active_start_minute, active_end_minute,
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
    v_src.schedule_end_mode, v_src.timezone, v_src.active_weekdays, v_src.active_start_minute, v_src.active_end_minute,
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

-- Returns the editable draft revision, creating one from the active revision when needed.
create or replace function public.begin_campaign_edit(p_campaign_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_number integer;
  v_revision_id uuid;
begin
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id for no key update;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(v_campaign.workspace_id, 'admin');

  if v_campaign.draft_revision_id is not null then
    return v_campaign.draft_revision_id;
  end if;
  if v_campaign.status in ('completed', 'canceled', 'finalizing') then
    perform app_private.fail('campaign_not_editable', 'This campaign has finished and can no longer be edited. Duplicate it to run it again.');
  end if;

  select coalesce(max(r.revision_number), 0) + 1 into v_number
  from public.campaign_revisions r where r.campaign_id = p_campaign_id;
  v_revision_id := app_private.copy_revision(v_campaign.active_revision_id, p_campaign_id, v_number, false);
  update public.campaigns set draft_revision_id = v_revision_id where id = p_campaign_id;
  return v_revision_id;
end;
$$;

-- Saves the working copy. p_patch may contain:
--   name, description                      campaign fields
--   config: {...}                          whitelisted revision columns (partial)
--   steps: [{step_index, kind, label, template_ids: [...]}]   full replacement of the sequence
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
    'start_at', 'end_at', 'schedule_end_mode', 'timezone', 'active_weekdays', 'active_start_minute', 'active_end_minute',
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

  return v_revision_id;
end;
$$;

create or replace function public.discard_campaign_draft(p_campaign_id uuid)
returns void
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
  if v_campaign.status = 'draft' or v_campaign.draft_revision_id is null then
    return;
  end if;
  update public.campaigns set draft_revision_id = null where id = p_campaign_id;
  update public.campaign_revisions set state = 'discarded' where id = v_campaign.draft_revision_id;
  perform app_private.audit(v_campaign.workspace_id, 'campaign.draft_discarded', 'campaign', p_campaign_id, '{}'::jsonb);
end;
$$;

create or replace function public.duplicate_campaign(p_campaign_id uuid, p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_new_id uuid;
  v_revision_id uuid;
  v_name text;
begin
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(v_campaign.workspace_id, 'admin');

  v_name := left(coalesce(nullif(btrim(coalesce(p_name, '')), ''), v_campaign.name || ' (copy)'), 120);
  insert into public.campaigns (workspace_id, name, description, created_by)
  values (v_campaign.workspace_id, v_name, v_campaign.description, (select auth.uid()))
  returning id into v_new_id;

  v_revision_id := app_private.copy_revision(
    coalesce(v_campaign.draft_revision_id, v_campaign.active_revision_id), v_new_id, 1, true
  );
  update public.campaigns set draft_revision_id = v_revision_id where id = v_new_id;

  perform app_private.audit(v_campaign.workspace_id, 'campaign.duplicated', 'campaign', v_new_id,
    jsonb_build_object('source_campaign_id', p_campaign_id));
  return v_new_id;
end;
$$;

create or replace function public.set_campaign_archived(p_campaign_id uuid, p_archived boolean)
returns void
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
  if p_archived and v_campaign.status not in ('draft', 'completed', 'canceled') then
    perform app_private.fail('campaign_active', 'Cancel or finish the campaign before archiving it.');
  end if;
  update public.campaigns
  set archived_at = case when p_archived then now() else null end
  where id = p_campaign_id;
  perform app_private.audit(v_campaign.workspace_id,
    case when p_archived then 'campaign.archived' else 'campaign.restored' end,
    'campaign', p_campaign_id, '{}'::jsonb);
end;
$$;

-- Deleting removes every record of the campaign. Admins may delete drafts that never launched;
-- anything with results requires an owner.
create or replace function public.delete_campaign(p_campaign_id uuid)
returns void
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
  if v_campaign.status = 'draft' and v_campaign.launched_at is null
     and not exists (select 1 from public.runs r where r.campaign_id = p_campaign_id) then
    perform app_private.require_role(v_campaign.workspace_id, 'admin');
  else
    perform app_private.require_role(v_campaign.workspace_id, 'owner');
  end if;
  if v_campaign.status in ('scheduled', 'baseline', 'running', 'paused', 'finalizing') then
    perform app_private.fail('campaign_active', 'Cancel the campaign before deleting it.');
  end if;
  if exists (
    select 1 from public.jobs j
    where j.campaign_id = p_campaign_id and j.status in ('queued', 'running', 'waiting')
  ) then
    perform app_private.fail('campaign_busy', 'Requests for this campaign are still in flight. Try again in a few minutes.');
  end if;

  perform app_private.audit(v_campaign.workspace_id, 'campaign.deleted', 'campaign', p_campaign_id,
    jsonb_build_object('name', v_campaign.name, 'status', v_campaign.status));
  set constraints all deferred;
  delete from public.campaigns where id = p_campaign_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Freezing a revision
-- ---------------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------------
-- Lifecycle
-- ---------------------------------------------------------------------------------------------

-- Problems that block launch (or applying edits), for display before activation.
create or replace function public.campaign_launch_check(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_revision_id uuid;
begin
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(v_campaign.workspace_id, 'member');
  v_revision_id := coalesce(v_campaign.draft_revision_id, v_campaign.active_revision_id);
  return jsonb_build_object(
    'revision_id', v_revision_id,
    'problems', app_private.revision_problems(
      v_revision_id, case when v_campaign.status = 'draft' then 'launch' else 'apply' end
    ),
    'test_problems', app_private.revision_problems(v_revision_id, 'test')
  );
end;
$$;

-- Activates a draft campaign. Paid work begins only after this explicit action.
create or replace function public.launch_campaign(
  p_campaign_id uuid,
  p_expected_revision_id uuid,
  p_validation jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_rev public.campaign_revisions%rowtype;
  v_now timestamptz := now();
begin
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id for no key update;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(v_campaign.workspace_id, 'admin');
  if v_campaign.status <> 'draft' then
    perform app_private.fail('already_launched', 'This campaign has already been launched.');
  end if;
  if v_campaign.archived_at is not null then
    perform app_private.fail('campaign_archived', 'Restore this campaign from the archive before launching it.');
  end if;
  if v_campaign.draft_revision_id is distinct from p_expected_revision_id then
    perform app_private.fail('stale_review', 'The campaign changed after you reviewed it. Review it again before launching.');
  end if;

  v_rev := app_private.freeze_revision(v_campaign.draft_revision_id, 'launch', p_validation, v_now);
  update public.campaign_revisions set effective_at = v_now where id = v_rev.id;

  update public.campaigns
  set status = 'scheduled',
      active_revision_id = v_rev.id,
      draft_revision_id = null,
      launched_at = v_now,
      launched_by = (select auth.uid()),
      planned_through = null
  where id = p_campaign_id;

  perform app_private.audit(v_campaign.workspace_id, 'campaign.launched', 'campaign', p_campaign_id,
    jsonb_build_object('revision_id', v_rev.id, 'revision_number', v_rev.revision_number,
      'start_at', v_rev.start_at, 'end_at', v_rev.end_at));

  -- Start immediately when the start time has already arrived.
  perform app_private.plan_campaign(p_campaign_id, v_now);
  perform app_private.dispatch(v_now);
  return jsonb_build_object('revision_id', v_rev.id, 'status', (select c.status from public.campaigns c where c.id = p_campaign_id));
end;
$$;

-- Applies pending edits to a launched campaign as a new immutable revision for future work.
create or replace function public.apply_campaign_changes(
  p_campaign_id uuid,
  p_expected_revision_id uuid,
  p_validation jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_old public.campaign_revisions%rowtype;
  v_rev public.campaign_revisions%rowtype;
  v_now timestamptz := now();
  v_job record;
  v_new_group boolean;
begin
  select * into v_campaign from public.campaigns c where c.id = p_campaign_id for no key update;
  if not found then
    perform app_private.forbid('Campaign not found or access denied.');
  end if;
  perform app_private.require_role(v_campaign.workspace_id, 'admin');
  if v_campaign.status not in ('scheduled', 'baseline', 'running', 'paused') then
    perform app_private.fail('campaign_not_editable', 'Only scheduled, running or paused campaigns can be changed.');
  end if;
  if v_campaign.draft_revision_id is null then
    perform app_private.fail('no_changes', 'There are no pending changes to apply.');
  end if;
  if v_campaign.draft_revision_id is distinct from p_expected_revision_id then
    perform app_private.fail('stale_review', 'The campaign changed after you reviewed it. Review it again before applying.');
  end if;

  select * into v_old from public.campaign_revisions r where r.id = v_campaign.active_revision_id;
  v_rev := app_private.freeze_revision(v_campaign.draft_revision_id, 'apply', p_validation, v_now);
  update public.campaign_revisions set effective_at = v_now where id = v_rev.id;
  v_new_group := v_rev.comparison_group_id is distinct from v_old.comparison_group_id;

  -- Work that has not been dispatched yet moves to the new revision: drop the old slots and
  -- let the planner materialize them again from now.
  for v_job in
    select j.id from public.jobs j
    where j.campaign_id = p_campaign_id
      and j.revision_id <> v_rev.id
      and j.status = 'pending'
      and (j.kind in ('conversation', 'check_daily') or (v_new_group and j.kind = 'check_baseline'))
    for no key update
  loop
    update public.jobs
    set status = 'canceled', status_reason = 'superseded_by_revision', finished_at = v_now
    where id = v_job.id;
  end loop;

  update public.campaigns
  set active_revision_id = v_rev.id,
      draft_revision_id = null,
      planned_through = case when v_campaign.baseline_completed_at is not null then v_now else planned_through end
  where id = p_campaign_id;

  -- A new comparison group collects its own reference sample before its scheduled checks.
  if v_new_group and v_rev.comparison_group_id is not null and v_rev.baseline_samples > 0
     and coalesce(v_campaign.paused_from, v_campaign.status) in ('baseline', 'running') then
    perform app_private.create_check_jobs(p_campaign_id, v_rev.id, 'check_baseline', v_rev.baseline_samples, v_now);
  end if;

  -- Raised caps may release work that was waiting on the budget.
  update public.jobs set blocked_until = v_now
  where campaign_id = p_campaign_id and status = 'blocked';

  perform app_private.audit(v_campaign.workspace_id, 'campaign.revision_applied', 'campaign', p_campaign_id,
    jsonb_build_object('revision_id', v_rev.id, 'revision_number', v_rev.revision_number,
      'previous_revision_id', v_old.id, 'new_comparison_group', v_new_group));

  perform app_private.plan_campaign(p_campaign_id, v_now);
  perform app_private.dispatch(v_now);
  return jsonb_build_object('revision_id', v_rev.id, 'new_comparison_group', v_new_group);
end;
$$;
