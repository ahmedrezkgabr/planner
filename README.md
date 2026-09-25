# Flexible weekly planner, v2

The main screen answers three questions: **what should I be doing now, what's next, and which tasks belong to it.**

```
index.html              app shell (open this)
planner.css             styles (original + now-bar, dashboard, tasks, dialogs)
js/schedule.js          schedule engine: chain, overrides, custom blocks, current/next   (no DOM)
js/tasks.js             task model, views, overdue logic, migration                     (no DOM)
js/notify.js            reminder logic (dedupe), calendar (.ics) export
js/store.js             IndexedDB persistence (localStorage fallback)
js/excel.js             Excel import/export (ExcelJS, vendored in vendor/)
js/ui.js                rendering, dialogs, reminder tick, boot
sw.js, manifest.webmanifest, icons/   PWA: offline, installable, Android notifications
tests/check.js          logic self-check:  node tests/check.js
flexible_weekly_planner.html          your original, untouched (backup)
flexible_weekly_planner.xlsx          your original, untouched
flexible_weekly_planner_v2.xlsx       original + Categories/Blocks/Overrides/Tasks/BlockDone sheets
```

## Architecture

**Local-first PWA. IndexedDB holds the live data. Excel is for import/export, backup and reporting (option B/C). Calendar export handles closed-app reminders.** No server, no account, no cost.

- A browser page can't keep an .xlsx file open and write to it live. It also can't read one from your phone in the background. So Excel can't be the live database behind notifications. The workbook stays fully usable: its formula sheets are untouched, it imports into the app, and every app export can be opened, edited and imported again.
- The schedule is still **generated** from your settings (prayer times, wake/bed, block lengths). Edits are stored as **overrides** on top ("only this Tuesday" or "every Tuesday"), and **custom blocks** sit on top of the chain. Change prayer times and everything still slides, and your edits survive.
- Every record has an id and `updatedAt`, which is the groundwork for laptop↔phone sync, Google/Outlook calendar integration, statistics (`blockDone` = planned vs done) and cloud backup later.

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

The phone and laptop keep **separate data**. To move data between them, use *Export to Excel* on one and *Import* on the other. Tasks merge by id (newer wins).

## Enabling notifications

1. Settings → **Turn on notifications** → allow. Use **Send a test** to check.
2. Under *Block types, colors and reminders*, switch reminders on or off per type and set the minutes (5/10/15 or any number).
3. For reminders with the app closed or the phone locked: Settings → **Export calendar (.ics)** (14 days by default) and import it:
   - **Google Calendar:** create a calendar called "Planner" on the web (calendar.google.com → Settings → Import). Google **ignores alarms inside .ics files**, so set that calendar's *default notification* (e.g. 10 min). Delete and recreate the calendar before each re-import.
   - **Apple Calendar / Outlook:** open the .ics file; the per-block alarms are honored.
   - Re-export in the Saturday weekly review, or whenever you change the plan.
4. Android: turn off battery optimisation for Chrome (or the installed app) so the open app is paused less often.

## Excel format

`Settings` keeps **the same cells as your original** (B5 = Fajr ... B45 = gym slot), so values can be pasted in either direction. New sheets: `Categories` (key, label, color hex, reminder, lead), `Blocks` (your blocks: days like `Sun,Tue` or one date), `Overrides` (scope `weekly`/`date`, block id, changed fields, hidden), `Tasks` (all fields, with dropdowns for priority/status/link type), `BlockDone`, and `Schedule` (a colored 2-week report; export only). Times are Excel times (hh:mm). Dates are `YYYY-MM-DD`.

Typing tasks in Excel: `Title` + `Link type = Block` + `Link date` + `Link block name` (e.g. `Gym`) is enough. The app finds the block id.
Import replaces the schedule sheets it finds and **merges** tasks, and it **downloads a backup of your current data first**.

## Migrating your current data

- **Settings in your Excel:** Settings → *Import from Excel…* → pick `flexible_weekly_planner.xlsx`.
- **Tasks and done ticks from the old HTML planner:** these were in the browser's localStorage. They are migrated automatically on first launch **if the new app opens at the same address** as the old one. Example: if you opened the old file by double-click, open the new `index.html` by double-click in the same browser once, then *Export to Excel*. Then open the served version (localhost or your phone) and *Import*. If you used the old planner as a Claude artifact, its storage can't be reached. Only settings carry over (from the Excel file).
- Old data is never deleted.

## Testing checklist

- [ ] `node tests/check.js` prints "all checks passed"
- [ ] Now-bar shows the current block in its color, with the time range, minutes left and next block; the phone status bar matches when installed
- [ ] Leave the tab open across a block boundary: the bar and dashboard change with no refresh
- [ ] Set a block type's lead so a reminder is due in 1–2 min: one notification and one toast. Refresh: no repeat
- [ ] Turn a block type's reminder off: no notification
- [ ] Day → *Edit schedule* → move Lunch: the following blocks slide and prayers stay put. Try "Only this date" and "Every Sunday"
- [ ] *+ Block*: recurring on weekdays, one-off, one crossing midnight (23:30–00:30). *Duplicate*, *Delete*, *Undo edits*
- [ ] Rename a block type and change its color: timeline, week, now-bar, task labels and Excel all update
- [ ] Tasks: create one for each link type; a routine "every Gym" task resets in each Gym block
- [ ] Let a block-linked task pass its block: it shows under *Overdue* with all five options
- [ ] Export Excel → edit a task in Excel → import: the change arrives, and a backup file downloaded first
- [ ] Import the original `flexible_weekly_planner.xlsx`: settings are applied
- [ ] Close and reopen the browser: everything is still there. Settings shows "IndexedDB, protected from clean-up"
- [ ] Airplane mode on an installed phone app: it still opens and works
- [ ] At 00:30 the now-bar shows last night's Sleep
- [ ] Phone width: no sideways scrolling; the Now tab shows current, next, tasks and reminders in that order

## Known limits

- Reminders need the app open, or the .ics export (see the table above).
- Custom blocks that overlap the chain count twice in the Budget totals.
- Excel import doesn't delete tasks that were deleted on the other device. Sync with tombstones would fix that later.
- Moving a block later leaves a gap before it, shown as "Nothing scheduled".
- After changing app files, bump `VERSION` in `sw.js` so installed phones update.
