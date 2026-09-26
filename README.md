# Flexible weekly planner, v3 (in progress: see SPEC.md §15 for the build order)

The main screen answers three questions: **what should I be doing now, what's next, and which tasks belong to it.**

```
index.html              app shell (open this)
planner.css             styles (original + now-bar, dashboard, tasks, dialogs)
js/schedule.js          schedule engine: chain, overrides, custom blocks, current/next   (no DOM)
js/tasks.js             task model, views, overdue logic, migration                     (no DOM)
js/notify.js            materialize() (next 14 days of blocks for the push server), this device's push subscription
js/config.js            Supabase URL + anon key (empty = local-only)
js/sync.js              local IndexedDB records + Supabase sync (last write wins), JSON backup
supabase/migrations/    database schema: run 001_init.sql once
js/ui.js                rendering, dialogs, the 15 s now-bar tick, boot
sw.js, manifest.webmanifest, icons/   PWA: offline, installable, shows push reminders
supabase/functions/tick/   edge function: sends due reminders as Web Push (pg_cron, every minute)
tests/check.js          logic self-check:  node tests/check.js
flexible_weekly_planner.html          your original, untouched (backup)
flexible_weekly_planner.xlsx          your original, untouched
flexible_weekly_planner_v2.xlsx       v2 export template (no longer read by the app)
```

## Architecture

**Local-first PWA with Supabase sync.** Every edit is saved to IndexedDB first, so the app works offline. When you're signed in, changes upload about a second later, and the other device receives them live. If both devices change the same thing, the later edit wins. Deletes sync too. Excel has been removed: *Settings → Download backup* gives you a JSON file of everything.

## Turning on sync (one-time)

1. Create a free project at supabase.com. In the SQL editor, run `supabase/migrations/001_init.sql`.
2. Authentication → URL configuration: set the Site URL and Redirect URLs to where you host the app (e.g. `https://you.github.io/planner/`, plus `http://localhost:9000/` for testing).
3. Project Settings → API: copy the URL and the `anon` key into `js/config.js`.
4. On each device: Settings → *Account and sync* → email yourself a link and open it **in the same browser/app**. Your existing data uploads on the first sign-in.

## Reminders

Reminders are **Web Push sent by Supabase**, so they arrive with the planner closed and the phone locked (Android, desktop, and iPhone 16.4+ from the Home Screen app).

- Whenever the plan changes (and at least every 6 h while any device is open), the app uploads the next 14 days of blocks to `occurrences`, with `remind_at = start − lead` for block types that have reminders on. Only changed rows are sent, and removed blocks are marked deleted.
- A pg_cron job calls the `tick` edge function every minute. It claims the due rows (`sent_at`, so nothing is sent twice) and pushes them to every device in `push_subs`. A reminder more than 5 min late is skipped rather than sent stale. A device that unsubscribed (404/410) is removed.
- A moved block gets a new `remind_at`, so it reminds again. Renaming a block doesn't.
- The server never runs the schedule engine. If no device opens the app for 14 days, reminders run out. Settings shows "Scheduled until …".

### Server setup (one-time)
1. SQL editor: run `supabase/migrations/002_reminders.sql`.
2. Edge Functions → deploy `supabase/functions/tick/index.ts` as a function named **tick**, with **JWT verification off** (the cron job authenticates with a shared secret instead).
3. Edge Functions → Secrets: add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `CRON_SECRET` from `supabase/local/secrets.env`. That file is git-ignored, and the private key must never be committed. The public key is also in `js/config.js`.
4. SQL editor: run `supabase/local/cron.sql` (git-ignored, because it holds the secret). It schedules `planner-tick` every minute.

## Running it

A service worker, installation and notifications need `http://localhost` or `https://`. Double-clicking `index.html` still works, but without those features.

```bash
cd ~/Desktop/planner
python3 -m http.server 9000
# open http://localhost:9000
```

## Installing on your phone

The phone needs the app over **HTTPS**. Host the folder on any free static host. Only the code is uploaded; your data stays on the phone.
- **GitHub Pages**: push the folder to a repo, then Settings → Pages. A public repo means public *code* only, with no data in it. Or use **Netlify Drop** / **Cloudflare Pages** (drag the folder in).
- **Android (Chrome):** open the URL → ⋮ → *Install app*.
- **iPhone (Safari, iOS 16.4+):** Share → *Add to Home Screen*, then open it **from the Home Screen icon** (notifications only work there).

Sign in on both devices and they share the same data.

## Turning on reminders

1. Sign in on the device. Then Settings → **Reminders** → **Turn on reminders on this device** → allow. Do this on every device that should ring.
2. **Send a test**: it goes through the server and arrives within a minute, even if you close the planner first.
3. Under *Block types, colors and reminders*, switch reminders on or off per type and set the minutes.
4. iPhone: open the planner from the Home Screen icon first. Android: if reminders come late, turn off battery optimisation for Chrome.

## Migrating your current data

The first time v3 opens at the same address as v2, it copies v2's data (settings, block types, edits, tasks, done ticks) into the new store, and it uploads on the first sign-in. The v2 database is left untouched. The migration from the original single-file HTML planner has been removed.

## Testing checklist

- [ ] `node tests/check.js` prints "all checks passed"
- [ ] Now shows one card: the current block, time left, progress and what's next. On the other tabs a slim bar keeps the current block in view; the phone status bar matches when installed
- [ ] Leave the tab open across a block boundary: the bar and dashboard change with no refresh
- [ ] Settings → Reminders → Send a test, then close the planner: one notification within a minute
- [ ] Set a block type's lead so a reminder is due in 2–3 min, then close the planner and lock the phone: one notification, on every device with reminders on
- [ ] Turn a block type's reminder off: no notification
- [ ] Settings → Prayer times → *Use my location*: the five times fill in and lock, and the Plan's chain moves. Untick it to get your typed times back
- [ ] Day → *Edit schedule* → move Lunch: the following blocks slide and prayers stay put. Try "Only this date" and "Every Sunday"
- [ ] *+ Block*: recurring on weekdays, one-off, one crossing midnight (23:30–00:30). *Duplicate*, *Delete*, *Undo edits*
- [ ] Rename a block type and change its color: timeline, week, now-bar and task labels all update
- [ ] Tasks: create one for each link type; a routine "every Gym" task resets in each Gym block
- [ ] Let a block-linked task pass its block: it shows in the red *Overdue* box on top of Tasks with *Next … block* and *Reschedule…*
- [ ] Signed in on two devices: add a task on one and it appears on the other within seconds. Airplane mode: edit, reconnect, and it syncs
- [ ] Download backup → Import backup: nothing is duplicated
- [ ] Close and reopen the browser: everything is still there. Settings shows "IndexedDB, protected from clean-up"
- [ ] Airplane mode on an installed phone app: it still opens and works
- [ ] At 00:30 the now-bar shows last night's Sleep
- [ ] Phone width: no sideways scrolling, bottom tab bar (Now · Plan · Tasks · Stats), gear opens Settings
- [ ] The background tints to the current block color and fades toward the next block; it changes by itself at a block boundary
- [ ] Quick add: `Call dad !high @gym tomorrow 20m` previews "Gym · <tomorrow>, High, 20 min" and saves there
- [ ] Dark mode (system setting): all text readable, block colors unchanged

## Known limits

- Reminders run 14 days ahead of the last time any device opened the app.
- The notification icon is the app icon, not the block color.
- Custom blocks that overlap the chain count twice in the Budget totals.
- Conflicts are decided by each device's clock. If a device's clock is badly wrong, its edits win or lose incorrectly.
- Moving a block later leaves a gap before it, shown as "Nothing scheduled".
- After changing app files, bump `VERSION` in `sw.js` so installed phones update.
