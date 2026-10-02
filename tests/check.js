// Logic self-check: node tests/check.js  (no dependencies)
process.env.TZ = 'Africa/Cairo';
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ctx = vm.createContext({ console, structuredClone, Date, Math, isFinite, JSON, Number, String, Set, Map, Array, Object, setTimeout, clearTimeout });
for (const f of ['schedule.js', 'tasks.js', 'habits.js', 'notify.js', 'sync.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'legacy-schedule.js'), 'utf8'), ctx);   // the old hardcoded week, for the equivalence test
const run = code => vm.runInContext(code, ctx);
const at = (iso, hhmm) => run(`atMin('${iso}', toMin('${hhmm}'))`);
ctx.plan = run('emptyPlan()');
const st = ms => { ctx.ms = ms; return run('status(plan, ms)'); };

// 2026-09-20 is a Sunday. Default afternoon gym: lunch 16:05-16:35, gym 16:35-17:55.
let s = st(at('2026-09-20', '17:00'));
assert.equal(s.current.id, 'Sun:gym'); assert.equal(s.next.id, 'Sun:offset-shower-walk-back');
assert.equal(run('fromMin(status(plan, ms).current.start)'), '16:35');

// After midnight, yesterday's Sleep is the current block.
assert.equal(st(at('2026-09-21', '02:00')).current.id, 'Sun:sleep');

// One-day override: lunch starts later, gym slides with it but still ends before Maghrib.
run(`plan.overrides.dated['2026-09-20'] = { 'Sun:lunch-whenever-it-s-ready': { start: toMin('16:50') } }`);
s = st(at('2026-09-20', '17:30'));
assert.equal(s.current.id, 'Sun:gym'); assert.equal(run('fromMin(status(plan, ms).current.start)'), '17:20');
assert.equal(st(at('2026-09-27', '16:40')).current.id, 'Sun:gym', 'other Sundays untouched');

// Weekly hide: leisure disappears, spare absorbs it.
run(`plan.overrides.weekly['Sun:leisure-reels-tv-anything'] = { hidden: true }`);
assert.equal(st(at('2026-09-27', '21:30')).current.id, 'Sun:spare-overflow-family-or-nothing');

// Custom overlay beats the chain; a custom block crossing midnight stays current after 00:00.
run(`plan.customBlocks.push({ id:'c-call', name:'Client call', cat:'Work', start:toMin('17:00'), end:toMin('17:30'), days:[0] })`);
s = st(at('2026-09-27', '17:10')); assert.equal(s.current.id, 'c-call'); assert.equal(s.overlaps[0].id, 'Sun:gym');
run(`plan.customBlocks.push({ id:'c-late', name:'Late film', cat:'Leisure', start:toMin('23:30'), end:toMin('00:30'), days:[], date:'2026-09-26' })`);
assert.equal(st(at('2026-09-27', '00:10')).current.id, 'c-late');

// Bedtime after midnight no longer collapses the evening.
run(`plan.settings.bedWork = '00:30'`);
assert.equal(run(`fromMin(buildDay(plan, parseISO('2026-09-28')).find(b => b.cat === 'Sleep').start)`), '00:30');
run(`plan.settings.bedWork = '23:00'`);

// Auto prayer times: Mansoura, Egyptian method, matches adhan (05:18 12:46 16:10 18:45 20:03, summer time) within 1 min.
{
  const p = run(`prayerTimesFor({ prayerAuto:true, location:{ lat:31.04, lng:31.38 } }, parseISO('2026-09-27'))`);
  const ref = { fajr:'05:18', dhuhr:'12:46', asr:'16:10', maghrib:'18:45', isha:'20:03' };
  for (const k in ref) assert.ok(Math.abs(run(`toMin('${p[k]}') - toMin('${ref[k]}')`)) <= 1, `${k} ${p[k]} vs ${ref[k]}`);
  assert.deepEqual(JSON.parse(JSON.stringify(run(`prayerTimesFor({ prayerAuto:false, location:{ lat:31, lng:31 } }, new Date())`))), {}, 'off: manual times');
  run(`plan.settings.prayerAuto = true; plan.settings.location = { lat:31.04, lng:31.38 }`);
  const gym = run(`buildDay(plan, parseISO('2026-09-27')).find(b => b.id === 'Sun:gym')`);
  assert.equal(run(`fromMin(${gym.end})`), '18:35', 'gym ends 10 min before the calculated Maghrib');
  run(`delete plan.settings.prayerAuto; delete plan.settings.location`);
}

// Week template: the default template builds exactly the old hardcoded week, ids included.
// 3 weeks across the October DST change; both gym slots; default and changed settings; template stored or not; weekly and dated overrides.
{
  const keys = ['id', 'name', 'cat', 'type', 'note', 'start', 'end', 'min', 'hidden', 'edited'];
  const pick = bs => bs.filter(b => !b.custom).map(b => Object.fromEntries(keys.map(k => [k, b[k]])));
  const changedSet = { bedWork:'00:30', gymMax:150, learnWork:60, prayerAuto:true, location:{ lat:31.04, lng:31.38 } };
  const ov = { weekly:{ 'Sun:lunch-whenever-it-s-ready':{ start:run(`toMin('16:20')`) }, 'Tue:learning-software-ai-part-1':{ hidden:true },
                        'Thu:gym':{ name:'Gym (short)', end:run(`toMin('18:00')`) }, 'Sat:offset':{ hidden:true } },
               dated:{ '2026-10-19':{ 'Mon:reading-finance-management-history-part-1':{ start:run(`toMin('19:00')`) }, 'Mon:dinner-whenever-it-s-ready':{ hidden:true } },
                       '2026-10-23':{ 'Fri:rest-nap':{ start:run(`toMin('14:30')`), note:'moved' }, 'Fri:sleep':{ start:run(`toMin('01:00')`) } } } };
  let n = 0;
  for (const gymSlot of ['afternoon', 'evening']) for (const extra of [{}, changedSet]) for (const stored of [false, true]) for (const overrides of [{ weekly:{}, dated:{} }, ov]){
    ctx.P = { ...run('emptyPlan()'), overrides };
    Object.assign(ctx.P.settings, { gymSlot }, extra);
    if (stored) ctx.P.template = run('DEFAULT_TEMPLATE(P.settings.gymSlot)');
    for (let i = 0; i < 21; i++){
      ctx.d = run(`addDays(parseISO('2026-10-18'), ${i})`);
      assert.deepEqual(pick(run('buildDay(P, d)')), pick(run('legacyBuild(P, d)')), `${gymSlot} ${JSON.stringify(extra)} stored:${stored} day ${i}`);
      n++;
    }
  }
  assert.equal(n, 336);
  assert.equal(run(`DAYS.map(d => d.kind).join('|')`), 'workday|workday|workday|workday|workday, weekend starts tonight|day off|day off');
}

// Template rules on a hand-made day (default settings: wakeWork 06:30, dhuhr 11:50, asr 15:20, maghrib 18:05, learnWork 45).
{
  ctx.P = run('emptyPlan()');
  ctx.P.template = { ...run('DEFAULT_TEMPLATE()'), Sun:{ label:'test', steps:[
    { id:'a', name:'A', cat:'Prayer', kind:'Fixed', start:'wakeWork', rule:'len', len:30 },                         // 06:30-07:00
    { id:'b', name:'B', cat:'Work', kind:'Fixed', rule:'until', at:{ anchor:'dhuhr', minus:[10] } },               // until 11:40
    { id:'c', name:'C', cat:'Gym', kind:'Flex', rule:'cap', len:60, at:{ anchor:'maghrib' } },                     // 60 min, under the cap
    { id:'d', name:'D', cat:'Gym', kind:'Flex', rule:'cap', len:999, at:{ anchor:'asr', minus:[{ ref:'offsetShort' }] } },   // capped at 15:10
    { id:'e', name:'E', cat:'Offset', kind:'Spare', rule:'atLeast', len:20, at:{ anchor:'asr' } },                 // 15:10 → 15:30 (at least 20)
    { id:'f', name:'F', cat:'Learning', kind:'Flex', rule:'rest', len:{ ref:'learnWork' }, of:'a' },               // 45 − 30 = 15
    { id:'g', name:'G', cat:'Learning', kind:'Flex', rule:'rest', len:20, of:'b' },                                // b ran 280: 0
    { id:'h', name:'H', cat:'Spare', kind:'Spare', rule:'until', at:{ anchor:'asr' } },                            // already past: 0
    { id:'z', name:'Sleep', cat:'Sleep', kind:'Fixed', note:'n', rule:'until', at:{ anchor:'wakeWork', nextDay:true } },   // to 06:30 next day
  ] } };
  const r = run(`buildDay(P, parseISO('2026-10-18')).map(b => b.id + ' ' + fromMin(b.start) + '-' + fromMin(b.end) + ' ' + b.min)`);
  assert.deepEqual(r, ['Sun:a 06:30-07:00 30', 'Sun:b 07:00-11:40 280', 'Sun:c 11:40-12:40 60', 'Sun:d 12:40-15:10 150', 'Sun:e 15:10-15:30 20',
                       'Sun:f 15:30-15:45 15', 'Sun:g 15:45-15:45 0', 'Sun:h 15:45-15:45 0', 'Sun:z 15:45-06:30 885']);
  assert.equal(run(`buildDay(P, parseISO('2026-10-19')).find(b => b.id === 'Mon:gym').start`), run(`buildDay(emptyPlan(), parseISO('2026-10-19')).find(b => b.id === 'Mon:gym').start`), 'other days: default');
  ctx.P.overrides.weekly['Sun:a'] = { hidden:true };
  assert.equal(run(`buildDay(P, parseISO('2026-10-18')).find(b => b.id === 'Sun:f').min`), 45, 'rest: a hidden step counts as 0');
}

// Stats: a custom block on top of the chain is not counted twice; week totals add up.
{
  run('plan = emptyPlan()');
  const sun = "parseISO('2026-09-27')", sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  const base = run(`plannedByCat(buildDay(plan, ${sun}))`);
  run(`plan.customBlocks.push({ id:'c-call', name:'Client call', cat:'Work', start:toMin('17:00'), end:toMin('17:30'), days:[0] })`);
  const withCall = run(`plannedByCat(buildDay(plan, ${sun}))`);
  assert.equal(sum(withCall), sum(base), 'the day has the same number of minutes');
  assert.equal(withCall.Gym, base.Gym - 30); assert.equal(withCall.Work, base.Work + 30);
  assert.equal(sum(run(`plannedByCat(buildDay(plan, ${sun}), toMin('12:00'))`)), 330, 'cut off at noon: 06:30 wake to 12:00 (the night belongs to the day before)');
  ctx.wk = { blockDone:{ '2026-09-27':['Sun:gym'] }, habits:[{ id:'h', name:'Read', days:[0,1,2,3,4,5,6], createdAt:'2026-09-01T00:00:00Z' }],
             habitLog:{ 'h|2026-09-27':true }, tasks:[{ ...run(`newTask({ title:'x' })`), status:'Completed', completedAt:'2026-09-28T09:00:00.000Z' }],
             timeEntries:[{ id:'e', cat:'Gym', start:'2026-09-27T14:00:00.000Z', end:'2026-09-27T15:00:00.000Z' }] };
  const w = run(`weekStats(plan, wk, Array.from({ length:7 }, (_, i) => addDays(parseISO('2026-09-27'), i)), ${at('2026-09-28', '12:00')})`);
  assert.equal(w.cats.Gym.done, withCall.Gym + 30, 'done counts the ticked block as built (before the overlap)');
  assert.equal(w.cats.Gym.tracked, 60);
  assert.deepEqual(w.tasksDone, [0, 1, 0, 0, 0, 0, 0]);
  assert.equal(w.habitRate, 1/2, 'Sun kept, Mon (today) not yet');
  assert.ok(w.cats.Work.sofar < w.cats.Work.planned && w.cats.Work.sofar > 0);
  run(`plan.customBlocks = []`);
}

// Reminders: materialize() rows for the push server.
{
  ctx.ms = at('2026-09-27', '16:28');   // Sunday; gym 16:35, lead 10
  const rows = run('materialize(plan, ms)');
  const gym = rows.find(r => r.id === 'Sun:gym|2026-09-27');
  assert.equal(new Date(gym.remind_at).getTime(), at('2026-09-27', '16:25'));
  assert.ok(!rows.some(r => new Date(r.end_at).getTime() <= ctx.ms), 'nothing that already ended');
  assert.ok(rows.some(r => r.id === 'Sun:gym|2026-10-10') === false && rows.some(r => r.id.endsWith('|2026-10-10')), '14 days: up to Sat 10 Oct');
  assert.ok(!rows.some(r => r.id.endsWith('|2026-10-11')));
  assert.equal(rows.find(r => r.cat === 'Meals').remind_at, null, 'Meals has reminders off');
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length, 'ids unique');
  assert.equal(rows.find(r => r.id === 'Sun:sleep|2026-09-27').end_at, new Date(at('2026-09-28', '06:30')).toISOString(), 'sleep crosses midnight');
  run(`plan.overrides.dated['2026-09-27'] = { 'Sun:lunch-whenever-it-s-ready': { start: toMin('16:08') } }`);   // gym moves to 16:38
  const moved = run('materialize(plan, ms)').find(r => r.id === 'Sun:gym|2026-09-27');
  assert.notEqual(moved.hash, gym.hash); assert.equal(new Date(moved.remind_at).getTime(), at('2026-09-27', '16:28'));
  run(`plan.overrides.dated['2026-09-27'] = { 'Sun:gym': { hidden: true } }`);
  assert.ok(!run('materialize(plan, ms)').some(r => r.id === 'Sun:gym|2026-09-27'), 'hidden block not emitted');
  run(`delete plan.overrides.dated['2026-09-27']`);
  assert.equal(run('materialize(plan, ms)').find(r => r.id === 'Sun:gym|2026-09-27').hash, gym.hash, 'hash is stable');
}

// Tasks: a block-linked task goes overdue after the block; "next matching" finds the next gym.
ctx.t = run(`newTask({ title:'Buy protein', link:{ type:'block', date:'2026-09-20', blockId:'Sun:gym' } })`);
assert.equal(run(`isOverdue(t, plan, ${at('2026-09-20', '17:00')})`), false);
assert.equal(run(`isOverdue(t, plan, ${at('2026-09-21', '09:00')})`), true);
const nx = run(`nextMatchingLink(t, plan, ${at('2026-09-21', '09:00')})`);
assert.equal(nx.blockId, 'Mon:gym'); assert.equal(nx.date, '2026-09-21');
ctx.t2 = run(`newTask({ title:'Warm-up', link:{ type:'cat', cat:'Gym' } })`);
ctx.ms = at('2026-09-27', '16:45');
assert.deepEqual(run('tasksForNow([t, t2], status(plan, ms), ms).map(x => x.title)'), ['Warm-up']);

// Quick add. 2026-09-27 is a Sunday; at 16:45 the current block is Gym.
{
  ctx.ms = at('2026-09-27', '16:45'); run('plan = emptyPlan()');
  const Q = s => run(`parseQuick(${JSON.stringify(s)}, plan, ms)`);
  let q = Q('Call dad !high @gym tomorrow 20m');
  assert.equal(q.title, 'Call dad'); assert.equal(q.priority, 'High'); assert.equal(q.estimate, 20);
  assert.deepEqual(q.link, { type:'block', date:'2026-09-28', blockId:'Mon:gym' });
  assert.deepEqual(Q('Buy protein').link, { type:'block', date:'2026-09-27', blockId:'Sun:gym' }, 'no token: current block');
  assert.deepEqual(Q('Stretch @gym').link.blockId, 'Sun:gym', 'today\'s gym is still running');
  assert.deepEqual(Q('Warm-up @every-gym').link, { type:'cat', cat:'Gym' });
  assert.deepEqual(Q('Warm-up *gym').link, { type:'cat', cat:'Gym' });
  assert.deepEqual(Q('Pay rent fri').link, { type:'day', date:'2026-10-02' });
  assert.deepEqual(Q('Plan week sun').link, { type:'day', date:'2026-09-27' }, 'weekday includes today');
  assert.deepEqual(Q('Journal evening').link, { type:'period', date:'2026-09-27', period:'evening' });
  assert.deepEqual(Q('Read tomorrow morning').link, { type:'period', date:'2026-09-28', period:'morning' });
  q = Q('Report 1h30m !4 due:2026-10-05');
  assert.equal(q.estimate, 90); assert.equal(q.priority, 'Urgent'); assert.equal(q.due, '2026-10-05');
  q = Q('Email bob@x.com about @nowhere');
  assert.equal(q.title, 'Email bob@x.com about @nowhere', 'unmatched @word stays in the title');
  assert.equal(Q('Fix !bogus thing').title, 'Fix !bogus thing');
  ctx.ms = at('2026-09-27', '03:00');
  assert.deepEqual(Q('Nothing now').link.type, 'block', 'at 3am it is Sleep');
}

// Habits: a streak counts scheduled days only; an unticked today doesn't break it; a missed scheduled day does.
{
  ctx.h = { id:'h1', name:'Stretch', days:[1,3,5], createdAt:'2026-09-01T06:00:00.000Z' };   // Mon, Wed, Fri
  const L = o => { ctx.log = Object.fromEntries(o.map(d => ['h1|' + d, true])); };
  const S = today => run(`streak(h, log, '${today}')`);
  L(['2026-09-21', '2026-09-23', '2026-09-25']);               // Mon Wed Fri
  assert.equal(S('2026-09-27'), 3, 'weekend (days off) does not break it');
  assert.equal(S('2026-09-28'), 3, 'Monday unticked so far: still 3');
  L(['2026-09-21', '2026-09-25', '2026-09-28']);               // missed Wed
  assert.equal(S('2026-09-28'), 2, 'a missed scheduled day breaks it');
  L([]); assert.equal(S('2026-09-28'), 0);
  L(['2026-09-21', '2026-09-23']);
  assert.equal(run(`rate(h, log, '2026-09-21', '2026-09-27')`), 2/3);
  assert.equal(run(`rate(h, log, '2026-09-26', '2026-09-27')`), null, 'nothing scheduled');
  assert.equal(run(`habitsDue([h], '2026-08-31').length`), 0, 'not before it was created');
}

// Timers: one at a time; starting another stops the first; a sub-minute tap leaves no entry.
{
  ctx.E = []; const t0 = Date.parse('2026-09-28T10:00:00Z');
  run(`startTimer(E, { label:'Report', taskId:'t1' }, ${t0})`);
  run(`startTimer(E, { label:'Gym', cat:'Gym' }, ${t0 + 30 * 60000})`);
  assert.equal(ctx.E.length, 2); assert.equal(ctx.E[0].end, '2026-09-28T10:30:00.000Z'); assert.equal(run('running(E).label'), 'Gym');
  assert.equal(run(`trackedMin(E, e => e.taskId === 't1', ${t0 + 99 * 60000})`), 30);
  assert.equal(run(`Math.round(trackedMin(E, e => e.cat === 'Gym', ${t0 + 45 * 60000}))`), 15, 'running entry counts up to now');
  run(`stopTimer(E, ${t0 + 45 * 60000})`); assert.equal(run('running(E)'), null);
  run(`startTimer(E, { label:'Oops' }, ${t0 + 50 * 60000}); stopTimer(E, ${t0 + 50 * 60000 + 20000})`);
  assert.equal(ctx.E.length, 2, 'accidental tap dropped');
}

// Sync: state -> records -> state round-trips, including dated overrides on ids with colons.
run(`plan.overrides.dated['2026-09-27'] = { 'Sun:gym': { start: toMin('17:00') } }`);
ctx.state = { settings:ctx.plan.settings, categories:ctx.plan.categories, template:run('DEFAULT_TEMPLATE("evening")'), customBlocks:ctx.plan.customBlocks, overrides:ctx.plan.overrides,
              tasks:[ctx.t, ctx.t2], blockDone:{ '2026-09-20':['Sun:fajr', 'Sun:gym'] },
              habits:[{ id:'hA', name:'Read', days:[1,3], createdAt:'2026-09-01T08:00:00.000Z' }], habitLog:{ 'hA|2026-09-21':true },
              timeEntries:[{ id:'e1', label:'Gym', cat:'Gym', blockKey:'Sun:gym|2026-09-20', start:'2026-09-20T14:00:00.000Z', end:null }] };
const recs = run(`Object.entries(COLLS).flatMap(([k, c]) => Object.entries(toRecords(k, state[k])).map(([id, data]) => ({ collection:c, id, data })))`);
assert.ok(recs.some(r => r.id === 'd:2026-09-27:Sun:gym'));
ctx.recs = recs;
assert.deepEqual(JSON.parse(JSON.stringify(run('toState(recs)'))), JSON.parse(JSON.stringify(ctx.state)));
assert.equal(recs.filter(r => r.collection === 'template').map(r => r.id).join(), 'Sun,Mon,Tue,Wed,Thu,Fri,Sat');
ctx.state.template.Sun.label = 'edited';
assert.equal(run(`toState(Object.entries(COLLS).flatMap(([k, c]) => Object.entries(toRecords(k, state[k])).map(([id, data]) => ({ collection:c, id, data })))).template.Sun.label`), 'edited');
ctx.state.template.Sun.label = 'workday';
assert.deepEqual(JSON.parse(JSON.stringify(run(`toState(recs.filter(r => r.id !== 'Mon')).template.Mon`))), JSON.parse(JSON.stringify(run(`DEFAULT_TEMPLATE(plan.settings.gymSlot).Mon`))), 'a missing day is filled from the default');
assert.deepEqual(run(`toState(recs.map(r => r.id === t.id ? { ...r, deleted:true, data:null } : r)).tasks.map(x => x.title)`), ['Warm-up'], 'tombstone drops the task');

// Last write wins; a tie keeps the local copy.
const W = (a, b, dirty) => run(`wins({ updated_at:'${a}' }, { updated_at:'${b}', dirty:${dirty} })`);
assert.equal(W('2026-09-26T10:00:01Z', '2026-09-26T10:00:00Z', true), true, 'newer remote wins');
assert.equal(W('2026-09-26T10:00:00Z', '2026-09-26T10:00:01Z', false), false, 'older remote loses');
assert.equal(W('2026-09-26T10:00:00.000+00:00', '2026-09-26T10:00:00.000Z', false), false, 'same instant, other format: no-op');
assert.equal(run(`wins({ updated_at:'2026-09-26T10:00:00Z' }, undefined)`), true);

// save() diffs: unchanged state writes nothing, a removed task becomes a dirty tombstone.
(async () => {
  await run('Sync.save(Object.keys(COLLS), state)');
  assert.equal(run('Sync.pending()'), recs.length);
  run('for (const r of Sync.recs.values()) r.dirty = false');
  await run('Sync.save(Object.keys(COLLS), state)');
  assert.equal(run('Sync.pending()'), 0, 'no-op save');
  run('state.tasks = [t2]');
  await run(`Sync.save(['tasks'], state)`);
  const tomb = run('Sync.recs.get("task|" + t.id)');
  assert.equal(tomb.deleted, true); assert.equal(tomb.dirty, true); assert.equal(run('Sync.pending()'), 1);
  // Regression: state loaded from the store and then edited in place (ticking a task, recoloring a type) must still save.
  run('for (const r of Sync.recs.values()) r.dirty = false; ctx2 = Sync.state(); setDone(ctx2.tasks[0], true); ctx2.categories.Gym.color = "#000000"');
  await run(`Sync.save(['tasks', 'categories'], ctx2)`);
  assert.equal(run('Sync.pending()'), 2, 'in-place edits of loaded state are saved');
  assert.equal(run('Sync.state().tasks[0].status'), 'Completed');
  run('clearTimeout(Sync.timer)');
  console.log('all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
