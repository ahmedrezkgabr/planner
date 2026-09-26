/* =====================================================================
   schedule.js: the schedule engine. Pure logic with no DOM access, so
   tests/check.js can run it in node.

   Moved from the original planner's <script id="engine">. The chain model
   is unchanged: each block starts where the previous one ends, and anchored
   blocks (prayers, work, bedtime) pull the chain back into place.

   New in this version:
   - every generated block gets a stable id ("Sun:gym") so edits, tasks and
     reminders can refer to it
   - overrides: edit one occurrence (dated) or every week (weekly)
   - custom blocks: user-created blocks, recurring on weekdays or one-off
   - absolute timestamps per occurrence, which handle midnight crossing and DST
   - current / next block detection
   ===================================================================== */

/* ---------- settings (same keys as the Excel Settings sheet) ---------- */
const DEFAULTS = {
  fajr:'04:20', dhuhr:'11:50', asr:'15:20', maghrib:'18:05', isha:'19:25',
  wakeWork:'06:30', bedWork:'23:00', wakeOff:'08:00', bedOff:'23:30',
  workStart:'07:00', workEnd:'15:00', gymSlot:'afternoon',
  prayer:15, jumuah:75, jumuahPrep:30, azkar:30, quran:30, lunch:30, dinner:30, breakfast:30,
  familyLunch:60, gymMax:120, learnWork:45, startupWork:60, startupSat:150, learnSat:60, readFri:60,
  nap:60, leisure:30, planning:20, windDown:15, offsetWork:20, offsetShort:10
};
const TIME_KEYS = ['fajr','dhuhr','asr','maghrib','isha','wakeWork','bedWork','wakeOff','bedOff','workStart','workEnd'];
const toMin = t => { const [h,m] = String(t).split(':').map(Number); return h*60+m; };
const fromMin = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0'); };
/* ---------- automatic prayer times (Egyptian General Authority: Fajr 19.5°, Isha 17.5°, Asr shadow 1) ----------
   Standard solar-position formulas (as in PrayTimes/adhan); checked against adhan in tests/check.js to ±1 min.
   ponytail: no high-latitude rule. Above ~48° a summer Isha/Fajr has no solution; that prayer then keeps its manual time. */
function prayerTimesFor(s, date){
  if (!s.prayerAuto || !s.location) return {};
  const rad = Math.PI / 180, { lat, lng } = s.location;
  const d = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) / 864e5 - 10957.5;   // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const decl = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad / 15;
  const eqt = q / 15 - ((ra % 24) + 24) % 24, noon = 12 - lng / 15 - (((eqt + 12) % 24) + 24) % 24 + 12;   // UTC hours
  const span = alt => Math.acos((Math.sin(alt * rad) - Math.sin(decl) * Math.sin(lat * rad)) / (Math.cos(decl) * Math.cos(lat * rad))) / rad / 15;
  const asrAlt = Math.atan(1 / (1 + Math.tan(Math.abs(lat * rad - decl)))) / rad;
  const utc = { fajr:noon - span(-19.5), dhuhr:noon + 1/60, asr:noon + span(asrAlt), maghrib:noon + span(-0.833), isha:noon + span(-17.5) };
  const out = {};
  for (const [k, h] of Object.entries(utc)) if (isFinite(h)){
    const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + Math.round(h * 60) * 60000);
    out[k] = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');   // device time zone, DST included
  }
  return out;
}
const daySettings = (plan, date) => ({ ...plan.settings, ...prayerTimesFor(plan.settings, date) });

function norm(s){
  const n = {};
  for (const k in DEFAULTS){ const v = s[k] ?? DEFAULTS[k]; n[k] = TIME_KEYS.includes(k) ? toMin(v) : (k==='gymSlot' ? v : Number(v)); }
  // Bug fix: a bedtime after midnight (00:30) belongs to the same night. Before, it collapsed the evening.
  for (const k of ['bedWork','bedOff']) if (n[k] < 720) n[k] += 1440;
  return n;
}

/* ---------- block types (categories) ----------
   Colors used to be hard-coded in CSS classes. They are data now, so you can
   edit them and they stay the same in the timeline, the now-bar, task labels,
   notifications and the Excel export. */
const DEFAULT_CATEGORIES = {
  Prayer:  {label:'Prayer',            color:'#2F6B4F', remind:true,  lead:10},
  Azkar:   {label:'Azkar',             color:'#D6E9DA', remind:false, lead:5},
  Quran:   {label:'Quran',             color:'#D6E9DA', remind:true,  lead:5},
  Work:    {label:'Work',              color:'#CBDCF2', remind:true,  lead:10},
  Gym:     {label:'Gym',               color:'#F5CDB0', remind:true,  lead:10},
  Learning:{label:'Learning',          color:'#DCD0EE', remind:true,  lead:5},
  Reading: {label:'Reading',           color:'#EAD8F0', remind:true,  lead:5},
  Startup: {label:'Startup',           color:'#BEE3DE', remind:true,  lead:5},
  Meals:   {label:'Meals',             color:'#F8E8B6', remind:false, lead:5},
  Social:  {label:'Family & social',   color:'#F6D4DD', remind:false, lead:10},
  Leisure: {label:'Leisure',           color:'#F6D4DD', remind:false, lead:5},
  Rest:    {label:'Rest & chores',     color:'#EDE4D9', remind:false, lead:5},
  Planning:{label:'Weekly review',     color:'#F3DFA6', remind:true,  lead:10},
  Sleep:   {label:'Sleep',             color:'#DFE3E9', remind:false, lead:15},
  Offset:  {label:'Offset',            color:'#B8BDC7', remind:false, lead:5, dashed:true},
  Spare:   {label:'Spare',             color:'#B8BDC7', remind:false, lead:5, dashed:true},
};
// Readable text on a block color: dark ink on the pastels, white on dark colors like Prayer green.
function inkOn(hex){ const n = parseInt(String(hex).slice(1), 16); return (0.299*(n>>16) + 0.587*(n>>8&255) + 0.114*(n&255)) > 150 ? '#1F2A37' : '#FFFFFF'; }
const PERIODS = { morning:['Morning',300,720], afternoon:['Afternoon',720,1020], evening:['Evening',1020,1440] };
const periodOf = min => min < 300 ? 'evening' : min < 720 ? 'morning' : min < 1020 ? 'afternoon' : 'evening';

/* ---------- chain engine ---------- */
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
// An end at or before the start means "the next day" (for example 23:00 to 06:30).
const fixEnd = (start, end) => end < start ? end + 1440 : end;

// ov = merged overrides for this date, keyed by block id: {name, cat, start, end, note, hidden}
function chain(dayKey, defs, ov = {}){
  const out = [], seen = {}; let prev = null, p1 = 0;
  for (const d of defs){
    const s = slug(d.name); seen[s] = (seen[s]||0) + 1;
    const id = dayKey + ':' + s + (seen[s] > 1 ? '-' + seen[s] : '');   // stable across weeks
    const o = ov[id] || {};
    let start = d.start !== undefined ? d.start : prev.end;
    if (o.start != null){ start = o.start; if (prev && start < prev.end - 720) start += 1440; }
    let end = o.hidden ? start : o.end != null ? fixEnd(start, o.end) : d.end(start, p1);
    if (end < start) end = start;
    const b = { id, name:o.name || d.name, cat:o.cat || d.cat, type:d.type, note:o.note ?? (d.note || ''),
                start, end, min:end-start, hidden:!!o.hidden, edited:!!ov[id] };
    if (d.name.endsWith(', part 1')) p1 = b.min;   // part 2 tops up to the workday learning target
    out.push(b); prev = b;
  }
  return out;
}

/* ---------- the day templates (unchanged content) ---------- */
function workday(key, S, ov, learnName, learnCat, bed, nextWake, startupNote){
  const aft = S.gymSlot === 'afternoon';
  return chain(key, [
    {name:'Fajr', cat:'Prayer', type:'Fixed', note:'Folded into wake-up for now.', start:S.wakeWork, end:s=>s+S.prayer},
    {name:'Morning azkar', cat:'Azkar', type:'Fixed', note:'Short before work. Finish the rest in your breakfast break, or wake 15 min earlier in Settings.', end:()=>S.workStart},
    {name:'Work, morning', cat:'Work', type:'Fixed', note:'30-min breakfast break floats inside, whenever it\'s ready.', end:()=>S.dhuhr},
    {name:'Dhuhr', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Work, afternoon', cat:'Work', type:'Fixed', end:()=>S.workEnd},
    {name:'Offset: close the laptop, move around', cat:'Offset', type:'Spare', note:'If Asr falls during work (winter), pray then; this stays a pure break.', end:s=>Math.max(S.asr, s+S.offsetWork)},
    {name:'Asr', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Evening azkar', cat:'Azkar', type:'Fixed', end:s=>s+S.azkar},
    {name:'Lunch, whenever it\'s ready', cat:'Meals', type:'Flex', note:'Depends on family; everything after it slides.', end:s=>s+S.lunch},
    aft ? {name:'Gym', cat:'Gym', type:'Flex', note:'Ends 10 min before Maghrib. Choose the evening slot in Settings for a longer session.', end:s=>Math.min(s+S.gymMax, S.maghrib-S.offsetShort)}
        : {name:'Startup deep work', cat:'Startup', type:'Flex', note:startupNote, end:s=>Math.min(s+S.startupWork, S.maghrib-S.offsetShort)},
    {name:aft ? 'Offset: shower, walk back' : 'Offset before Maghrib', cat:'Offset', type:'Spare', end:()=>S.maghrib},
    {name:'Maghrib', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Quran study', cat:'Quran', type:'Fixed', end:s=>s+S.quran},
    {name:learnName+', part 1', cat:learnCat, type:'Flex', note:'Split around Isha; the two parts add up to the workday target.', end:s=>Math.max(s, S.isha)},
    {name:'Isha', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:learnName+', part 2', cat:learnCat, type:'Flex', end:(s,p1)=>s+Math.max(0, S.learnWork-p1)},
    aft ? {name:'Startup deep work', cat:'Startup', type:'Flex', note:startupNote, end:s=>s+S.startupWork}
        : {name:'Gym', cat:'Gym', type:'Flex', note:'Evening slot. Ends in time for dinner and wind-down.', end:s=>Math.min(s+S.gymMax, S[bed]-S.windDown-S.leisure-S.dinner)},
    {name:'Dinner, whenever it\'s ready', cat:'Meals', type:'Flex', end:s=>s+S.dinner},
    {name:'Leisure: reels, TV, anything', cat:'Leisure', type:'Flex', note:'Set a timer. Scrolling gets a home here so it stops leaking into everything else.', end:s=>s+S.leisure},
    {name:'Spare: overflow, family, or nothing', cat:'Spare', type:'Spare', note:'Absorbs whatever ran over. Empty is fine.', end:s=>Math.max(s, S[bed]-S.windDown)},
    {name:'Wind-down, screens off', cat:'Offset', type:'Fixed', end:s=>s+S.windDown},
    {name:'Sleep', cat:'Sleep', type:'Fixed', note:'Target 7.5–8 h.', end:()=>S[nextWake]+1440},
  ], ov);
}
function friday(S, ov){
  return chain('Fri', [
    {name:'Fajr', cat:'Prayer', type:'Fixed', note:'No alarm; the wake time is a guess.', start:S.wakeOff, end:s=>s+S.prayer},
    {name:'Morning azkar', cat:'Azkar', type:'Fixed', end:s=>s+S.azkar},
    {name:'Breakfast, whenever it\'s ready', cat:'Meals', type:'Flex', end:s=>s+S.breakfast},
    {name:'Reading: finance, management, history…', cat:'Reading', type:'Flex', note:'A book from outside your field.', end:s=>s+S.readFri},
    {name:'Spare: family, chores, errands', cat:'Spare', type:'Spare', end:s=>Math.max(s, S.dhuhr-S.jumuahPrep)},
    {name:'Jumu\'ah: go to the mosque, khutbah, prayer', cat:'Prayer', type:'Fixed', end:s=>s+S.jumuah},
    {name:'Lunch with family', cat:'Meals', type:'Flex', end:s=>s+S.familyLunch},
    {name:'Rest, nap', cat:'Rest', type:'Flex', end:s=>s+S.nap},
    {name:'Spare', cat:'Spare', type:'Spare', end:s=>Math.max(s, S.asr)},
    {name:'Asr', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Evening azkar', cat:'Azkar', type:'Fixed', end:s=>s+S.azkar},
    {name:'Startup deep work, long block', cat:'Startup', type:'Flex', note:'Runs until just before Maghrib. One of your two big blocks of the week.', end:s=>Math.max(s, S.maghrib-S.offsetShort)},
    {name:'Offset', cat:'Offset', type:'Spare', end:()=>S.maghrib},
    {name:'Maghrib', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Quran study', cat:'Quran', type:'Fixed', end:s=>s+S.quran},
    {name:'Family time', cat:'Social', type:'Flex', end:s=>Math.max(s, S.isha)},
    {name:'Isha', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Friends, going out, family', cat:'Social', type:'Flex', note:'Nothing scheduled on purpose. Home and in the mood? Startup or a film, your call.', end:s=>Math.max(s, S.bedOff-S.windDown)},
    {name:'Wind-down, screens off', cat:'Offset', type:'Fixed', end:s=>s+S.windDown},
    {name:'Sleep', cat:'Sleep', type:'Fixed', note:'8.5 h.', end:()=>S.wakeOff+1440},
  ], ov);
}
function saturday(S, ov){
  return chain('Sat', [
    {name:'Fajr', cat:'Prayer', type:'Fixed', start:S.wakeOff, end:s=>s+S.prayer},
    {name:'Morning azkar', cat:'Azkar', type:'Fixed', end:s=>s+S.azkar},
    {name:'Breakfast, whenever it\'s ready', cat:'Meals', type:'Flex', end:s=>s+S.breakfast},
    {name:'Startup deep work, long block', cat:'Startup', type:'Flex', note:'Your longest block. Ends 10 min before Dhuhr at the latest.', end:s=>Math.min(s+S.startupSat, S.dhuhr-S.offsetShort)},
    {name:'Offset', cat:'Offset', type:'Spare', end:()=>S.dhuhr},
    {name:'Dhuhr', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Learning: software & AI', cat:'Learning', type:'Flex', end:s=>s+S.learnSat},
    {name:'Lunch, whenever it\'s ready', cat:'Meals', type:'Flex', end:s=>s+S.lunch},
    {name:'Rest, chores, errands', cat:'Rest', type:'Flex', note:'Laundry, groceries, a nap, whatever the week left behind.', end:s=>Math.max(s, S.asr)},
    {name:'Asr', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Evening azkar', cat:'Azkar', type:'Fixed', end:s=>s+S.azkar},
    {name:'Gym', cat:'Gym', type:'Flex', end:s=>Math.min(s+S.gymMax, S.maghrib-S.offsetShort)},
    {name:'Offset: shower, walk back', cat:'Offset', type:'Spare', end:()=>S.maghrib},
    {name:'Maghrib', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Quran study', cat:'Quran', type:'Fixed', end:s=>s+S.quran},
    {name:'Weekly review: what slipped, plan next week', cat:'Planning', type:'Fixed', note:'Update prayer times in Settings, move blocks, note what to change. Re-export the calendar reminders.', end:s=>s+S.planning},
    {name:'Spare', cat:'Spare', type:'Spare', end:s=>Math.max(s, S.isha)},
    {name:'Isha', cat:'Prayer', type:'Fixed', end:s=>s+S.prayer},
    {name:'Friends, family, leisure', cat:'Social', type:'Flex', note:'Work tomorrow: lights out at the workday time.', end:s=>Math.max(s, S.bedWork-S.windDown)},
    {name:'Wind-down, screens off', cat:'Offset', type:'Fixed', end:s=>s+S.windDown},
    {name:'Sleep', cat:'Sleep', type:'Fixed', note:'7.5 h, Sunday alarm.', end:()=>S.wakeWork+1440},
  ], ov);
}
const SW = ['Learning: software & AI','Learning'], RD = ['Reading: finance, management, history…','Reading'];
const STARTUP_NOTE = 'Phone in another room. One concrete deliverable per session.';
const THU_NOTE = 'Going out with friends tonight? Skip this block guilt-free; the Fri/Sat long blocks cover it.';
const DAYS = [
  {key:'Sun', name:'Sunday',    kind:'workday', build:(S,ov)=>workday('Sun',S,ov,...SW,'bedWork','wakeWork',STARTUP_NOTE)},
  {key:'Mon', name:'Monday',    kind:'workday', build:(S,ov)=>workday('Mon',S,ov,...RD,'bedWork','wakeWork',STARTUP_NOTE)},
  {key:'Tue', name:'Tuesday',   kind:'workday', build:(S,ov)=>workday('Tue',S,ov,...SW,'bedWork','wakeWork',STARTUP_NOTE)},
  {key:'Wed', name:'Wednesday', kind:'workday', build:(S,ov)=>workday('Wed',S,ov,...RD,'bedWork','wakeWork',STARTUP_NOTE)},
  {key:'Thu', name:'Thursday',  kind:'workday, weekend starts tonight', build:(S,ov)=>workday('Thu',S,ov,...SW,'bedOff','wakeOff',THU_NOTE)},
  {key:'Fri', name:'Friday',    kind:'day off', build:(S,ov)=>friday(S,ov)},
  {key:'Sat', name:'Saturday',  kind:'day off', build:(S,ov)=>saturday(S,ov)},
];
const BUDGET = [
  ['Prayer',9.75],['Work',40],['Sleep',54.5],['Quran',3.5],['Azkar',7],['Gym',9],['Learning',3.25],['Reading',2.5],
  ['Startup',9],['Meals',7.5],['Social',7],['Rest',3],['Leisure',2.5],['Planning',0.33],['Offset',null],['Spare',null]
];

/* ---------- dates ---------- */
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseISO = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
// new Date(y, m, d, 0, minutes) normalises overflow, so 1470 min is 00:30 the next day, and DST days come out right.
const atMin = (iso, min) => { const d = parseISO(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, min).getTime(); };

/* ---------- plan → concrete blocks for a date ----------
   plan = { settings, categories, customBlocks:[], overrides:{weekly:{}, dated:{iso:{}}} } */
function emptyPlan(){ return { settings:{...DEFAULTS}, categories:structuredClone(DEFAULT_CATEGORIES), customBlocks:[], overrides:{weekly:{}, dated:{}} }; }
function overridesFor(plan, iso){
  const w = plan.overrides.weekly, d = plan.overrides.dated[iso] || {}, out = {};
  for (const id of new Set([...Object.keys(w), ...Object.keys(d)])) out[id] = {...w[id], ...d[id]};   // one day beats every week
  return out;
}
function customOn(c, iso, dow){ return c.date ? c.date === iso : (c.days || []).includes(dow); }

// All blocks of one date, hidden ones included (flagged). Each block gets date, startAt, endAt.
function buildDay(plan, date){
  const dow = date.getDay(), iso = isoDate(date), ov = overridesFor(plan, iso);
  const blocks = DAYS[dow].build(norm(daySettings(plan, date)), ov);
  for (const c of plan.customBlocks){
    if (!customOn(c, iso, dow)) continue;
    const o = ov[c.id] || {}, start = o.start ?? c.start, end = o.hidden ? start : fixEnd(start, o.end ?? c.end);
    blocks.push({ id:c.id, name:o.name || c.name, cat:o.cat || c.cat, type:'Custom', note:o.note ?? (c.note || ''),
                  start, end, min:end-start, hidden:!!o.hidden, edited:!!ov[c.id], custom:true });
  }
  for (const b of blocks){ b.date = iso; b.dow = dow; b.startAt = atMin(iso, b.start); b.endAt = atMin(iso, b.end); }
  return blocks;
}
const visible = blocks => blocks.filter(b => !b.hidden && b.min > 0);

// Yesterday, today and tomorrow, sorted by start. Yesterday matters because its Sleep block runs past midnight.
function around(plan, nowMs, days = [-1, 0, 1]){
  const now = new Date(nowMs);
  return days.flatMap(k => visible(buildDay(plan, addDays(now, k)))).sort((a,b) => a.startAt - b.startAt);
}

/* What am I supposed to be doing right now? When blocks overlap, a custom block beats
   the generated chain (you added it on purpose), then the later-starting one wins. */
function status(plan, nowMs){
  const occ = around(plan, nowMs);
  const active = occ.filter(b => b.startAt <= nowMs && nowMs < b.endAt)
                    .sort((a,b) => (!!b.custom - !!a.custom) || (b.startAt - a.startAt));
  const current = active[0] || null;
  const next = occ.find(b => b.startAt > nowMs && b !== current) || null;
  return { current, overlaps:active.slice(1), next, occ };
}

function daySummary(blocks){
  const vis = visible(blocks), sleep = vis.find(b=>b.cat==='Sleep'), sleepMin = sleep ? sleep.min : 0;
  const sum = cats => vis.filter(b=>cats.includes(b.cat)).reduce((a,b)=>a+b.min,0);
  const buffer = sum(['Offset','Spare']);
  return { sleepH:sleepMin/60, buffer, deep:sum(['Learning','Reading','Startup']), bufferPct:buffer/(1440-sleepMin), lightsOut:sleep ? sleep.start : null };
}
