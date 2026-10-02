# Planner v3 spec

This spec comes from the decisions in `WAYFINDER.md` (D1–D15). It describes what to build. The order of work is in "Build order" at the end.

## 1. Goal

A planner for one person. It runs as a PWA on Android, iPhone and desktop browsers, works offline, and syncs through Supabase. Block reminders arrive as Web Push even when the app is closed. There is no Excel.

**Done means:**
- Edit a task on the laptop and it shows on the phone within 5 s while both are online. An edit made offline syncs on reconnect.
- With the app closed and the phone locked, a reminder arrives within 1 minute of `start − lead` on Android and on iPhone (iOS 16.4+, installed to the Home Screen).
- Blocks from the next 14 days appear in a Google Calendar called "Planner" and follow edits within 5 minutes.
- Prayer times update daily from your location (Egyptian method), with no typing.
- `node tests/check.js` passes.

## 2. Architecture

```
 browser (vanilla JS, no build)                   Supabase (free tier)
 ┌───────────────────────────────┐    sync    ┌───────────────────────────────┐
 │ schedule.js tasks.js (kept)   │ ─────────▶ │ records       (all user data) │
 │ prayer.js habits.js (new)     │ ◀───────── │   realtime channel            │
 │ sync.js  (replaces store.js)  │            │ occurrences   (next 14 days)  │
 │ IndexedDB: records + outbox   │ ─────────▶ │ push_subs                     │
 │ sw.js: shell cache + push     │            │ google_tokens                 │
 └───────────────────────────────┘            │ pg_cron ─▶ edge fn "tick"     │
          ▲ Web Push                          │    ├ send due pushes (VAPID)  │
          └────────────────────────────────── │    └ upsert Google events     │
                                              └───────────────────────────────┘
```

**Key choice: the server never runs the schedule engine.** Whenever the plan changes (and at least once a day when any device opens), the client *materializes* the next 14 days of block occurrences into the `occurrences` table. The server only reads those rows to send pushes and write to Google Calendar. That keeps the chain logic in one place (`schedule.js`), and the edge function stays small.
`ponytail:` if no device opens the app for 14 days, reminders stop. The app shows "Reminders scheduled until <date>" in Settings. The upgrade path is running `schedule.js` in the edge function nightly.

Hosting: the static files go on GitHub Pages (HTTPS, free). The same repo runs a weekly GitHub Action that pings Supabase so the free project doesn't pause.

## 3. Data model

### 3.1 One generic table for user data

```sql
create table records (
  user_id    uuid not null default auth.uid() references auth.users,
  collection text not null,           -- see list below
  id         text not null,
  data       jsonb,                   -- null when deleted
  deleted    boolean not null default false,
  updated_at timestamptz not null,    -- set by the client (last-write-wins)
  server_ts  timestamptz not null default now(),  -- set by a trigger on every write, used for pulls
  primary key (user_id, collection, id)
);
-- RLS: user_id = auth.uid() for select/insert/update. No delete: deletes are tombstones.
-- Trigger: before insert/update, set server_ts = now(), and reject the write if new.updated_at < old.updated_at (LWW is enforced on the server).
```

| collection | id | data | comes from today |
|---|---|---|---|
| `settings` | `main` | the `DEFAULTS` keys plus `location {lat,lng,name}`, `prayerAuto`, `prayerAdjust {fajr:+2,…}` | `plan.settings` |
| `category` | key (`Gym`) | `{label,color,remind,lead,dashed}` | `plan.categories[k]` |
| `customBlock` | block id | the custom block object | `plan.customBlocks[]` |
| `override` | `w:<blockId>` or `d:<iso>:<blockId>` | the override fields | `plan.overrides.weekly/dated` |
| `blockDone` | `<iso>\|<blockId>` | `{done:true}` | `blockDone` |
| `task` | task id | the task object (unchanged shape) | `tasks` |
| `habit` | uid | `{name,color,days:[0-6],order,archived}` | new |
| `habitLog` | `<habitId>\|<iso>` | `{done:true}` | new |
| `timeEntry` | uid | `{taskId?, blockKey?, cat, start, end}` (ms; `end` null while running) | new |
| `pref` | key | per-user UI prefs that should follow you | `prefs` |

The in-memory `plan` object keeps its current shape. `sync.js` rebuilds it from records (`recordsToPlan`) and turns edits back into records (`planDiff`). The rest of `ui.js` keeps calling `changed(...)` as it does today.

### 3.2 Server-only tables

```sql
create table occurrences (           -- written by the client, read by the tick function
  user_id uuid, id text,             -- '<blockId>|<iso>'
  name text, cat text, color text,
  start_at timestamptz, end_at timestamptz,
  remind_at timestamptz,             -- null if the category has reminders off
  hash text,                         -- of name/cat/start/end/note, for Google change detection
  deleted boolean default false,
  sent_at timestamptz, gcal_id text, gcal_hash text,
  primary key (user_id, id)
);
create table push_subs (user_id uuid, endpoint text primary key, p256dh text, auth text, device text, created_at timestamptz default now());
create table google_tokens (user_id uuid primary key, refresh_token text, calendar_id text);  -- never readable by the client (RLS denies select)
```

## 4. Sync (`js/sync.js`, which replaces `store.js`)

- **Local:** IndexedDB `planner` v2 with an object store `records` (key `[collection,id]`) and a `meta` store (`lastPull`, `userId`). A record changed locally gets `dirty:true`.
- **Push:** debounce 1 s after `changed()`, then upsert every dirty record, then clear `dirty`. If offline, keep it dirty and retry on `online` and on app focus.
- **Pull:** on boot, on focus and on reconnect, select `records where server_ts > lastPull`. A pulled record only overwrites the local copy if `updated_at` is ≥ the local value and the local copy isn't dirty with a newer `updated_at`. Then call `renderAll()`.
- **Live:** a Supabase Realtime subscription on `records` for this user applies incoming rows with the same rule.
- **Deletes** are tombstones (`deleted:true, data:null`). This fixes the old "deleted tasks come back" limit.
- **Clock skew:** `updated_at` comes from the device clock. That's acceptable for one person. `ponytail:` if two devices edit the same record in the same second, the later push wins.
- **Supabase client:** `@supabase/supabase-js` loaded as an ES module from jsDelivr, pinned to a version and cached by the service worker. No build step.

**Auth:** magic link (`signInWithOtp`). Signed out, the app still works locally. Records wait in IndexedDB and sync on first sign-in. A sign-in screen appears on first run with a "Use without account" option.

**Migration (D11):** on first boot of v3, if the old `kv` store exists, convert each collection into records (all dirty) and delete nothing. After the first successful push, set `meta.migrated = true`. The old localStorage path from the original HTML planner is dropped.

**Backup:** Settings has *Export JSON* (all records) and *Import JSON* (merges by the LWW rule). This replaces Excel.

## 5. Reminders (Web Push)

- **Subscribe:** Settings → *Turn on reminders on this device*. This asks for notification permission, runs `pushManager.subscribe` with the VAPID public key and upserts a `push_subs` row. iPhone: show "Add to Home Screen first" when it isn't installed (`navigator.standalone` is false).
- **Materialize** (`materialize(plan, fromMs, days=14)` in `notify.js`, pure and tested): it takes `visible(buildDay())` for each day and returns occurrence rows with `remind_at = start − lead` when the category has reminders on. `sync.js` upserts the rows and marks window rows that are no longer produced as `deleted`. It runs after any change to settings, category, customBlock or override, and once a day.
- **tick edge function** (pg_cron every minute through `pg_net`):
  1. `select … where remind_at <= now() and remind_at > now() - interval '5 min' and sent_at is null and not deleted`. The 5-minute window keeps late alerts from arriving stale, which matches the current rule.
  2. Set `sent_at = now()` first (dedupe), then send `{title:name, body:"starts in N min", color, tag:id}` to every `push_subs` row. A 404/410 response deletes that subscription.
  3. Google step (§6).
- **sw.js:** a `push` event shows the notification with the category color as its icon. `notificationclick` focuses or opens the app. If a planner window is focused, it `postMessage`s instead and the page shows a toast.
- **Removed:** the client-side reminder firing in `ui.js runReminders`, `notifyLog`, `buildICS`/.ics export, and the multi-tab leader logic. `upcomingReminders` stays for the dashboard.

## 6. Google Calendar (one-way)

- Settings → *Connect Google Calendar* starts an OAuth flow (scope `calendar.app.created`, access_type offline). An edge function `google-callback` exchanges the code and stores the refresh token in `google_tokens`. It creates a calendar called "Planner" and stores its id.
- The tick function runs the Google step at most every 5 minutes. For rows where `hash != gcal_hash`: insert or patch the event (`colorId` is the nearest Google color to the category color, `reminders.useDefault=false` because push handles alerts). For `deleted` rows with a `gcal_id`: delete the event. Then set `gcal_hash`.
- *Disconnect* revokes the token and deletes the "Planner" calendar.

## 7. Prayer times (`prayerTimesFor` in `js/schedule.js`)

- About 20 lines of standard solar-position math (Fajr 19.5°, Isha 17.5°, Asr shadow 1, Dhuhr +1 min), with no vendored library. It runs offline and matches adhan's `CalculationMethod.Egyptian()` within ±1 min all year in Egypt (checked in a scratch script, with a pinned case in `tests/check.js`). There is no high-latitude rule: a prayer with no solution keeps its manual time. Per-prayer ± adjustments were skipped.
- `prayerTimesFor(settings, date)` returns `{fajr,dhuhr,asr,maghrib,isha}` as `HH:MM` after the per-prayer ± minute adjustments. When `prayerAuto` is on, `buildDay` uses `norm({...plan.settings, ...prayerTimesFor(plan.settings, date)})`. That's a one-line change in `schedule.js`, and the chain slides as it does today.
- Location: Settings → *Use my location* (`navigator.geolocation`, run once and stored in settings) or a manual latitude/longitude. The manual times stay available when auto is off.

## 8. Habits and time tracking (D15)

**Habits** (`js/habits.js`, pure):
- A habit repeats on chosen weekdays. It is ticked once per day in `habitLog`.
- `streak(habit, logs, todayIso)` counts consecutive *scheduled* days that were done. Today doesn't break the streak until the day ends.
- `rate(habit, logs, fromIso, toIso)` gives done ÷ scheduled.
- UI (built): today's habits are tick pills on Now. Tasks → *Habits* lists every habit with "n in a row" and a 12-week grid, adds new ones (name + weekdays) and edits or deletes them. There's no separate tab, so the bar stays at 4.

**Timers:**
- One timer runs at a time. Start it from a task (▶ in `taskItem`) or from the current block card in Now. Starting another one stops the running timer.
- A running timer is a `timeEntry` with `end:null`, so it syncs and the other device shows it running. It survives reloads.
- The running timer is a pill on every tab (label, elapsed, Stop). A block timer stops by itself at the block's end. A tap under a minute leaves no entry.
- Tasks show actual time next to the estimate (`35m / 20m est`).

## 9. Stats (replaces the Budget view)

A *Stats* view with a week picker:
- For each category: planned hours (from blocks, the current Budget math), done hours (blocks ticked in `blockDone`) and tracked hours (`timeEntry`). Shown as horizontal bars.
- Tasks completed per day (a 7-bar chart) and the overdue count.
- Habit completion % for the week.
- The current Budget checks (slack/hard ratios) move here as one line.
- This also fixes the "custom blocks overlapping the chain count twice" limit: planned hours come from the union of intervals per day, not a plain sum.

## 10. UX changes

**Navigation (phone first):**
- A bottom tab bar with five tabs: **Now · Plan · Tasks · Habits · Stats**.
- *Plan* is Day and Week behind a segmented toggle. *Settings* sits behind a gear in the top bar.
- On wide screens (≥ 900 px) the tabs move to a left rail.
- Tap targets are at least 44 px. There's no horizontal scroll at 360 px. The bottom bar uses `env(safe-area-inset-bottom)`.

**Background (D12):** `body` gets `background: linear-gradient(180deg, color-mix(in srgb, var(--c) 70%, var(--paper)) 0, color-mix(in srgb, var(--n) 25%, var(--paper)) 100%) fixed`.
- `--c` is the current block's category color and `--n` is the next block's. Both are set in `tick()` next to the existing `theme-color` update.
- Cards stay on `var(--card)`, so text contrast doesn't depend on the gradient.
- With nothing scheduled, the background falls back to `var(--paper)`.
- The gradient transitions over 1 s when the block changes.

**Quick add (D13):** one input at the top of Now and Tasks. `parseQuick(text, plan, nowMs)` in `tasks.js` is pure and tested:

| token | meaning |
|---|---|
| `!low` `!med` `!high` `!urgent` (also `!1`–`!4`) | priority |
| `@gym` | the next occurrence of a block whose name or category matches (today or later) → `link:{type:'block'}` |
| `@every-gym` or `*gym` | every block of that category → `link:{type:'cat'}` |
| `today` `tomorrow` `sun`…`sat` `2026-10-03` | link to that day (or combine: `@gym tomorrow` means tomorrow's Gym block) |
| `morning` `afternoon` `evening` | the period of that day (today by default) |
| `20m` `1h` `1h30m` | estimate |
| `due:fri` | due date |
| no link token | the current block (the inbox if nothing is current) |

- Everything that isn't a token becomes the title.
- A live preview chip under the input shows what was parsed, in the target block's color.
- Enter saves. The full edit dialog is still there by tapping the task.

**Dark mode:** `@media (prefers-color-scheme: dark)` tokens for `--paper`, `--card`, `--ink` and `--line`. Category colors stay the same.

## 11. Files

| file | change |
|---|---|
| `js/schedule.js` | keep; per-day prayer times hook in `buildDay` |
| `js/tasks.js` | keep; add `parseQuick` |
| `js/notify.js` | keep `upcomingReminders`; add `materialize`; delete `dueReminders`, `pruneLog`, `buildICS` and the in-page `Notify.show` path |
| `js/store.js` | **delete** → `js/sync.js` |
| `js/excel.js`, `vendor/exceljs.min.js` | **delete** |
| `js/habits.js` | new |
| `js/ui.js` | new nav, views for Habits and Stats, quick add, timer, gradient, sign-in/connect screens; delete Excel, ICS and reminder-loop code |
| `sw.js` | new SHELL list; `push` + `notificationclick` handlers; `VERSION` bump |
| `supabase/migrations/001_init.sql` | tables, RLS, triggers, pg_cron job |
| `supabase/functions/tick/index.ts` | push + Google step |
| `supabase/functions/google-callback/index.ts` | OAuth code exchange |
| `.github/workflows/keepalive.yml`, `.github/workflows/pages.yml` | weekly ping; deploy the static files |
| `tests/check.js` | add tests (below) |
| `README.md` | rewrite for v3 setup |
| `flexible_weekly_planner*.{html,xlsx}` | leave untouched (your originals) |

## 12. Tests (`tests/check.js`, plain asserts)

- `parseQuick`: each token row above, combinations, a title with an `@` in it, and the no-link default.
- `recordsToPlan(planToRecords(plan))` round-trips the plan unchanged. The LWW merge: newer wins, a dirty local copy beats an older remote one, and a tombstone beats an older live record.
- `materialize`: 14 days, reminders on only for categories with `remind`, a block crossing midnight, a moved block gets a new hash, and a hidden block isn't emitted.
- `prayerTimesFor`: Cairo on a fixed date matches known Egyptian-method times within ±2 min.
- `streak` and `rate`: gaps on non-scheduled days don't break a streak, and an unticked today doesn't break it either.
- Stats: overlapping custom and chain blocks aren't double-counted.
- The existing schedule and task checks stay.

## 13. Setup (one-time manual work, `task` type)

1. Create the Supabase project. Run `001_init.sql`. Enable email auth with the redirect URL set to the Pages URL.
2. Generate VAPID keys (`npx web-push generate-vapid-keys`). Store them as edge function secrets and put the public key in `js/sync.js`.
3. Create a Google Cloud OAuth client (web). Add the callback URL, and store the client id/secret as secrets. The app stays in "testing" mode with you as the only test user, so no Google verification is needed.
4. Create the GitHub repo and enable Pages. Add the `SUPABASE_URL` + anon key secret for the keep-alive.
5. Install on the phone(s). Turn on reminders per device. Connect Google once.

## 14. Out of scope

Multi-user or sharing, Excel, two-way Google sync, Outlook, native apps, and editing from the Google side.

## 15. Build order (each step ships something usable)

1. **Sync foundation:** schema, `sync.js`, auth, migration, JSON backup. Delete Excel. Tests for the round-trip and LWW.
2. **Push reminders:** `materialize`, the tick function, sw push, per-device subscribe. Delete the old reminder loop.
3. **UX:** bottom nav, phone layout, gradient background, quick add, dark mode.
4. **Prayer times:** location, auto/manual. Done.
5. **Habits + timers.** Done.
6. **Stats** (replaces Budget). Done.
7. **Google Calendar.**
8. README, keep-alive, Pages deploy.

## Open research (confirm when building)

- R1: Web Push from a Supabase Edge Function in Deno. Does `npm:web-push` work, or is `jsr:@negrel/webpush` needed?
- R2: Does pg_cron activity inside the database count as "activity" for the free-tier pause? If it does, the keep-alive Action can be dropped.
- R3: Is iOS PWA push delivery reliable enough with a 1-minute tick? Test on your device during step 2.
