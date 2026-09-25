/* =====================================================================
   ui.js: app state, rendering, events, the reminder tick, and boot.
   The render functions for Day / Week / Budget / Settings are the
   original planner's, adapted to read from buildDay() so edits,
   custom blocks and colors show up everywhere.
   ===================================================================== */

/* ---------- state ---------- */
let plan = emptyPlan();
let tasks = [];
let blockDone = {};                 // { 'YYYY-MM-DD': [blockId] }  (was: block indexes, which broke when blocks moved)
let prefs = { lastExport:null };
let selected = new Date().getDay(), weekOffset = 0, editMode = false, taskFilter = 'now';
let lastIso = isoDate(new Date()), dashSig = '', curKey = '', version = 0;
let pushOn = false;                 // this device has a push subscription (Settings → Reminders)
const keptOverdue = new Set();      // "keep overdue" hides the action buttons for this session

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cat = k => plan.categories[k] || { label:k, color:'#CCCCCC', remind:false, lead:10 };
const colorVars = k => { const c = cat(k).color; return `--c:${c};--ci:${inkOn(c)}`; };
const short = n => n.split(/[:,]/)[0];
const fmt = m => { m = ((m % 1440) + 1440) % 1440; const h = Math.floor(m/60), mm = String(m%60).padStart(2,'0'); const h12 = h%12 || 12; return `${h12}:${mm}${h<12?'am':'pm'}`; };
const fmtRange = (a,b) => { const A = fmt(a), B = fmt(b); return (A.slice(-2)===B.slice(-2) ? A.slice(0,-2) : A) + ' – ' + B; };
const dur = min => min >= 60 ? (min/60).toFixed(min%60?1:0)+' h' : min+' min';
const inMin = ms => { const m = Math.max(0, Math.round(ms/60000)); return m >= 60 ? `${Math.floor(m/60)} h ${m%60} min` : `${m} min`; };
const todayIdx = () => new Date().getDay();
const dateFor = idx => addDays(new Date(), idx - todayIdx() + 7*weekOffset);
const dayLabel = iso => parseISO(iso).toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'});
const touch = t => { t.updatedAt = new Date().toISOString(); };

/* ---------- persistence (sync.js) ----------
   Synced: the plan, tasks and done ticks. Device-only: prefs. */
const stateOf = () => ({ settings:plan.settings, categories:plan.categories, customBlocks:plan.customBlocks, overrides:plan.overrides, tasks, blockDone });
async function save(...keys){
  try {
    await Sync.save(keys, stateOf());
    if (keys.includes('prefs')) await Sync.setMeta('prefs', prefs);
    $('savedNote').textContent = Sync.mode === 'memory' ? 'Saved for this session only' : 'Saved';
  } catch (e) { toast('Could not save: ' + e.message); }
}
function load(st){
  plan.settings = st.settings; plan.categories = st.categories; plan.customBlocks = st.customBlocks; plan.overrides = st.overrides;
  tasks = st.tasks; blockDone = st.blockDone;
}
function changed(...keys){ version++; save(...keys); renderAll(); }

/* ---------- toast (in-app reminder / feedback) ---------- */
let toastTimer;
function toast(msg, catKey, ms = 3500){
  const el = $('toast'); el.textContent = msg; el.style.cssText = catKey ? colorVars(catKey) : ''; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, ms);
}
function download(data, name, type){
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], {type})); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- persistent now-bar ---------- */
function renderNowbar(st, now){
  const bar = $('nowbar'), c = st.current, n = st.next;
  const next = n ? `<span class="nx">Next: ${esc(short(n.name))} in ${inMin(n.startAt - now)}</span>` : '';
  if (!c){
    bar.style.cssText = ''; bar.innerHTML = `<span class="lbl">NOW</span><span class="nm">Nothing scheduled</span>${next}`;
    $('themeColor').content = '#1F2A37'; document.title = 'Planner'; return;
  }
  const pct = Math.min(100, (now - c.startAt) / (c.endAt - c.startAt) * 100);
  bar.style.cssText = colorVars(c.cat);
  bar.innerHTML = `<span class="lbl">CURRENT BLOCK</span><span class="nm">${esc(c.name)}</span><span class="tm">${fmtRange(c.start, c.end)}</span>` +
    `<span class="left">${inMin(c.endAt - now)} left</span>${next}<span class="bar"><i style="width:${pct}%"></i></span>`;
  $('themeColor').content = cat(c.cat).color;
  document.title = `${short(c.name)} · ${inMin(c.endAt - now)} left`;
}

/* ---------- dashboard (Now tab) ---------- */
function renderDash(st, now){
  const c = st.current, n = st.next, today = isoDate(new Date(now));
  $('dCur').style.cssText = c ? colorVars(c.cat) : 'background:#1F2A37;color:#fff';
  $('dCur').innerHTML = c
    ? `<h3>Current · ${esc(cat(c.cat).label)}</h3><p class="big">${esc(c.name)}</p><div class="sub">${fmtRange(c.start, c.end)} · ${dur(c.min)}</div>` +
      `<div class="rem">${inMin(c.endAt - now)} remaining</div>` + (c.note ? `<div class="meta">${esc(c.note)}</div>` : '') +
      (st.overlaps.length ? `<div class="meta">Also running: ${st.overlaps.map(o => esc(o.name)).join(', ')}</div>` : '')
    : `<h3>Current</h3><p class="big">Nothing scheduled</p>`;
  $('dNext').innerHTML = n
    ? `<h3>Next</h3><p style="margin:0;font-size:20px;font-weight:600"><span class="dot" style="${colorVars(n.cat)}"></span> ${esc(n.name)}</p><div class="sub">Starts in ${inMin(n.startAt - now)} · ${fmt(n.start)}</div>`
    : `<h3>Next</h3><p class="muted">Nothing else scheduled.</p>`;

  const tv = taskView('today', tasks, plan, now, st);
  const doneT = t => isDone(t) || (t.repeat && (t.lastDone || '').endsWith('|' + today));
  const over = taskView('overdue', tasks, plan, now, st).length, dn = tv.filter(doneT).length;
  $('dToday').innerHTML = `<h3>Today</h3><div class="nums"><div><b>${tv.length - dn}</b><span>remaining</span></div><div><b>${dn}</b><span>completed</span></div>` +
    (over ? `<div><b style="color:var(--red)">${over}</b><span>overdue</span></div>` : '') + `</div>`;

  $('dTasksTitle').textContent = c ? `Tasks for ${short(c.name)}` : 'Tasks for now';
  $('dTaskText').placeholder = c ? `Add to ${short(c.name)}… or try !high @gym tomorrow 20m` : 'Add a task… try !high @gym tomorrow 20m';
  renderTaskList($('dTasks'), tasksForNow(tasks, st, now).sort(byPriority), { block:c,
    empty: c ? `Nothing assigned to this block. Tasks linked to it, or to every “${cat(c.cat).label}” block, show up here.` : 'Nothing scheduled right now.' });

  // Reminder state + the next few reminders
  $('dNotifyState').innerHTML = pushOn ? '' : `Reminders are off on this device. <a href="#" id="dNotifyLink">Turn them on in Settings</a>. They arrive even when the planner is closed.`;
  const link = $('dNotifyLink'); if (link) link.onclick = e => { e.preventDefault(); show('settings'); };
  const up = upcomingReminders(plan, st.occ, now);
  $('dReminders').innerHTML = up.length ? up.map(r => `<li><span class="when">${fmt(new Date(r.at).getHours()*60 + new Date(r.at).getMinutes())}</span><span class="dot" style="${colorVars(r.block.cat)}"></span>` +
    `<span>${esc(short(r.block.name))} <span class="muted">starts ${fmt(r.block.start)}, ${cat(r.block.cat).lead} min notice</span></span></li>`).join('')
    : '<li class="muted">No reminders in the next 24 hours. Turn them on per block type in Settings.</li>';
}
/* ---------- quick add (Now and Tasks): one line, parsed by parseQuick(), with a live preview ---------- */
function quickPreview(inp, out){
  const q = inp.value.trim() ? parseQuick(inp.value, plan, Date.now()) : null;
  if (!q || !q.title){ out.innerHTML = ''; return; }
  const L = linkLabel({ link:q.link }, plan);
  out.innerHTML = `<span class="ttl">${esc(q.title)}</span><span style="${L.cat ? colorVars(L.cat) : ''}">${esc(L.text)}</span>` +
    (q.priority ? `<span>${q.priority}</span>` : '') + (q.estimate ? `<span>${dur(q.estimate)}</span>` : '') + (q.due ? `<span>due ${esc(dayLabel(q.due))}</span>` : '');
}
function quickAdd(inp, out){
  const q = parseQuick(inp.value, plan, Date.now()); if (!q.title) return;
  const t = newTask(q); tasks.push(t);
  inp.value = ''; out.innerHTML = ''; changed('tasks'); inp.focus();
  toast('Added to ' + linkLabel(t, plan).text, linkLabel(t, plan).cat);
}
for (const [inp, btn, out] of [['dTaskText', 'dTaskAdd', 'dTaskPrev'], ['quickText', 'quickAdd', 'quickPrev']]){
  $(btn).onclick = () => quickAdd($(inp), $(out));
  $(inp).onkeydown = e => { if (e.key === 'Enter') quickAdd($(inp), $(out)); };
  $(inp).oninput = () => quickPreview($(inp), $(out));
}
$('nowbar').onclick = () => show('now');

/* ---------- shared task list rendering ---------- */
// opts.block: the occurrence the list is for (routine tasks tick per block); opts.actions: show overdue options.
function taskItem(t, opts = {}){
  const li = document.createElement('li'), now = Date.now();
  const routine = t.repeat && t.link.type === 'cat', done = opts.block ? doneIn(t, opts.block) : isDone(t);
  if (done) li.className = 'done';
  if (routine && !opts.block){ const r = document.createElement('span'); r.textContent = '↻'; r.title = 'Routine: ticked per block on the dashboard'; r.style.cssText = 'width:20px;text-align:center;color:var(--muted)'; li.appendChild(r); }
  else {
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = done; cb.setAttribute('aria-label', 'Done: ' + t.title);
    cb.onchange = () => { if (routine) { t.lastDone = cb.checked ? occKey(opts.block) : null; touch(t); } else setDone(t, cb.checked); changed('tasks'); };
    li.appendChild(cb);
  }
  const tt = document.createElement('button'); tt.className = 'tt'; tt.textContent = t.title; tt.title = 'Edit task'; tt.onclick = () => openTaskDlg(t);
  li.appendChild(tt);
  if (t.priority !== 'Medium'){ const p = document.createElement('span'); p.className = 'pri ' + t.priority; p.textContent = t.priority; li.appendChild(p); }
  if (opts.showLink !== false){
    const L = linkLabel(t, plan), tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = (routine ? '↻ ' : '') + L.text; tag.title = L.text;
    if (L.cat) tag.style.cssText = colorVars(L.cat); li.appendChild(tag);
  }
  if (t.due){ const d = document.createElement('span'); d.className = 'due' + (!isDone(t) && endOfDay(t.due) <= now ? ' late' : ''); d.textContent = 'due ' + dayLabel(t.due); li.appendChild(d); }
  if (opts.actions && !keptOverdue.has(t.id)) li.appendChild(overdueActions(t));
  return li;
}
function renderTaskList(ul, list, opts = {}){
  ul.innerHTML = '';
  if (!list.length){ ul.innerHTML = `<li class="empty">${esc(opts.empty || 'Nothing here.')}</li>`; return; }
  list.forEach(t => ul.appendChild(taskItem(t, opts)));
}

/* Overdue options: next matching block / reschedule / keep / complete / back to inbox */
function overdueActions(t){
  const box = document.createElement('div'); box.className = 'acts';
  const today = isoDate(new Date());
  const add = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = fn; box.appendChild(b); };
  const nx = nextMatchingLink(t, plan, Date.now());
  if (nx) add(t.link.type === 'block' ? 'Next matching block' : 'Move to ' + (nx.date === today ? 'today' : 'tomorrow'), () => {
    t.link = nx; if (t.due && t.due < today) t.due = nx.date;   // a stale due date would keep it overdue
    touch(t); changed('tasks'); toast('Moved to ' + linkLabel(t, plan).text, nx.blockId ? buildDay(plan, parseISO(nx.date)).find(b => b.id === nx.blockId)?.cat : null);
  });
  add('Reschedule…', () => openTaskDlg(t, null, true));
  add('Keep overdue', () => { keptOverdue.add(t.id); renderTasks(); });
  add('Complete', () => { setDone(t, true); changed('tasks'); });
  add('To inbox', () => { t.link = { type:'none' }; if (t.due && t.due < today) t.due = ''; touch(t); changed('tasks'); });
  return box;
}

/* ---------- Day view (original, plus edit mode and custom blocks) ---------- */
const T1 = 1440;
function renderDayPicker(){
  const el = $('days'); el.innerHTML = '';
  const nav = (txt, lbl, fn) => { const b = document.createElement('button'); b.className = 'wk'; b.textContent = txt; b.setAttribute('aria-label', lbl); b.onclick = fn; el.appendChild(b); };
  nav('‹', 'Previous week', () => { weekOffset--; renderAll(); });
  DAYS.forEach((d, i) => {
    const b = document.createElement('button'); b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', i === selected); if (isoDate(dateFor(i)) === isoDate(new Date())) b.classList.add('today');
    b.innerHTML = `${d.key}<small>${dateFor(i).getDate()}</small>`;
    b.onclick = () => { selected = i; renderDay(); };
    el.appendChild(b);
  });
  nav('›', 'Next week', () => { weekOffset++; renderAll(); });
}
function renderDay(){
  renderDayPicker();
  const date = dateFor(selected), iso = isoDate(date), d = DAYS[selected];
  const all = buildDay(plan, date), blocks = visible(all), sum = daySummary(all);
  $('dayTitle').textContent = d.name;
  $('daySub').textContent = `${date.toLocaleDateString('en-GB', {day:'numeric', month:'long'})}, ${d.kind}`;
  const dayTasks = tasks.filter(t => t.link.date === iso || t.due === iso);
  $('dayStats').innerHTML =
    `<span>Sleep <b>${sum.sleepH.toFixed(1)} h</b></span><span>Buffer <b>${sum.buffer} min</b> (${Math.round(sum.bufferPct*100)}% of waking)</span>` +
    `<span>Deep work <b>${sum.deep} min</b></span>` + (sum.lightsOut != null ? `<span>Lights out <b>${fmt(sum.lightsOut)}</b></span>` : '') +
    (dayTasks.length ? `<span>Tasks <b>${dayTasks.filter(isDone).length} of ${dayTasks.length}</b> done</span>` : '');
  const ppm = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ppm'));
  const wake = (all.find(b => !b.custom && !b.hidden) || {start:360}).start;
  const T0 = Math.min(360, Math.floor(Math.min(wake, ...blocks.map(b => b.start)) / 60) * 60);   // grows upward if you start before 6:00
  const H = (T1 - T0) * ppm;
  const g = $('gutter'); g.innerHTML = ''; g.style.height = H + 'px';
  for (let m = T0; m <= T1; m += 60){
    const s = document.createElement('div'); s.className = 'h' + (m >= 1200 ? ' late' : '');
    s.style.top = ((m - T0) * ppm) + 'px'; s.textContent = (m/60) % 24 === 0 ? '24' : String(m/60); g.appendChild(s);
  }
  const S = norm(plan.settings);
  ['dhuhr','asr','maghrib','isha'].forEach(k => { const p = document.createElement('div'); p.className = 'p'; p.style.top = ((S[k] - T0) * ppm) + 'px'; g.appendChild(p); });
  const t = $('track'); t.innerHTML = ''; t.style.height = H + 'px';
  const doneSet = new Set(blockDone[iso] || []), cur = status(plan, Date.now()).current;
  if (wake > T0) t.appendChild(blockEl({name:'Sleep', cat:'Sleep', start:T0, end:wake, min:wake - T0, note:''}, ppm, T0, false, null));
  blocks.forEach(b => {
    if (b.start >= T1) return;
    const end = Math.min(b.end, T1), open = tasks.filter(x => inBlock(x, b) && !doneIn(x, b)).length;
    const el = blockEl({...b, end, min:end - b.start, open}, ppm, T0, doneSet.has(b.id), () => editMode ? openBlockDlg(b) : toggleDone(iso, b.id));
    if (b.cat === 'Sleep') el.querySelector('.t').textContent = `${fmtRange(b.start, b.end)} (${(b.min/60).toFixed(1)} h)`;
    if (cur && cur.id === b.id && cur.date === iso) el.classList.add('cur');
    t.appendChild(el);
  });
  if (iso === isoDate(new Date())){ const now = document.createElement('div'); now.className = 'now'; now.id = 'nowLine'; now.dataset.t0 = T0; t.appendChild(now); positionNow(); }
  $('tl').classList.toggle('editing', editMode);
  renderDayTasks();
}
function blockEl(b, ppm, T0, isDoneB, onClick){
  const el = document.createElement(onClick ? 'button' : 'div'), h = b.min * ppm, c = cat(b.cat);
  el.className = `blk${c.dashed ? ' dashed' : ''}${b.custom ? ' custom' : ''}${b.edited ? ' edited' : ''}${h < 30 ? ' tiny' : ''}${isDoneB ? ' done' : ''}`;
  el.style.cssText = `${colorVars(b.cat)};top:${(b.start - T0) * ppm}px;height:${Math.max(h, 14)}px`;
  el.innerHTML = `<span class="n">${esc(b.name)}</span><span class="t">${fmtRange(b.start, b.end)} (${dur(b.min)}${b.open ? ', ' + b.open + (b.open > 1 ? ' tasks' : ' task') : ''})</span>` +
    (b.note && h >= 52 ? `<span class="note">${esc(b.note)}</span>` : '');
  if (b.note) el.title = b.note;
  if (onClick){ el.onclick = onClick; if (!editMode) el.setAttribute('aria-pressed', isDoneB); }
  return el;
}
function toggleDone(iso, id){
  const set = new Set(blockDone[iso] || []); set.has(id) ? set.delete(id) : set.add(id);
  blockDone[iso] = [...set]; changed('blockDone');
}
function positionNow(){
  const el = $('nowLine'); if (!el) return;
  const n = new Date(), m = n.getHours()*60 + n.getMinutes(), T0 = Number(el.dataset.t0);
  const ppm = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ppm'));
  el.style.display = m < T0 ? 'none' : 'block'; el.style.top = ((m - T0) * ppm) + 'px';
}
$('editToggle').onclick = () => {
  editMode = !editMode; $('editToggle').setAttribute('aria-pressed', editMode);
  $('editToggle').textContent = editMode ? 'Done editing' : 'Edit schedule'; $('editToggle').classList.toggle('primary', editMode);
  renderDay(); if (editMode) toast('Edit mode: tap a block to change it');
};
$('addBlock').onclick = () => {
  const iso = isoDate(dateFor(selected));
  openBlockDlg({ id:null, name:'', cat:'Work', start:toMin('17:00'), end:toMin('18:00'), note:'', date:iso, custom:true }, true);
};

/* Day-view task panel: tasks dated to this day (the original feature, now on the new task model) */
function renderDayTasks(){
  const date = dateFor(selected), iso = isoDate(date), blocks = visible(buildDay(plan, date));
  const list = tasks.filter(t => t.link.date === iso || t.due === iso).sort(byPriority);
  $('tasksTitle').textContent = `Tasks for ${DAYS[selected].name}`;
  const doneN = list.filter(isDone).length;
  $('tasksCount').textContent = list.length ? `${doneN} of ${list.length} done` : '';
  renderTaskList($('taskList'), list, { empty:'Nothing yet. Add what you want to get done and, if you like, which block it belongs to.' });
  const sel = $('taskBlock'), cur = sel.value;
  sel.innerHTML = '<option value="">Anytime this day</option>' + Object.entries(PERIODS).map(([k, p]) => `<option value="p:${k}">${p[0]}</option>`).join('') +
    blocks.filter(b => b.cat !== 'Sleep').map(b => `<option value="${esc(b.id)}">${fmt(b.start)} ${esc(b.name)}</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  const prevIso = isoDate(addDays(date, -1)), undone = tasks.filter(t => !isDone(t) && t.link.date === prevIso);
  const c = $('carry'); c.hidden = !undone.length;
  if (undone.length) c.textContent = `Bring ${undone.length} unfinished task${undone.length > 1 ? 's' : ''} over from ${DAYS[(selected + 6) % 7].name}`;
}
function addDayTask(){
  const inp = $('taskText'), title = inp.value.trim(); if (!title) return;
  const iso = isoDate(dateFor(selected)), v = $('taskBlock').value;
  const link = !v ? { type:'day', date:iso } : v.startsWith('p:') ? { type:'period', date:iso, period:v.slice(2) } : { type:'block', date:iso, blockId:v };
  tasks.push(newTask({ title, link })); inp.value = ''; changed('tasks'); inp.focus();
}
$('taskAdd').onclick = addDayTask;
$('taskText').onkeydown = e => { if (e.key === 'Enter') addDayTask(); };
$('carry').onclick = () => {
  const date = dateFor(selected), iso = isoDate(date), prevIso = isoDate(addDays(date, -1)), blocks = visible(buildDay(plan, date));
  for (const t of tasks.filter(t => !isDone(t) && t.link.date === prevIso)){
    if (t.link.type === 'block'){
      const was = buildDay(plan, parseISO(prevIso)).find(b => b.id === t.link.blockId), same = was && blocks.find(b => b.cat === was.cat);
      t.link = same ? { type:'block', date:iso, blockId:same.id } : { type:'day', date:iso };
    } else t.link = { ...t.link, date:iso };
    touch(t);
  }
  changed('tasks');
};

/* ---------- Week view ---------- */
function renderWeek(){
  const ppm = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wppm')), T0 = 360;
  const H = (T1 - T0) * ppm;
  const nav = $('weekNav'), first = dateFor(0);
  nav.innerHTML = `<button class="wk" aria-label="Previous week">‹</button><button disabled>Week of ${first.toLocaleDateString('en-GB', {day:'numeric', month:'short'})}</button>` +
    (weekOffset ? '<button>This week</button>' : '') + '<button class="wk" aria-label="Next week">›</button>';
  const [prev, , ...rest] = nav.children; prev.onclick = () => { weekOffset--; renderAll(); }; rest[rest.length - 1].onclick = () => { weekOffset++; renderAll(); };
  if (weekOffset) rest[0].onclick = () => { weekOffset = 0; renderAll(); };
  const w = $('week'); w.innerHTML = '';
  const gut = document.createElement('div'); gut.className = 'col'; gut.innerHTML = '<h3>&nbsp;<small>&nbsp;</small></h3>';
  const gb = document.createElement('div'); gb.className = 'wgut'; gb.style.height = H + 'px';
  for (let m = T0; m <= T1; m += 120){ const s = document.createElement('div'); s.className = 'h'; s.style.top = ((m - T0) * ppm) + 'px'; s.textContent = (m/60) % 24 === 0 ? '24' : String(m/60); gb.appendChild(s); }
  gut.appendChild(gb); w.appendChild(gut);
  DAYS.forEach((d, i) => {
    const col = document.createElement('div'); col.className = 'col';
    const isToday = isoDate(dateFor(i)) === isoDate(new Date());
    col.innerHTML = `<h3 class="${isToday ? 'today' : ''}" style="cursor:pointer" title="Open ${d.name}">${d.key}<small>${dateFor(i).getDate()}</small></h3>`;
    col.firstChild.onclick = () => { selected = i; show('day'); };
    const body = document.createElement('div'); body.className = 'body'; body.style.height = H + 'px';
    const all = buildDay(plan, dateFor(i)), blocks = visible(all), wake = (all.find(b => !b.custom && !b.hidden) || {start:T0}).start;
    const add = b => { if (b.min <= 0 || b.start >= T1) return; const start = Math.max(b.start, T0), end = Math.min(b.end, T1); if (end <= start) return;
      const e = document.createElement('div'), c = cat(b.cat);
      e.className = 'wb' + (c.dashed ? ' dashed' : '') + (b.custom ? ' custom' : ''); e.style.cssText = `${colorVars(b.cat)};top:${(start - T0) * ppm}px;height:${Math.max((end - start) * ppm - 1, 4)}px`;
      e.title = `${b.name}, ${fmtRange(b.start, b.end)}`; if ((end - start) * ppm >= 12) e.textContent = short(b.name); body.appendChild(e); };
    if (wake > T0) add({name:'Sleep', cat:'Sleep', start:T0, end:wake, min:wake - T0});
    blocks.forEach(add);
    col.appendChild(body); w.appendChild(col);
  });
  // Legend: one swatch per color, naming every block type that uses it.
  const groups = new Map();
  for (const [k, c] of Object.entries(plan.categories)){ if (!groups.has(c.color)) groups.set(c.color, { k, labels:[] }); groups.get(c.color).labels.push(c.label); }
  $('legend').innerHTML = [...groups.values()].map(g => `<span><span class="dot" style="${colorVars(g.k)}"></span>${esc(g.labels.join(', '))}</span>`).join('');
}

/* ---------- Tasks tab ---------- */
const FILTERS = [['now','Current block'],['today','Today'],['week','This week'],['overdue','Overdue'],['inbox','Inbox'],['done','Completed'],['all','All']];
const EMPTY = { now:'Nothing assigned to the current block.', today:'Nothing planned for today.', week:'Nothing planned this week.', overdue:'Nothing overdue.', inbox:'Inbox is empty.', done:'Nothing completed yet.', all:'No tasks yet.' };
function renderTasks(){
  const now = Date.now(), st = status(plan, now);
  const f = $('filters'); f.innerHTML = '';
  FILTERS.forEach(([k, label]) => {
    const n = taskView(k, tasks, plan, now, st).filter(t => k === 'done' || k === 'all' || !isDone(t)).length;
    const b = document.createElement('button'); b.setAttribute('aria-pressed', k === taskFilter); b.innerHTML = `${label}<b>${n}</b>`;
    b.onclick = () => { taskFilter = k; renderTasks(); }; f.appendChild(b);
  });
  let list = taskView(taskFilter, tasks, plan, now, st);
  if (taskFilter !== 'done') list = list.sort(byPriority);
  renderTaskList($('taskView'), list, { actions:taskFilter === 'overdue', block:taskFilter === 'now' ? st.current : null, empty:EMPTY[taskFilter] });
  const over = taskView('overdue', tasks, plan, now, st).length, badge = $('overdueBadge');
  badge.hidden = !over; badge.textContent = over;
}
$('newTask').onclick = () => openTaskDlg(null);

/* ---------- Task dialog ---------- */
let dlgTask = null;
function openTaskDlg(t, preset, focusLink){
  const f = $('taskForm').elements, isNew = !t; t = t || newTask(preset || {}); dlgTask = { t, isNew };
  $('tdTitle').textContent = isNew ? 'New task' : 'Edit task';
  f.priority.innerHTML = PRIORITIES.map(p => `<option>${p}</option>`).join('');
  f.status.innerHTML = STATUSES.map(s => `<option>${s}</option>`).join('');
  f.linkCat.innerHTML = Object.entries(plan.categories).map(([k, c]) => `<option value="${esc(k)}">${esc(c.label)}</option>`).join('');
  $('taskCats').innerHTML = [...new Set(tasks.map(x => x.category).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('');
  f.title.value = t.title; f.notes.value = t.notes || ''; f.priority.value = t.priority; f.status.value = t.status;
  f.due.value = t.due || ''; f.estimate.value = t.estimate ?? ''; f.category.value = t.category || '';
  f.linkType.value = t.link.type; f.linkDate.value = t.link.date || isoDate(new Date());
  f.linkCat.value = t.link.cat || (status(plan, Date.now()).current || {}).cat || 'Gym';
  f.linkPeriod.value = t.link.period || periodOf(new Date().getHours()*60 + new Date().getMinutes());
  f.repeat.checked = !!t.repeat;
  fillBlockSelect(t.link.blockId); syncLinkFields();
  $('tdDelete').hidden = isNew;
  $('taskDlg').showModal();
  if (focusLink) f.linkDate.focus();
}
function fillBlockSelect(sel){
  const f = $('taskForm').elements; if (!f.linkDate.value) return;
  const bl = visible(buildDay(plan, parseISO(f.linkDate.value))).filter(b => b.cat !== 'Sleep');
  f.linkBlock.innerHTML = bl.map(b => `<option value="${esc(b.id)}">${fmt(b.start)} ${esc(b.name)}</option>`).join('');
  if (sel && bl.some(b => b.id === sel)) f.linkBlock.value = sel;
}
function syncLinkFields(){
  const type = $('taskForm').elements.linkType.value;
  $('taskForm').querySelectorAll('[data-for]').forEach(el => el.hidden = !el.dataset.for.split(' ').includes(type));
}
$('taskForm').elements.linkType.onchange = syncLinkFields;
$('taskForm').elements.linkDate.onchange = () => fillBlockSelect($('taskForm').elements.linkBlock.value);
$('taskDlg').addEventListener('close', () => {
  const v = $('taskDlg').returnValue, f = $('taskForm').elements, { t, isNew } = dlgTask; $('taskDlg').returnValue = '';
  if (v === 'delete'){ if (confirm(`Delete “${t.title}”?`)){ tasks = tasks.filter(x => x !== t); changed('tasks'); } return; }
  if (v !== 'save') return;
  const wasDone = isDone(t);
  Object.assign(t, { title:f.title.value.trim() || t.title, notes:f.notes.value.trim(), priority:f.priority.value, status:f.status.value, due:f.due.value,
                     estimate:f.estimate.value ? Number(f.estimate.value) : null, category:f.category.value.trim(), repeat:f.linkType.value === 'cat' && f.repeat.checked });
  const type = f.linkType.value, date = f.linkDate.value;
  t.link = type === 'block' && date && f.linkBlock.value ? { type, date, blockId:f.linkBlock.value }
         : type === 'cat' ? { type, cat:f.linkCat.value }
         : (type === 'day' || type === 'block') && date ? { type:'day', date }
         : type === 'period' && date ? { type, date, period:f.linkPeriod.value } : { type:'none' };
  if (isDone(t) && !wasDone) t.completedAt = new Date().toISOString();
  if (!isDone(t)) t.completedAt = null;
  touch(t); keptOverdue.delete(t.id);
  if (isNew) tasks.push(t);
  changed('tasks');
});

/* ---------- Block dialog: edit / move / rename / recolor / duplicate / delete ---------- */
let dlgBlock = null;
function openBlockDlg(b, isNew){
  const f = $('blockForm').elements, custom = b.custom && !isNew ? plan.customBlocks.find(c => c.id === b.id) : null;
  dlgBlock = { b, isNew, custom };
  $('bdTitle').textContent = isNew ? 'New block' : 'Edit block';
  f.cat.innerHTML = Object.entries(plan.categories).map(([k, c]) => `<option value="${esc(k)}">${esc(c.label)}</option>`).join('');
  f.name.value = b.name; f.cat.value = b.cat; f.start.value = fromMin(b.start); f.end.value = fromMin(b.end); f.note.value = b.note || '';
  const dow = parseISO(b.date).getDay(), recurring = !isNew && (!custom || !custom.date);
  $('bdScope').innerHTML = recurring
    ? `<label><input type="radio" name="scope" value="date" checked> Only ${dayLabel(b.date)}</label><label><input type="radio" name="scope" value="all"> ${custom ? 'Every time it repeats' : 'Every ' + DAYS[dow].name}</label>` : '';
  const days = isNew ? [] : custom ? (custom.days || []) : [];
  $('bdDaysBoxes').innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" ${days.includes(i) ? 'checked' : ''}> ${d.key}</label>`).join('');
  const syncDays = () => $('bdDays').hidden = !(isNew || (custom && (custom.date || (f.scope && f.scope.value === 'all'))));
  $('bdScope').onchange = syncDays; syncDays();
  $('bdDup').hidden = isNew; $('bdDelete').hidden = isNew; $('bdReset').hidden = isNew || !b.edited;
  $('bdHint').textContent = isNew || custom ? 'Your own blocks sit on top of the plan and don’t push other blocks. When blocks overlap, the now-bar shows yours.'
    : 'Changing the start or end slides the blocks after it. Anchored blocks (prayers, work, bedtime) stay put, and the dashed buffer absorbs the difference.';
  $('blockDlg').showModal();
}
$('blockDlg').addEventListener('close', () => {
  const v = $('blockDlg').returnValue, f = $('blockForm').elements, { b, isNew, custom } = dlgBlock; $('blockDlg').returnValue = '';
  if (!v || v === 'cancel') return;
  const scope = f.scope ? f.scope.value : 'date';
  const days = [...$('bdDaysBoxes').querySelectorAll('input:checked')].map(i => Number(i.value));
  const vals = { name:f.name.value.trim() || b.name, cat:f.cat.value, start:toMin(f.start.value), end:toMin(f.end.value), note:f.note.value.trim() };
  const now = new Date().toISOString();
  const target = () => scope === 'all' && !b.custom ? plan.overrides.weekly : (plan.overrides.dated[b.date] ||= {});
  const wholeCustom = custom && (custom.date || scope === 'all');   // edit the custom block itself, not one occurrence

  if (isNew){ plan.customBlocks.push({ id:'c-' + uid(), ...vals, days, date:days.length ? null : b.date, updatedAt:now }); toast('Block added', vals.cat); }
  else if (v === 'save'){
    if (wholeCustom) Object.assign(custom, vals, { days, date:days.length ? null : (custom.date || b.date), updatedAt:now });
    else {
      // Store only what changed, so untouched times keep sliding with the chain.
      const o = {};
      for (const k of ['name','cat','note']) if (vals[k] !== b[k]) o[k] = vals[k];
      if (vals.start !== b.start % 1440) o.start = vals.start;
      if (vals.end !== b.end % 1440) o.end = vals.end;
      const tg = target(); tg[b.id] = { ...tg[b.id], ...o };
    }
  }
  else if (v === 'delete'){
    if (wholeCustom){ if (!confirm(`Delete “${b.name}” everywhere?`)) return; plan.customBlocks = plan.customBlocks.filter(c => c !== custom); }
    else { const tg = target(); tg[b.id] = { ...tg[b.id], hidden:true }; }
    toast(`Deleted ${scope === 'all' ? 'every week' : 'on ' + dayLabel(b.date)}. “Remove all block edits” in Settings brings it back.`);
  }
  else if (v === 'reset'){
    if (scope === 'all') delete plan.overrides.weekly[b.id]; else if (plan.overrides.dated[b.date]) delete plan.overrides.dated[b.date][b.id];
  }
  else if (v === 'dup'){
    plan.customBlocks.push({ id:'c-' + uid(), name:vals.name, cat:vals.cat, start:b.end % 1440, end:(b.end + b.min) % 1440, note:vals.note, days:[], date:b.date, updatedAt:now });
    toast('Duplicated right after the original. Tap it to adjust.', vals.cat);
  }
  changed('customBlocks', 'overrides');
});

/* ---------- Budget (original) ---------- */
function renderBudget(){
  const totals = {};
  for (let i = 0; i < 7; i++) visible(buildDay(plan, dateFor(i))).forEach(b => { totals[b.cat] = (totals[b.cat] || 0) + b.min; });
  const rows = [...BUDGET, ...Object.keys(totals).filter(k => !BUDGET.some(([c]) => c === k)).map(k => [k, null])];
  let t1 = 0, t2 = 0; const trim = x => x.toFixed(2).replace(/\.?0+$/, '');
  $('budgetBody').innerHTML = rows.map(([c, target]) => {
    const h = (totals[c] || 0) / 60; t2 += h; if (target != null) t1 += target;
    const diff = target == null ? null : h - target, cls = diff == null ? '' : (diff < -0.05 ? 'neg' : diff > 0.05 ? 'pos' : '');
    return `<tr><td><span class="dot" style="${colorVars(c)}"></span>${esc(cat(c).label)}</td><td>${target == null ? '–' : trim(target)}</td><td>${trim(h)}</td><td class="${cls}">${diff == null ? '' : (diff > 0 ? '+' : '') + trim(diff)}</td></tr>`;
  }).join('');
  $('bT1').textContent = t1.toFixed(1); $('bT2').textContent = t2.toFixed(1);
  const tot = k => (totals[k] || 0) / 60, waking = 168 - tot('Sleep');
  const hard = (tot('Offset') + tot('Spare')) / waking, slack = (tot('Offset') + tot('Spare') + tot('Leisure') + tot('Rest') + tot('Social')) / waking;
  $('kpis').innerHTML =
    `<div class="kpi"><b>${waking.toFixed(1)}</b><span>waking hours a week</span></div>` +
    `<div class="kpi"><b>${Math.round(hard*100)}%</b><span>hard buffer: offsets and spare</span></div>` +
    `<div class="kpi"><b>${Math.round(slack*100)}%</b><span>total slack, adding leisure, rest and social</span></div>`;
}

/* ---------- Settings (original fields + notifications, block types, data) ---------- */
const FIELDS = [
  {group:'Prayer times', hint:'Approximate for Mansoura in mid-September 2026. Update them from your app or mosque each month; everything below moves with them.',
   items:[['fajr','Fajr'],['dhuhr','Dhuhr'],['asr','Asr'],['maghrib','Maghrib'],['isha','Isha']], type:'time'},
  {group:'Sleep', hint:'7.5 h on work nights, 8.5 h before a day off.',
   items:[['wakeWork','Wake, workday'],['bedWork','Lights out before a workday'],['wakeOff','Wake, day off'],['bedOff','Lights out before a day off']], type:'time'},
  {group:'Work', hint:'Remote, Sunday to Thursday.', items:[['workStart','Starts'],['workEnd','Ends']], type:'time'},
  {group:'Gym slot on workdays', hint:'Afternoon: gym after azkar and lunch, startup after Isha, and a spare block before bed. Evening: startup after lunch in daylight, a longer gym after Isha, no spare block.', type:'toggle'},
  {group:'Block lengths, in minutes', hint:'The startup and learning lengths are the main dials for how much slack the day has.',
   items:[['prayer','Prayer, each'],['azkar','Azkar, morning and evening'],['quran','Quran study'],['lunch','Lunch'],['dinner','Dinner'],['breakfast','Breakfast, days off'],
          ['familyLunch','Friday family lunch'],['jumuah','Jumu\'ah, including going'],['jumuahPrep','Leave for Jumu\'ah, before Dhuhr'],['gymMax','Gym, maximum'],
          ['learnWork','Learning, workday'],['startupWork','Startup, workday'],['startupSat','Startup, Saturday morning'],['learnSat','Learning, Saturday'],['readFri','Reading, Friday'],
          ['nap','Friday rest'],['leisure','Leisure'],['planning','Weekly review'],['windDown','Wind-down'],['offsetWork','Offset after work'],['offsetShort','Short offset']], type:'number'},
];
function renderSettings(){
  const f = $('settingsForm'); f.innerHTML = '';
  FIELDS.forEach(g => {
    const fs = document.createElement('fieldset');
    fs.innerHTML = `<legend>${g.group}</legend><p>${g.hint}</p>`;
    if (g.type === 'toggle'){
      const seg = document.createElement('div'); seg.className = 'seg';
      ['afternoon','evening'].forEach(v => { const b = document.createElement('button'); b.textContent = v[0].toUpperCase() + v.slice(1);
        b.setAttribute('aria-pressed', plan.settings.gymSlot === v); b.onclick = () => update('gymSlot', v); seg.appendChild(b); });
      fs.appendChild(seg);
    } else {
      const grid = document.createElement('div'); grid.className = 'grid';
      g.items.forEach(([k, label]) => {
        const l = document.createElement('label'); l.textContent = label;
        const inp = document.createElement('input'); inp.type = g.type; inp.value = plan.settings[k];
        if (g.type === 'number'){ inp.min = 0; inp.step = 5; inp.inputMode = 'numeric'; }
        inp.onchange = () => { const v = g.type === 'number' ? Math.max(0, Number(inp.value) || 0) : inp.value; if (v === '') return; update(k, v); };
        l.appendChild(inp); grid.appendChild(l);
      });
      fs.appendChild(grid);
    }
    f.appendChild(fs);
  });
  renderCats(); renderNotifyStatus(); renderBackup();
}
function update(k, v){ plan.settings = {...plan.settings, [k]: v}; changed('settings'); renderSettings(); }
$('reset').onclick = () => { if (!confirm('Reset prayer times, sleep, work and block lengths to the original plan? Tasks and block edits are kept.')) return; plan.settings = {...DEFAULTS}; changed('settings'); renderSettings(); };
$('resetEdits').onclick = () => {
  if (!confirm('Remove every edit to the generated blocks (moves, renames, deletions) and delete your own blocks? Tasks linked to your own blocks stay, marked “Removed block”.')) return;
  plan.overrides = { weekly:{}, dated:{} }; plan.customBlocks = []; changed('overrides', 'customBlocks');
};

// Block types: color, label, reminder on/off, lead minutes
function renderCats(){
  const box = $('cats'); box.innerHTML = '<div class="cat head"><span>Color</span><span>Name</span><span>Remind</span><span>Minutes</span><span></span></div>';
  const used = new Set(plan.customBlocks.map(c => c.cat));
  for (const [k, c] of Object.entries(plan.categories)){
    const row = document.createElement('div'); row.className = 'cat';
    row.innerHTML = `<input type="color" value="${c.color}" aria-label="${esc(c.label)} color"><input type="text" value="${esc(c.label)}" maxlength="30" aria-label="Name">` +
      `<label><input type="checkbox" ${c.remind ? 'checked' : ''}> on</label><input type="number" min="0" max="240" value="${c.lead}" list="leads" aria-label="Minutes before" ${c.remind ? '' : 'disabled'}>` +
      (DEFAULT_CATEGORIES[k] || used.has(k) ? '<span></span>' : `<button class="x" aria-label="Delete ${esc(c.label)}" title="Delete">×</button>`);
    const [color, label, remLbl, lead, del] = row.children, rem = remLbl.firstChild;
    color.onchange = () => { c.color = color.value; changed('categories'); };
    label.onchange = () => { c.label = label.value.trim() || k; changed('categories'); };
    rem.onchange = () => { c.remind = rem.checked; lead.disabled = !rem.checked; changed('categories'); };
    lead.onchange = () => { c.lead = Math.max(0, Math.min(240, Number(lead.value) || 0)); changed('categories'); };
    if (del.tagName === 'BUTTON') del.onclick = () => { delete plan.categories[k]; changed('categories'); renderCats(); };
    box.appendChild(row);
  }
}
$('newCatAdd').onclick = () => {
  const name = $('newCatName').value.trim(); if (!name) return;
  const key = name.replace(/[^\p{L}\p{N}]+/gu, '') || 'Type' + uid();
  if (plan.categories[key]) return toast('That block type already exists.');
  plan.categories[key] = { label:name, color:$('newCatColor').value, remind:true, lead:10 };
  $('newCatName').value = ''; changed('categories'); renderCats();
};

// Reminders: Web Push from the server (notify.js Push, supabase/functions/tick)
async function renderNotifyStatus(){
  const perm = Push.permission(), ok = Push.supported() && isSecureContext;
  pushOn = ok && perm === 'granted' && !!(await Push.current());
  const until = Sync.meta.lastMat ? ` Scheduled until ${addDays(new Date(Sync.meta.lastMat), HORIZON_DAYS - 1).toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'})}; opening the app on any device extends it.` : '';
  let msg, cls = '';
  if (Push.needsInstall()) msg = 'On iPhone and iPad, reminders need the Home Screen app: Share → Add to Home Screen, open the planner from that icon, then turn them on here.';
  else if (!ok) msg = !isSecureContext ? 'Reminders need the planner on https:// or http://localhost.' : 'This browser can’t receive push reminders.';
  else if (!Sync.user) msg = 'Sign in (Account and sync, below) to turn on reminders. The server sends them, so they arrive even when the planner is closed and the phone is locked.';
  else if (perm === 'denied') { msg = 'Blocked in the browser. Allow notifications for this site in the browser’s site settings, then reload.'; cls = 'bad'; }
  else if (pushOn) { msg = 'On for this device. Reminders arrive even when the planner is closed.' + until; cls = 'ok'; }
  else msg = 'Off on this device. Turn them on for each phone or computer that should ring.';
  $('notifyStatus').textContent = msg; $('notifyStatus').className = 'status ' + cls;
  $('notifyEnable').hidden = pushOn; $('notifyOff').hidden = $('notifyTest').hidden = !pushOn;
  $('notifyEnable').disabled = !ok || !Sync.user || perm === 'denied' || Push.needsInstall();
}
const pushAction = (fn, done) => async () => {
  try { await fn(); if (done) toast(done, null, 6000); } catch (e) { toast('Reminders: ' + (e.message || e), null, 6000); }
  renderNotifyStatus(); tick(true);
};
$('notifyEnable').onclick = pushAction(() => Push.enable(), 'Reminders on for this device');
$('notifyOff').onclick = pushAction(() => Push.disable(), 'Reminders off for this device');
$('notifyTest').onclick = pushAction(() => Push.test(), 'Test sent to the server. It should arrive within a minute. Try closing the planner first.');
// A push arrived while the planner is open: also show it in the app.
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'reminder') toast(e.data.title, null, 10000); });

$('jsonExport').onclick = () => {
  download(Sync.backup(), `planner_${isoDate(new Date())}.json`, 'application/json');
  prefs.lastExport = new Date().toISOString(); save('prefs'); renderBackup();
};
$('jsonImport').onclick = () => $('jsonFile').click();
$('jsonFile').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (!confirm(`Import ${file.name}? Records newer than yours replace them; nothing newer on this device is lost.`)) return;
  try { const n = await Sync.restore(await file.text()); load(Sync.state()); renderSettings(); renderAll(); toast(`Imported ${n} change${n === 1 ? '' : 's'}`); }
  catch (err) { alert('Import failed: ' + err.message); }
};
function renderBackup(){
  $('storeMode').textContent = { indexeddb:'IndexedDB' + (Sync.persisted ? ', protected from clean-up' : ''), memory:'memory only: nothing is saved!' }[Sync.mode];
  $('lastBackup').textContent = prefs.lastExport ? 'Last export ' + new Date(prefs.lastExport).toLocaleDateString('en-GB', {day:'numeric', month:'short'}) : 'Never exported';
  renderAccount();
}

// Account & sync
function renderAccount(){
  const on = Sync.configured(), u = Sync.user, n = Sync.pending();
  $('acctOut').hidden = !on || !!u; $('acctIn').hidden = !u;
  let msg, cls = '';
  if (!on) msg = 'Sync isn’t set up: data stays on this device. Fill in js/config.js to turn it on (see README).';
  else if (!Sync.client) msg = Sync.error || 'Connecting…';
  else if (!u) msg = 'Signed out. Everything is saved on this device and uploads when you sign in.';
  else if (Sync.error) { msg = 'Sync problem: ' + Sync.error + (n ? ` (${n} change${n > 1 ? 's' : ''} waiting)` : ''); cls = 'bad'; }
  else { msg = `Signed in as ${u.email}. ` + (n ? `${n} change${n > 1 ? 's' : ''} waiting to upload.` : 'All synced' + (Sync.meta.lastSync ? ', ' + new Date(Sync.meta.lastSync).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '') + '.'); cls = 'ok'; }
  $('acctStatus').textContent = msg; $('acctStatus').className = 'status ' + cls;
}
$('acctSend').onclick = async () => {
  const email = $('acctEmail').value.trim(); if (!email) return;
  const { error } = await Sync.signIn(email);
  toast(error ? 'Could not send: ' + error.message : 'Check your email for the sign-in link', null, 6000);
};
$('acctSync').onclick = () => Sync.syncNow();
$('acctSignOut').onclick = () => Sync.signOut();

/* ---------- navigation ---------- */
// Tabs: Now · Plan (Day/Week toggle) · Tasks · Stats. Settings opens from the gear.
const VIEWS = ['now','day','week','tasks','budget','settings'];
let planMode = 'day';
function show(view){
  if (view === 'plan') view = planMode;
  if (view === 'day' || view === 'week') planMode = view;
  const tab = view === 'day' || view === 'week' ? 'plan' : view;
  document.querySelectorAll('nav [role=tab]').forEach(x => x.setAttribute('aria-selected', x.dataset.view === tab));
  document.querySelectorAll('#planSeg button').forEach(x => x.setAttribute('aria-pressed', x.dataset.plan === view));
  $('planSeg').hidden = tab !== 'plan'; $('gear').setAttribute('aria-pressed', view === 'settings');
  VIEWS.forEach(v => $('view-' + v).hidden = v !== view);
  window.scrollTo(0, 0);
  $('wrap').classList.toggle('wide', view === 'week');
  if (view === 'day') renderDay(); if (view === 'tasks') renderTasks(); if (view === 'settings') renderNotifyStatus();
  try { sessionStorage.setItem('view', view); } catch (e) {}
}
document.querySelectorAll('nav [role=tab]').forEach(b => b.onclick = () => show(b.dataset.view));
document.querySelectorAll('#planSeg button').forEach(b => b.onclick = () => show(b.dataset.plan));
$('gear').onclick = () => show($('view-settings').hidden ? 'settings' : 'now');

function renderAll(){ renderDay(); renderWeek(); renderBudget(); renderTasks(); tick(true); }

/* ---------- the tick: now-bar, dashboard, reminders ----------
   Runs every 15 s and whenever the page becomes visible again. Everything is
   recomputed from the clock each time, so date changes, sleep/wake and time zone
   changes fix themselves on the next tick. */
// Page background: current block color fading into the next block's. Weaker for dark colors and in dark mode so text keeps its contrast.
const darkMode = matchMedia('(prefers-color-scheme: dark)');
darkMode.onchange = () => tick(true);
function paintBackground(st){
  const b = document.body.style, c = st.current && cat(st.current.cat), n = st.next && cat(st.next.cat);
  const mix = (x, strong) => !x || x.dashed ? '0%' : darkMode.matches ? (strong ? '22%' : '8%') : inkOn(x.color) === '#FFFFFF' ? (strong ? '25%' : '10%') : (strong ? '55%' : '20%');
  b.setProperty('--bgc', c && !c.dashed ? c.color : 'transparent'); b.setProperty('--mixa', mix(c, true));
  b.setProperty('--bgn', n && !n.dashed ? n.color : c && !c.dashed ? c.color : 'transparent'); b.setProperty('--mixb', n && !n.dashed ? mix(n, false) : mix(c, false));
}
function tick(force){
  const now = Date.now(), iso = isoDate(new Date(now));
  if (iso !== lastIso){ lastIso = iso; selected = todayIdx(); weekOffset = 0; keptOverdue.clear(); return renderAll(); }
  const st = status(plan, now);
  renderNowbar(st, now); paintBackground(st);
  const key = st.current ? st.current.id + st.current.date : '';
  if (key !== curKey){ curKey = key; if (!$('view-day').hidden) renderDay(); if (!$('view-tasks').hidden) renderTasks(); }
  const sig = [key, st.next?.id, Math.floor(now / 60000), version, pushOn].join('|');
  if (force || sig !== dashSig){ dashSig = sig; renderDash(st, now); }
  positionNow();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(true); });
window.addEventListener('focus', () => tick(true));

/* ---------- boot ---------- */
(async () => {
  await Sync.open();
  const migrated = await Sync.migrateV2();
  load(Sync.state());
  prefs = { ...prefs, ...(Sync.meta.prefs || {}) };
  if (migrated) toast('Brought over your data from the previous version.');

  Sync.onRemote = st => { load(st); version++; renderAll(); if (!$('view-settings').hidden) renderSettings(); };
  Sync.onStatus = () => { renderAccount(); renderNotifyStatus(); };
  Sync.connect();
  window.addEventListener('online', () => Sync.syncNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Sync.syncNow(); });

  // Service worker: offline use, installability, notifications on Android.
  if ('serviceWorker' in navigator && isSecureContext && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  renderSettings(); renderAll();
  let v = 'now'; try { v = sessionStorage.getItem('view') || 'now'; planMode = v === 'week' ? 'week' : 'day'; } catch (e) {}
  show(VIEWS.includes(v) ? v : 'now');
  setInterval(tick, 15000);
})();
