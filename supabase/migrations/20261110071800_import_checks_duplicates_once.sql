-- Legiit Recommends — a large prompt import no longer runs into the statement timeout.
--
-- With "skip duplicates" (every CSV import), each new prompt was compared with every wording the
-- workspace already had for that kind, and the comparison lower-cased and collapsed the
-- whitespace of every one of those wordings again for every new prompt, including the ones the
-- same call had just inserted. The work grew with (new prompts) x (existing prompts) x (length):
-- 280 prompts of about 3,900 characters took longer than the 8 seconds a signed-in request may
-- run, and the import failed as a whole with "Something went wrong".
--
-- The existing wordings are now normalised once, kept as a list of fingerprints, and each new
-- prompt is looked up in that list and added to it. What counts as a duplicate is unchanged:
-- the same text ignoring case and runs of whitespace, among the workspace's prompts of the same
-- kind that are not archived, including earlier rows of the same import.
--
-- Each prompt is also stamped with the time it was inserted rather than the time the call
-- began, so that the prompts of one import keep the order of the file wherever lists are sorted
-- by creation time.

create or replace function public.create_templates(
  p_workspace_id uuid,
  p_kind public.template_kind,
  p_items jsonb,
  p_collection text default null,
  p_source text default 'manual',
  p_generation_id uuid default null,
  p_skip_duplicates boolean default false
)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_body text;
  v_problem text;
  v_template_id uuid;
  v_version_id uuid;
  v_ids uuid[] := '{}'::uuid[];
  v_index integer := 0;
  v_collection text := nullif(left(btrim(coalesce(p_collection, '')), 120), '');
  v_key text;
  v_seen text[] := '{}'::text[];
begin
  perform app_private.require_role(p_workspace_id, 'admin');
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    perform app_private.fail('no_items', 'Add at least one prompt.');
  end if;
  if jsonb_array_length(p_items) > 500 then
    perform app_private.fail('too_many_items', 'Add at most 500 prompts at a time.');
  end if;
  if p_source not in ('manual', 'csv_import', 'ai_generated') then
    perform app_private.fail('invalid_source', 'Unknown template source.');
  end if;

  -- The wordings this workspace already has for the kind, normalised once.
  if p_skip_duplicates then
    select coalesce(array_agg(md5(regexp_replace(lower(tv.body), '\s+', ' ', 'g'))), '{}'::text[])
    into v_seen
    from public.templates t
    join public.template_versions tv on tv.id = t.current_version_id
    where t.workspace_id = p_workspace_id and t.kind = p_kind and t.archived_at is null;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_index := v_index + 1;
    v_body := btrim(coalesce(v_item ->> 'body', ''));
    v_problem := app_private.template_problem(v_body, p_kind);
    if v_problem is not null then
      perform app_private.fail('invalid_template', format('Prompt %s: %s', v_index, v_problem));
    end if;

    if p_skip_duplicates then
      v_key := md5(regexp_replace(lower(v_body), '\s+', ' ', 'g'));
      if v_key = any(v_seen) then
        continue;
      end if;
      -- Later rows of the same file are compared with this one too.
      v_seen := v_seen || v_key;
    end if;

    -- The wall clock, not the transaction's start time that the column defaults to: every prompt
    -- of one call would otherwise carry the same created_at, and lists sorted by it could not
    -- show them in the order they were given.
    insert into public.templates (workspace_id, kind, label, collection, source, generation_id, created_by, created_at)
    values (
      p_workspace_id, p_kind, nullif(left(btrim(coalesce(v_item ->> 'label', '')), 120), ''),
      v_collection, p_source, p_generation_id, (select auth.uid()), clock_timestamp()
    )
    returning id into v_template_id;

    insert into public.template_versions (workspace_id, template_id, version, body, variables, created_by)
    values (p_workspace_id, v_template_id, 1, v_body, app_private.template_variables(v_body), (select auth.uid()))
    returning id into v_version_id;

    update public.templates set current_version_id = v_version_id where id = v_template_id;
    v_ids := v_ids || v_template_id;
  end loop;

  perform app_private.audit(p_workspace_id, 'templates.created', 'template', null,
    jsonb_build_object('kind', p_kind, 'count', cardinality(v_ids), 'source', p_source, 'collection', v_collection));
  return v_ids;
end;
$$;
