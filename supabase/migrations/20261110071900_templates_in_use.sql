-- Legiit Recommends — which prompts are used by a campaign, in one answer.
--
-- The Prompt Library marks prompts that a campaign uses (they can be archived, not deleted). It
-- found them by reading every row that links a prompt to a step of a campaign revision. That
-- table grows with history rather than with the library: each edit of a launched campaign and
-- each duplicate copies all of a campaign's links into a new revision, so a workspace reaches
-- tens of thousands of rows while the library has a few hundred prompts, and the screen read
-- them a thousand at a time on every view.
--
-- This returns the ids of the workspace's prompts that have at least one such link: one index
-- lookup per prompt, one value in the reply, whatever the number of revisions.

create or replace function public.templates_in_use(p_workspace_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app_private.require_role(p_workspace_id, 'member');
  return coalesce((
    select array_agg(t.id)
    from public.templates t
    where t.workspace_id = p_workspace_id
      and exists (
        select 1
        from public.campaign_revision_step_templates l
        where l.template_id = t.id
      )
  ), '{}'::uuid[]);
end;
$$;

-- New objects are closed by default (20261110071100): grant exactly what is needed. The function
-- checks the caller's membership itself.
revoke all on function public.templates_in_use(uuid) from public, anon, authenticated;
grant execute on function public.templates_in_use(uuid) to authenticated;
