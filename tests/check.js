// Logic self-check: node tests/check.js  (no dependencies)
process.env.TZ = 'Africa/Cairo';
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ctx = vm.createContext({ console, structuredClone, Date, Math, isFinite, JSON, Number, String, Set, Map, Array, Object, setTimeout, clearTimeout });
for (const f of ['schedule.js', 'tasks.js', 'notify.js', 'sync.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx);
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

// Sync: state -> records -> state round-trips, including dated overrides on ids with colons.
run(`plan.overrides.dated['2026-09-27'] = { 'Sun:gym': { start: toMin('17:00') } }`);
ctx.state = { settings:ctx.plan.settings, categories:ctx.plan.categories, customBlocks:ctx.plan.customBlocks, overrides:ctx.plan.overrides,
              tasks:[ctx.t, ctx.t2], blockDone:{ '2026-09-20':['Sun:fajr', 'Sun:gym'] } };
const recs = run(`Object.entries(COLLS).flatMap(([k, c]) => Object.entries(toRecords(k, state[k])).map(([id, data]) => ({ collection:c, id, data })))`);
assert.ok(recs.some(r => r.id === 'd:2026-09-27:Sun:gym'));
ctx.recs = recs;
assert.deepEqual(JSON.parse(JSON.stringify(run('toState(recs)'))), JSON.parse(JSON.stringify(ctx.state)));
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
