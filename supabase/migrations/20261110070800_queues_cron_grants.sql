-- Legiit Recommends — queue, schedules, API grants and realtime.

-- ---------------------------------------------------------------------------------------------
-- Work queue (Supabase Queues / pgmq). Archived messages are the dead-letter record.
-- ---------------------------------------------------------------------------------------------

select pgmq.create('lr_work');

-- The queue tables are only reached through SECURITY DEFINER functions; they are not exposed.
alter table pgmq.q_lr_work enable row level security;
alter table pgmq.a_lr_work enable row level security;
revoke all on table pgmq.q_lr_work from public, anon, authenticated;
revoke all on table pgmq.a_lr_work from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Schedules (Supabase Cron / pg_cron). Deploying the app starts no paid work: these ticks only
-- act on campaigns a person has launched.
-- ---------------------------------------------------------------------------------------------

select cron.schedule('lr-dispatch', '10 seconds', $$select app_private.cron_dispatch()$$);
select cron.schedule('lr-plan', '* * * * *', $$select app_private.cron_plan()$$);
select cron.schedule('lr-maintenance', '17 3 * * *', $$select app_private.cron_maintenance()$$);

-- ---------------------------------------------------------------------------------------------
-- API surface: deny everything, then grant an explicit allowlist.
-- ---------------------------------------------------------------------------------------------

select app_private.lock_down_api();

grant usage on schema public to anon, authenticated, service_role;

-- Reads: members read through row level security. No client role can write to any table.
grant select on
  public.profiles,
  public.workspaces,
  public.workspace_members,
  public.workspace_invitations,
  public.audit_events,
  public.provider_connections,
  public.provider_models,
  public.model_prices,
  public.templates,
  public.template_versions,
  public.probe_sets,
  public.probe_set_versions,
  public.probe_questions,
  public.campaigns,
  public.campaign_revisions,
  public.campaign_revision_steps,
  public.campaign_revision_step_templates,
  public.comparison_groups,
  public.jobs,
  public.runs,
  public.run_turns,
  public.fresh_checks,
  public.manual_checks,
  public.variation_generations,
  public.provider_attempts,
  public.budget_reservations,
  public.usage_ledger,
  public.classifications
to authenticated;

-- The trusted backend reads everything and writes only through svc_* functions.
grant select on all tables in schema public to service_role;

-- Helpers evaluated inside row level security policies.
grant execute on function app_private.role_in(uuid) to authenticated;
grant execute on function app_private.is_member(uuid) to authenticated;
grant execute on function app_private.is_admin(uuid) to authenticated;
grant execute on function app_private.is_owner(uuid) to authenticated;

-- Client RPCs. Every one of these checks the caller's membership and role itself.
grant execute on function public.setup_status() to authenticated;
grant execute on function public.complete_owner_setup(text) to authenticated;
grant execute on function public.accept_pending_invitations() to authenticated;
grant execute on function public.update_profile(text) to authenticated;

grant execute on function public.update_workspace(uuid, text, integer) to authenticated;
grant execute on function public.set_emergency_stop(uuid, boolean, text) to authenticated;
grant execute on function public.update_member_role(uuid, uuid, public.workspace_role) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.delete_workspace(uuid, text) to authenticated;

grant execute on function public.create_connection(uuid, text, numeric, numeric, integer, integer, integer) to authenticated;
grant execute on function public.update_connection(uuid, jsonb) to authenticated;
grant execute on function public.declare_data_sharing(uuid, public.data_sharing_setting, date, text) to authenticated;
grant execute on function public.archive_connection(uuid) to authenticated;

grant execute on function public.effective_prices(uuid) to authenticated;
grant execute on function public.add_model_price(uuid, jsonb) to authenticated;

grant execute on function public.create_templates(uuid, public.template_kind, jsonb, text, text, uuid, boolean) to authenticated;
grant execute on function public.update_template(uuid, text, text, text) to authenticated;
grant execute on function public.set_templates_archived(uuid[], boolean) to authenticated;
grant execute on function public.delete_template(uuid) to authenticated;
grant execute on function public.save_probe_set(uuid, uuid, text, text, jsonb) to authenticated;
grant execute on function public.set_probe_set_archived(uuid, boolean) to authenticated;

grant execute on function public.create_campaign(uuid, text, text) to authenticated;
grant execute on function public.begin_campaign_edit(uuid) to authenticated;
grant execute on function public.save_campaign_draft(uuid, jsonb) to authenticated;
grant execute on function public.discard_campaign_draft(uuid) to authenticated;
grant execute on function public.duplicate_campaign(uuid, text) to authenticated;
grant execute on function public.set_campaign_archived(uuid, boolean) to authenticated;
grant execute on function public.delete_campaign(uuid) to authenticated;
grant execute on function public.campaign_launch_check(uuid) to authenticated;
grant execute on function public.launch_campaign(uuid, uuid, jsonb) to authenticated;
grant execute on function public.apply_campaign_changes(uuid, uuid, jsonb) to authenticated;
grant execute on function public.pause_campaign(uuid) to authenticated;
grant execute on function public.resume_campaign(uuid) to authenticated;
grant execute on function public.cancel_campaign(uuid) to authenticated;
grant execute on function public.request_test_conversation(uuid) to authenticated;

grant execute on function public.retry_job(uuid) to authenticated;
grant execute on function public.restart_run(uuid) to authenticated;
grant execute on function public.resolve_uncertain_attempt(uuid, text) to authenticated;
grant execute on function public.correct_classification(text, uuid, text, integer, integer, text) to authenticated;
grant execute on function public.record_manual_check(uuid, date, text, text, text, jsonb) to authenticated;
grant execute on function public.delete_manual_check(uuid) to authenticated;

grant execute on function public.campaign_conversation_metrics(uuid) to authenticated;
grant execute on function public.campaign_check_metrics(uuid) to authenticated;
grant execute on function public.usage_daily(uuid, date, date, uuid) to authenticated;
grant execute on function public.budget_status(uuid) to authenticated;
grant execute on function public.campaign_plan_preview(uuid) to authenticated;
grant execute on function public.operational_status(uuid) to authenticated;

-- Service functions: trusted backend only.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'svc\_%'
  loop
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Realtime: live refresh of operational screens. Subscribers are authorized by the same row
-- level security policies as ordinary reads.
-- ---------------------------------------------------------------------------------------------

alter publication supabase_realtime add table
  public.campaigns,
  public.jobs,
  public.runs,
  public.fresh_checks,
  public.provider_connections;
