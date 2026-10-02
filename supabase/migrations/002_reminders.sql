-- Planner v3, step 2: push reminders. Run in the Supabase SQL editor after 001_init.sql.
-- The app writes the next 14 days of blocks here (js/sync.js materialize); the `tick` edge function
-- sends the due ones as Web Push. The server never runs the schedule engine.

create table if not exists public.occurrences (
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  id        text not null,                 -- '<blockId>|<YYYY-MM-DD>'
  name      text not null,
  cat       text,
  color     text,
  body      text,
  start_at  timestamptz not null,
  end_at    timestamptz not null,
  remind_at timestamptz,                   -- null: reminders off for this block type
  hash      text not null,                 -- changes when anything above changes
  deleted   boolean not null default false,
  sent_at   timestamptz,                   -- set by tick before sending, so nothing goes out twice
  gcal_id   text, gcal_hash text,          -- unused: Google Calendar sync was dropped
  primary key (user_id, id)
);
create index if not exists occurrences_due on public.occurrences (remind_at) where sent_at is null and not deleted;
alter table public.occurrences enable row level security;
drop policy if exists "own occurrences" on public.occurrences;
create policy "own occurrences" on public.occurrences for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- One row per device that turned reminders on.
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh     text not null,
  auth       text not null,
  device     text,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "own push subs" on public.push_subs;
create policy "own push subs" on public.push_subs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Every minute, call the tick function. The cron job itself is created by supabase/local/cron.sql,
-- which holds the shared secret and is not committed.
create extension if not exists pg_cron;
create extension if not exists pg_net;
