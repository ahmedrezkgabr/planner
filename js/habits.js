/* =====================================================================
   habits.js: habits and time tracking. Pure logic with no DOM access.

   habit     {id, name, days:[0..6], createdAt}   repeats on those weekdays
   habitLog  { '<habitId>|<YYYY-MM-DD>': true }   one tick per day
   timeEntry {id, label, cat, taskId?, blockKey?, start, end}   end:null while running.
             One timer runs at a time; starting another stops it. A running entry
             syncs like anything else, so the other device shows it running.
   ===================================================================== */
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
function newHabit({ name, days }){
  return { id:'h' + uid(), name, days:days && days.length ? [...days].sort() : ALL_DAYS, createdAt:new Date().toISOString() };
}
const habitKey = (h, iso) => h.id + '|' + iso;
const habitStart = h => isoDate(new Date(h.createdAt));
const isDue = (h, iso) => iso >= habitStart(h) && h.days.includes(parseISO(iso).getDay());
const habitsDue = (habits, iso) => habits.filter(h => isDue(h, iso));

// Consecutive scheduled days done, counting back from today. Days off don't break it; an unticked today doesn't either, until it ends.
function streak(h, log, todayIso){
  let n = 0, d = parseISO(todayIso);
  if (isDue(h, todayIso) && !log[habitKey(h, todayIso)]) d = addDays(d, -1);
  for (let iso = isoDate(d); iso >= habitStart(h); d = addDays(d, -1), iso = isoDate(d)){
    if (!h.days.includes(d.getDay())) continue;
    if (!log[habitKey(h, iso)]) break;
    n++;
  }
  return n;
}
// Done ÷ scheduled between two dates (inclusive). null when nothing was scheduled.
function rate(h, log, fromIso, toIso){
  let due = 0, done = 0;
  for (let d = parseISO(fromIso), iso = fromIso; iso <= toIso; d = addDays(d, 1), iso = isoDate(d))
    if (isDue(h, iso)){ due++; if (log[habitKey(h, iso)]) done++; }
  return due ? done / due : null;
}

/* ---------- timers ---------- */
const running = entries => entries.find(e => !e.end) || null;
const entryMin = (e, nowMs) => Math.max(0, ((e.end ? Date.parse(e.end) : nowMs) - Date.parse(e.start)) / 60000);
const trackedMin = (entries, pred, nowMs) => entries.filter(pred).reduce((s, e) => s + entryMin(e, nowMs), 0);
// Stops the running timer. An accidental tap (under a minute) leaves no entry.
function stopTimer(entries, nowMs = Date.now()){
  const r = running(entries); if (!r) return null;
  r.end = new Date(nowMs).toISOString();
  if (entryMin(r, nowMs) < 1) entries.splice(entries.indexOf(r), 1);
  return r;
}
function startTimer(entries, fields, nowMs = Date.now()){
  stopTimer(entries, nowMs);
  const e = { id:'e' + uid(), label:'', cat:null, ...fields, start:new Date(nowMs).toISOString(), end:null };
  entries.push(e);
  return e;
}
