-- Legiit Recommends — invitations report an existing, never-confirmed account.
--
-- An address can already have an account that was never confirmed: someone registered it while
-- public sign-up was still open on the project, or an earlier invitation was never accepted.
-- Such an account may hold a password that the person being invited did not choose, and the
-- invitation link would confirm that same account. The function now returns its id so the
-- caller (the `ops` Edge Function) can replace the password with one nobody knows before the
-- invitation is sent. Confirmed accounts are added directly, as before.
--
-- Replacing a function keeps its owner and grants, so the API allowlist is unchanged.

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
    'user_exists', v_user.id is not null,
    -- Set only for an account that exists but was never confirmed (see the header).
    'user_id', v_user.id
  );
end;
$$;
