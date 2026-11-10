-- Legiit Recommends — campaigns, immutable revisions, jobs, runs, turns, fresh checks, provider
-- attempts, budget reservations, usage ledger, classifications.

-- ---------------------------------------------------------------------------------------------
-- Campaigns and revisions
-- ---------------------------------------------------------------------------------------------

create type public.campaign_status as enum (
  'draft',       -- never launched
  'scheduled',   -- launched, start time not reached
  'baseline',    -- collecting baseline fresh checks before any conversation
  'running',     -- conversations and scheduled checks are being dispatched
  'paused',      -- dispatch stopped; `paused_from` remembers where to resume
  'finalizing',  -- conversations ended; waiting for jobs to resolve, then final checks
  'completed',
  'canceled'
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 2000),
  status public.campaign_status not null default 'draft',
  paused_from public.campaign_status,
  -- 'user' or an operational reason: credentials, quota, model_unavailable, configuration.
  pause_reason text,
  pause_detail text,
  -- Editable working copy (NULL when there are no pending edits).
  draft_revision_id uuid,
  -- Frozen revision used for all new work.
  active_revision_id uuid,
  -- Slots have been materialized through this instant.
  planned_through timestamptz,
  launched_at timestamptz,
  launched_by uuid references auth.users (id) on delete set null,
  started_at timestamptz,
  baseline_completed_at timestamptz,
  conversations_ended_at timestamptz,
  final_checks_started_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((status = 'paused') = (paused_from is not null)),
  check (paused_from is null or paused_from in ('scheduled', 'baseline', 'running', 'finalizing'))
);
create index campaigns_workspace_idx on public.campaigns (workspace_id, status);
create index campaigns_active_idx on public.campaigns (status)
  where status in ('scheduled', 'baseline', 'running', 'finalizing');

create trigger campaigns_touch before update on public.campaigns
  for each row execute function app_private.touch_updated_at();

create table public.campaign_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  campaign_id uuid not null,
  revision_number integer not null check (revision_number >= 1),
  state text not null default 'draft' check (state in ('draft', 'frozen', 'discarded')),
  frozen_at timestamptz,
  frozen_by uuid references auth.users (id) on delete set null,
  -- When this revision became the active one (work scheduled after this instant uses it).
  effective_at timestamptz,

  -- Target
  business_name text check (business_name is null or char_length(business_name) <= 200),
  website_url text check (website_url is null or char_length(website_url) <= 500),
  business_aliases text[] not null default '{}',
  domain_aliases text[] not null default '{}',
  category text check (category is null or char_length(category) <= 300),
  location text check (location is null or char_length(location) <= 200),
  language text check (language is null or char_length(language) <= 80),

  -- Provider
  connection_id uuid,
  model text check (model is null or char_length(model) <= 200),
  model_params jsonb not null default '{}'::jsonb check (jsonb_typeof(model_params) = 'object'),
  max_output_tokens integer check (max_output_tokens is null or max_output_tokens between 16 and 1000000),
  execution_mode text not null default 'auto' check (execution_mode in ('auto', 'sync', 'background')),
  -- Fresh-check model settings. NULL means "same as conversations".
  check_model text check (check_model is null or char_length(check_model) <= 200),
  check_params jsonb check (check_params is null or jsonb_typeof(check_params) = 'object'),
  check_max_output_tokens integer check (check_max_output_tokens is null or check_max_output_tokens between 16 and 1000000),

  -- Schedule (instants in UTC; local rules interpreted in `timezone`)
  start_at timestamptz,
  end_at timestamptz,
  schedule_end_mode text not null default 'end_time' check (schedule_end_mode in ('end_time', 'duration')),
  timezone text check (timezone is null or char_length(timezone) <= 64),
  -- ISO weekdays, 1 = Monday … 7 = Sunday
  active_weekdays smallint[] check (
    active_weekdays is null
    or (cardinality(active_weekdays) between 1 and 7 and active_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[])
  ),
  -- Minutes after local midnight; the window is [start, end) with end up to 1440.
  active_start_minute integer check (active_start_minute is null or active_start_minute between 0 and 1439),
  active_end_minute integer check (active_end_minute is null or active_end_minute between 1 and 1440),
  conversations_per_day integer check (conversations_per_day is null or conversations_per_day between 1 and 5000),
  total_conversation_limit integer check (total_conversation_limit is null or total_conversation_limit between 1 and 1000000),
  max_concurrency integer check (max_concurrency is null or max_concurrency between 1 and 64),
  requests_per_minute integer check (requests_per_minute is null or requests_per_minute between 1 and 100000),
  tokens_per_minute integer check (tokens_per_minute is null or tokens_per_minute between 1000 and 1000000000),
  jitter_seconds integer not null default 0 check (jitter_seconds between 0 and 3600),
  missed_slot_behavior text check (missed_slot_behavior is null or missed_slot_behavior in ('skip', 'catch_up')),
  catch_up_max_delay_minutes integer check (catch_up_max_delay_minutes is null or catch_up_max_delay_minutes between 1 and 1440),
  catch_up_max_per_day integer check (catch_up_max_per_day is null or catch_up_max_per_day between 1 and 5000),

  -- Budgets (USD), covering conversations, fresh checks, tests and retries
  daily_budget_usd numeric(12, 4) check (daily_budget_usd is null or daily_budget_usd > 0),
  total_budget_usd numeric(12, 4) check (total_budget_usd is null or total_budget_usd > 0),

  -- Fresh checks
  probe_set_id uuid,
  probe_set_version_id uuid,
  baseline_samples integer check (baseline_samples is null or baseline_samples between 0 and 10000),
  daily_checks integer check (daily_checks is null or daily_checks between 0 and 5000),
  final_samples integer check (final_samples is null or final_samples between 0 and 10000),

  -- Behavior
  on_existing_inclusion text check (on_existing_inclusion is null or on_existing_inclusion in ('continue', 'finish_early')),
  selection_mode text not null default 'balanced' check (selection_mode in ('balanced', 'seeded_random')),
  selection_seed text check (selection_seed is null or char_length(selection_seed) between 1 and 120),

  -- Derived at freeze time
  price_id uuid references public.model_prices (id),
  check_price_id uuid references public.model_prices (id),
  comparison_group_id uuid,
  cohort_key text,
  est_run_max_cost_usd numeric(14, 8),
  est_check_max_cost_usd numeric(14, 8),
  final_check_set_aside_usd numeric(14, 8) not null default 0,
  -- Launch-time validation findings (e.g. target named in an initial question).
  validation jsonb not null default '{}'::jsonb,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (campaign_id, revision_number),
  unique (workspace_id, id),
  unique (campaign_id, id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (workspace_id, connection_id) references public.provider_connections (workspace_id, id),
  foreign key (workspace_id, probe_set_id) references public.probe_sets (workspace_id, id),
  foreign key (workspace_id, probe_set_version_id) references public.probe_set_versions (workspace_id, id),
  check (end_at is null or start_at is null or end_at > start_at),
  check (active_start_minute is null or active_end_minute is null or active_end_minute > active_start_minute),
  -- A frozen revision is complete.
  check (
    state <> 'frozen'
    or (
      frozen_at is not null
      and business_name is not null and website_url is not null and category is not null
      and language is not null and connection_id is not null and model is not null
      and max_output_tokens is not null and start_at is not null and end_at is not null
      and timezone is not null and active_weekdays is not null
      and active_start_minute is not null and active_end_minute is not null
      and conversations_per_day is not null and max_concurrency is not null
      and missed_slot_behavior is not null
      and daily_budget_usd is not null and total_budget_usd is not null
      and baseline_samples is not null and daily_checks is not null and final_samples is not null
      and on_existing_inclusion is not null and selection_seed is not null
      and price_id is not null
      and (missed_slot_behavior <> 'catch_up'
           or (catch_up_max_delay_minutes is not null and catch_up_max_per_day is not null))
      and ((baseline_samples + daily_checks + final_samples) = 0
           or (probe_set_version_id is not null and check_price_id is not null and comparison_group_id is not null))
    )
  )
);
create index campaign_revisions_campaign_idx on public.campaign_revisions (campaign_id, revision_number desc);
create unique index campaign_revisions_single_draft_idx
  on public.campaign_revisions (campaign_id) where state = 'draft';

alter table public.campaigns
  add constraint campaigns_draft_revision_fk
    foreign key (id, draft_revision_id) references public.campaign_revisions (campaign_id, id)
    deferrable initially deferred,
  add constraint campaigns_active_revision_fk
    foreign key (id, active_revision_id) references public.campaign_revisions (campaign_id, id)
    deferrable initially deferred;

-- Frozen revisions never change. Draft rows may be edited or frozen; discarded rows are dead.
create or replace function app_private.guard_revision_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state = 'frozen' then
    -- `effective_at` is stamped exactly once, when a frozen revision becomes the active one.
    if old.effective_at is null and new.effective_at is not null
       and (to_jsonb(new) - 'effective_at' - 'updated_at') = (to_jsonb(old) - 'effective_at' - 'updated_at') then
      return new;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'A frozen campaign revision cannot be modified. Create a new revision instead.',
      detail = 'immutable_revision';
  end if;
  if old.state = 'discarded' then
    raise exception using
      errcode = 'P0001',
      message = 'A discarded campaign revision cannot be modified.',
      detail = 'immutable_revision';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger campaign_revisions_guard
  before update on public.campaign_revisions
  for each row execute function app_private.guard_revision_update();

-- The ordered user-message steps of a conversation.
create table public.campaign_revision_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  revision_id uuid not null,
  step_index integer not null check (step_index between 1 and 12),
  kind public.template_kind not null check (kind <> 'fresh_check'),
  label text check (label is null or char_length(label) <= 120),
  unique (revision_id, step_index),
  unique (workspace_id, id),
  foreign key (workspace_id, revision_id) references public.campaign_revisions (workspace_id, id) on delete cascade,
  check (
    (step_index = 1 and kind = 'initial_question')
    or (step_index = 2 and kind = 'inclusion_request')
    or (step_index = 3 and kind = 'revision_request')
    or (step_index >= 4 and kind = 'extra_step')
  )
);

-- The saved wording variations available to each step. Versions are pinned when frozen.
create table public.campaign_revision_step_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  revision_id uuid not null,
  step_index integer not null,
  position integer not null check (position >= 1),
  template_id uuid not null,
  template_version_id uuid,
  unique (revision_id, step_index, template_id),
  unique (revision_id, step_index, position),
  foreign key (revision_id, step_index)
    references public.campaign_revision_steps (revision_id, step_index) on delete cascade,
  foreign key (workspace_id, revision_id) references public.campaign_revisions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, template_id) references public.templates (workspace_id, id),
  foreign key (template_id, template_version_id) references public.template_versions (template_id, id)
);
create index campaign_revision_step_templates_template_idx
  on public.campaign_revision_step_templates (template_id);

-- Children of a revision are editable only while the revision is a draft.
create or replace function app_private.guard_revision_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision_id uuid := coalesce(new.revision_id, old.revision_id);
  v_state text;
begin
  select r.state into v_state from public.campaign_revisions r where r.id = v_revision_id;
  -- v_state is NULL while the parent revision itself is being deleted (cascade).
  if v_state is not null and v_state <> 'draft' then
    -- Pinning versions happens inside the freeze transaction, flagged by this setting.
    if current_setting('app.freezing_revision', true) = v_revision_id::text then
      return coalesce(new, old);
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'The steps of a frozen campaign revision cannot be modified.',
      detail = 'immutable_revision';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger campaign_revision_steps_guard
  before insert or update or delete on public.campaign_revision_steps
  for each row execute function app_private.guard_revision_child();
create trigger campaign_revision_step_templates_guard
  before insert or update or delete on public.campaign_revision_step_templates
  for each row execute function app_private.guard_revision_child();

-- A comparison group fixes everything that must stay constant for fresh-check results to be
-- comparable: question-set version, allocation, model and parameters.
create table public.comparison_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  campaign_id uuid not null,
  sequence integer not null check (sequence >= 1),
  signature text not null,
  probe_set_version_id uuid not null,
  model text not null,
  params jsonb not null default '{}'::jsonb,
  max_output_tokens integer not null,
  baseline_samples integer not null,
  daily_checks integer not null,
  final_samples integer not null,
  selection_seed text not null,
  -- True when the group began after conversations had already started: its "baseline" is a
  -- mid-campaign reference sample, not a pre-campaign baseline.
  started_mid_campaign boolean not null default false,
  first_revision_id uuid,
  created_at timestamptz not null default now(),
  unique (campaign_id, sequence),
  unique (campaign_id, signature),
  unique (workspace_id, id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (workspace_id, probe_set_version_id) references public.probe_set_versions (workspace_id, id)
);

alter table public.campaign_revisions
  add constraint campaign_revisions_group_fk
  foreign key (workspace_id, comparison_group_id) references public.comparison_groups (workspace_id, id);

create trigger comparison_groups_immutable
  before update on public.comparison_groups
  for each row execute function app_private.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Jobs: one row per scheduled slot. Durable state for the queue consumer.
-- ---------------------------------------------------------------------------------------------

create type public.job_kind as enum (
  'conversation',
  'check_baseline',
  'check_daily',
  'check_final',
  'test_conversation'
);

create type public.job_status as enum (
  'pending',    -- planned, not yet dispatched
  'queued',     -- message in the queue, ready for a worker
  'running',    -- leased by a worker
  'waiting',    -- message hidden until a retry backoff or a background-response poll is due
  'paused',     -- campaign paused; resumes from persisted state
  'blocked',    -- cannot proceed until budget or connection recovers
  'succeeded',
  'dead',       -- dead-letter: needs review; an owner or admin can retry
  'canceled',
  'skipped'     -- slot not executed (missed slot, budget, limit)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  campaign_id uuid not null,
  revision_id uuid not null,
  connection_id uuid not null,
  kind public.job_kind not null,
  -- Deterministic slot identity: local calendar date in the campaign timezone plus an index.
  slot_date date not null,
  slot_index integer not null check (slot_index >= 0),
  scheduled_for timestamptz not null,
  status public.job_status not null default 'pending',
  status_reason text,
  is_catch_up boolean not null default false,
  -- Failed provider attempts for the current unit of work (reset when a unit commits).
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz,
  blocked_until timestamptz,
  queue_msg_id bigint,
  lease_token uuid,
  lease_expires_at timestamptz,
  leased_by text,
  -- Incremented on every claim; commits must present the current value.
  fencing_token bigint not null default 0,
  run_id uuid,
  fresh_check_id uuid,
  last_error_class text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  -- Prevents duplicate scheduling of a slot, however many times the scheduler runs.
  unique (revision_id, kind, slot_date, slot_index),
  unique (workspace_id, id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (campaign_id, revision_id) references public.campaign_revisions (campaign_id, id),
  foreign key (workspace_id, connection_id) references public.provider_connections (workspace_id, id),
  check ((lease_token is null) = (lease_expires_at is null))
);
create index jobs_campaign_status_idx on public.jobs (campaign_id, status, scheduled_for);
create index jobs_due_idx on public.jobs (scheduled_for) where status = 'pending';
create index jobs_active_idx on public.jobs (connection_id, status)
  where status in ('queued', 'running', 'waiting', 'paused', 'blocked');
create index jobs_workspace_status_idx on public.jobs (workspace_id, status, updated_at desc);

create trigger jobs_touch before update on public.jobs
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Runs and turns: one run is one fresh multi-turn conversation.
-- ---------------------------------------------------------------------------------------------

create type public.run_status as enum (
  'pending',
  'in_progress',
  'completed',
  'completed_early',  -- target already present in the first answer and the owner chose to stop
  'incomplete',       -- a turn ended incomplete (e.g. output-token limit)
  'failed',           -- job is in the dead-letter queue; may be retried
  'canceled',
  'expired',          -- provider conversation state no longer available; restart explicitly
  'unresolved'        -- campaign ended while the run could not be resolved
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  campaign_id uuid not null,
  revision_id uuid not null,
  job_id uuid not null,
  connection_id uuid not null,
  kind text not null default 'scheduled' check (kind in ('scheduled', 'test')),
  -- Position in the revision's selection sequence (drives balanced/seeded template selection).
  ordinal integer not null check (ordinal >= 0),
  status public.run_status not null default 'pending',
  -- Snapshot of everything a run needs, so later edits never change an existing run.
  model text,
  model_params jsonb,
  max_output_tokens integer,
  execution_mode text,
  price_id uuid references public.model_prices (id),
  cohort_key text,
  target jsonb,
  on_existing_inclusion text,
  selection_mode text,
  selection_seed text,
  combination_index bigint,
  combination jsonb,
  steps_total integer,
  steps_completed integer not null default 0,
  -- Measurement labels
  target_in_initial_prompt boolean,
  -- Whether the target appeared in the first answer, recorded before the inclusion request.
  target_in_first_response boolean,
  -- Head of the provider response chain
  last_response_id text,
  last_response_at timestamptz,
  restart_of_run_id uuid,
  error_class text,
  error_message text,
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  content_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (revision_id, kind, ordinal),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (campaign_id, revision_id) references public.campaign_revisions (campaign_id, id),
  foreign key (workspace_id, job_id) references public.jobs (workspace_id, id) on delete cascade,
  foreign key (workspace_id, connection_id) references public.provider_connections (workspace_id, id)
);
create index runs_campaign_idx on public.runs (campaign_id, created_at desc);
create index runs_workspace_idx on public.runs (workspace_id, created_at desc);
create index runs_job_idx on public.runs (job_id);

create trigger runs_touch before update on public.runs
  for each row execute function app_private.touch_updated_at();

create type public.turn_status as enum (
  'pending',
  'in_flight',   -- a request has been submitted and its outcome is not yet recorded
  'completed',
  'incomplete',
  'failed',
  'uncertain',   -- the provider may have processed the request; outcome unknown
  'canceled',
  'skipped'
);

create table public.run_turns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  campaign_id uuid not null,
  step_index integer not null check (step_index >= 1),
  step_kind public.template_kind not null,
  template_id uuid,
  template_version_id uuid,
  -- The exact user message sent to the provider.
  rendered_prompt text,
  status public.turn_status not null default 'pending',
  response_id text,
  previous_response_id text,
  output_text text,
  output_items jsonb,
  response_status text,
  incomplete_reason text,
  refusal boolean not null default false,
  requested_model text,
  returned_model text,
  request_params jsonb,
  service_tier text,
  input_tokens integer,
  cached_input_tokens integer,
  cache_write_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  total_tokens integer,
  cost_usd numeric(14, 8),
  latency_ms integer,
  attempt_count integer not null default 0,
  -- Current classification, denormalized for aggregation.
  classification_id uuid,
  mentioned boolean,
  inclusion text check (inclusion is null or inclusion in ('included', 'mentioned_only', 'not_mentioned', 'ambiguous')),
  rank integer,
  list_position integer,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, step_index),
  unique (workspace_id, id),
  foreign key (workspace_id, run_id) references public.runs (workspace_id, id) on delete cascade,
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);
create index run_turns_campaign_idx on public.run_turns (campaign_id, step_index, status);

create trigger run_turns_touch before update on public.run_turns
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Fresh checks: independent single-question requests with no conversation or target context.
-- ---------------------------------------------------------------------------------------------

create type public.check_phase as enum ('baseline', 'daily', 'final');

create type public.check_status as enum (
  'pending',
  'in_flight',
  'completed',
  'incomplete',
  'failed',
  'uncertain',
  'canceled',
  'excluded'   -- deliberately left out of measurement (e.g. the question leaked the target)
);

create table public.fresh_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  campaign_id uuid not null,
  revision_id uuid not null,
  comparison_group_id uuid not null,
  job_id uuid not null,
  connection_id uuid not null,
  phase public.check_phase not null,
  probe_question_id uuid not null,
  question_position integer not null,
  is_held_out boolean not null,
  -- Local calendar day in the campaign timezone, for daily series.
  local_day date not null,
  rendered_prompt text,
  status public.check_status not null default 'pending',
  exclusion_reason text,
  model text not null,
  params jsonb not null default '{}'::jsonb,
  max_output_tokens integer not null,
  execution_mode text not null default 'auto',
  store_response boolean not null default false,
  price_id uuid references public.model_prices (id),
  response_id text,
  output_text text,
  output_items jsonb,
  response_status text,
  incomplete_reason text,
  refusal boolean not null default false,
  returned_model text,
  service_tier text,
  input_tokens integer,
  cached_input_tokens integer,
  cache_write_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  total_tokens integer,
  cost_usd numeric(14, 8),
  latency_ms integer,
  attempt_count integer not null default 0,
  classification_id uuid,
  mentioned boolean,
  inclusion text check (inclusion is null or inclusion in ('included', 'mentioned_only', 'not_mentioned', 'ambiguous')),
  rank integer,
  list_position integer,
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  content_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (job_id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (campaign_id, revision_id) references public.campaign_revisions (campaign_id, id),
  foreign key (workspace_id, comparison_group_id) references public.comparison_groups (workspace_id, id),
  foreign key (workspace_id, job_id) references public.jobs (workspace_id, id) on delete cascade,
  foreign key (workspace_id, probe_question_id) references public.probe_questions (workspace_id, id),
  foreign key (workspace_id, connection_id) references public.provider_connections (workspace_id, id)
);
create index fresh_checks_campaign_idx on public.fresh_checks (campaign_id, comparison_group_id, phase, local_day);
create index fresh_checks_workspace_idx on public.fresh_checks (workspace_id, created_at desc);

create trigger fresh_checks_touch before update on public.fresh_checks
  for each row execute function app_private.touch_updated_at();

-- Manually recorded observations (e.g. from the ChatGPT app). Always a separate dataset.
create table public.manual_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  campaign_id uuid not null,
  observed_on date not null,
  source_label text not null check (char_length(btrim(source_label)) between 1 and 120),
  question text check (question is null or char_length(question) <= 4000),
  response_text text not null check (char_length(btrim(response_text)) between 1 and 100000),
  classification_id uuid,
  mentioned boolean,
  inclusion text check (inclusion is null or inclusion in ('included', 'mentioned_only', 'not_mentioned', 'ambiguous')),
  rank integer,
  list_position integer,
  recorded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);
create index manual_checks_campaign_idx on public.manual_checks (campaign_id, observed_on);

-- ---------------------------------------------------------------------------------------------
-- Variation generation (explicit, logged, reviewable)
-- ---------------------------------------------------------------------------------------------

create table public.variation_generations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  connection_id uuid not null,
  campaign_id uuid,
  kind public.template_kind not null,
  requested_count integer not null check (requested_count between 1 and 100),
  model text not null,
  context jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  candidates jsonb,
  error_message text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, connection_id) references public.provider_connections (workspace_id, id) on delete cascade
);
create index variation_generations_workspace_idx on public.variation_generations (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Provider attempts: exactly one row per HTTP request that creates a response.
-- ---------------------------------------------------------------------------------------------

create type public.attempt_purpose as enum (
  'conversation_turn',
  'fresh_check',
  'model_probe',
  'variation_generation',
  'classification'
);

create type public.attempt_status as enum (
  'started',     -- request submitted; outcome not recorded yet
  'in_flight',   -- background response accepted by the provider; being polled by response id
  'succeeded',
  'incomplete',
  'failed',      -- the provider answered with an error, or the request never left
  'uncertain',   -- timed out or interrupted: the provider may have processed it
  'canceled'
);

create table public.provider_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  connection_id uuid not null,
  campaign_id uuid,
  purpose public.attempt_purpose not null,
  is_test boolean not null default false,
  job_id uuid,
  run_id uuid,
  run_turn_id uuid,
  fresh_check_id uuid,
  generation_id uuid,
  attempt_number integer not null default 1,
  status public.attempt_status not null default 'started',
  mode text not null default 'sync' check (mode in ('sync', 'background')),
  requested_model text not null,
  -- Non-secret request settings actually sent (parameters, store flag, chaining).
  request_params jsonb not null default '{}'::jsonb,
  est_input_tokens integer not null default 0,
  max_output_tokens integer not null default 0,
  response_id text,
  provider_request_id text,
  http_status integer,
  error_class text,
  error_type text,
  error_code text,
  error_param text,
  error_message text,
  retry_after_ms integer,
  returned_model text,
  service_tier text,
  response_status text,
  input_tokens integer,
  cached_input_tokens integer,
  cache_write_tokens integer,
  cache_write_30m_tokens integer,
  cache_write_12h_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  total_tokens integer,
  cost_usd numeric(14, 8),
  price_id uuid references public.model_prices (id),
  reservation_id uuid,
  lease_token uuid,
  fencing_token bigint,
  poll_count integer not null default 0,
  last_polled_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  latency_ms integer,
  -- Owner resolution of an uncertain attempt.
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  resolution text check (resolution is null or resolution in ('counted_as_spent', 'released', 'reconciled')),
  created_by uuid references auth.users (id) on delete set null,
  unique (workspace_id, id),
  foreign key (workspace_id, connection_id) references public.provider_connections (workspace_id, id) on delete cascade,
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (workspace_id, job_id) references public.jobs (workspace_id, id) on delete cascade
);
create index provider_attempts_connection_idx on public.provider_attempts (connection_id, started_at desc);
create index provider_attempts_open_idx on public.provider_attempts (connection_id, status)
  where status in ('started', 'in_flight');
create index provider_attempts_job_idx on public.provider_attempts (job_id, started_at);
create index provider_attempts_turn_idx on public.provider_attempts (run_turn_id);
create index provider_attempts_check_idx on public.provider_attempts (fresh_check_id);
create index provider_attempts_workspace_idx on public.provider_attempts (workspace_id, started_at desc);
create index provider_attempts_uncertain_idx on public.provider_attempts (workspace_id)
  where status = 'uncertain' and resolved_at is null;

-- ---------------------------------------------------------------------------------------------
-- Budget reservations and usage ledger
-- ---------------------------------------------------------------------------------------------

create type public.reservation_status as enum (
  'held',        -- reserved before dispatch
  'settled',     -- reconciled against returned usage (see usage_ledger)
  'released',    -- request definitely not billed
  'unresolved'   -- ambiguous attempt: kept counted against the caps until resolved
);

create table public.budget_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  connection_id uuid not null,
  campaign_id uuid,
  attempt_id uuid not null,
  purpose public.attempt_purpose not null,
  is_final_check boolean not null default false,
  amount_usd numeric(14, 8) not null check (amount_usd >= 0),
  status public.reservation_status not null default 'held',
  settled_cost_usd numeric(14, 8),
  -- Day buckets fixed at reservation time: UTC day for the connection cap, campaign-local day
  -- for the campaign cap.
  connection_day date not null,
  campaign_day date,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (workspace_id, id),
  unique (attempt_id),
  foreign key (workspace_id, connection_id) references public.provider_connections (workspace_id, id) on delete cascade,
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (workspace_id, attempt_id) references public.provider_attempts (workspace_id, id) on delete cascade
);
create index budget_reservations_open_conn_idx on public.budget_reservations (connection_id, connection_day)
  where status in ('held', 'unresolved');
create index budget_reservations_open_campaign_idx on public.budget_reservations (campaign_id, campaign_day)
  where status in ('held', 'unresolved');
create index budget_reservations_workspace_idx on public.budget_reservations (workspace_id, created_at desc);

alter table public.provider_attempts
  add constraint provider_attempts_reservation_fk
  foreign key (reservation_id) references public.budget_reservations (id)
  deferrable initially deferred;

-- Append-only record of usage-based cost estimates. Not an invoice.
create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  connection_id uuid not null,
  campaign_id uuid,
  attempt_id uuid not null,
  purpose public.attempt_purpose not null,
  is_test boolean not null default false,
  model text not null,
  returned_model text,
  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cost_usd numeric(14, 8) not null check (cost_usd >= 0),
  price_id uuid references public.model_prices (id),
  -- 'usage' = computed from returned token usage; 'reservation' = an unresolved reservation the
  -- owner chose to count as spent (no usage was returned).
  basis text not null default 'usage' check (basis in ('usage', 'reservation')),
  connection_day date not null,
  campaign_day date,
  occurred_at timestamptz not null default now(),
  unique (attempt_id),
  foreign key (workspace_id, connection_id) references public.provider_connections (workspace_id, id) on delete cascade,
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (workspace_id, attempt_id) references public.provider_attempts (workspace_id, id) on delete cascade
);
create index usage_ledger_conn_day_idx on public.usage_ledger (connection_id, connection_day);
create index usage_ledger_campaign_day_idx on public.usage_ledger (campaign_id, campaign_day);
create index usage_ledger_workspace_idx on public.usage_ledger (workspace_id, occurred_at desc);

create trigger usage_ledger_immutable
  before update on public.usage_ledger
  for each row execute function app_private.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Classifications: detection results with a full correction history.
-- ---------------------------------------------------------------------------------------------

create table public.classifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  campaign_id uuid not null,
  subject_type text not null check (subject_type in ('run_turn', 'fresh_check', 'manual_check')),
  subject_id uuid not null,
  method text not null check (method in ('rules', 'model', 'manual')),
  detector_version text,
  mentioned boolean not null,
  inclusion text not null check (inclusion in ('included', 'mentioned_only', 'not_mentioned', 'ambiguous')),
  -- Explicit rank only when the answer is a numbered ranking; never inferred.
  rank integer check (rank is null or rank >= 1),
  -- Position inside an unranked list.
  list_position integer check (list_position is null or list_position >= 1),
  list_kind text not null default 'none' check (list_kind in ('numbered', 'bulleted', 'none')),
  list_length integer,
  -- [{start, end, text, kind, term}] character spans in the raw answer.
  matched_spans jsonb not null default '[]'::jsonb,
  reason text,
  note text check (note is null or char_length(note) <= 1000),
  is_current boolean not null default true,
  supersedes_id uuid references public.classifications (id) on delete set null,
  attempt_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  check (rank is null or list_kind = 'numbered'),
  check (inclusion <> 'not_mentioned' or (mentioned = false and rank is null and list_position is null))
);
create unique index classifications_current_idx
  on public.classifications (subject_type, subject_id) where is_current;
create index classifications_subject_idx on public.classifications (subject_type, subject_id, created_at desc);
create index classifications_review_idx on public.classifications (campaign_id)
  where is_current and inclusion = 'ambiguous';

-- ---------------------------------------------------------------------------------------------
-- Infrastructure (global, privileged)
-- ---------------------------------------------------------------------------------------------

create table app_private.heartbeats (
  name text primary key,
  last_started_at timestamptz,
  last_ok_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  last_duration_ms integer,
  runs bigint not null default 0,
  details jsonb not null default '{}'::jsonb
);
alter table app_private.heartbeats enable row level security;

create table app_private.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table app_private.settings enable row level security;

insert into app_private.settings (key, value) values
  ('queue_name', '"lr_work"'),
  -- Messages stay invisible this long after a worker reads them (must exceed the worker deadline).
  ('lease_seconds', '180'),
  -- Upper bound on worker invocations woken per dispatch tick.
  ('max_wakes_per_tick', '8'),
  -- Slots are materialized this far ahead.
  ('planning_horizon_minutes', '1440'),
  -- A pending slot older than this is treated as missed.
  ('missed_slot_grace_minutes', '5'),
  ('retry_base_seconds', '5'),
  ('retry_max_seconds', '900'),
  ('background_poll_max_minutes', '30'),
  ('finalize_wait_minutes', '120');

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.campaigns enable row level security;
alter table public.campaign_revisions enable row level security;
alter table public.campaign_revision_steps enable row level security;
alter table public.campaign_revision_step_templates enable row level security;
alter table public.comparison_groups enable row level security;
alter table public.jobs enable row level security;
alter table public.runs enable row level security;
alter table public.run_turns enable row level security;
alter table public.fresh_checks enable row level security;
alter table public.manual_checks enable row level security;
alter table public.variation_generations enable row level security;
alter table public.provider_attempts enable row level security;
alter table public.budget_reservations enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.classifications enable row level security;

create policy campaigns_select on public.campaigns
  for select to authenticated using (app_private.is_member(workspace_id));
create policy campaign_revisions_select on public.campaign_revisions
  for select to authenticated using (app_private.is_member(workspace_id));
create policy campaign_revision_steps_select on public.campaign_revision_steps
  for select to authenticated using (app_private.is_member(workspace_id));
create policy campaign_revision_step_templates_select on public.campaign_revision_step_templates
  for select to authenticated using (app_private.is_member(workspace_id));
create policy comparison_groups_select on public.comparison_groups
  for select to authenticated using (app_private.is_member(workspace_id));
create policy jobs_select on public.jobs
  for select to authenticated using (app_private.is_member(workspace_id));
create policy runs_select on public.runs
  for select to authenticated using (app_private.is_member(workspace_id));
create policy run_turns_select on public.run_turns
  for select to authenticated using (app_private.is_member(workspace_id));
create policy fresh_checks_select on public.fresh_checks
  for select to authenticated using (app_private.is_member(workspace_id));
create policy manual_checks_select on public.manual_checks
  for select to authenticated using (app_private.is_member(workspace_id));
create policy variation_generations_select on public.variation_generations
  for select to authenticated using (app_private.is_admin(workspace_id));
create policy provider_attempts_select on public.provider_attempts
  for select to authenticated using (app_private.is_member(workspace_id));
create policy budget_reservations_select on public.budget_reservations
  for select to authenticated using (app_private.is_member(workspace_id));
create policy usage_ledger_select on public.usage_ledger
  for select to authenticated using (app_private.is_member(workspace_id));
create policy classifications_select on public.classifications
  for select to authenticated using (app_private.is_member(workspace_id));
