/* =====================================================================
   template-ui.js: the week template editor (Plan → Edit week template)
   and its step dialog. Loaded after ui.js and uses its globals.
   Edits go to a draft; Save writes plan.template. Shared durations are
   settings, so they save right away and are not part of the draft.
   ===================================================================== */
const ANCHORS = { fajr:'Fajr', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha', wakeWork:'Wake (workday)', wakeOff:'Wake (day off)',
  bedWork:'Bedtime (workday)', bedOff:'Bedtime (day off)', workStart:'Work starts', workEnd:'Work ends' };
// The shared durations (the old Settings "Block lengths"): settings keys a step's length can point at with {ref}.
const LENGTHS = { prayer:'Prayer, each', azkar:'Azkar, morning and evening', quran:'Quran study', lunch:'Lunch', dinner:'Dinner', breakfast:'Breakfast, days off',
  familyLunch:'Friday family lunch', jumuah:'Jumu\'ah, including going', jumuahPrep:'Leave for Jumu\'ah, before Dhuhr', gymMax:'Gym, maximum',
  learnWork:'Learning, workday', startupWork:'Startup, workday', startupSat:'Startup, Saturday morning', learnSat:'Learning, Saturday', readFri:'Reading, Friday',
  nap:'Friday rest', leisure:'Leisure', planning:'Weekly review', windDown:'Wind-down', offsetWork:'Offset after work', offsetShort:'Short offset' };
let tDraft = null, tDay = new Date().getDay(), tSel = -1, tDirty = false, tGym = null, tS = null;
const tKey = () => DAYS[tDay].key, tSteps = () => tDraft[tKey()].steps;
const lenOf = x => typeof x === 'number' ? x : Number(tS[x.ref]) || 0;
const minusOf = at => (at?.minus || []).reduce((a, m) => a + lenOf(m), 0);

// "45 min", "until Maghrib", "up to 2 h · ends 10 min before Maghrib", "top up to 45 min", "until tomorrow’s wake"
function ruleText(st){
  const L = st.len == null ? '' : dur(lenOf(st.len)) + (typeof st.len === 'object' ? ` (${LENGTHS[st.len.ref] || st.len.ref})` : '');
  const A = st.at && (st.at.nextDay ? 'tomorrow’s ' + ANCHORS[st.at.anchor].replace(/ \(.*/, '').toLowerCase() : ANCHORS[st.at.anchor] || st.at.anchor);
  const m = minusOf(st.at), when = m ? `${dur(m)} before ${A}` : A;
  return { len:L, until:'until ' + when, cap:`up to ${L} · ends ${m ? when : 'by ' + A}`, atLeast:`at least ${L}, until ${when}`, rest:'top up to ' + L }[st.rule] || '';
}

// The draft day as it would run on that weekday this week (dated and weekly edits included). Sets tS for the labels.
function tPreview(){
  const date = addDays(new Date(), tDay - todayIdx());
  tS = norm(daySettings(plan, date));
  return chain(tKey(), tSteps().map(s => compileStep(s, tS)), overridesFor(plan, isoDate(date)));
}
// Every change to the draft goes through here. The first step must carry the day's start anchor and only the first.
function tEdit(fn){
  const s = tSteps(), s0 = s[0]?.start; fn(s);
  s.forEach((x, i) => { if (i) delete x.start; else x.start ||= s0 || 'wakeWork'; });
  tDirty = true; renderTemplate();
}

function renderTemplate(){
  if (!tDraft){ tDraft = structuredClone(plan.template || DEFAULT_TEMPLATE(plan.settings.gymSlot)); tDirty = false; tGym = null; tSel = -1; }
  $('tDays').innerHTML = DAYS.map((d, i) => `<button role="tab" data-i="${i}" aria-selected="${i === tDay}" aria-label="${d.name}">${d.key.slice(0, 2)}</button>`).join('');
  $('tLabel').value = tDraft[tKey()].label || '';
  const slot = tGym || plan.settings.gymSlot;
  $('tGym').innerHTML = ['afternoon', 'evening'].map(v => `<button type="button" data-g="${v}" aria-pressed="${slot === v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('');
  renderSteps(); renderLens();
}
function renderSteps(){
  const steps = tSteps(), bl = tPreview(), wk = plan.overrides.weekly;
  const bed = steps.map(s => s.at?.anchor).find(a => /^bed/.test(a));   // the bedtime this day aims at
  $('tSteps').innerHTML = steps.map((st, i) => {
    const b = bl[i], warn = b.hidden ? '' : b.min <= 0 ? 'Squeezed to 0 min' : st.at?.nextDay && bed && b.start > tS[bed] ? `Day runs past bedtime (${fmt(tS[bed])})` : '';
    return `<li class="${i === tSel ? 'sel' : ''}" style="${colorVars(st.cat)}"><span class="dot"></span>` +
      `<button type="button" class="st" data-i="${i}" aria-label="Edit ${esc(st.name)}"><b>${esc(st.name)}</b>` +
      `<span class="tm">${b.hidden ? 'Hidden by an edit' : fmtRange(b.start, b.end) + ' · ' + dur(b.min)}</span><span class="rl">${esc(ruleText(st))}</span>` +
      (warn ? `<span class="warn">⚠ ${warn}</span>` : '') + '</button>' +
      `<span class="mv"><button type="button" data-mv="${i}" data-d="-1" aria-label="Move ${esc(st.name)} up" ${i ? '' : 'disabled'}>↑</button>` +
      `<button type="button" data-mv="${i}" data-d="1" aria-label="Move ${esc(st.name)} down" ${i < steps.length - 1 ? '' : 'disabled'}>↓</button></span>` +
      (wk[b.id] ? `<span class="wkly">Edited every ${DAYS[tDay].name} <button type="button" data-clear="${esc(b.id)}" aria-label="Clear the weekly edit of ${esc(st.name)}">Clear</button></span>` : '') + '</li>';
  }).join('');
  $('tSave').disabled = !tDirty; $('tState').textContent = tDirty ? 'Unsaved changes' : '';
}
function renderLens(){
  const all = Object.values(tDraft).flatMap(d => d.steps);
  const uses = k => all.filter(s => s.len?.ref === k || (s.at?.minus || []).some(m => m.ref === k)).length;
  $('tLenGrid').innerHTML = Object.entries(LENGTHS).map(([k, l]) => { const n = uses(k);
    return `<label><span>${esc(l)}<small>${n ? `used by ${n} block${n > 1 ? 's' : ''}` : 'not used'}</small></span><input type="number" min="0" max="1440" step="5" inputmode="numeric" data-k="${k}" value="${plan.settings[k] ?? DEFAULTS[k]}"></label>`; }).join('');
}

$('tDays').onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; tDay = +b.dataset.i; tSel = -1; $('tCopyBox').hidden = true; renderTemplate(); };
$('tLabel').oninput = () => { tDraft[tKey()].label = $('tLabel').value; tDirty = true; $('tSave').disabled = false; $('tState').textContent = 'Unsaved changes'; };
$('tSteps').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.i) return openStepDlg(+b.dataset.i);
  if (b.dataset.clear){ delete plan.overrides.weekly[b.dataset.clear]; changed('overrides'); return renderSteps(); }
  const i = +b.dataset.mv, d = +b.dataset.d; tSel = i + d;
  tEdit(s => s.splice(i + d, 0, s.splice(i, 1)[0]));
  $('tSteps').querySelector(`[data-mv="${i + d}"][data-d="${d}"]:not(:disabled)`)?.focus();   // keep the keyboard on the moved row
};
$('tLenGrid').onchange = e => { const k = e.target.dataset.k; plan.settings = { ...plan.settings, [k]:Math.max(0, Number(e.target.value) || 0) }; changed('settings'); renderSteps(); };
$('tGym').onclick = e => {
  const v = e.target.closest('[data-g]')?.dataset.g;
  if (!v || !confirm(`Workday gym in the ${v}: Sunday to Thursday go back to the default week for that slot. This replaces your edits on workdays.`)) return;
  const d = DEFAULT_TEMPLATE(v); for (const k of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu']) tDraft[k] = d[k];
  tGym = v; tSel = -1; tDirty = true; renderTemplate();
};
$('tAdd').onclick = () => openStepDlg(null);
$('tReset').onclick = () => {
  if (!confirm(`Put ${DAYS[tDay].name} back to the default day? Your changes to it are replaced.`)) return;
  tDraft[tKey()] = DEFAULT_TEMPLATE(tGym || plan.settings.gymSlot)[tKey()]; tSel = -1; tDirty = true; renderTemplate();
};
$('tCopy').onclick = () => {
  const box = $('tCopyBox'); box.hidden = !box.hidden; $('tCopy').setAttribute('aria-expanded', !box.hidden);
  if (!box.hidden){ dayPick($('tCopyDays'), []); $('tCopyDays').querySelector(`[data-d="${tDay}"]`).disabled = true; }
};
$('tCopyGo').onclick = () => {
  const to = pickedDays($('tCopyDays')).filter(i => i !== tDay); if (!to.length) return toast('Pick the days to copy to.');
  if (!confirm(`Replace the blocks of ${to.map(i => DAYS[i].name).join(', ')} with ${DAYS[tDay].name}’s?`)) return;
  for (const i of to) tDraft[DAYS[i].key].steps = structuredClone(tSteps());   // the label stays: it describes that day
  $('tCopyBox').hidden = true; $('tCopy').setAttribute('aria-expanded', false); tDirty = true; renderTemplate();
  toast(`Copied to ${to.map(i => DAYS[i].key).join(', ')}. Save to keep it.`);
};
$('tSave').onclick = () => {
  if (tGym) plan.settings = { ...plan.settings, gymSlot:tGym };
  plan.template = tDraft; tDirty = false; selected = tDay;
  changed('template', ...(tGym ? ['settings'] : [])); show('day'); toast('Week template saved');
};
$('tCancel').onclick = $('tBack').onclick = () => show('day');
$('tmplEdit').onclick = $('tmplFromSettings').onclick = () => { tDay = selected; show('template'); };
// show() asks this before leaving the editor.
function leaveTemplate(){
  if (tDirty && !confirm('Discard your changes to the week template?')) return false;
  tDraft = null; tDirty = false; return true;
}
addEventListener('beforeunload', e => { if (tDirty) e.preventDefault(); });

/* ---------- step dialog ---------- */
let dlgStep = null;
function openStepDlg(i){
  const steps = tSteps(), isNew = i == null, at = isNew ? (tSel >= 0 ? tSel + 1 : Math.max(1, steps.length - 1)) : i;   // new: after the selected row, else before Sleep
  const st = isNew ? { id:'u-' + uid(), name:'', cat:Object.keys(plan.categories).find(k => !cat(k).dashed), kind:'Flex', rule:'len', len:30 } : steps[i];
  if (!isNew){ tSel = i; renderSteps(); }
  dlgStep = { st, isNew, at };
  const f = $('stepForm').elements, opts = o => Object.entries(o).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('');
  $('sdTitle').textContent = isNew ? 'New block' : 'Edit block';
  f.cat.innerHTML = opts(Object.fromEntries(Object.entries(plan.categories).map(([k, c]) => [k, c.label]))) +
    (plan.categories[st.cat] ? '' : `<option value="${esc(st.cat)}">${esc(st.cat)}</option>`) + '<option value="__new">New type…</option>';
  f.anchor.innerHTML = f.start.innerHTML = opts(ANCHORS);
  f.lenRef.innerHTML = '<option value="">Its own number of minutes</option>' + Object.entries(LENGTHS).map(([k, l]) => `<option value="${k}">${esc(l)} (${dur(Number(tS[k]) || 0)})</option>`).join('');
  f.of.innerHTML = steps.filter(s => s !== st).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  f.name.value = st.name; f.cat.value = st.cat; f.kind.value = st.kind; f.note.value = st.note || ''; f.newCat.value = '';
  f.start.value = st.start || 'wakeWork'; f.rule.value = st.rule;
  f.lenRef.value = st.len?.ref || ''; f.lenMin.value = st.len == null ? 30 : lenOf(st.len);
  f.anchor.value = st.at?.anchor || 'maghrib'; f.minus.value = minusOf(st.at); f.nextDay.checked = !!st.at?.nextDay;
  f.of.value = st.of || steps[at - 1]?.id || '';
  $('sdFirst').hidden = isNew || i !== 0; $('sdDelete').hidden = isNew || steps.length < 2;
  syncStepFields(); $('stepDlg').showModal();
}
function syncStepFields(){
  const f = $('stepForm').elements, r = f.rule.value;
  $('stepForm').querySelectorAll('[data-r]').forEach(el => el.hidden = !el.dataset.r.split(' ').includes(r));
  if (f.lenRef.value) $('sdOwn').hidden = true;
  $('sdNew').hidden = f.cat.value !== '__new';
}
$('stepForm').onchange = syncStepFields;
$('stepDlg').addEventListener('close', () => {
  const v = $('stepDlg').returnValue, f = $('stepForm').elements, { st, isNew, at } = dlgStep; $('stepDlg').returnValue = '';
  if (v === 'delete'){
    if (confirm(`Delete “${st.name}” from ${DAYS[tDay].name}? Tasks linked to it stay, marked “Removed block”.`)){ tSel = -1; tEdit(s => s.splice(s.indexOf(st), 1)); }
    return;
  }
  if (v !== 'save') return;
  let c = f.cat.value;
  if (c === '__new') c = f.newCat.value.trim() ? newCategory(f.newCat.value.trim(), '#F4B183', true) : st.cat;
  const rule = f.rule.value, minus = Math.max(0, Number(f.minus.value) || 0), timed = rule === 'until' || rule === 'cap' || rule === 'atLeast';
  // Spread over the old step: the id stays (tasks and edits key on it) and an unchanged step compares equal.
  const out = { ...st, name:f.name.value.trim() || st.name || 'Block', cat:c, kind:f.kind.value, note:f.note.value.trim() || undefined, rule,
    start:st.start && f.start.value,
    len:rule === 'until' ? undefined : f.lenRef.value ? { ref:f.lenRef.value } : Math.max(0, Number(f.lenMin.value) || 0),
    at:timed ? { anchor:f.anchor.value, ...(minus ? { minus:minus === minusOf(st.at) && st.at?.minus ? st.at.minus : [minus] } : {}), ...(rule === 'until' && f.nextDay.checked ? { nextDay:true } : {}) } : undefined,
    of:rule === 'rest' ? f.of.value : undefined };
  for (const k in out) if (out[k] === undefined || out[k] === '') delete out[k];
  if (!isNew && JSON.stringify(out) === JSON.stringify(st)) return;
  if (isNew) tSel = at;
  tEdit(s => s.splice(isNew ? at : s.indexOf(st), isNew ? 0 : 1, out));
});
