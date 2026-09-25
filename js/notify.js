/* =====================================================================
   notify.js: reminder logic.

   Rules (the pure functions below; tests/check.js covers them):
   - A reminder is due once now >= start - lead and now < start.
   - Each reminder has a key: blockId | date | startAt. It goes into a
     persisted log BEFORE the notification is shown, so a refresh, a
     reopen or a second tab never repeats it.
   - startAt is part of the key. If you move a block, the moved block gets
     a new reminder. Changing only the lead time does not repeat one.
   - Opening the app late (after start - lead, before start) still fires,
     with the real minutes left. After the start it stays silent: no stale
     alerts after the phone wakes up.
   - Blocks come from yesterday, today and tomorrow with absolute
     timestamps. That covers midnight, date changes and time zone changes,
     since everything is recomputed from the clock on every tick.

   Limit: this JavaScript only runs while the planner is open (a tab,
   including a background tab, or the installed app while the OS keeps it
   alive). For reminders when it is closed, see buildICS() and README.md.
   ===================================================================== */
const reminderKey = b => `${b.id}|${b.date}|${b.startAt}`;

function dueReminders(plan, occ, nowMs, log){
  const out = [];
  for (const b of occ){
    const c = plan.categories[b.cat];
    if (!c || !c.remind) continue;
    const key = reminderKey(b);
    if (nowMs >= b.startAt - c.lead * 60000 && nowMs < b.startAt && !log[key]) out.push({ block:b, key, minsLeft:Math.ceil((b.startAt - nowMs) / 60000) });
  }
  return out;
}

// The next few reminders that will fire, for the dashboard.
function upcomingReminders(plan, occ, nowMs, n = 4){
  return occ.filter(b => plan.categories[b.cat]?.remind && b.startAt > nowMs)
            .map(b => ({ block:b, at:b.startAt - plan.categories[b.cat].lead * 60000 }))
            .filter(r => r.at < nowMs + 86400000).slice(0, n);
}

// Drop log entries for blocks that started more than a day ago.
function pruneLog(log, nowMs){
  for (const k in log) if (Number(k.split('|')[2]) < nowMs - 86400000) delete log[k];
  return log;
}

/* ---------- calendar export (.ics) ----------
   The one no-server way to get reminders with the planner closed and the phone
   locked: the phone's calendar app fires them. Each block becomes a separate event
   with a VALARM at the category's lead time, for the next `days` days. Only block
   types with reminders on are exported. The UIDs are stable, so re-importing
   updates events instead of duplicating them (in calendars that honour UIDs). */
function buildICS(plan, fromDate, days){
  const utc = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const fold = l => l.length <= 74 ? l : l.match(/.{1,74}/g).join('\r\n ');   // RFC 5545 line folding
  const L = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Flexible planner//EN','CALSCALE:GREGORIAN','X-WR-CALNAME:Planner'];
  const stamp = utc(Date.now());
  for (let k = 0; k < days; k++) for (const b of visible(buildDay(plan, addDays(fromDate, k)))){
    const c = plan.categories[b.cat];
    if (!c || !c.remind) continue;
    L.push('BEGIN:VEVENT', `UID:${b.id}-${b.date}@flexible-planner`, `DTSTAMP:${stamp}`, `DTSTART:${utc(b.startAt)}`, `DTEND:${utc(b.endAt)}`,
           fold('SUMMARY:' + esc(b.name)), 'CATEGORIES:' + esc(c.label));
    if (b.note) L.push(fold('DESCRIPTION:' + esc(b.note)));
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', fold('DESCRIPTION:' + esc(`${b.name} starts in ${c.lead} min`)), `TRIGGER:-PT${c.lead}M`, 'END:VALARM', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}

/* ---------- browser side ---------- */
const Notify = {
  supported: () => typeof Notification !== 'undefined',
  permission: () => typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  request: () => Notification.requestPermission(),
  // A small circle in the block's color, used as the notification icon so the color carries over where the OS shows icons.
  icon(color){
    const c = document.createElement('canvas'); c.width = c.height = 96;
    const g = c.getContext('2d'); g.fillStyle = color; g.beginPath(); g.arc(48, 48, 44, 0, 7); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 3; g.stroke();
    return c.toDataURL('image/png');
  },
  // Android Chrome only allows notifications through the service worker; desktop works both ways.
  async show(title, opts){
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if (reg) return reg.showNotification(title, opts);
    new Notification(title, opts);
  },
};
