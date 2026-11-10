-- Legiit Recommends — foundations: extensions, schemas, tenancy, audit.
--
-- Access model used by every migration in this project:
--   * Browser/API roles (`anon`, `authenticated`) never receive table write privileges.
--     `authenticated` gets SELECT (filtered by RLS) plus EXECUTE on an explicit allowlist of RPCs.
--   * Every write goes through a SQL function that verifies workspace membership and role itself.
--   * `service_role` (trusted backend: Edge Functions, bootstrap CLI) gets SELECT plus EXECUTE on
--     `svc_*` functions. It still performs writes only through audited functions.
--   * `app_private` holds internals and secrets references and is not exposed through the Data API.
--
-- Grants are explicit so the schema behaves the same whether or not the platform auto-exposes
-- new objects in `public` (see `[api] auto_expose_new_tables`).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Error helpers
-- ---------------------------------------------------------------------------------------------

-- Raise an application error. `p_code` is a stable machine-readable code surfaced as DETAIL.
create or replace function app_private.fail(p_code text, p_message text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_message, detail = p_code;
end;
$$;

create or replace function app_private.forbid(p_message text default 'You do not have permission to do that.')
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  raise exception using errcode = '42501', message = p_message, detail = 'forbidden';
end;
$$;

create or replace function app_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Identity and tenancy
-- ---------------------------------------------------------------------------------------------

create type public.workspace_role as enum ('owner', 'admin', 'member');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text check (display_name is null or char_length(display_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null,
  -- Owner-only global stop: while set, no new provider request is dispatched for the workspace.
  emergency_stop boolean not null default false,
  emergency_stop_at timestamptz,
  emergency_stop_by uuid references auth.users (id) on delete set null,
  emergency_stop_reason text,
  -- Transcript retention in days after a run/check completes. NULL keeps content indefinitely.
  retention_days integer check (retention_days is null or retention_days between 7 and 3650),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  role public.workspace_role not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null
);
create unique index workspace_invitations_pending_idx
  on public.workspace_invitations (workspace_id, email) where status = 'pending';
create index workspace_invitations_email_idx on public.workspace_invitations (email) where status = 'pending';

-- Privileged, global: who may create the first workspace. Written only by the bootstrap command.
create table app_private.owner_bootstrap_grants (
  email text primary key check (email = lower(email)),
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_by uuid,
  workspace_id uuid
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_user_id uuid,
  actor_kind text not null default 'user' check (actor_kind in ('user', 'system', 'worker')),
  action text not null,
  entity_type text,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_workspace_idx on public.audit_events (workspace_id, created_at desc);
create index audit_events_entity_idx on public.audit_events (workspace_id, entity_type, entity_id, created_at desc);

create trigger profiles_touch before update on public.profiles
  for each row execute function app_private.touch_updated_at();
create trigger workspaces_touch before update on public.workspaces
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Membership helpers (used by RLS policies and by every RPC)
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.role_in(p_workspace_id uuid)
returns public.workspace_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.workspace_members m
  where m.workspace_id = p_workspace_id
    and m.user_id = (select auth.uid());
$$;

create or replace function app_private.is_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function app_private.is_admin(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function app_private.is_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

-- Raise unless the caller holds at least `p_min_role` in the workspace. Returns the caller's role.
create or replace function app_private.require_role(p_workspace_id uuid, p_min_role public.workspace_role)
returns public.workspace_role
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.workspace_role;
begin
  if (select auth.uid()) is null then
    perform app_private.forbid('Sign in to continue.');
  end if;
  v_role := app_private.role_in(p_workspace_id);
  if v_role is null then
    -- Same response for "no such workspace" and "not a member": never confirm existence.
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

create or replace function app_private.audit(
  p_workspace_id uuid,
  p_action text,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_details jsonb default '{}'::jsonb,
  p_actor_kind text default null,
  p_actor uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(p_actor, (select auth.uid()));
begin
  insert into public.audit_events (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, details)
  values (
    p_workspace_id,
    v_actor,
    coalesce(p_actor_kind, case when v_actor is null then 'system' else 'user' end),
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(p_details, '{}'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Profile sync from auth.users
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.sync_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '')
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

create trigger lr_sync_profile_insert
  after insert on auth.users
  for each row execute function app_private.sync_profile();

create trigger lr_sync_profile_update
  after update of email on auth.users
  for each row execute function app_private.sync_profile();

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.audit_events enable row level security;
alter table app_private.owner_bootstrap_grants enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1
      from public.workspace_members theirs
      where theirs.user_id = profiles.id
        and app_private.is_member(theirs.workspace_id)
    )
  );

create policy workspaces_select on public.workspaces
  for select to authenticated
  using (app_private.is_member(id));

create policy workspace_members_select on public.workspace_members
  for select to authenticated
  using (app_private.is_member(workspace_id));

create policy workspace_invitations_select on public.workspace_invitations
  for select to authenticated
  using (app_private.is_owner(workspace_id));

create policy audit_events_select on public.audit_events
  for select to authenticated
  using (app_private.is_admin(workspace_id));

-- ---------------------------------------------------------------------------------------------
-- Lockdown routine: deny by default, then grant an explicit allowlist (see the grants migration).
-- ---------------------------------------------------------------------------------------------

create or replace function app_private.lock_down_api()
returns void
language plpgsql
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private')
      and not exists (
        select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;

  for r in
    select c.oid::regclass as rel, c.relkind
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'app_private')
      and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and not exists (
        select 1 from pg_catalog.pg_depend d where d.objid = c.oid and d.deptype = 'e'
      )
  loop
    if r.relkind = 'S' then
      execute format('revoke all on sequence %s from public, anon, authenticated, service_role', r.rel);
    else
      execute format('revoke all on table %s from public, anon, authenticated, service_role', r.rel);
    end if;
  end loop;
end;
$$;
