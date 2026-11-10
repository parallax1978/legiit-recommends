-- Legiit Recommends — an account that authored immutable records can be deleted.
--
-- Prompt versions, question-set versions, workspace prices and frozen campaign revisions keep
-- who created them, with foreign keys declared ON DELETE SET NULL so that removing a person's
-- login never removes history. The triggers that make those rows immutable rejected that very
-- update, so "Delete user" in the Supabase dashboard (or the Auth admin API) failed with a
-- database error for anyone who had ever written a prompt or launched a campaign.
--
-- The triggers now let exactly one change through: the author columns going from a value to
-- NULL with every other column untouched. Everything else is rejected as before, including
-- replacing an author with another account.

create or replace function app_private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Deleting an account clears its authorship on the rows it created (foreign keys declared
  -- ON DELETE SET NULL). That is the one change an immutable row accepts: who wrote it
  -- becomes unknown and nothing else moves.
  if tg_op = 'UPDATE'
     and (to_jsonb(old) ->> 'created_by') is not null
     and (to_jsonb(new) ->> 'created_by') is null
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by') then
    return new;
  end if;
  raise exception using
    errcode = 'P0001',
    message = format('%s rows are immutable.', tg_table_name),
    detail = 'immutable_record';
end;
$$;

create or replace function app_private.guard_revision_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The same exception as for other immutable records: an account being deleted has its
  -- authorship cleared, and that alone is let through for frozen and discarded revisions.
  if old.state in ('frozen', 'discarded')
     and (new.created_by is distinct from old.created_by or new.frozen_by is distinct from old.frozen_by)
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.frozen_by is null or new.frozen_by is not distinct from old.frozen_by)
     and (to_jsonb(new) - 'created_by' - 'frozen_by' - 'updated_at')
       = (to_jsonb(old) - 'created_by' - 'frozen_by' - 'updated_at') then
    return new;
  end if;
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
