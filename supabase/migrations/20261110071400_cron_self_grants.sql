-- Legiit Recommends — remove the self-granted privileges on the cron schema.
--
-- The first migration used to run `grant usage on schema cron to postgres` and `grant all
-- privileges on all tables in schema cron to postgres`. On this platform `postgres` already
-- receives those rights from the script that runs after pg_cron is created, so the lines only
-- added entries that `postgres` granted to itself. They are not harmless: afterwards every
-- `create extension if not exists pg_cron` fails with "dependent privileges exist", because
-- the platform script tries to reset the rights it gave and finds grants that depend on them.
--
-- The two lines are gone from the first migration. This removes the entries from databases
-- where they already ran. A role can only revoke what it granted itself, so the rights given
-- by the platform stay in place and the schedules keep working.

revoke all on all tables in schema cron from postgres;
revoke usage on schema cron from postgres;
