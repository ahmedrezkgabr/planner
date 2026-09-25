// Logic self-check: node tests/check.js  (no dependencies)
process.env.TZ = 'Africa/Cairo';
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ctx = vm.createContext({ console, structuredClone, Date, Math, JSON, Number, String, Set, Map, Array, Object, setTimeout, clearTimeout });
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

// Reminders: due once, deduped by the log, and a moved block gets a fresh one.
ctx.log = {};
ctx.ms = at('2026-09-27', '16:28');   // gym 16:35, lead 10
let due = run('dueReminders(plan, around(plan, ms), ms, log)').filter(r => r.block.cat === 'Gym');
assert.equal(due.length, 1); assert.equal(due[0].minsLeft, 7);
run(`log[dueReminders(plan, around(plan, ms), ms, log).find(r => r.block.cat === 'Gym').key] = ms`);
assert.equal(run('dueReminders(plan, around(plan, ms), ms, log)').filter(r => r.block.cat === 'Gym').length, 0, 'no duplicate');
assert.equal(run(`dueReminders(plan, around(plan, ${at('2026-09-27', '16:40')}), ${at('2026-09-27', '16:40')}, log)`).filter(r => r.block.cat === 'Gym').length, 0, 'none after start');
run(`plan.overrides.dated['2026-09-27'] = { 'Sun:lunch-whenever-it-s-ready': { start: toMin('16:08') } }`);   // gym now 16:38, reminder at 16:28
assert.equal(run('dueReminders(plan, around(plan, ms), ms, log)').filter(r => r.block.cat === 'Gym').length, 1, 'moved block re-reminds');
run(`plan.categories.Gym.remind = false`);
assert.equal(run('dueReminders(plan, around(plan, ms), ms, log)').filter(r => r.block.cat === 'Gym').length, 0, 'category off');
run(`plan.categories.Gym.remind = true; delete plan.overrides.dated['2026-09-27']`);

// Tasks: a block-linked task goes overdue after the block; "next matching" finds the next gym.
ctx.t = run(`newTask({ title:'Buy protein', link:{ type:'block', date:'2026-09-20', blockId:'Sun:gym' } })`);
assert.equal(run(`isOverdue(t, plan, ${at('2026-09-20', '17:00')})`), false);
assert.equal(run(`isOverdue(t, plan, ${at('2026-09-21', '09:00')})`), true);
const nx = run(`nextMatchingLink(t, plan, ${at('2026-09-21', '09:00')})`);
assert.equal(nx.blockId, 'Mon:gym'); assert.equal(nx.date, '2026-09-21');
ctx.t2 = run(`newTask({ title:'Warm-up', link:{ type:'cat', cat:'Gym' } })`);
ctx.ms = at('2026-09-27', '16:45');
assert.deepEqual(run('tasksForNow([t, t2], status(plan, ms), ms).map(x => x.title)'), ['Warm-up']);

// Calendar export has the gym event with a 10-minute alarm.
const ics = run(`buildICS(plan, parseISO('2026-09-20'), 1)`);
assert.ok(/SUMMARY:Gym\r\n[\s\S]*?TRIGGER:-PT10M/.test(ics)); assert.ok(!ics.includes('SUMMARY:Spare'));

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
  run('clearTimeout(Sync.timer)');
  console.log('all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
