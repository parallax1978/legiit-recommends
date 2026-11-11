-- Legiit Recommends — a launched campaign keeps its start when a save sends none.
--
-- The start of a draft may be left open: the campaign then starts when it is launched, and the
-- launch writes that moment into the revision. The editor that was open before the launch still
-- holds the empty start field when it is shown again afterwards (the web app keeps a visited
-- page's form while the person looks at other pages). Saving from it stored an empty start as
-- a pending change, which can never be applied: a launched campaign has to name its start, and
-- a start that has passed cannot change. The person was left with pending changes that could
-- only be discarded.
--
-- A save for a campaign that is no longer a draft now keeps the stored start when it is sent
-- none. Nothing else in the function changes. The web app also starts the editor again from
-- what is stored whenever the campaign has been launched or its pending changes have been
-- created, applied or discarded.

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

      -- A campaign that has been launched cannot go back to "starts when it is launched". A
      -- save that sends no start (an editor that was opened before the launch and shown again
      -- afterwards still holds the empty field) keeps the start the campaign has.
      if v_campaign.status <> 'draft' and v_new.start_at is null then
        v_new.start_at := v_rev.start_at;
      end if;

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
