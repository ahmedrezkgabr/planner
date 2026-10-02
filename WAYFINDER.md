# Wayfinder map: planner v3

## Destination
A personal planner (one user) that works on an Android phone, an iPhone, a Linux laptop and other desktops. Data syncs live between the devices, reminders fire even when the app is closed or the phone is locked, and the UX is clean. There is no Excel: the app is the only source of truth.

## Decisions so far
- D1 Scope: personal, not multi-user. (2026-09-25)
- D2 Excel removed as a live or two-way format. (2026-09-25)
- D3 Pain points to fix: unreliable reminders, no sync, UI bugs and clunky UX, Excel round-trip issues. Upgrade the features too. (2026-09-25)
- D4 (T1) New features: stats and insights, calendar sync, auto prayer times, time tracking and habits. (2026-09-26)
- D5 (T2) Backend: Supabase free tier (Postgres, auth, realtime; Edge Functions and pg_cron for push). (2026-09-26)
- D6 (T3) Reminders: Web Push from an installed PWA; the server schedules the pushes. (2026-09-26)
- D7 (T4) Offline-first: local queue, sync later, last-write-wins per record by updatedAt. (2026-09-26)
- ~~D8 (T7) Calendar:~~ (superseded by D16) one-way push to Google Calendar (a separate "Connect Google" OAuth step; the refresh token is stored server-side). Google edits are ignored.
- D9 (T8) Auth: Supabase email magic link.
- D10 (T9) Stack: keep vanilla JS with no build step; reuse schedule.js, tasks.js and notify.js; replace store.js with a sync layer; delete excel.js and vendor/exceljs.
- D11 (T6) One-time upload of the existing IndexedDB data to Supabase on first login.
- D12 (T5) UX: faster task entry and a better phone layout. The page background becomes a gradient from the current block's category color into the next block's color (it is a fixed var(--paper) today).
- D13 Quick add: a one-line smart input ("Call dad !high @gym tomorrow 20m"); details stay optional.
- D14 Prayer times: automatic from location, Egyptian General Authority method; manual override kept.
- D16 Google Calendar dropped (2026-10-02): the planner already covers reminders and every device. Google's testing-mode sign-in expires weekly, and nothing else depends on it. D8 is superseded.
- D15 Time tracking and habits are separate: timers on tasks and blocks (actual vs planned) plus a daily habit checklist with streaks.

## Defaults taken (change them if wrong)
- Backup: JSON export/import, replacing Excel.
- Supabase free-tier idle pause: a weekly keep-alive ping (GitHub Action or a Cloudflare cron).
- Push scheduling: pg_cron every minute calls an Edge Function that sends the due Web Push messages (VAPID).

## Status: arrived (2026-10-02)
Live at https://ahmedrezkgabr.github.io/planner/. Sync, server-sent reminders (confirmed on a phone), UX, prayer times, habits and timers, and stats are built. Google Calendar was dropped (D16).

## Out of scope
- Multi-user, sharing, teams
- Excel import/export
- Google Calendar sync (D16)
