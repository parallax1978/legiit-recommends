-- Legiit Recommends — provider connections, model catalog, pricing, template library, probe sets.

-- ---------------------------------------------------------------------------------------------
-- Provider connections
-- ---------------------------------------------------------------------------------------------

create type public.connection_status as enum ('not_configured', 'ok', 'error');
create type public.data_sharing_setting as enum ('enabled', 'disabled', 'unknown');

create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider text not null default 'openai' check (provider = 'openai'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  status public.connection_status not null default 'not_configured',
  -- Operational reason when status = 'error': invalid_credentials, quota_exhausted, permission_denied, ...
  status_code text,
  status_message text,
  -- Masked hint only (e.g. "sk-…a1b2"). The key itself lives in Vault.
  key_hint text,
  key_set_at timestamptz,
  key_set_by uuid references auth.users (id) on delete set null,
  last_tested_at timestamptz,
  last_ok_at timestamptz,
  -- Owner's declaration of the OpenAI project data-sharing setting. A record, not a switch.
  data_sharing public.data_sharing_setting not null default 'unknown',
  data_sharing_verified_on date,
  data_sharing_note text check (data_sharing_note is null or char_length(data_sharing_note) <= 500),
  -- Response storage (`store`) for single-request fresh checks. Conversation turns always store
  -- because turn chaining uses previous_response_id. Unrelated to data sharing.
  store_fresh_check_responses boolean not null default false,
  -- Limits shared by every campaign that uses this connection.
  max_concurrent_requests integer not null default 2 check (max_concurrent_requests between 1 and 64),
  requests_per_minute integer check (requests_per_minute is null or requests_per_minute between 1 and 100000),
  tokens_per_minute integer check (tokens_per_minute is null or tokens_per_minute between 1000 and 1000000000),
  -- Spending limits (USD). The daily cap must be set before any paid request is dispatched.
  daily_budget_usd numeric(12, 4) check (daily_budget_usd is null or daily_budget_usd >= 0),
  total_budget_usd numeric(12, 4) check (total_budget_usd is null or total_budget_usd >= 0),
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index provider_connections_name_idx
  on public.provider_connections (workspace_id, lower(name)) where archived_at is null;

create trigger provider_connections_touch before update on public.provider_connections
  for each row execute function app_private.touch_updated_at();

-- Vault reference. Never readable through the Data API.
create table app_private.connection_secrets (
  connection_id uuid primary key references public.provider_connections (id) on delete cascade,
  vault_secret_id uuid not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);
alter table app_private.connection_secrets enable row level security;

create or replace function app_private.drop_connection_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

create trigger connection_secrets_cleanup
  after delete on app_private.connection_secrets
  for each row execute function app_private.drop_connection_secret();

-- Models visible to a connection's key, plus the capability profile discovered by verification.
create table public.provider_models (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  connection_id uuid not null,
  model_id text not null check (char_length(model_id) between 1 and 200),
  owned_by text,
  provider_created_at timestamptz,
  shutdown_date date,
  is_listed boolean not null default true,
  listed_at timestamptz,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'verified', 'failed')),
  verified_at timestamptz,
  verified_by uuid references auth.users (id) on delete set null,
  -- Empirically discovered: supported parameters, effort values, output-token ceiling, chaining.
  capabilities jsonb,
  verification_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, model_id),
  foreign key (workspace_id, connection_id)
    references public.provider_connections (workspace_id, id) on delete cascade
);
create index provider_models_workspace_idx on public.provider_models (workspace_id);

create trigger provider_models_touch before update on public.provider_models
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Model pricing: versioned, append-only. workspace_id NULL = global default (privileged).
-- Estimates derived from these rows are usage-based estimates, not provider invoices.
-- ---------------------------------------------------------------------------------------------

create table public.model_prices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete cascade,
  provider text not null default 'openai' check (provider = 'openai'),
  model_id text not null check (char_length(model_id) between 1 and 200),
  version integer not null check (version >= 1),
  input_usd_per_mtok numeric(14, 6) not null check (input_usd_per_mtok >= 0),
  -- NULL means cached input is billed at the full input rate.
  cached_input_usd_per_mtok numeric(14, 6) check (cached_input_usd_per_mtok is null or cached_input_usd_per_mtok >= 0),
  output_usd_per_mtok numeric(14, 6) not null check (output_usd_per_mtok >= 0),
  -- Prompt-cache write rates where the provider bills them. NULL = not billed separately.
  cache_write_30m_usd_per_mtok numeric(14, 6) check (cache_write_30m_usd_per_mtok is null or cache_write_30m_usd_per_mtok >= 0),
  cache_write_12h_usd_per_mtok numeric(14, 6) check (cache_write_12h_usd_per_mtok is null or cache_write_12h_usd_per_mtok >= 0),
  -- Long-context surcharge: when input tokens exceed the threshold the whole request is
  -- repriced with these multipliers.
  long_context_threshold_tokens integer check (long_context_threshold_tokens is null or long_context_threshold_tokens > 0),
  long_context_input_multiplier numeric(8, 4) check (long_context_input_multiplier is null or long_context_input_multiplier >= 1),
  long_context_output_multiplier numeric(8, 4) check (long_context_output_multiplier is null or long_context_output_multiplier >= 1),
  source_url text not null check (source_url ~* '^https://'),
  verified_on date not null,
  notes text check (notes is null or char_length(notes) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (
    (long_context_threshold_tokens is null and long_context_input_multiplier is null and long_context_output_multiplier is null)
    or (long_context_threshold_tokens is not null and long_context_input_multiplier is not null and long_context_output_multiplier is not null)
  )
);
create unique index model_prices_version_idx
  on public.model_prices (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), provider, model_id, version);
create index model_prices_lookup_idx on public.model_prices (provider, model_id, workspace_id, version desc);

create or replace function app_private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = format('%s rows are immutable.', tg_table_name),
    detail = 'immutable_record';
end;
$$;

create trigger model_prices_immutable
  before update on public.model_prices
  for each row execute function app_private.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Template library (versioned). Campaign revisions pin exact template versions.
-- ---------------------------------------------------------------------------------------------

create type public.template_kind as enum (
  'initial_question',
  'inclusion_request',
  'revision_request',
  'extra_step',
  'fresh_check'
);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind public.template_kind not null,
  label text check (label is null or char_length(label) <= 120),
  -- Free-form library name used to group reusable variations.
  collection text check (collection is null or char_length(collection) <= 120),
  current_version_id uuid,
  source text not null default 'manual' check (source in ('manual', 'csv_import', 'ai_generated')),
  generation_id uuid,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index templates_workspace_idx on public.templates (workspace_id, kind) where archived_at is null;
create index templates_collection_idx on public.templates (workspace_id, collection);

create table public.template_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  template_id uuid not null,
  version integer not null check (version >= 1),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  variables text[] not null default '{}',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version),
  unique (workspace_id, id),
  unique (template_id, id),
  foreign key (workspace_id, template_id) references public.templates (workspace_id, id) on delete cascade
);

alter table public.templates
  add constraint templates_current_version_fk
  foreign key (id, current_version_id) references public.template_versions (template_id, id)
  deferrable initially deferred;

create trigger templates_touch before update on public.templates
  for each row execute function app_private.touch_updated_at();
create trigger template_versions_immutable
  before update on public.template_versions
  for each row execute function app_private.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Probe sets: fresh-check question sets (versioned; every version is immutable).
-- ---------------------------------------------------------------------------------------------

create table public.probe_sets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  current_version_id uuid,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.probe_set_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  probe_set_id uuid not null,
  version integer not null check (version >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (probe_set_id, version),
  unique (workspace_id, id),
  unique (probe_set_id, id),
  foreign key (workspace_id, probe_set_id) references public.probe_sets (workspace_id, id) on delete cascade
);

alter table public.probe_sets
  add constraint probe_sets_current_version_fk
  foreign key (id, current_version_id) references public.probe_set_versions (probe_set_id, id)
  deferrable initially deferred;

create table public.probe_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  probe_set_version_id uuid not null,
  position integer not null check (position >= 1),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  variables text[] not null default '{}',
  -- Held-out questions are never used as conversation prompts in a campaign.
  is_held_out boolean not null default false,
  created_at timestamptz not null default now(),
  unique (probe_set_version_id, position),
  unique (workspace_id, id),
  foreign key (workspace_id, probe_set_version_id)
    references public.probe_set_versions (workspace_id, id) on delete cascade
);

create trigger probe_sets_touch before update on public.probe_sets
  for each row execute function app_private.touch_updated_at();
create trigger probe_set_versions_immutable
  before update on public.probe_set_versions
  for each row execute function app_private.reject_mutation();
create trigger probe_questions_immutable
  before update on public.probe_questions
  for each row execute function app_private.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.provider_connections enable row level security;
alter table public.provider_models enable row level security;
alter table public.model_prices enable row level security;
alter table public.templates enable row level security;
alter table public.template_versions enable row level security;
alter table public.probe_sets enable row level security;
alter table public.probe_set_versions enable row level security;
alter table public.probe_questions enable row level security;

create policy provider_connections_select on public.provider_connections
  for select to authenticated using (app_private.is_member(workspace_id));
create policy provider_models_select on public.provider_models
  for select to authenticated using (app_private.is_member(workspace_id));
create policy model_prices_select on public.model_prices
  for select to authenticated using (workspace_id is null or app_private.is_member(workspace_id));
create policy templates_select on public.templates
  for select to authenticated using (app_private.is_member(workspace_id));
create policy template_versions_select on public.template_versions
  for select to authenticated using (app_private.is_member(workspace_id));
create policy probe_sets_select on public.probe_sets
  for select to authenticated using (app_private.is_member(workspace_id));
create policy probe_set_versions_select on public.probe_set_versions
  for select to authenticated using (app_private.is_member(workspace_id));
create policy probe_questions_select on public.probe_questions
  for select to authenticated using (app_private.is_member(workspace_id));
