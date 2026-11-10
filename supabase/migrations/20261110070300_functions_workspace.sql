-- Legiit Recommends — workspace, member, connection, pricing, template and probe-set functions.
--
-- Naming:
--   public.<verb>_<noun>(...)  client RPCs; each verifies the caller's role from auth.uid().
--   public.svc_<...>(...)      service-role RPCs used by Edge Functions and the bootstrap CLI.
--                              Where they act for a person they take p_actor and verify that
--                              person's role again, independently of the calling function.

-- ---------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.setting_int(p_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (s.value #>> '{}')::integer from app_private.settings s where s.key = p_key;
$$;

create or replace function app_private.setting_text(p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.value #>> '{}' from app_private.settings s where s.key = p_key;
$$;

-- Role of an explicit actor (used by service functions acting on behalf of a signed-in user).
create or replace function app_private.require_actor_role(
  p_workspace_id uuid,
  p_actor uuid,
  p_min_role public.workspace_role
)
returns public.workspace_role
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.workspace_role;
begin
  if p_actor is null then
    perform app_private.forbid('A signed-in user is required.');
  end if;
  select m.role into v_role
  from public.workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = p_actor;
  if v_role is null then
    perform app_private.forbid('Workspace not found or access denied.');
  end if;
  if p_min_role = 'owner' and v_role <> 'owner' then
    perform app_private.forbid('Only a workspace owner can do that.');
  elsif p_min_role = 'admin' and v_role not in ('owner', 'admin') then
    perform app_private.forbid('Only workspace owners and admins can do that.');
  end if;
  return v_role;
end;
$$;

create or replace function app_private.current_user_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email)
  from auth.users u
  where u.id = (select auth.uid())
    and u.email_confirmed_at is not null;
$$;

-- ---------------------------------------------------------------------------------------------
-- First-run setup and invitations
-- ---------------------------------------------------------------------------------------------

create or replace function public.setup_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := app_private.current_user_email();
begin
  if v_uid is null then
    perform app_private.forbid('Sign in to continue.');
  end if;
  return jsonb_build_object(
    'workspace_count', (select count(*) from public.workspace_members m where m.user_id = v_uid),
    'can_create_workspace', exists (
      select 1 from app_private.owner_bootstrap_grants g
      where g.email = v_email and g.consumed_at is null
    ),
    'pending_invitations', (
      select count(*) from public.workspace_invitations i
      where i.email = v_email and i.status = 'pending' and i.expires_at > now()
    )
  );
end;
$$;

-- The bootstrapped owner names the workspace on first sign-in.
create or replace function public.complete_owner_setup(p_workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := app_private.current_user_email();
  v_workspace_id uuid;
begin
  if v_uid is null or v_email is null then
    perform app_private.forbid('Sign in with a confirmed email address to continue.');
  end if;
  if char_length(btrim(coalesce(p_workspace_name, ''))) not between 1 and 80 then
    perform app_private.fail('invalid_name', 'Enter a workspace name between 1 and 80 characters.');
  end if;

  perform 1
  from app_private.owner_bootstrap_grants g
  where g.email = v_email and g.consumed_at is null
  for update;
  if not found then
    perform app_private.forbid('This account is not authorized to create a workspace.');
  end if;

  insert into public.workspaces (name, created_by)
  values (btrim(p_workspace_name), v_uid)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, v_uid, 'owner');

  update app_private.owner_bootstrap_grants
  set consumed_at = now(), consumed_by = v_uid, workspace_id = v_workspace_id
  where email = v_email;

  perform app_private.audit(v_workspace_id, 'workspace.created', 'workspace', v_workspace_id,
    jsonb_build_object('name', btrim(p_workspace_name)));
  return v_workspace_id;
end;
$$;

-- Turns pending invitations for the caller's confirmed email into memberships.
create or replace function public.accept_pending_invitations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := app_private.current_user_email();
  v_inv record;
  v_count integer := 0;
begin
  if v_uid is null or v_email is null then
    perform app_private.forbid('Sign in with a confirmed email address to continue.');
  end if;

  update public.workspace_invitations
  set status = 'expired'
  where email = v_email and status = 'pending' and expires_at <= now();

  for v_inv in
    select i.* from public.workspace_invitations i
    where i.email = v_email and i.status = 'pending'
    for update
  loop
    insert into public.workspace_members (workspace_id, user_id, role, invited_by)
    values (v_inv.workspace_id, v_uid, v_inv.role, v_inv.invited_by)
    on conflict (workspace_id, user_id) do nothing;

    update public.workspace_invitations
    set status = 'accepted', accepted_at = now(), accepted_by = v_uid
    where id = v_inv.id;

    perform app_private.audit(v_inv.workspace_id, 'member.joined', 'user', v_uid,
      jsonb_build_object('role', v_inv.role, 'invitation_id', v_inv.id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.update_profile(p_display_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    perform app_private.forbid('Sign in to continue.');
  end if;
  update public.profiles
  set display_name = nullif(left(btrim(coalesce(p_display_name, '')), 120), '')
  where id = (select auth.uid());
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Workspace settings and members (owner)
-- ---------------------------------------------------------------------------------------------

create or replace function public.update_workspace(
  p_workspace_id uuid,
  p_name text,
  p_retention_days integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.require_role(p_workspace_id, 'owner');
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    perform app_private.fail('invalid_name', 'Enter a workspace name between 1 and 80 characters.');
  end if;
  if p_retention_days is not null and p_retention_days not between 7 and 3650 then
    perform app_private.fail('invalid_retention', 'Retention must be between 7 and 3650 days, or empty to keep data.');
  end if;
  update public.workspaces
  set name = btrim(p_name), retention_days = p_retention_days
  where id = p_workspace_id;
  perform app_private.audit(p_workspace_id, 'workspace.updated', 'workspace', p_workspace_id,
    jsonb_build_object('name', btrim(p_name), 'retention_days', p_retention_days));
end;
$$;

-- Global stop: while enabled no new provider request is dispatched for the workspace.
create or replace function public.set_emergency_stop(
  p_workspace_id uuid,
  p_enabled boolean,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.require_role(p_workspace_id, 'owner');
  update public.workspaces
  set emergency_stop = p_enabled,
      emergency_stop_at = case when p_enabled then now() else null end,
      emergency_stop_by = case when p_enabled then (select auth.uid()) else null end,
      emergency_stop_reason = case when p_enabled then left(p_reason, 500) else null end
  where id = p_workspace_id;
  if not p_enabled then
    perform app_private.resume_stopped_jobs(p_workspace_id);
  end if;
  perform app_private.audit(p_workspace_id,
    case when p_enabled then 'workspace.emergency_stop_enabled' else 'workspace.emergency_stop_released' end,
    'workspace', p_workspace_id, jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.update_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role public.workspace_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.workspace_role;
begin
  perform app_private.require_role(p_workspace_id, 'owner');
  -- Serialize owner-count changes per workspace.
  perform 1 from public.workspaces w where w.id = p_workspace_id for update;

  select m.role into v_current
  from public.workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
  if v_current is null then
    perform app_private.fail('not_found', 'That person is not a member of this workspace.');
  end if;
  if v_current = 'owner' and p_role <> 'owner' and (
    select count(*) from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.role = 'owner'
  ) <= 1 then
    perform app_private.fail('last_owner', 'A workspace must keep at least one owner.');
  end if;

  update public.workspace_members
  set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id;
  perform app_private.audit(p_workspace_id, 'member.role_changed', 'user', p_user_id,
    jsonb_build_object('from', v_current, 'to', p_role));
end;
$$;

create or replace function public.remove_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current public.workspace_role;
begin
  -- Owners remove anyone; any member may leave.
  if p_user_id = v_uid then
    perform app_private.require_role(p_workspace_id, 'member');
  else
    perform app_private.require_role(p_workspace_id, 'owner');
  end if;
  perform 1 from public.workspaces w where w.id = p_workspace_id for update;

  select m.role into v_current
  from public.workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
  if v_current is null then
    perform app_private.fail('not_found', 'That person is not a member of this workspace.');
  end if;
  if v_current = 'owner' and (
    select count(*) from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.role = 'owner'
  ) <= 1 then
    perform app_private.fail('last_owner', 'A workspace must keep at least one owner.');
  end if;

  delete from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;
  perform app_private.audit(p_workspace_id, 'member.removed', 'user', p_user_id,
    jsonb_build_object('role', v_current));
end;
$$;

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.workspace_invitations%rowtype;
begin
  select * into v_inv from public.workspace_invitations i where i.id = p_invitation_id;
  if not found then
    perform app_private.forbid('Invitation not found or access denied.');
  end if;
  perform app_private.require_role(v_inv.workspace_id, 'owner');
  update public.workspace_invitations
  set status = 'revoked'
  where id = p_invitation_id and status = 'pending';
  perform app_private.audit(v_inv.workspace_id, 'member.invitation_revoked', 'invitation', p_invitation_id,
    jsonb_build_object('email', v_inv.email));
end;
$$;

create or replace function public.delete_workspace(p_workspace_id uuid, p_confirm_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  perform app_private.require_role(p_workspace_id, 'owner');
  select w.name into v_name from public.workspaces w where w.id = p_workspace_id for update;
  if v_name is distinct from btrim(coalesce(p_confirm_name, '')) then
    perform app_private.fail('confirmation_mismatch', 'Type the workspace name exactly to confirm deletion.');
  end if;
  if exists (
    select 1 from public.campaigns c
    where c.workspace_id = p_workspace_id
      and c.status in ('scheduled', 'baseline', 'running', 'paused', 'finalizing')
  ) then
    perform app_private.fail('active_campaigns', 'Cancel all active campaigns before deleting the workspace.');
  end if;
  -- Cascades to every tenant record; connection secrets are removed from Vault by trigger.
  delete from public.workspaces where id = p_workspace_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Service functions: bootstrap and invitations
-- ---------------------------------------------------------------------------------------------

-- Grants `p_email` the right to create the first workspace. When the account already exists
-- and a name is supplied, the workspace is created immediately.
create or replace function public.svc_bootstrap_owner(p_email text, p_workspace_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user_id uuid;
  v_workspace_id uuid;
begin
  if position('@' in v_email) < 2 then
    perform app_private.fail('invalid_email', 'A valid owner email address is required.');
  end if;

  insert into app_private.owner_bootstrap_grants (email) values (v_email)
  on conflict (email) do nothing;

  select u.id into v_user_id from auth.users u where lower(u.email) = v_email;

  if v_user_id is not null and nullif(btrim(coalesce(p_workspace_name, '')), '') is not null then
    select g.workspace_id into v_workspace_id
    from app_private.owner_bootstrap_grants g
    where g.email = v_email and g.consumed_at is not null;

    if v_workspace_id is null then
      insert into public.workspaces (name, created_by)
      values (btrim(p_workspace_name), v_user_id)
      returning id into v_workspace_id;
      insert into public.workspace_members (workspace_id, user_id, role)
      values (v_workspace_id, v_user_id, 'owner');
      update app_private.owner_bootstrap_grants
      set consumed_at = now(), consumed_by = v_user_id, workspace_id = v_workspace_id
      where email = v_email;
      perform app_private.audit(v_workspace_id, 'workspace.created', 'workspace', v_workspace_id,
        jsonb_build_object('name', btrim(p_workspace_name), 'via', 'bootstrap'), 'system', v_user_id);
    end if;
  end if;

  return jsonb_build_object(
    'email', v_email,
    'user_id', v_user_id,
    'workspace_id', v_workspace_id,
    'needs_workspace_setup', v_workspace_id is null
  );
end;
$$;

-- Records an invitation (or adds an existing confirmed account directly).
-- Returns {outcome: 'added' | 'invited' | 'already_member', invitation_id}.
create or replace function public.svc_invite_member(
  p_workspace_id uuid,
  p_actor uuid,
  p_email text,
  p_role public.workspace_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user record;
  v_invitation_id uuid;
begin
  perform app_private.require_actor_role(p_workspace_id, p_actor, 'owner');
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform app_private.fail('invalid_email', 'Enter a valid email address.');
  end if;

  select u.id, u.email_confirmed_at into v_user from auth.users u where lower(u.email) = v_email;

  if v_user.id is not null and exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = v_user.id
  ) then
    return jsonb_build_object('outcome', 'already_member');
  end if;

  if v_user.id is not null and v_user.email_confirmed_at is not null then
    insert into public.workspace_members (workspace_id, user_id, role, invited_by)
    values (p_workspace_id, v_user.id, p_role, p_actor);
    perform app_private.audit(p_workspace_id, 'member.added', 'user', v_user.id,
      jsonb_build_object('email', v_email, 'role', p_role), 'user', p_actor);
    return jsonb_build_object('outcome', 'added', 'user_id', v_user.id);
  end if;

  update public.workspace_invitations
  set status = 'revoked'
  where workspace_id = p_workspace_id and email = v_email and status = 'pending';

  insert into public.workspace_invitations (workspace_id, email, role, invited_by)
  values (p_workspace_id, v_email, p_role, p_actor)
  returning id into v_invitation_id;

  perform app_private.audit(p_workspace_id, 'member.invited', 'invitation', v_invitation_id,
    jsonb_build_object('email', v_email, 'role', p_role), 'user', p_actor);
  return jsonb_build_object(
    'outcome', 'invited',
    'invitation_id', v_invitation_id,
    'user_exists', v_user.id is not null
  );
end;
$$;

create or replace function public.svc_cancel_invitation(p_invitation_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.workspace_invitations%rowtype;
begin
  update public.workspace_invitations
  set status = 'revoked'
  where id = p_invitation_id and status = 'pending'
  returning * into v_inv;
  if found then
    perform app_private.audit(v_inv.workspace_id, 'member.invitation_failed', 'invitation', p_invitation_id,
      jsonb_build_object('email', v_inv.email, 'reason', left(p_reason, 300)), 'system');
  end if;
end;
$$;

-- Resolves the role of a user in a workspace for Edge Function authorization.
create or replace function public.svc_member_role(p_workspace_id uuid, p_user_id uuid)
returns public.workspace_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Provider connections
-- ---------------------------------------------------------------------------------------------

create or replace function public.create_connection(
  p_workspace_id uuid,
  p_name text,
  p_daily_budget_usd numeric,
  p_total_budget_usd numeric default null,
  p_max_concurrent_requests integer default 2,
  p_requests_per_minute integer default null,
  p_tokens_per_minute integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app_private.require_role(p_workspace_id, 'owner');
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    perform app_private.fail('invalid_name', 'Enter a connection name between 1 and 80 characters.');
  end if;
  if p_daily_budget_usd is null or p_daily_budget_usd < 0 then
    perform app_private.fail('invalid_budget', 'Enter a daily spending limit for this connection.');
  end if;
  begin
    insert into public.provider_connections (
      workspace_id, name, daily_budget_usd, total_budget_usd,
      max_concurrent_requests, requests_per_minute, tokens_per_minute, created_by
    )
    values (
      p_workspace_id, btrim(p_name), p_daily_budget_usd, p_total_budget_usd,
      coalesce(p_max_concurrent_requests, 2), p_requests_per_minute, p_tokens_per_minute, (select auth.uid())
    )
    returning id into v_id;
  exception
    when unique_violation then
      perform app_private.fail('duplicate_name', 'A connection with that name already exists.');
    when check_violation then
      perform app_private.fail('invalid_limits', 'One of the connection limits is out of range.');
  end;
  perform app_private.audit(p_workspace_id, 'connection.created', 'connection', v_id,
    jsonb_build_object('name', btrim(p_name), 'daily_budget_usd', p_daily_budget_usd,
      'total_budget_usd', p_total_budget_usd));
  return v_id;
end;
$$;

-- Jobs blocked on a connection condition become eligible again.
create or replace function app_private.unblock_connection_jobs(p_connection_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.jobs
  set blocked_until = now()
  where connection_id = p_connection_id and status = 'blocked';
$$;

create or replace function public.update_connection(p_connection_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.provider_connections%rowtype;
begin
  select * into v_conn from public.provider_connections c where c.id = p_connection_id for update;
  if not found then
    perform app_private.forbid('Connection not found or access denied.');
  end if;
  perform app_private.require_role(v_conn.workspace_id, 'owner');

  if p_patch ? 'daily_budget_usd' and (p_patch ->> 'daily_budget_usd') is null then
    perform app_private.fail('invalid_budget', 'A connection must keep a daily spending limit.');
  end if;

  begin
    update public.provider_connections c
    set name = case when p_patch ? 'name' then btrim(p_patch ->> 'name') else c.name end,
        daily_budget_usd = case when p_patch ? 'daily_budget_usd'
          then (p_patch ->> 'daily_budget_usd')::numeric else c.daily_budget_usd end,
        total_budget_usd = case when p_patch ? 'total_budget_usd'
          then (p_patch ->> 'total_budget_usd')::numeric else c.total_budget_usd end,
        max_concurrent_requests = case when p_patch ? 'max_concurrent_requests'
          then (p_patch ->> 'max_concurrent_requests')::integer else c.max_concurrent_requests end,
        requests_per_minute = case when p_patch ? 'requests_per_minute'
          then (p_patch ->> 'requests_per_minute')::integer else c.requests_per_minute end,
        tokens_per_minute = case when p_patch ? 'tokens_per_minute'
          then (p_patch ->> 'tokens_per_minute')::integer else c.tokens_per_minute end,
        store_fresh_check_responses = case when p_patch ? 'store_fresh_check_responses'
          then (p_patch ->> 'store_fresh_check_responses')::boolean else c.store_fresh_check_responses end
    where c.id = p_connection_id;
  exception
    when unique_violation then
      perform app_private.fail('duplicate_name', 'A connection with that name already exists.');
    when check_violation or not_null_violation or invalid_text_representation then
      perform app_private.fail('invalid_limits', 'One of the connection settings is out of range.');
  end;

  perform app_private.unblock_connection_jobs(p_connection_id);
  perform app_private.audit(v_conn.workspace_id, 'connection.updated', 'connection', p_connection_id, p_patch);
end;
$$;

-- Records the owner's declaration of the OpenAI data-sharing setting. This does not change
-- anything at OpenAI; it documents what the owner verified in the OpenAI dashboard.
create or replace function public.declare_data_sharing(
  p_connection_id uuid,
  p_setting public.data_sharing_setting,
  p_verified_on date,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.provider_connections%rowtype;
begin
  select * into v_conn from public.provider_connections c where c.id = p_connection_id for update;
  if not found then
    perform app_private.forbid('Connection not found or access denied.');
  end if;
  perform app_private.require_role(v_conn.workspace_id, 'owner');
  if p_setting <> 'unknown' and p_verified_on is null then
    perform app_private.fail('verification_date_required', 'Enter the date you verified this setting in OpenAI.');
  end if;
  if p_verified_on is not null and p_verified_on > (now() at time zone 'utc')::date + 1 then
    perform app_private.fail('verification_date_in_future', 'The verification date cannot be in the future.');
  end if;
  update public.provider_connections
  set data_sharing = p_setting,
      data_sharing_verified_on = case when p_setting = 'unknown' then null else p_verified_on end,
      data_sharing_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
  where id = p_connection_id;
  perform app_private.audit(v_conn.workspace_id, 'connection.data_sharing_declared', 'connection', p_connection_id,
    jsonb_build_object('from', v_conn.data_sharing, 'to', p_setting, 'verified_on', p_verified_on));
end;
$$;

create or replace function public.archive_connection(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.provider_connections%rowtype;
begin
  select * into v_conn from public.provider_connections c where c.id = p_connection_id for update;
  if not found then
    perform app_private.forbid('Connection not found or access denied.');
  end if;
  perform app_private.require_role(v_conn.workspace_id, 'owner');
  if exists (
    select 1
    from public.campaigns c
    join public.campaign_revisions r on r.id = c.active_revision_id
    where r.connection_id = p_connection_id
      and c.status in ('scheduled', 'baseline', 'running', 'paused', 'finalizing')
  ) then
    perform app_private.fail('connection_in_use', 'Cancel or finish the campaigns using this connection first.');
  end if;
  -- Removes the credential from Vault (trigger on connection_secrets).
  delete from app_private.connection_secrets where connection_id = p_connection_id;
  update public.provider_connections
  set archived_at = now(), status = 'not_configured', status_code = null, status_message = null, key_hint = null
  where id = p_connection_id;
  perform app_private.audit(v_conn.workspace_id, 'connection.archived', 'connection', p_connection_id, '{}'::jsonb);
end;
$$;

-- Stores or replaces the API key in Vault. The key is never written to any other table or log
-- by this function; only a masked hint is kept.
create or replace function public.svc_store_connection_secret(
  p_connection_id uuid,
  p_actor uuid,
  p_api_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.provider_connections%rowtype;
  v_secret_id uuid;
  v_key text := btrim(coalesce(p_api_key, ''));
  v_replaced boolean := false;
begin
  select * into v_conn from public.provider_connections c where c.id = p_connection_id for update;
  if not found then
    perform app_private.forbid('Connection not found or access denied.');
  end if;
  perform app_private.require_actor_role(v_conn.workspace_id, p_actor, 'owner');
  if v_conn.archived_at is not null then
    perform app_private.fail('connection_archived', 'This connection is archived.');
  end if;
  if char_length(v_key) < 20 or v_key ~ '\s' then
    perform app_private.fail('invalid_api_key', 'That does not look like an API key.');
  end if;

  select s.vault_secret_id into v_secret_id
  from app_private.connection_secrets s where s.connection_id = p_connection_id;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(
      v_key,
      'lr_conn_' || p_connection_id::text,
      'Legiit Recommends provider credential'
    );
    insert into app_private.connection_secrets (connection_id, vault_secret_id)
    values (p_connection_id, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, v_key);
    update app_private.connection_secrets set rotated_at = now() where connection_id = p_connection_id;
    v_replaced := true;
  end if;

  update public.provider_connections
  set key_hint = left(v_key, 3) || '…' || right(v_key, 4),
      key_set_at = now(),
      key_set_by = p_actor
  where id = p_connection_id;

  perform app_private.audit(v_conn.workspace_id,
    case when v_replaced then 'connection.credential_replaced' else 'connection.credential_stored' end,
    'connection', p_connection_id, '{}'::jsonb, 'user', p_actor);
end;
$$;

-- Decrypts the API key for trusted backend use only.
create or replace function public.svc_get_connection_secret(p_connection_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret
  from app_private.connection_secrets s
  join vault.decrypted_secrets d on d.id = s.vault_secret_id
  where s.connection_id = p_connection_id;
$$;

create or replace function public.svc_record_connection_status(
  p_connection_id uuid,
  p_ok boolean,
  p_code text default null,
  p_message text default null,
  p_actor uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.provider_connections%rowtype;
begin
  select * into v_conn from public.provider_connections c where c.id = p_connection_id for update;
  if not found then
    return;
  end if;
  update public.provider_connections
  set status = case when p_ok then 'ok'::public.connection_status else 'error'::public.connection_status end,
      status_code = case when p_ok then null else p_code end,
      status_message = case when p_ok then null else left(p_message, 500) end,
      last_tested_at = now(),
      last_ok_at = case when p_ok then now() else last_ok_at end
  where id = p_connection_id;

  if p_ok then
    perform app_private.unblock_connection_jobs(p_connection_id);
  end if;
  if v_conn.status::text is distinct from (case when p_ok then 'ok' else 'error' end)
     or v_conn.status_code is distinct from (case when p_ok then null else p_code end) then
    perform app_private.audit(v_conn.workspace_id,
      case when p_ok then 'connection.ok' else 'connection.error' end,
      'connection', p_connection_id,
      jsonb_build_object('code', p_code, 'message', left(p_message, 300)),
      case when p_actor is null then 'worker' else 'user' end, p_actor);
  end if;
end;
$$;

-- Replaces the cached list of models visible to this connection's key.
create or replace function public.svc_upsert_provider_models(p_connection_id uuid, p_models jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.provider_connections%rowtype;
  v_count integer;
begin
  select * into v_conn from public.provider_connections c where c.id = p_connection_id;
  if not found then
    return 0;
  end if;

  insert into public.provider_models (
    workspace_id, connection_id, model_id, owned_by, provider_created_at, shutdown_date, is_listed, listed_at
  )
  select v_conn.workspace_id, p_connection_id, m.model_id, m.owned_by,
         case when m.created is not null then to_timestamp(m.created) end,
         m.shutdown_date, true, now()
  from jsonb_to_recordset(coalesce(p_models, '[]'::jsonb))
    as m(model_id text, owned_by text, created double precision, shutdown_date date)
  where m.model_id is not null and char_length(m.model_id) between 1 and 200
  on conflict (connection_id, model_id) do update
    set owned_by = excluded.owned_by,
        provider_created_at = excluded.provider_created_at,
        shutdown_date = excluded.shutdown_date,
        is_listed = true,
        listed_at = excluded.listed_at;
  get diagnostics v_count = row_count;

  update public.provider_models pm
  set is_listed = false
  where pm.connection_id = p_connection_id
    and pm.is_listed
    and not exists (
      select 1 from jsonb_array_elements(coalesce(p_models, '[]'::jsonb)) e
      where e ->> 'model_id' = pm.model_id
    );
  return v_count;
end;
$$;

create or replace function public.svc_save_model_verification(
  p_connection_id uuid,
  p_actor uuid,
  p_model_id text,
  p_verified boolean,
  p_capabilities jsonb,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.provider_connections%rowtype;
begin
  select * into v_conn from public.provider_connections c where c.id = p_connection_id;
  if not found then
    perform app_private.forbid('Connection not found or access denied.');
  end if;
  perform app_private.require_actor_role(v_conn.workspace_id, p_actor, 'owner');

  insert into public.provider_models (
    workspace_id, connection_id, model_id, is_listed, verification_status, verified_at, verified_by,
    capabilities, verification_error
  )
  values (
    v_conn.workspace_id, p_connection_id, p_model_id, false,
    case when p_verified then 'verified' else 'failed' end, now(), p_actor,
    p_capabilities, left(p_error, 1000)
  )
  on conflict (connection_id, model_id) do update
    set verification_status = excluded.verification_status,
        verified_at = excluded.verified_at,
        verified_by = excluded.verified_by,
        capabilities = excluded.capabilities,
        verification_error = excluded.verification_error;

  perform app_private.audit(v_conn.workspace_id,
    case when p_verified then 'model.verified' else 'model.verification_failed' end,
    'connection', p_connection_id,
    jsonb_build_object('model', p_model_id, 'capabilities', p_capabilities, 'error', left(p_error, 300)),
    'user', p_actor);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------------------------

-- The price row in force for a workspace and model: the latest workspace override if one
-- exists, otherwise the latest global default. NULL when no price is known.
create or replace function app_private.current_price(p_workspace_id uuid, p_model_id text)
returns public.model_prices
language sql
stable
security definer
set search_path = ''
as $$
  select p.*
  from public.model_prices p
  where p.provider = 'openai'
    and p.model_id = p_model_id
    and (p.workspace_id = p_workspace_id or p.workspace_id is null)
  order by (p.workspace_id is not null) desc, p.version desc
  limit 1;
$$;

create or replace function public.effective_prices(p_workspace_id uuid)
returns setof public.model_prices
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct on (p.model_id) p.*
  from public.model_prices p
  where p.provider = 'openai'
    and (p.workspace_id = p_workspace_id or p.workspace_id is null)
  order by p.model_id, (p.workspace_id is not null) desc, p.version desc;
$$;

create or replace function public.add_model_price(p_workspace_id uuid, p_price jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_model text := btrim(coalesce(p_price ->> 'model_id', ''));
  v_version integer;
  v_id uuid;
begin
  perform app_private.require_role(p_workspace_id, 'owner');
  if v_model = '' then
    perform app_private.fail('invalid_model', 'Enter the exact model ID this price applies to.');
  end if;
  if coalesce(p_price ->> 'source_url', '') !~* '^https://' then
    perform app_private.fail('invalid_source', 'Enter the https:// source URL where you verified this price.');
  end if;
  if (p_price ->> 'verified_on') is null then
    perform app_private.fail('invalid_verified_on', 'Enter the date you verified this price.');
  end if;

  perform 1 from public.workspaces w where w.id = p_workspace_id for update;
  select coalesce(max(p.version), 0) + 1 into v_version
  from public.model_prices p
  where p.workspace_id = p_workspace_id and p.provider = 'openai' and p.model_id = v_model;

  begin
    insert into public.model_prices (
      workspace_id, model_id, version,
      input_usd_per_mtok, cached_input_usd_per_mtok, output_usd_per_mtok,
      cache_write_30m_usd_per_mtok, cache_write_12h_usd_per_mtok,
      long_context_threshold_tokens, long_context_input_multiplier, long_context_output_multiplier,
      source_url, verified_on, notes, created_by
    )
    values (
      p_workspace_id, v_model, v_version,
      (p_price ->> 'input_usd_per_mtok')::numeric,
      (p_price ->> 'cached_input_usd_per_mtok')::numeric,
      (p_price ->> 'output_usd_per_mtok')::numeric,
      (p_price ->> 'cache_write_30m_usd_per_mtok')::numeric,
      (p_price ->> 'cache_write_12h_usd_per_mtok')::numeric,
      (p_price ->> 'long_context_threshold_tokens')::integer,
      (p_price ->> 'long_context_input_multiplier')::numeric,
      (p_price ->> 'long_context_output_multiplier')::numeric,
      p_price ->> 'source_url',
      (p_price ->> 'verified_on')::date,
      nullif(left(btrim(coalesce(p_price ->> 'notes', '')), 500), ''),
      (select auth.uid())
    )
    returning id into v_id;
  exception
    when check_violation or not_null_violation or invalid_text_representation
      or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
      perform app_private.fail('invalid_price', 'Check the price values: input and output prices are required and must not be negative.');
  end;

  perform app_private.audit(p_workspace_id, 'pricing.version_added', 'model_price', v_id,
    jsonb_build_object('model', v_model, 'version', v_version) || (p_price - 'notes'));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.template_variables(p_body text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct btrim(m[1]) order by btrim(m[1])), '{}'::text[])
  from regexp_matches(coalesce(p_body, ''), '\{\{([^{}]*)\}\}', 'g') as m;
$$;

create or replace function app_private.allowed_variables(p_kind public.template_kind)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case
    -- Fresh-check questions must never reference the target business.
    when p_kind = 'fresh_check' then array['category', 'location', 'language']
    else array['business_name', 'website_url', 'category', 'location', 'language']
  end;
$$;

-- NULL when the body is a valid template for the kind; otherwise a human-readable problem.
create or replace function app_private.template_problem(p_body text, p_kind public.template_kind)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_var text;
  v_rest text;
begin
  if char_length(btrim(coalesce(p_body, ''))) = 0 then
    return 'The prompt text is empty.';
  end if;
  if char_length(p_body) > 4000 then
    return 'The prompt text is longer than 4000 characters.';
  end if;
  foreach v_var in array app_private.template_variables(p_body) loop
    if v_var !~ '^[a-z_][a-z0-9_]*$' then
      return format('"{{%s}}" is not a valid variable.', v_var);
    end if;
    if not (v_var = any (app_private.allowed_variables(p_kind))) then
      if p_kind = 'fresh_check' and v_var in ('business_name', 'website_url') then
        return format('Fresh-check questions cannot use {{%s}}: they must not mention the target business.', v_var);
      end if;
      return format('Unknown variable {{%s}}.', v_var);
    end if;
  end loop;
  v_rest := regexp_replace(p_body, '\{\{[^{}]*\}\}', '', 'g');
  if v_rest ~ '\{\{|\}\}' then
    return 'The prompt has an unclosed or stray "{{" or "}}".';
  end if;
  return null;
end;
$$;

create or replace function app_private.render_template(p_body text, p_vars jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out text := p_body;
  v_key text;
  v_value text;
begin
  for v_key, v_value in select key, value from jsonb_each_text(coalesce(p_vars, '{}'::jsonb)) loop
    v_out := regexp_replace(
      v_out,
      '\{\{\s*' || v_key || '\s*\}\}',
      replace(coalesce(v_value, ''), '\', '\\'),
      'g'
    );
  end loop;
  return v_out;
end;
$$;

-- Creates one or more templates. p_items: [{"body": "...", "label": "..."}]
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

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_index := v_index + 1;
    v_body := btrim(coalesce(v_item ->> 'body', ''));
    v_problem := app_private.template_problem(v_body, p_kind);
    if v_problem is not null then
      perform app_private.fail('invalid_template', format('Prompt %s: %s', v_index, v_problem));
    end if;

    if p_skip_duplicates and exists (
      select 1
      from public.templates t
      join public.template_versions tv on tv.id = t.current_version_id
      where t.workspace_id = p_workspace_id and t.kind = p_kind and t.archived_at is null
        and regexp_replace(lower(tv.body), '\s+', ' ', 'g') = regexp_replace(lower(v_body), '\s+', ' ', 'g')
    ) then
      continue;
    end if;

    insert into public.templates (workspace_id, kind, label, collection, source, generation_id, created_by)
    values (
      p_workspace_id, p_kind, nullif(left(btrim(coalesce(v_item ->> 'label', '')), 120), ''),
      v_collection, p_source, p_generation_id, (select auth.uid())
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

-- Edits a template. A changed body creates a new immutable version.
create or replace function public.update_template(
  p_template_id uuid,
  p_body text,
  p_label text default null,
  p_collection text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tpl public.templates%rowtype;
  v_current_body text;
  v_body text := btrim(coalesce(p_body, ''));
  v_problem text;
  v_version integer;
  v_version_id uuid;
begin
  select * into v_tpl from public.templates t where t.id = p_template_id for update;
  if not found then
    perform app_private.forbid('Template not found or access denied.');
  end if;
  perform app_private.require_role(v_tpl.workspace_id, 'admin');

  v_problem := app_private.template_problem(v_body, v_tpl.kind);
  if v_problem is not null then
    perform app_private.fail('invalid_template', v_problem);
  end if;

  select tv.body into v_current_body from public.template_versions tv where tv.id = v_tpl.current_version_id;
  v_version_id := v_tpl.current_version_id;

  if v_current_body is distinct from v_body then
    select coalesce(max(tv.version), 0) + 1 into v_version
    from public.template_versions tv where tv.template_id = p_template_id;
    insert into public.template_versions (workspace_id, template_id, version, body, variables, created_by)
    values (v_tpl.workspace_id, p_template_id, v_version, v_body, app_private.template_variables(v_body), (select auth.uid()))
    returning id into v_version_id;
  end if;

  update public.templates
  set current_version_id = v_version_id,
      label = nullif(left(btrim(coalesce(p_label, '')), 120), ''),
      collection = nullif(left(btrim(coalesce(p_collection, '')), 120), '')
  where id = p_template_id;

  if v_current_body is distinct from v_body then
    perform app_private.audit(v_tpl.workspace_id, 'template.version_created', 'template', p_template_id,
      jsonb_build_object('version', v_version));
  end if;
  return v_version_id;
end;
$$;

create or replace function public.set_templates_archived(p_template_ids uuid[], p_archived boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_count integer;
begin
  if p_template_ids is null or cardinality(p_template_ids) = 0 then
    return 0;
  end if;
  -- All templates must belong to workspaces where the caller is an admin.
  for v_workspace_id in
    select distinct t.workspace_id from public.templates t where t.id = any (p_template_ids)
  loop
    perform app_private.require_role(v_workspace_id, 'admin');
  end loop;

  update public.templates t
  set archived_at = case when p_archived then now() else null end
  where t.id = any (p_template_ids)
    and app_private.is_admin(t.workspace_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.delete_template(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tpl public.templates%rowtype;
begin
  select * into v_tpl from public.templates t where t.id = p_template_id for update;
  if not found then
    perform app_private.forbid('Template not found or access denied.');
  end if;
  perform app_private.require_role(v_tpl.workspace_id, 'admin');
  if exists (
    select 1 from public.campaign_revision_step_templates st where st.template_id = p_template_id
  ) or exists (
    select 1 from public.run_turns rt where rt.template_id = p_template_id
  ) then
    perform app_private.fail('template_in_use', 'This prompt is used by a campaign. Archive it instead of deleting it.');
  end if;
  delete from public.templates where id = p_template_id;
  perform app_private.audit(v_tpl.workspace_id, 'template.deleted', 'template', p_template_id, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Probe sets (fresh-check question sets)
-- ---------------------------------------------------------------------------------------------

-- Creates a probe set, or a new immutable version of an existing one when its questions change.
-- p_questions: [{"body": "...", "is_held_out": true|false}]
create or replace function public.save_probe_set(
  p_workspace_id uuid,
  p_probe_set_id uuid,
  p_name text,
  p_description text,
  p_questions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set public.probe_sets%rowtype;
  v_item jsonb;
  v_body text;
  v_problem text;
  v_index integer := 0;
  v_version integer;
  v_version_id uuid;
  v_same boolean := false;
begin
  perform app_private.require_role(p_workspace_id, 'admin');
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
    perform app_private.fail('invalid_name', 'Enter a name for the question set.');
  end if;
  if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions) = 0 then
    perform app_private.fail('no_questions', 'Add at least one fresh-check question.');
  end if;
  if jsonb_array_length(p_questions) > 200 then
    perform app_private.fail('too_many_questions', 'A question set can hold at most 200 questions.');
  end if;

  for v_item in select value from jsonb_array_elements(p_questions) loop
    v_index := v_index + 1;
    v_problem := app_private.template_problem(btrim(coalesce(v_item ->> 'body', '')), 'fresh_check');
    if v_problem is not null then
      perform app_private.fail('invalid_question', format('Question %s: %s', v_index, v_problem));
    end if;
  end loop;

  if p_probe_set_id is null then
    insert into public.probe_sets (workspace_id, name, description, created_by)
    values (p_workspace_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), (select auth.uid()))
    returning * into v_set;
  else
    select * into v_set from public.probe_sets s
    where s.id = p_probe_set_id and s.workspace_id = p_workspace_id
    for update;
    if not found then
      perform app_private.forbid('Question set not found or access denied.');
    end if;
    update public.probe_sets
    set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '')
    where id = v_set.id;

    -- Unchanged questions keep the current version (and therefore the comparison group).
    select coalesce(
      (select jsonb_agg(jsonb_build_array(q.body, q.is_held_out) order by q.position)
       from public.probe_questions q where q.probe_set_version_id = v_set.current_version_id),
      '[]'::jsonb
    ) = (
      select jsonb_agg(jsonb_build_array(btrim(e.value ->> 'body'), coalesce((e.value ->> 'is_held_out')::boolean, false)) order by e.ordinality)
      from jsonb_array_elements(p_questions) with ordinality as e(value, ordinality)
    ) into v_same;
  end if;

  if v_same then
    return jsonb_build_object('probe_set_id', v_set.id, 'version_id', v_set.current_version_id, 'new_version', false);
  end if;

  select coalesce(max(v.version), 0) + 1 into v_version
  from public.probe_set_versions v where v.probe_set_id = v_set.id;

  insert into public.probe_set_versions (workspace_id, probe_set_id, version, created_by)
  values (p_workspace_id, v_set.id, v_version, (select auth.uid()))
  returning id into v_version_id;

  v_index := 0;
  for v_item in select value from jsonb_array_elements(p_questions) loop
    v_index := v_index + 1;
    v_body := btrim(v_item ->> 'body');
    insert into public.probe_questions (workspace_id, probe_set_version_id, position, body, variables, is_held_out)
    values (
      p_workspace_id, v_version_id, v_index, v_body,
      app_private.template_variables(v_body),
      coalesce((v_item ->> 'is_held_out')::boolean, false)
    );
  end loop;

  update public.probe_sets set current_version_id = v_version_id where id = v_set.id;
  perform app_private.audit(p_workspace_id, 'probe_set.version_created', 'probe_set', v_set.id,
    jsonb_build_object('version', v_version, 'questions', v_index));
  return jsonb_build_object('probe_set_id', v_set.id, 'version_id', v_version_id, 'new_version', true);
end;
$$;

create or replace function public.set_probe_set_archived(p_probe_set_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set public.probe_sets%rowtype;
begin
  select * into v_set from public.probe_sets s where s.id = p_probe_set_id for update;
  if not found then
    perform app_private.forbid('Question set not found or access denied.');
  end if;
  perform app_private.require_role(v_set.workspace_id, 'admin');
  update public.probe_sets
  set archived_at = case when p_archived then now() else null end
  where id = p_probe_set_id;
end;
$$;

-- Saves reviewed AI-generated candidates so the generation record matches what was kept.
create or replace function public.svc_record_generation(
  p_workspace_id uuid,
  p_actor uuid,
  p_connection_id uuid,
  p_campaign_id uuid,
  p_kind public.template_kind,
  p_requested_count integer,
  p_model text,
  p_context jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app_private.require_actor_role(p_workspace_id, p_actor, 'admin');
  insert into public.variation_generations (
    workspace_id, connection_id, campaign_id, kind, requested_count, model, context, created_by
  )
  values (p_workspace_id, p_connection_id, p_campaign_id, p_kind, p_requested_count, p_model,
          coalesce(p_context, '{}'::jsonb), p_actor)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.svc_finish_generation(
  p_generation_id uuid,
  p_candidates jsonb,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.variation_generations
  set status = case when p_error is null then 'completed' else 'failed' end,
      candidates = p_candidates,
      error_message = left(p_error, 1000),
      completed_at = now()
  where id = p_generation_id;
end;
$$;
