/* =====================================================================
   excel.js: Excel import / export (ExcelJS, vendored in /vendor and
   loaded only when needed).

   Workbook layout (see README.md):
     Settings    same cells as the original workbook (B5 = Fajr ... B45 = gym slot)
     Categories  block types: key, label, color, reminder, lead minutes
     Blocks      your custom blocks (recurring weekdays or one date)
     Overrides   edits to single occurrences / every-week edits
     Tasks       all tasks with their assignments
     BlockDone   which blocks you ticked off
     Schedule    two-week report, colored. Export only, never imported.

   Import reads whichever of these sheets exist. The original
   flexible_weekly_planner.xlsx therefore imports as settings only.
   Missing sheets leave your data untouched.
   ===================================================================== */
const SETTINGS_ROWS = [
  ['fajr',5,'Fajr'],['dhuhr',6,'Dhuhr'],['asr',7,'Asr'],['maghrib',8,'Maghrib'],['isha',9,'Isha'],
  ['wakeWork',12,'Wake — workday'],['bedWork',13,'Lights out — night before a workday'],['wakeOff',14,'Wake — day off (no alarm)'],['bedOff',15,'Lights out — night before a day off'],
  ['workStart',18,'Work start'],['workEnd',19,'Work end'],
  ['prayer',22,'Prayer (each)'],['jumuah',23,"Jumu'ah incl. going to the mosque"],['jumuahPrep',24,"Leave for Jumu'ah (min before Dhuhr)"],['azkar',25,'Azkar (morning / evening)'],
  ['quran',26,'Quran study'],['lunch',27,'Lunch'],['dinner',28,'Dinner'],['breakfast',29,'Breakfast (days off)'],['familyLunch',30,'Friday family lunch'],
  ['gymMax',31,'Gym — maximum'],['learnWork',32,'Learning — workday'],['startupWork',33,'Startup — workday'],['startupSat',34,'Startup — Saturday morning'],
  ['learnSat',35,'Learning — Saturday'],['readFri',36,'Reading — Friday'],['nap',37,'Friday rest / nap'],['leisure',38,'Leisure (bounded)'],
  ['planning',39,'Weekly review (Saturday)'],['windDown',40,'Wind-down, screens off'],['offsetWork',41,'Offset after work'],['offsetShort',42,'Short offset'],
  ['gymSlot',45,'Gym slot on workdays'],
];
const LINK_WORDS = { none:'Inbox', block:'Block', cat:'Block type', day:'Day', period:'Period' };
const DAY_KEYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function loadExcelJS(){
  if (window.ExcelJS) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/exceljs.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load vendor/exceljs.min.js')); document.head.appendChild(s); });
}

/* ---------- cell value helpers (Excel gives numbers, Dates, strings, formulas or rich text) ---------- */
const cellVal = v => v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map(r => r.text).join('') : null)) : v;
function cellToMin(v){
  v = cellVal(v);
  if (v instanceof Date) return v.getUTCHours()*60 + v.getUTCMinutes() + (v.getUTCSeconds() >= 30 ? 1 : 0);   // Excel times arrive as 1899-12-30Txx:xxZ
  if (typeof v === 'number') return Math.round((v % 1) * 1440);
  if (typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v.trim())) return toMin(v.trim());
  return null;
}
function cellToISO(v){
  v = cellVal(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);   // Excel serial date
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim().slice(0, 10);
  return '';
}
const cellToBool = v => { v = cellVal(v); return v === true || /^(true|yes|y|1|on|x|✓)$/i.test(String(v ?? '').trim()); };
const cellToStr = v => { v = cellVal(v); return v == null ? '' : String(v).trim(); };
const argb = hex => 'FF' + hex.replace('#', '').toUpperCase();

// Rows of a sheet as objects keyed by the header in row 1 (case-insensitive).
function sheetRows(ws){
  const heads = [], out = [];
  ws.getRow(1).eachCell((c, i) => heads[i] = cellToStr(c.value).toLowerCase());
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const o = {}; let any = false;
    heads.forEach((h, i) => { if (!h) return; const v = row.getCell(i).value; o[h] = v; if (cellVal(v) != null && cellVal(v) !== '') any = true; });
    if (any) out.push(o);
  });
  return out;
}

/* ---------- export ---------- */
async function exportExcel(plan, tasks, blockDone){
  await loadExcelJS();
  const wb = new ExcelJS.Workbook(); wb.creator = 'Flexible planner';
  const bold = { bold:true, color:{argb:'FFFFFFFF'} }, headFill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1F3864'} };
  const table = (name, cols) => {
    const ws = wb.addWorksheet(name); ws.columns = cols.map(([header, width]) => ({ header, width: width || 14 }));
    ws.getRow(1).eachCell(c => { c.font = bold; c.fill = headFill; }); ws.views = [{ state:'frozen', ySplit:1 }];
    return ws;
  };
  const timeCell = (cell, min) => { cell.value = ((min % 1440) + 1440) % 1440 / 1440; cell.numFmt = 'hh:mm'; };
  const paint = (cell, cat) => { const c = plan.categories[cat]; if (!c) return; cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:argb(c.color)} }; cell.font = { color:{argb:argb(inkOn(c.color))} }; };

  // Settings: same row positions as the original workbook, so values can be pasted straight across.
  const s = wb.addWorksheet('Settings');
  s.getColumn(1).width = 42; s.getColumn(2).width = 12; s.getColumn(3).width = 14;
  s.getCell('A1').value = 'Flexible Weekly Planner — Settings'; s.getCell('A1').font = { bold:true, size:14 };
  s.getCell('A2').value = 'Same cells as the original workbook. Column C is the key the app uses.';
  [[4,'Prayer times'],[11,'Sleep'],[17,'Work'],[21,'Block lengths (minutes)'],[44,'Workday gym slot']].forEach(([r, t]) => { s.getCell('A'+r).value = t; s.getCell('A'+r).font = { bold:true }; });
  for (const [k, r, label] of SETTINGS_ROWS){
    s.getCell('A'+r).value = label; s.getCell('C'+r).value = k;
    if (TIME_KEYS.includes(k)) timeCell(s.getCell('B'+r), toMin(plan.settings[k])); else s.getCell('B'+r).value = k === 'gymSlot' ? plan.settings[k] : Number(plan.settings[k]);
    s.getCell('B'+r).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFF9E5'} };
  }
  s.dataValidations.add('B45', { type:'list', allowBlank:false, formulae:['"afternoon,evening"'] });

  const cats = table('Categories', [['Key',14],['Label',22],['Color',10],['Reminder',10],['Lead min',10],['Dashed',8]]);
  for (const [k, c] of Object.entries(plan.categories)){
    const r = cats.addRow([k, c.label, c.color, !!c.remind, c.lead, !!c.dashed]); paint(r.getCell(3), k);
  }

  const bl = table('Blocks', [['Id',14],['Name',30],['Category',14],['Start',8],['End',8],['Days',24],['Date',12],['Note',40]]);
  for (const c of plan.customBlocks){
    const r = bl.addRow([c.id, c.name, c.cat, null, null, (c.days || []).map(d => DAY_KEYS[d]).join(','), c.date || '', c.note || '']);
    timeCell(r.getCell(4), c.start); timeCell(r.getCell(5), c.end); paint(r.getCell(2), c.cat);
  }

  const ov = table('Overrides', [['Scope',8],['Date',12],['Block id',30],['Name',30],['Category',14],['Start',8],['End',8],['Hidden',8],['Note',40]]);
  const ovRow = (scope, date, id, o) => { const r = ov.addRow([scope, date, id, o.name || '', o.cat || '', null, null, !!o.hidden, o.note ?? '']);
    if (o.start != null) timeCell(r.getCell(6), o.start); if (o.end != null) timeCell(r.getCell(7), o.end); };
  for (const [id, o] of Object.entries(plan.overrides.weekly)) ovRow('weekly', '', id, o);
  for (const [date, m] of Object.entries(plan.overrides.dated)) for (const [id, o] of Object.entries(m)) ovRow('date', date, id, o);

  const tk = table('Tasks', [['Id',12],['Title',36],['Notes',30],['Priority',10],['Status',12],['Completed',10],['Due',12],['Estimate min',10],['Category',14],
    ['Link type',11],['Link date',12],['Link block id',26],['Link block name',26],['Link block type',14],['Link period',11],['Created',20],['Updated',20],['Completed at',20]]);
  for (const t of tasks){
    const l = t.link, b = l.type === 'block' ? buildDay(plan, parseISO(l.date)).find(x => x.id === l.blockId) : null;
    const r = tk.addRow([t.id, t.title, t.notes, t.priority, t.status, isDone(t), t.due || '', t.estimate ?? '', t.category,
      LINK_WORDS[l.type], l.date || '', l.blockId || '', b ? b.name : '', l.cat || (b && b.cat) || '', l.period || '', t.createdAt, t.updatedAt, t.completedAt || '']);
    if (l.cat || b) paint(r.getCell(l.cat ? 14 : 13), l.cat || b.cat);
  }
  tk.dataValidations.add('D2:D2000', { type:'list', allowBlank:true, formulae:['"' + PRIORITIES.join(',') + '"'] });
  tk.dataValidations.add('E2:E2000', { type:'list', allowBlank:true, formulae:['"' + STATUSES.join(',') + '"'] });
  tk.dataValidations.add('J2:J2000', { type:'list', allowBlank:true, formulae:['"' + Object.values(LINK_WORDS).join(',') + '"'] });
  tk.dataValidations.add('O2:O2000', { type:'list', allowBlank:true, formulae:['"morning,afternoon,evening"'] });

  const bd = table('BlockDone', [['Date',12],['Block id',30]]);
  for (const [date, ids] of Object.entries(blockDone)) for (const id of ids) bd.addRow([date, id]);

  // Report: this week and next, one row per block, colored by type.
  const sc = table('Schedule', [['Date',12],['Day',6],['Start',8],['End',8],['Min',6],['Block',40],['Category',16],['Type',8],['Done',6],['Tasks',40],['Note',50]]);
  const sun = addDays(new Date(), -new Date().getDay());
  for (let k = 0; k < 14; k++) for (const b of visible(buildDay(plan, addDays(sun, k)))){
    const tl = tasks.filter(t => inBlock(t, b)).map(t => (isDone(t) ? '✓ ' : '☐ ') + t.title).join('; ');
    const r = sc.addRow([b.date, DAY_KEYS[b.dow], null, null, b.min, b.name, plan.categories[b.cat]?.label || b.cat, b.type, (blockDone[b.date] || []).includes(b.id), tl, b.note]);
    timeCell(r.getCell(3), b.start); timeCell(r.getCell(4), b.end); paint(r.getCell(6), b.cat); paint(r.getCell(7), b.cat);
  }
  sc.getCell('M1').value = 'Report only: regenerated on every export, never imported.';

  return wb.xlsx.writeBuffer();
}

/* ---------- import ---------- */
async function importExcel(arrayBuffer, plan){
  await loadExcelJS();
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(arrayBuffer);
  const out = { found:[], warnings:[] }, ws = n => wb.getWorksheet(n);

  if (ws('Settings')){
    const s = ws('Settings'), settings = {};
    for (const [k, r] of SETTINGS_ROWS){
      const v = s.getCell('B'+r).value;
      if (TIME_KEYS.includes(k)){ const m = cellToMin(v); if (m != null) settings[k] = fromMin(m); else out.warnings.push(`Settings B${r} (${k}) is not a time; kept the current value.`); }
      else if (k === 'gymSlot'){ const g = cellToStr(v).toLowerCase(); if (g === 'afternoon' || g === 'evening') settings[k] = g; }
      else { const n = Number(cellVal(v)); if (Number.isFinite(n) && n >= 0) settings[k] = n; else out.warnings.push(`Settings B${r} (${k}) is not a number; kept the current value.`); }
    }
    out.settings = settings; out.found.push('Settings');
  }
  if (ws('Categories')){
    out.categories = {};
    for (const r of sheetRows(ws('Categories'))){
      const key = cellToStr(r.key); if (!key) continue;
      const color = cellToStr(r.color); const lead = Number(cellVal(r['lead min']));
      out.categories[key] = { label:cellToStr(r.label) || key, color:/^#[0-9a-f]{6}$/i.test(color) ? color : (plan.categories[key]?.color || '#CCCCCC'),
                              remind:cellToBool(r.reminder), lead:Number.isFinite(lead) ? lead : 10, ...(cellToBool(r.dashed) ? {dashed:true} : {}) };
    }
    out.found.push('Categories');
  }
  if (ws('Blocks')){
    out.customBlocks = [];
    for (const r of sheetRows(ws('Blocks'))){
      const start = cellToMin(r.start), end = cellToMin(r.end), name = cellToStr(r.name);
      if (!name || start == null || end == null){ out.warnings.push(`Blocks: skipped a row without name/start/end (${name || 'unnamed'}).`); continue; }
      const days = cellToStr(r.days).split(/[,\s]+/).map(d => DAY_KEYS.findIndex(k => k.toLowerCase() === d.slice(0,3).toLowerCase())).filter(i => i >= 0);
      out.customBlocks.push({ id:cellToStr(r.id) || 'c-' + uid(), name, cat:cellToStr(r.category) || 'Spare', start, end, days, date:cellToISO(r.date) || null, note:cellToStr(r.note), updatedAt:new Date().toISOString() });
    }
    out.found.push('Blocks');
  }
  if (ws('Overrides')){
    out.overrides = { weekly:{}, dated:{} };
    for (const r of sheetRows(ws('Overrides'))){
      const id = cellToStr(r['block id']); if (!id) continue;
      const o = {}, name = cellToStr(r.name), cat = cellToStr(r.category), st = cellToMin(r.start), en = cellToMin(r.end), note = cellToStr(r.note);
      if (name) o.name = name; if (cat) o.cat = cat; if (st != null) o.start = st; if (en != null) o.end = en; if (note) o.note = note; if (cellToBool(r.hidden)) o.hidden = true;
      const date = cellToISO(r.date);
      if (cellToStr(r.scope).toLowerCase() === 'weekly' || !date) out.overrides.weekly[id] = o; else (out.overrides.dated[date] ||= {})[id] = o;
    }
    out.found.push('Overrides');
  }
  if (ws('Tasks')){
    out.tasks = [];
    const words = Object.fromEntries(Object.entries(LINK_WORDS).map(([k, w]) => [w.toLowerCase(), k]));
    for (const r of sheetRows(ws('Tasks'))){
      const title = cellToStr(r.title); if (!title) continue;
      let type = cellToStr(r['link type']).toLowerCase(); type = words[type] || (LINK_WORDS[type] ? type : 'none');
      const date = cellToISO(r['link date']), link = { type };
      if (type === 'block'){
        link.date = date; link.blockId = cellToStr(r['link block id']);
        // Typed by hand in Excel? A block name plus a date is enough.
        if (!link.blockId && date){ const nm = cellToStr(r['link block name']).toLowerCase(); const b = visible(buildDay(plan, parseISO(date))).find(x => x.name.toLowerCase().startsWith(nm)); if (nm && b) link.blockId = b.id; }
        if (!date || !link.blockId){ out.warnings.push(`Task "${title}": block not found, put in the inbox.`); link.type = 'none'; delete link.date; delete link.blockId; }
      }
      if (type === 'cat') link.cat = cellToStr(r['link block type']);
      if (type === 'day' || type === 'period'){ if (date) link.date = date; else { out.warnings.push(`Task "${title}": no link date, put in the inbox.`); link.type = 'none'; } }
      if (type === 'period') link.period = PERIODS[cellToStr(r['link period']).toLowerCase()] ? cellToStr(r['link period']).toLowerCase() : 'morning';
      let status = cellToStr(r.status); if (!STATUSES.includes(status)) status = 'Not started';
      if (cellToBool(r.completed)) status = 'Completed';
      const priority = PRIORITIES.includes(cellToStr(r.priority)) ? cellToStr(r.priority) : 'Medium';
      const est = Number(cellVal(r['estimate min']));
      out.tasks.push(newTask({ id:cellToStr(r.id) || uid(), title, notes:cellToStr(r.notes), priority, status, due:cellToISO(r.due), estimate:Number.isFinite(est) && est > 0 ? est : null,
        category:cellToStr(r.category), link, createdAt:cellToStr(r.created) || new Date().toISOString(), updatedAt:cellToStr(r.updated) || new Date().toISOString(),
        completedAt:status === 'Completed' ? (cellToStr(r['completed at']) || new Date().toISOString()) : null }));
    }
    out.found.push('Tasks');
  }
  if (ws('BlockDone')){
    out.blockDone = {};
    for (const r of sheetRows(ws('BlockDone'))){ const d = cellToISO(r.date), id = cellToStr(r['block id']); if (d && id) (out.blockDone[d] ||= []).push(id); }
    out.found.push('BlockDone');
  }
  return out;
}

// Merge imported tasks by id: the newer updatedAt wins, and tasks only on this device are kept.
// ponytail: no delete propagation. A task deleted on one device comes back on import; a sync layer with tombstones fixes that.
function mergeTasks(local, incoming){
  const m = new Map(local.map(t => [t.id, t]));
  for (const t of incoming){ const l = m.get(t.id); if (!l || (t.updatedAt || '') >= (l.updatedAt || '')) m.set(t.id, t); }
  return [...m.values()];
}
