-- Legiit Recommends — new database objects are not reachable through the API until granted.
--
-- Postgres lets everyone execute a newly created function, and the hosted platform additionally
-- grants new tables, sequences and functions in `public` to the API roles. The original
-- migrations corrected that at the end, with app_private.lock_down_api() followed by an explicit
-- allowlist. Between creating an object and that correction, the object was reachable with the
-- publishable key: for a few seconds during a first deployment, and for as long as a later
-- migration forgot to revoke.
--
-- From here on creation is closed by default instead. Anything a browser role or the trusted
-- backend should reach must be granted explicitly by the migration that creates it, exactly
-- like the allowlist in 20261110070800_queues_cron_grants.sql. The same statements now also
-- open 20261110070000_foundations.sql, so a new installation is closed from its first object.
--
-- The last statement is global for objects created by `postgres`: Postgres cannot withdraw the
-- built-in PUBLIC execute right per schema. An extension added later by this role therefore
-- also needs explicit grants on its functions before API roles can call them.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;
alter default privileges for role postgres
  revoke execute on functions from public;
