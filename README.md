# Flexible weekly planner, v3 (in progress: see SPEC.md §15 for the build order)

The main screen answers three questions: **what should I be doing now, what's next, and which tasks belong to it.**

```
index.html              app shell (open this)
planner.css             styles (original + now-bar, dashboard, tasks, dialogs)
js/schedule.js          schedule engine: chain, overrides, custom blocks, current/next   (no DOM)
js/tasks.js             task model, views, overdue logic, migration                     (no DOM)
js/notify.js            reminder logic (dedupe), calendar (.ics) export
js/config.js            Supabase URL + anon key (empty = local-only)
js/sync.js              local IndexedDB records + Supabase sync (last write wins), JSON backup
supabase/migrations/    database schema: run 001_init.sql once
js/ui.js                rendering, dialogs, reminder tick, boot
sw.js, manifest.webmanifest, icons/   PWA: offline, installable, Android notifications
tests/check.js          logic self-check:  node tests/check.js
flexible_weekly_planner.html          your original, untouched (backup)
flexible_weekly_planner.xlsx          your original, untouched
flexible_weekly_planner_v2.xlsx       v2 export template (no longer read by the app)
```

## Architecture

**Local-first PWA with Supabase sync.** Every edit is saved to IndexedDB first, so the app works offline. When you're signed in, changes upload about a second later, and the other device receives them live. If both devices change the same thing, the later edit wins. Deletes sync too. Excel has been removed: *Settings → Download backup* gives you a JSON file of everything.

## Turning on sync (one-time)

1. Create a free project at supabase.com. In the SQL editor, run `supabase/migrations/001_init.sql`.
2. Authentication → URL configuration: set the Site URL and Redirect URLs to where you host the app (e.g. `https://you.github.io/planner/`, plus `http://localhost:8000/` for testing).
3. Project Settings → API: copy the URL and the `anon` key into `js/config.js`.
4. On each device: Settings → *Account and sync* → email yourself a link and open it **in the same browser/app**. Your existing data uploads on the first sign-in.

## Notifications: what's actually possible

| Option | Tab closed | Browser closed | Phone locked | Internet | Complexity | Privacy | Cost | Reliability |
|---|---|---|---|---|---|---|---|---|
| 1. Browser notifications (page JS) | No | No | No | No | Low | Full | Free | Only while open. Background tabs are OK on desktop; phones pause the page within minutes. |
| 2. PWA + service worker | No* | No | No | No | Low | Full | Free | Same as 1, plus it installs, works offline and shows notifications on Android. A service worker can't run timers. |
| 3. PWA + Web Push | Yes | Android yes; desktop needs the browser running | Yes (Android; iOS 16.4+ if installed) | Yes | Medium to high: server + scheduler + VAPID keys | Block times go to your server | Free tier possible (e.g. Cloudflare Workers cron) | Good, but depends on the server and push service |
| 4. Native wrapper (Capacitor + local notifications) | Yes | n/a | Yes | No | High: Android Studio; iOS needs a $99/yr developer account | Full | Free (Android) | Best |
| 5. Cloud service / **phone calendar (.ics)** | Yes | Yes | Yes | No (after import) | **Very low** | Full (the file never leaves your devices) | Free | Very good, but a snapshot: re-export when the plan changes |

\* Periodic Background Sync runs at most about every 12 h, at the browser's discretion. The "Notification Triggers" scheduling API was never shipped. Neither can give a reminder 5 minutes before a block.

**What's implemented:** 1 + 2 (in-app and system notifications while the planner is open) **plus** the .ics calendar export for everything else. That fits "simple, local-first, private, inexpensive." If you later want reminders that follow live edits with the app closed, the upgrade is **3** (a small push server). The reminder logic in `notify.js` would move to the server largely unchanged.

Reminder rules: it fires once when `now ≥ start − lead` and before the start. It is deduped by a persisted log (surviving refresh, reopen and several tabs), and only one tab sends. A moved block gets a fresh reminder. If the app was asleep past the start time, it stays silent (no stale alerts). Midnight, date and time zone changes are handled because everything is recomputed from the clock every 15 s with absolute timestamps. When blocks overlap, your own (custom) block wins, then the later-starting one.

## Running it

A service worker, installation and notifications need `http://localhost` or `https://`. Double-clicking `index.html` still works, but without those features.

```bash
cd ~/Desktop/planner
python3 -m http.server 8000
# open http://localhost:8000
```

## Installing on your phone

The phone needs the app over **HTTPS**. Host the folder on any free static host. Only the code is uploaded; your data stays on the phone.
- **GitHub Pages**: push the folder to a repo, then Settings → Pages. A public repo means public *code* only, with no data in it. Or use **Netlify Drop** / **Cloudflare Pages** (drag the folder in).
- **Android (Chrome):** open the URL → ⋮ → *Install app*.
- **iPhone (Safari, iOS 16.4+):** Share → *Add to Home Screen*, then open it **from the Home Screen icon** (notifications only work there).

Sign in on both devices and they share the same data.

## Enabling notifications

1. Settings → **Turn on notifications** → allow. Use **Send a test** to check.
2. Under *Block types, colors and reminders*, switch reminders on or off per type and set the minutes (5/10/15 or any number).
3. For reminders with the app closed or the phone locked: Settings → **Export calendar (.ics)** (14 days by default) and import it:
   - **Google Calendar:** create a calendar called "Planner" on the web (calendar.google.com → Settings → Import). Google **ignores alarms inside .ics files**, so set that calendar's *default notification* (e.g. 10 min). Delete and recreate the calendar before each re-import.
   - **Apple Calendar / Outlook:** open the .ics file; the per-block alarms are honored.
   - Re-export in the Saturday weekly review, or whenever you change the plan.
4. Android: turn off battery optimisation for Chrome (or the installed app) so the open app is paused less often.

## Migrating your current data

The first time v3 opens at the same address as v2, it copies v2's data (settings, block types, edits, tasks, done ticks) into the new store, and it uploads on the first sign-in. The v2 database is left untouched. The migration from the original single-file HTML planner has been removed.

## Testing checklist

- [ ] `node tests/check.js` prints "all checks passed"
- [ ] Now-bar shows the current block in its color, with the time range, minutes left and next block; the phone status bar matches when installed
- [ ] Leave the tab open across a block boundary: the bar and dashboard change with no refresh
- [ ] Set a block type's lead so a reminder is due in 1–2 min: one notification and one toast. Refresh: no repeat
- [ ] Turn a block type's reminder off: no notification
- [ ] Day → *Edit schedule* → move Lunch: the following blocks slide and prayers stay put. Try "Only this date" and "Every Sunday"
- [ ] *+ Block*: recurring on weekdays, one-off, one crossing midnight (23:30–00:30). *Duplicate*, *Delete*, *Undo edits*
- [ ] Rename a block type and change its color: timeline, week, now-bar and task labels all update
- [ ] Tasks: create one for each link type; a routine "every Gym" task resets in each Gym block
- [ ] Let a block-linked task pass its block: it shows under *Overdue* with all five options
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

- Reminders need the app open, or the .ics export (see the table above).
- Custom blocks that overlap the chain count twice in the Budget totals.
- Conflicts are decided by each device's clock. If a device's clock is badly wrong, its edits win or lose incorrectly.
- Moving a block later leaves a gap before it, shown as "Nothing scheduled".
- After changing app files, bump `VERSION` in `sw.js` so installed phones update.
