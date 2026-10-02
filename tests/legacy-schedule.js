// Test only: the hardcoded day builders from before the week template (Phase T1), kept verbatim
// so tests/check.js can prove the template engine builds the same week. Load after js/schedule.js.
// ov = merged overrides for this date, keyed by block id: {name, cat, start, end, note, hidden}
function legacyChain(dayKey, defs, ov = {}){
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
function legacyWorkday(key, S, ov, learnName, learnCat, bed, nextWake, startupNote){
  const aft = S.gymSlot === 'afternoon';
  return legacyChain(key, [
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
function legacyFriday(S, ov){
  return legacyChain('Fri', [
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
function legacySaturday(S, ov){
  return legacyChain('Sat', [
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
const L_SW = ['Learning: software & AI','Learning'], L_RD = ['Reading: finance, management, history…','Reading'];
const L_STARTUP_NOTE = 'Phone in another room. One concrete deliverable per session.';
const L_THU_NOTE = 'Going out with friends tonight? Skip this block guilt-free; the Fri/Sat long blocks cover it.';
const LEGACY_DAYS = [
  {key:'Sun', name:'Sunday',    kind:'workday', build:(S,ov)=>legacyWorkday('Sun',S,ov,...L_SW,'bedWork','wakeWork',L_STARTUP_NOTE)},
  {key:'Mon', name:'Monday',    kind:'workday', build:(S,ov)=>legacyWorkday('Mon',S,ov,...L_RD,'bedWork','wakeWork',L_STARTUP_NOTE)},
  {key:'Tue', name:'Tuesday',   kind:'workday', build:(S,ov)=>legacyWorkday('Tue',S,ov,...L_SW,'bedWork','wakeWork',L_STARTUP_NOTE)},
  {key:'Wed', name:'Wednesday', kind:'workday', build:(S,ov)=>legacyWorkday('Wed',S,ov,...L_RD,'bedWork','wakeWork',L_STARTUP_NOTE)},
  {key:'Thu', name:'Thursday',  kind:'workday, weekend starts tonight', build:(S,ov)=>legacyWorkday('Thu',S,ov,...L_SW,'bedOff','wakeOff',L_THU_NOTE)},
  {key:'Fri', name:'Friday',    kind:'day off', build:(S,ov)=>legacyFriday(S,ov)},
  {key:'Sat', name:'Saturday',  kind:'day off', build:(S,ov)=>legacySaturday(S,ov)},
];
// buildDay() as it was, generated chain only (no custom blocks).
function legacyBuild(plan, date){ return LEGACY_DAYS[date.getDay()].build(norm(daySettings(plan, date)), overridesFor(plan, isoDate(date))); }
