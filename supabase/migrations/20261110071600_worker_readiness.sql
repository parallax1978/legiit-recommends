-- Legiit Recommends — a wake-up is only accepted by a worker that can reach the database.
--
-- The worker used to answer "accepted" as soon as the shared secret matched, before it had read
-- its service key or made a single database call. A worker whose key had been revoked or
-- rotated would therefore look healthy to the wake-up check and on the status page while
-- every unit of work failed out of sight in the function's logs.
--
-- The worker now calls this function first and answers 503 when the call fails. It does
-- nothing: reaching it proves the function's URL and key, the API gateway, the `service_role`
-- grant and the database, which is everything claiming work depends on.

create or replace function public.svc_worker_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select true;
$$;

-- New objects are closed by default (20261110071100): grant exactly what is needed.
revoke all on function public.svc_worker_ready() from public, anon, authenticated;
grant execute on function public.svc_worker_ready() to service_role;
