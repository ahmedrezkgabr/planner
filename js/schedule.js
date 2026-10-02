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
// defs: {id?, name, cat, type, note, start?, end:(start, mins)=>end}; mins = minutes so far by step id (for 'rest').
function chain(dayKey, defs, ov = {}){
  const out = [], seen = {}, mins = {}; let prev = null;
  for (const d of defs){
    const s = slug(d.name); seen[s] = (seen[s]||0) + 1;
    const sid = d.id || s + (seen[s] > 1 ? '-' + seen[s] : ''), id = dayKey + ':' + sid;   // stable across weeks
    const o = ov[id] || {};
    let start = d.start !== undefined ? d.start : prev.end;
    if (o.start != null){ start = o.start; if (prev && start < prev.end - 720) start += 1440; }
    let end = o.hidden ? start : o.end != null ? fixEnd(start, o.end) : d.end(start, mins);
    if (end < start) end = start;
    const b = { id, name:o.name || d.name, cat:o.cat || d.cat, type:d.type, note:o.note ?? (d.note || ''),
                start, end, min:end-start, hidden:!!o.hidden, edited:!!ov[id] };
    mins[sid] = b.min;
    out.push(b); prev = b;
  }
  return out;
}

/* ---------- the week template ----------
   plan.template = { Sun:{ label, steps:[…] }, …, Sat }. Each step is one block of the chain:
   { id, name, cat, kind:'Fixed'|'Flex'|'Spare', note?, start?:'<time key>' (first step only), rule, len?, at?, of? }
   rule  len     end = s + len
         until   end = max(s, at)
         cap     end = min(s + len, at)
         atLeast end = max(at, s + len)
         rest    end = s + max(0, len − minutes of step `of`)   (part 2 tops up part 1)
   len: minutes or {ref:'<settings key>'}; at: {anchor:'<time key>', minus?:[minutes|{ref}], nextDay?:true}. */
function compileStep(st, S){
  const v = x => typeof x === 'number' ? x : Number(S[x.ref]) || 0, L = () => v(st.len);
  const at = () => (st.at.minus || []).reduce((t, m) => t - v(m), S[st.at.anchor]) + (st.at.nextDay ? 1440 : 0);
  const end = { len:s => s + L(), until:s => Math.max(s, at()), cap:s => Math.min(s + L(), at()), atLeast:s => Math.max(at(), s + L()),
                rest:(s, mins) => s + Math.max(0, L() - (mins[st.of] || 0)) }[st.rule] || (s => s);
  return { id:st.id, name:st.name, cat:st.cat, type:st.kind, note:st.note || '', start:st.start ? S[st.start] : undefined, end };
}

const STARTUP_NOTE = 'Phone in another room. One concrete deliverable per session.';
const THU_NOTE = 'Going out with friends tonight? Skip this block guilt-free; the Fri/Sat long blocks cover it.';
// The original week as data. Ids are slug(name), with -2 for a repeat, so "Sun:gym" stays "Sun:gym".
function DEFAULT_TEMPLATE(gymSlot = 'afternoon'){
  const st = (name, cat, kind, r, note) => ({ name, cat, kind, ...(note ? { note } : {}), ...r });
  const ref = k => typeof k === 'number' ? k : { ref:k };
  const at = (anchor, minus) => ({ anchor, ...(minus.length ? { minus:minus.map(ref) } : {}) });
  const len = k => ({ rule:'len', len:ref(k) }), until = (a, ...m) => ({ rule:'until', at:at(a, m) });
  const cap = (k, a, ...m) => ({ rule:'cap', len:ref(k), at:at(a, m) }), atLeast = (k, a) => ({ rule:'atLeast', len:ref(k), at:at(a, []) });
  const sleep = wake => ({ rule:'until', at:{ anchor:wake, nextDay:true } }), first = wake => ({ start:wake, ...len('prayer') });
  const aft = gymSlot === 'afternoon';
  const workday = (learn, lcat, bed, wake, snote) => [
    st('Fajr', 'Prayer', 'Fixed', first('wakeWork'), 'Folded into wake-up for now.'),
    st('Morning azkar', 'Azkar', 'Fixed', until('workStart'), 'Short before work. Finish the rest in your breakfast break, or wake 15 min earlier in Settings.'),
    st('Work, morning', 'Work', 'Fixed', until('dhuhr'), '30-min breakfast break floats inside, whenever it\'s ready.'),
    st('Dhuhr', 'Prayer', 'Fixed', len('prayer')),
    st('Work, afternoon', 'Work', 'Fixed', until('workEnd')),
    st('Offset: close the laptop, move around', 'Offset', 'Spare', atLeast('offsetWork', 'asr'), 'If Asr falls during work (winter), pray then; this stays a pure break.'),
    st('Asr', 'Prayer', 'Fixed', len('prayer')),
    st('Evening azkar', 'Azkar', 'Fixed', len('azkar')),
    st('Lunch, whenever it\'s ready', 'Meals', 'Flex', len('lunch'), 'Depends on family; everything after it slides.'),
    aft ? st('Gym', 'Gym', 'Flex', cap('gymMax', 'maghrib', 'offsetShort'), 'Ends 10 min before Maghrib. Choose the evening slot in Settings for a longer session.')
        : st('Startup deep work', 'Startup', 'Flex', cap('startupWork', 'maghrib', 'offsetShort'), snote),
    st(aft ? 'Offset: shower, walk back' : 'Offset before Maghrib', 'Offset', 'Spare', until('maghrib')),
    st('Maghrib', 'Prayer', 'Fixed', len('prayer')),
    st('Quran study', 'Quran', 'Fixed', len('quran')),
    st(learn + ', part 1', lcat, 'Flex', until('isha'), 'Split around Isha; the two parts add up to the workday target.'),
    st('Isha', 'Prayer', 'Fixed', len('prayer')),
    st(learn + ', part 2', lcat, 'Flex', { rule:'rest', len:ref('learnWork'), of:slug(learn + ', part 1') }),
    aft ? st('Startup deep work', 'Startup', 'Flex', len('startupWork'), snote)
        : st('Gym', 'Gym', 'Flex', cap('gymMax', bed, 'windDown', 'leisure', 'dinner'), 'Evening slot. Ends in time for dinner and wind-down.'),
    st('Dinner, whenever it\'s ready', 'Meals', 'Flex', len('dinner')),
    st('Leisure: reels, TV, anything', 'Leisure', 'Flex', len('leisure'), 'Set a timer. Scrolling gets a home here so it stops leaking into everything else.'),
    st('Spare: overflow, family, or nothing', 'Spare', 'Spare', until(bed, 'windDown'), 'Absorbs whatever ran over. Empty is fine.'),
    st('Wind-down, screens off', 'Offset', 'Fixed', len('windDown')),
    st('Sleep', 'Sleep', 'Fixed', sleep(wake), 'Target 7.5–8 h.'),
  ];
  const SW = ['Learning: software & AI', 'Learning'], RD = ['Reading: finance, management, history…', 'Reading'];
  const t = {
    Sun:{ label:'workday', steps:workday(...SW, 'bedWork', 'wakeWork', STARTUP_NOTE) },
    Mon:{ label:'workday', steps:workday(...RD, 'bedWork', 'wakeWork', STARTUP_NOTE) },
    Tue:{ label:'workday', steps:workday(...SW, 'bedWork', 'wakeWork', STARTUP_NOTE) },
    Wed:{ label:'workday', steps:workday(...RD, 'bedWork', 'wakeWork', STARTUP_NOTE) },
    Thu:{ label:'workday, weekend starts tonight', steps:workday(...SW, 'bedOff', 'wakeOff', THU_NOTE) },
    Fri:{ label:'day off', steps:[
      st('Fajr', 'Prayer', 'Fixed', first('wakeOff'), 'No alarm; the wake time is a guess.'),
      st('Morning azkar', 'Azkar', 'Fixed', len('azkar')),
      st('Breakfast, whenever it\'s ready', 'Meals', 'Flex', len('breakfast')),
      st('Reading: finance, management, history…', 'Reading', 'Flex', len('readFri'), 'A book from outside your field.'),
      st('Spare: family, chores, errands', 'Spare', 'Spare', until('dhuhr', 'jumuahPrep')),
      st('Jumu\'ah: go to the mosque, khutbah, prayer', 'Prayer', 'Fixed', len('jumuah')),
      st('Lunch with family', 'Meals', 'Flex', len('familyLunch')),
      st('Rest, nap', 'Rest', 'Flex', len('nap')),
      st('Spare', 'Spare', 'Spare', until('asr')),
      st('Asr', 'Prayer', 'Fixed', len('prayer')),
      st('Evening azkar', 'Azkar', 'Fixed', len('azkar')),
      st('Startup deep work, long block', 'Startup', 'Flex', until('maghrib', 'offsetShort'), 'Runs until just before Maghrib. One of your two big blocks of the week.'),
      st('Offset', 'Offset', 'Spare', until('maghrib')),
      st('Maghrib', 'Prayer', 'Fixed', len('prayer')),
      st('Quran study', 'Quran', 'Fixed', len('quran')),
      st('Family time', 'Social', 'Flex', until('isha')),
      st('Isha', 'Prayer', 'Fixed', len('prayer')),
      st('Friends, going out, family', 'Social', 'Flex', until('bedOff', 'windDown'), 'Nothing scheduled on purpose. Home and in the mood? Startup or a film, your call.'),
      st('Wind-down, screens off', 'Offset', 'Fixed', len('windDown')),
      st('Sleep', 'Sleep', 'Fixed', sleep('wakeOff'), '8.5 h.'),
    ] },
    Sat:{ label:'day off', steps:[
      st('Fajr', 'Prayer', 'Fixed', first('wakeOff')),
      st('Morning azkar', 'Azkar', 'Fixed', len('azkar')),
      st('Breakfast, whenever it\'s ready', 'Meals', 'Flex', len('breakfast')),
      st('Startup deep work, long block', 'Startup', 'Flex', cap('startupSat', 'dhuhr', 'offsetShort'), 'Your longest block. Ends 10 min before Dhuhr at the latest.'),
      st('Offset', 'Offset', 'Spare', until('dhuhr')),
      st('Dhuhr', 'Prayer', 'Fixed', len('prayer')),
      st('Learning: software & AI', 'Learning', 'Flex', len('learnSat')),
      st('Lunch, whenever it\'s ready', 'Meals', 'Flex', len('lunch')),
      st('Rest, chores, errands', 'Rest', 'Flex', until('asr'), 'Laundry, groceries, a nap, whatever the week left behind.'),
      st('Asr', 'Prayer', 'Fixed', len('prayer')),
      st('Evening azkar', 'Azkar', 'Fixed', len('azkar')),
      st('Gym', 'Gym', 'Flex', cap('gymMax', 'maghrib', 'offsetShort')),
      st('Offset: shower, walk back', 'Offset', 'Spare', until('maghrib')),
      st('Maghrib', 'Prayer', 'Fixed', len('prayer')),
      st('Quran study', 'Quran', 'Fixed', len('quran')),
      st('Weekly review: what slipped, plan next week', 'Planning', 'Fixed', len('planning'), 'Update prayer times in Settings, move blocks, note what to change. Re-export the calendar reminders.'),
      st('Spare', 'Spare', 'Spare', until('isha')),
      st('Isha', 'Prayer', 'Fixed', len('prayer')),
      st('Friends, family, leisure', 'Social', 'Flex', until('bedWork', 'windDown'), 'Work tomorrow: lights out at the workday time.'),
      st('Wind-down, screens off', 'Offset', 'Fixed', len('windDown')),
      st('Sleep', 'Sleep', 'Fixed', sleep('wakeWork'), '7.5 h, Sunday alarm.'),
    ] },
  };
  for (const d of Object.values(t)){ const seen = {}; for (const s of d.steps){ const k = slug(s.name); seen[k] = (seen[k] || 0) + 1; s.id = k + (seen[k] > 1 ? '-' + seen[k] : ''); } }
  return t;
}
// kind: the day's label in the default week (labels can't be edited yet).
const DAYS = Object.entries({ Sun:'Sunday', Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday' })
  .map(([key, name]) => ({ key, name, kind:DEFAULT_TEMPLATE()[key].label }));
// Minutes per block type in one day. Your own blocks paint over the chain they overlap, so nothing counts twice.
// untilMin cuts the day off (minutes since its midnight): planned "so far" for today.
function plannedByCat(blocks, untilMin = 2880){
  const slot = new Array(Math.max(0, Math.min(2880, untilMin))).fill(null);
  for (const b of visible(blocks).sort((x, y) => !!x.custom - !!y.custom))
    for (let m = Math.max(0, b.start); m < Math.min(slot.length, b.end); m++) slot[m] = b.cat;
  const out = {};
  for (const c of slot) if (c) out[c] = (out[c] || 0) + 1;
  return out;
}

/* ---------- dates ---------- */
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseISO = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
// new Date(y, m, d, 0, minutes) normalises overflow, so 1470 min is 00:30 the next day, and DST days come out right.
const atMin = (iso, min) => { const d = parseISO(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, min).getTime(); };

/* ---------- plan → concrete blocks for a date ----------
   plan = { settings, categories, template?, customBlocks:[], overrides:{weekly:{}, dated:{iso:{}}} }
   No template (tests, before the first load): the default week for the gym slot. */
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
  const key = DAYS[dow].key, S = norm(daySettings(plan, date));
  const blocks = chain(key, (plan.template?.[key] || DEFAULT_TEMPLATE(plan.settings.gymSlot)[key]).steps.map(st => compileStep(st, S)), ov);
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
