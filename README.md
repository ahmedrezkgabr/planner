# Planner

A personal weekly planner that answers three questions: **what should I be doing now, what's next, and which tasks belong to it.**

**Live:** https://ahmedrezkgabr.github.io/planner/. It works on Android, iPhone, Linux and any desktop, syncs live between them, and sends reminders with the app closed.

## What it does

- **Now:** the current block, time left, what's next, its tasks, today's habits, and the rest of today.
- **Plan:** the day timeline and the week. Prayers, work and sleep are anchors; everything else is a chain that slides, and dashed blocks are the slack. *Edit schedule* moves, renames, recolors or deletes blocks, for one date or every week. *+ Block* adds your own.
- **Tasks:** one-line quick add (`Call dad !high @gym tomorrow 20m`; the shortcuts are optional). The views are Now, Today, Week, Inbox, All and Habits. Overdue tasks surface on top. ▶ times a task.
- **Habits:** they repeat on chosen weekdays and are ticked on Now. They show "n in a row" and a 12-week grid.
- **Stats:** for each week, blocks done, tasks done, habits kept, buffer, hours per block type (done, planned, tracked) and tasks per day.
- **Prayer times:** set by hand, or automatic from your location (Egyptian method, summer time included).
- **Reminders:** a notification before each block whose type has reminders on, on every device where you turned them on.
- **Offline:** everything works without a connection and syncs when it comes back.

## Using it on a new device

1. Open the live link.
   - **Android (Chrome):** ⋮ → *Install app*.
   - **iPhone (Safari):** Share → *Add to Home Screen*. Open it from the icon from then on, because iPhone only delivers notifications there.
   - **Desktop (Chrome/Edge):** the install icon in the address bar.
2. Sign in with your email and open the link **on that same device**.
3. Gear → **Reminders → Turn on** → allow → *Send a test*. It arrives within a minute, even with the app closed.
4. **Updates:** when a new version is ready, a bar says *Tap to update*. Settings shows the version.
5. **Signing out** erases the planner data from that device (it stays in your account) and stops its reminders.

## How it works

```
index.html, planner.css      the app shell
js/schedule.js               schedule engine: chain, overrides, custom blocks, prayer times, current/next   (no DOM)
js/tasks.js                  tasks, views, overdue logic, quick-add parser                                   (no DOM)
js/habits.js                 habits, timers, week stats                                                      (no DOM)
js/notify.js                 next 14 days of blocks for the push server; this device's push subscription
js/sync.js                   local IndexedDB records + Supabase sync (last write wins), JSON backup
js/config.js                 Supabase URL, publishable key, VAPID public key
js/ui.js                     rendering, dialogs, the 15 s tick, boot
sw.js, manifest.webmanifest  PWA: offline shell, install, shows push reminders, updates
supabase/migrations/         database: 001_init.sql (records), 002_reminders.sql (occurrences, push_subs)
supabase/functions/tick/     edge function: sends due reminders as Web Push
.github/workflows/           pages.yml (test + deploy on push), keepalive.yml (weekly Supabase ping)
tests/check.js               logic checks: node tests/check.js
tests/e2e.js                 browser checks: npm i --no-save playwright && node tests/e2e.js
```

- **Local-first.** Every edit goes to IndexedDB first, uploads about a second later, and reaches the other device live (Realtime). If two devices change the same record, the later edit wins. Deletes sync as tombstones.
- **Reminders.** The app uploads the next 14 days of blocks to `occurrences`, with `remind_at = start − lead`. pg_cron calls `tick` every minute. `tick` claims the due rows (so nothing is sent twice), pushes them to every device in `push_subs`, skips anything more than 5 min late, and drops dead subscriptions. The server never runs the schedule engine, so reminders run out if no device opens the app for 14 days (Settings shows "Scheduled until …").
- **Hosting.** GitHub Pages. Every push to `main` runs `tests/check.js` and then deploys. A weekly Action pings Supabase so the free project isn't paused.

## Security

- **Your data:** every table has row-level security (`user_id = auth.uid()`), so anonymous requests get `[]` and can't write. New sign-ups are off in Supabase, and the app never creates accounts.
- **The app:** shows only a sign-in screen until you're signed in. A device that gets a different account's session wipes the old data instead of uploading it.
- **The page:** a Content-Security-Policy limits scripts to this site and jsDelivr (supabase-js), and connections to the Supabase project. It also sets no-referrer and noindex.
- **Secrets** live in the git-ignored `supabase/local/` (`secrets.env`, `cron.sql`) and as Supabase function secrets. The `tick` function refuses calls without the cron secret.
- **Public by design:** the code (including the default week in `js/schedule.js`) and the publishable key, which is useless without a signed-in session.

## Setting it up from scratch (one-time)

1. **Supabase** (free project):
   - Run `001_init.sql` and `002_reminders.sql` in the SQL editor.
   - Authentication: turn off new sign-ups after creating your own account. Set the Site URL and the Redirect URL to the Pages URL.
   - Put the project URL and publishable key in `js/config.js`.
2. **Reminders:**
   - Generate VAPID keys (`npx web-push generate-vapid-keys`) and put the public one in `js/config.js`.
   - Deploy `supabase/functions/tick` with JWT verification off.
   - Add the secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `CRON_SECRET`.
   - Schedule it every minute with pg_cron + pg_net, calling `/functions/v1/tick` with the `x-cron-secret` header (see `supabase/local/cron.sql`).
3. **GitHub:** a public repo with Pages set to "GitHub Actions". The workflows do the rest.

## Running locally

```bash
python3 -m http.server 9000     # then open http://localhost:9000
node tests/check.js             # logic
npm i --no-save playwright && node tests/e2e.js   # browser (set CHROME=/path/to/chrome if needed)
```

Add `http://localhost:9000/` to the Supabase redirect URLs to sign in locally.

## Backup

Settings → More settings → **Download backup** saves a JSON file of everything. **Import backup** merges one back in (newer records win, nothing is duplicated).

## Known limits

- Reminders reach 14 days past the last time any device opened the app.
- Automatic prayer times have no high-latitude rule. Above about 48° a summer Fajr or Isha keeps its typed time.
- iPhone notifications only work from the Home Screen app.
- Conflicts are decided by device clocks. A device with a badly wrong clock can win or lose edits it shouldn't.
- Moving a block later leaves a gap before it, shown as free time.
- After changing app files, bump `VERSION` in `sw.js`. That's what makes installed apps offer the update.
