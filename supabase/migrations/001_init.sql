-- Planner v3: user data, synced by js/sync.js. Run in the Supabase SQL editor (or `supabase db push`).

create table if not exists public.records (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  collection text not null,
  id         text not null,
  data       jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null,                 -- client clock, decides conflicts (last write wins)
  server_ts  timestamptz not null default clock_timestamp(),  -- server clock, drives incremental pulls
  primary key (user_id, collection, id)
);
create index if not exists records_pull on public.records (user_id, server_ts);

alter table public.records enable row level security;
drop policy if exists "own records" on public.records;
create policy "own records" on public.records for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No delete from the client: deletes are tombstones (deleted = true), so the other device learns about them.
revoke delete on public.records from anon, authenticated;

-- Last write wins, enforced on the server too: an older write is silently skipped.
-- clock_timestamp(), not now(): rows of one batch upsert get distinct server_ts values, so paging by server_ts can't skip rows.
create or replace function public.records_lww() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.server_ts := clock_timestamp();
  return new;
end $$;
drop trigger if exists records_lww on public.records;
create trigger records_lww before insert or update on public.records
  for each row execute function public.records_lww();

-- Realtime: the other device gets changes live.
do $$ begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object then null; end $$;
