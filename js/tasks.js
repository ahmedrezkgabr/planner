/* =====================================================================
   tasks.js: the task model and the queries behind the task views.
   Pure logic with no DOM access.

   A task's `link` says where it belongs:
     {type:'none'}                              task inbox
     {type:'block',  date, blockId}             one specific block ("Study, Tue 22 Sep")
     {type:'cat',    cat}                       every block of a type ("every Gym")
     {type:'day',    date}                      a day
     {type:'period', date, period}              morning / afternoon / evening of a day
   ===================================================================== */
const PRIORITIES = ['Low','Medium','High','Urgent'];
const STATUSES = ['Not started','In progress','Completed','Postponed'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function newTask(fields = {}){
  const now = new Date().toISOString();
  return { id:uid(), title:'', notes:'', priority:'Medium', status:'Not started', due:'', estimate:null, category:'',
           link:{type:'none'}, createdAt:now, updatedAt:now, completedAt:null, ...fields };
}
const isDone = t => t.status === 'Completed';
const completedOn = (t, iso) => !!t.completedAt && isoDate(new Date(t.completedAt)) === iso;
// Routine tasks ("every Gym block", repeat on) reset for each block: done only for the occurrence they were ticked in.
const occKey = b => b.id + '|' + b.date;
const doneIn = (t, b) => t.repeat && t.link.type === 'cat' ? t.lastDone === occKey(b) : isDone(t);
function setDone(t, done){
  t.status = done ? 'Completed' : 'Not started';
  t.completedAt = done ? new Date().toISOString() : null;
  t.updatedAt = new Date().toISOString();
}
const endOfDay = iso => atMin(iso, 1440);

// When does the task's assigned slot end? null means "no deadline from the link".
function linkEnd(t, plan){
  const l = t.link || {};
  if (l.type === 'block'){
    const b = buildDay(plan, parseISO(l.date)).find(x => x.id === l.blockId);
    return b && !b.hidden ? b.endAt : endOfDay(l.date);   // block deleted since: fall back to end of that day
  }
  if (l.type === 'day') return endOfDay(l.date);
  if (l.type === 'period') return atMin(l.date, PERIODS[l.period][2]);
  return null;
}
function isOverdue(t, plan, nowMs){
  if (isDone(t)) return false;
  if (t.due && endOfDay(t.due) <= nowMs) return true;
  const e = linkEnd(t, plan);
  return e != null && e <= nowMs;
}

// Tasks that belong to one block occurrence: linked to it, or to its type.
const inBlock = (t, b) => (t.link.type === 'block' && t.link.blockId === b.id && t.link.date === b.date) || (t.link.type === 'cat' && t.link.cat === b.cat);

// Tasks for "right now": the current block plus anything assigned to this part of today.
// Tasks ticked off today stay in the list (struck through) so ticking one doesn't make it vanish.
function tasksForNow(tasks, st, nowMs){
  const now = new Date(nowMs), iso = isoDate(now), p = periodOf(now.getHours()*60 + now.getMinutes());
  return tasks.filter(t => ((st.current && inBlock(t, st.current)) || (t.link.type === 'period' && t.link.date === iso && t.link.period === p))
                           && (!isDone(t) || completedOn(t, iso)));
}
function onDate(t, iso, catsThatDay){
  return t.link.date === iso || t.due === iso || (t.link.type === 'cat' && catsThatDay.has(t.link.cat));
}

// Named views for the Tasks tab. weekDates = the 7 ISO dates of the current week.
function taskView(name, tasks, plan, nowMs, st){
  const today = isoDate(new Date(nowMs));
  const catsOn = iso => new Set(visible(buildDay(plan, parseISO(iso))).map(b => b.cat));
  const week = Array.from({length:7}, (_, i) => isoDate(addDays(new Date(nowMs), i - new Date(nowMs).getDay())));
  const open = tasks.filter(t => !isDone(t));
  switch (name){
    case 'now':     return tasksForNow(tasks, st, nowMs);
    case 'today':   { const c = catsOn(today); return tasks.filter(t => onDate(t, today, c) && (!isDone(t) || completedOn(t, today))); }
    case 'week':    { const cs = week.map(catsOn); return open.filter(t => week.some((d, i) => onDate(t, d, cs[i]))); }
    case 'overdue': return open.filter(t => isOverdue(t, plan, nowMs));
    case 'inbox':   return open.filter(t => t.link.type === 'none');
    case 'done':    return tasks.filter(isDone).sort((a,b) => (b.completedAt||'').localeCompare(a.completedAt||''));
    default:        return tasks;
  }
}
const byPriority = (a, b) => isDone(a) - isDone(b) || PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority)
  || (a.due || '9').localeCompare(b.due || '9') || a.createdAt.localeCompare(b.createdAt);

/* Overdue option "move to the next matching block": the next block of the same type
   that has not started yet, searching two weeks ahead. Day/period links move to today, or to tomorrow if that part of today is over. */
function nextMatchingLink(t, plan, nowMs){
  const l = t.link;
  if (l.type === 'block'){
    const orig = buildDay(plan, parseISO(l.date)).find(x => x.id === l.blockId);
    if (!orig) return null;
    for (let k = 0; k < 14; k++){
      const b = visible(buildDay(plan, addDays(new Date(nowMs), k))).find(x => x.cat === orig.cat && x.startAt > nowMs);
      if (b) return { type:'block', date:b.date, blockId:b.id };
    }
    return null;
  }
  const today = isoDate(new Date(nowMs)), tomorrow = isoDate(addDays(new Date(nowMs), 1));
  if (l.type === 'period') return { ...l, date: atMin(today, PERIODS[l.period][2]) > nowMs ? today : tomorrow };
  if (l.type === 'day') return { type:'day', date:today };
  return null;
}

/* ---------- quick add: one line → task fields ----------
   "Call dad !high @gym tomorrow 20m due:fri". Anything that isn't a token stays in the title,
   and so does an @word that matches nothing. With no link token the task goes to the current block (the inbox if nothing is current). */
const PRI_TOKENS = { low:'Low', med:'Medium', medium:'Medium', high:'High', urgent:'Urgent', 1:'Low', 2:'Medium', 3:'High', 4:'Urgent' };
function quickDay(w, nowMs){
  const today = new Date(nowMs);
  if (w === 'today') return isoDate(today);
  if (w === 'tomorrow' || w === 'tmr') return isoDate(addDays(today, 1));
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  const i = DAYS.findIndex(d => w.length >= 3 && d.name.toLowerCase().startsWith(w));
  return i < 0 ? null : isoDate(addDays(today, (i - today.getDay() + 7) % 7));   // this weekday, today included
}
function parseQuick(text, plan, nowMs){
  const out = {}, title = [];
  let day = null, period = null, at = null, every = null;
  for (const tok of String(text).trim().split(/\s+/).filter(Boolean)){
    const w = tok.toLowerCase(); let m;
    if ((m = w.match(/^!(\w+)$/)) && PRI_TOKENS[m[1]]) out.priority = PRI_TOKENS[m[1]];
    else if ((m = w.match(/^(?:(\d+)h)?(?:(\d+)m)?$/)) && (m[1] || m[2])) out.estimate = (+m[1] || 0) * 60 + (+m[2] || 0);
    else if ((m = w.match(/^due:(.+)$/)) && quickDay(m[1], nowMs)) out.due = quickDay(m[1], nowMs);
    else if (quickDay(w, nowMs)) day = quickDay(w, nowMs);
    else if (PERIODS[w]) period = w;
    else if ((m = w.match(/^(?:@every-|\*)(.+)$/)) && quickCat(plan, m[1])) every = quickCat(plan, m[1]);
    else if ((m = w.match(/^@(.+)$/))) at = { q:slug(m[1]), tok };
    else title.push(tok);
  }
  let b = null;
  if (at){
    // First block whose name, type key or type label starts with the word: on the given day, else today (not yet over) and the next 6 days.
    const hit = x => [x.name, x.cat, plan.categories[x.cat]?.label || ''].some(s => slug(s).startsWith(at.q));
    for (let k = 0; k < (day ? 1 : 7) && !b; k++){
      const d = day ? parseISO(day) : addDays(new Date(nowMs), k);
      b = visible(buildDay(plan, d)).sort((x, y) => x.startAt - y.startAt).find(x => hit(x) && (day || x.endAt > nowMs)) || null;
    }
    if (!b) title.push(at.tok);
  }
  if (b) out.link = { type:'block', date:b.date, blockId:b.id };
  else if (every) out.link = { type:'cat', cat:every };
  else if (period) out.link = { type:'period', date:day || isoDate(new Date(nowMs)), period };
  else if (day) out.link = { type:'day', date:day };
  else { const c = status(plan, nowMs).current; out.link = c ? { type:'block', date:c.date, blockId:c.id } : { type:'none' }; }
  out.title = title.join(' ');
  return out;
}
const quickCat = (plan, w) => Object.keys(plan.categories).find(k => slug(k).startsWith(slug(w)) || slug(plan.categories[k].label).startsWith(slug(w)));

// Short human label for a link, e.g. "Gym · Tue 22 Sep" / "Every Gym" / "Inbox".
function linkLabel(t, plan){
  const l = t.link, day = iso => parseISO(iso).toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'});
  if (l.type === 'block'){ const b = buildDay(plan, parseISO(l.date)).find(x => x.id === l.blockId); return { text:`${b ? b.name.split(/[:,]/)[0] : 'Removed block'} · ${day(l.date)}`, cat:b && b.cat }; }
  if (l.type === 'cat') return { text:'Every ' + (plan.categories[l.cat]?.label || l.cat), cat:l.cat };
  if (l.type === 'day') return { text:day(l.date) };
  if (l.type === 'period') return { text:`${PERIODS[l.period][0]} · ${day(l.date)}` };
  return { text:'Inbox' };
}

