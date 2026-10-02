# Plan (not started): editable week template, targets and "Plan my week"

Plan only. Nothing here is implemented yet. Each phase below ships on its own, in order.

## Context
Today the week's **structure is hardcoded**: `workday()`, `friday()` and `saturday()` in `js/schedule.js` decide which blocks exist, in what order and of which type. You can only:
- tune lengths (Settings → Block lengths, 21 numbers) and the gym-slot toggle,
- edit occurrences (dated/weekly overrides),
- lay custom blocks on top (they don't push the chain).

There are no hours-per-type targets and nothing distributes them. You asked for both layers:
1. **An editable week template.** Choose which blocks each day has, their order, their type (including your own new types) and how long they run, while prayers, work and sleep stay anchored and the rest keeps sliding.
2. **Targets and "Plan my week".** Set weekly hours per block type. The planner spreads them over the free time and shows target against planned, then you accept or tweak.

The current week must come through unchanged, with the same blocks, times and **ids**. Tasks, done ticks, overrides, reminders and stats all key on ids like `Sun:gym`.

## Decisions (defaults; change any of them before implementing)
- **D1 Per-weekday lists.** Each of the 7 days has its own ordered list of blocks, plus "Copy this day to…". There are no shared "day kinds", because workdays already differ (the Learning/Reading alternation, Thursday's bedtime).
- **D2 Anchors stay in Settings.** Prayer times, wake, bed, and work start/end remain Settings values (prayer times can be automatic). Blocks refer to them by name.
- **D3 Shared durations stay.** A block's length is either its own number of minutes or a shared duration (e.g. "Prayer, each" used 35 times). Editing a shared duration updates every block that uses it, and any block can be switched to its own number. The Settings "Block lengths" section moves into the template editor; the gym-slot toggle becomes a "workday gym: afternoon/evening" preset in the editor.
- **D4 Overrides keep working.** The block dialog's "only this date" and "every <day>" edits still layer on top of the template, unchanged. The template editor marks rows that have weekly edits, with *Clear*.
- **D5 Auto blocks are marked.** Blocks created by "Plan my week" carry `auto:true`. Running it again replaces only auto blocks and never touches blocks you placed by hand.
- **D6 Targets live on block types.** Each type gets an optional hours/week target plus placement rules.
- **D7 No effective dates (ceiling).** A template change also changes how past weeks render, so past Stats shift. Upgrade path: a `since` date per template version.

---

## Phase T1: Template engine with no visible change (foundation)

**Data.** `plan.template = { Sun:{ label:'workday', steps:[…] }, …, Sat:{…} }`.

A step looks like:
```
{ id:'gym', name:'Gym', cat:'Gym', kind:'Fixed'|'Flex'|'Spare', note:'',
  start?: Anchor,                      // first step only (wake)
  rule: 'len'    → end = s + len
      | 'until'  → end = max(s, at)                     // "Offset before Maghrib", "Spare until Isha"
      | 'cap'    → end = min(s + len, at)               // "Gym, up to 2 h, ends 10 min before Maghrib"
      | 'atLeast'→ end = max(at, s + len)               // "Offset: at least 20 min, until Asr"
      | 'rest'   → end = s + max(0, len − minutes of step `of`)   // Learning part 2 tops up part 1
  len?: number | { ref:'<settings key>' },
  at?:  { anchor:'maghrib'|'isha'|'asr'|'dhuhr'|'fajr'|'wakeWork'|'wakeOff'|'bedWork'|'bedOff'|'workStart'|'workEnd',
          minus?: [number | {ref}], nextDay?: true },   // Sleep: until tomorrow's wake
  of?: '<step id>', auto?: true }
```
Every end function in the current builders maps to one of these rules. The trickiest, the evening gym (`min(s+gymMax, bed − windDown − leisure − dinner)`), is `cap` with `minus:[{ref:'windDown'},{ref:'leisure'},{ref:'dinner'}]`.

**Engine changes** (`js/schedule.js`):
- `DEFAULT_TEMPLATE(gymSlot)`: the current three builders rewritten as data, with both gym-slot variants, labels ("workday", "workday, weekend starts tonight", "day off") and notes. Step ids are the **exact current id suffixes**, the `slug(name)` with its `-2` duplicate suffix, so `Sun:gym` stays `Sun:gym`.
- `compileStep(step, S, mins)` turns a step into the `{name, cat, type, note, start, end:(s)=>…}` that `chain()` already takes, resolving refs and anchors from `norm(daySettings(…))`.
- `chain()`: use `d.id` when present (fall back to `slug(name)`). Replace the `', part 1'` name check with a `mins` map of id → minutes that `rest` reads.
- `buildDay()`: `const steps = (plan.template?.[key] || DEFAULT_TEMPLATE(plan.settings.gymSlot)[key]).steps`, then `chain(key, steps.map(compile), ov)`. The custom-block and timestamp code is unchanged. `DAYS` keeps `key` / `name`; `kind` comes from the template's `label`.
- Delete `workday()`, `friday()` and `saturday()`. A verbatim copy goes to `tests/legacy-schedule.js` for the equivalence test only.

**Sync** (`js/sync.js`):
- Add `template:'template'` to `COLLS` and `PLAN_COLLS`, since template changes must re-materialize reminders.
- `toRecords`: one record per weekday, id `Sun`…`Sat`.
- `toState`: rebuild `s.template`. Missing days are filled from the default.

**Migration** (boot, `js/ui.js`): if the store has no `template` records, write `DEFAULT_TEMPLATE(settings.gymSlot)` once, as dirty records, so it syncs. Two devices migrating at once write identical content, so last-write-wins is harmless.

**Tests** (`tests/check.js`):
- **Equivalence.** For every weekday over 3 weeks, with gym slot afternoon and evening, default settings, a changed set (late bedtime 00:30, longer gym, auto prayer times), and existing weekly and dated overrides: the new engine's `{id, name, cat, start, end, hidden}` must **equal** the legacy engine's.
- Each rule (`len`, `until`, `cap`, `atLeast`, `rest`, `nextDay`) on a small hand-made template.
- Sync round-trip with `template`.
- The existing schedule, materialize, task and stats checks pass unchanged.

---

## Phase T2: Template editor

**Where.** Plan → Day view toolbar → **"Edit week template"** opens `#view-template`, a full-screen view with a back arrow. It's rare, so it gets no tab. Settings gets a link to it too.

**Layout** (phone first):
- Day chips (Su … Sa) and the day's label.
- An **ordered list of steps.** Each row shows a color dot, the name, a rule summary ("45 min", "until Maghrib", "up to 2 h · ends 10 min before Maghrib", "top up to 45 min"), and the **computed time range from a live preview** (e.g. `16:35–17:55`). ↑ / ↓ buttons reorder (no drag library); tapping a row edits it.
- **Warnings inline on rows:** a block squeezed to 0 min; a block pushing past an anchor (e.g. Gym ending after Maghrib); a day running past bedtime.
- Actions: **+ Add block** (after the selected row), **Copy this day to…** (day chips), **Reset day to default**, **Workday gym: afternoon / evening** (preset).
- **Shared durations:** a collapsible list of the shared lengths (the old Settings "Block lengths"), each with "used by N blocks".
- **Save / Cancel.** Edits go to a draft (`structuredClone(plan.template)`). Save writes the changed days through `changed('template')`. The preview reuses `chain()` / `compileStep` on the draft.

**Step dialog** (`<dialog>`, following the `taskDlg` / `habitDlg` pattern):
- Name, Block type (any type, plus "New type…" inline), Kind (Fixed / Flex / Spare), Note.
- **"How long"** as radio choices that map to the rules:
  - "Fixed length", with minutes or a shared duration
  - "Until a time", with an anchor and "minus N min"
  - "Up to a length, but stop before a time"
  - "At least a length, until a time"
  - "Top up another block to a total", choosing the block
- Delete (with the existing "tasks linked to it stay, marked Removed block" behavior).

**Other changes:**
- Settings: remove the "Block lengths" fieldset and the gym-slot toggle. Both moved to the editor.
- `#view-template` joins `VIEWS` in `show()`.
- Reuse `dayPick()` for copy-to, `blockEl()` / `fmtRange()` / `dur()` for display, and `colorVars()` for dots.
- New UI code goes in **`js/template-ui.js`**, loaded after `ui.js` and using its globals, so `ui.js` (about 850 lines) doesn't grow further. Add it to `index.html` and `sw.js` SHELL, and bump `VERSION`.

---

## Phase T3: Targets on block types (plus Stats)

**Data:** `categories[k].target` (minutes/week, optional) and `categories[k].place`:
```
{ days:[0..6],                   // allowed weekdays (default all)
  min:30, max:120,               // session length bounds, in minutes
  prefer:'any'|'morning'|'afternoon'|'evening',
  perDay:1 }                     // max sessions per day
```
Plus `settings.minBuffer` (minutes of Spare to keep per day, default 30). This protects the "room in it" principle.

**UI:**
- In the "Plan my week" sheet (T5), a targets table: one row per type with hours/week, and a ⋯ button that expands the placement rules.
- **"Use current hours as targets"** prefills each target from this week's planned hours (`weekStats` / `plannedByCat`).
- **Stats:** each block-type row shows the target ("4 h of 8.5 h · target 9 h"). Under target, the row is marked with text, not color alone. A fifth tile shows "on target: N of M types".

**Tests:** sync round-trip of the new category fields; Stats with targets.

---

## Phase T4: Generator `autoPlan()` (pure, new `js/autoplan.js`)

Signature: `autoPlan(plan, weekDates) → { template, placed:{cat:min}, unplaced:[{cat, min, reason}], buffer:{day:min} }`. Deterministic, and it never edits Fixed steps or your hand-placed steps.

**Algorithm** (greedy and explainable; no solver):
1. **Start state.** Remove all `auto:true` steps from the template.
2. **Count what's already there.** Compute each target type's planned minutes over the week from the remaining template (`plannedByCat` over `buildDay` with the draft). The need per type is `target − existing`.
3. **Free windows.** For each day, build it and collect the **Spare-kind steps**: they are the slack that absorbs the chain. Each gives a window with start, length and period (`periodOf`). Usable length = window length − that day's share of `minBuffer`.
4. **Sessions.** For each type, ordered by fewest allowed days first, then largest need: split the need into sessions within `[min, max]`, spread evenly over its allowed days (round-robin by day, at most `perDay` per day).
5. **Place.** For each session, choose the window on an allowed day with the best score: the preferred period matches, the most room is left, and the type isn't already that day. Insert a step `{ id:'auto-<cat>-<n>', name:<type label>, cat, kind:'Flex', rule:'len', len, auto:true }` **just before** that Spare step. The Spare shrinks automatically, because it's a "fill until anchor" step. Rebuild the day to update the window.
6. **Can't fit.** A session that fits nowhere is shrunk to `min`; if that still doesn't fit, it goes to `unplaced` with a reason: "no free window on allowed days", "would break the minimum buffer", or "longer than any window".
7. **Return** the new template plus the report.

**Ceilings** (marked with `ponytail:` comments):
- It only uses existing Spare windows. It never moves Flex blocks like Meals.
- Greedy, so it can be suboptimal. Upgrade path: a swap/backtrack pass if results disappoint.

**Tests:**
- An empty target leaves the template unchanged.
- One type with 3 h a week and `days:[5,6]`, `max:90` lands as two 90-min blocks on Friday and Saturday.
- Hand-placed blocks count toward the target.
- Running it twice gives an identical result.
- `minBuffer` is respected.
- Impossible targets end up in `unplaced` with the right reason.
- Prayers, work and sleep keep their times. This is checked with the equivalence helper on Fixed steps.

---

## Phase T5: "Plan my week" flow

Entry: a button in the template editor header, and Stats → "Plan to targets".

1. **Sheet, step 1 (targets):** the targets table from T3, plus "Minimum buffer per day".
2. **Generate** runs `autoPlan` on a draft.
3. **Step 2 (preview):**
   - per day, the blocks to be added (and auto blocks removed), each with its computed time;
   - a summary table: for each type, target, then placed, then the difference;
   - the `unplaced` list with reasons;
   - the buffer left per day.

   The current week isn't touched yet.
4. **Apply** loads the result into the template editor draft, so you can still tweak it before **Save**. **Cancel** discards it.

After saving, the normal paths take over: reminders re-materialize (template is in `PLAN_COLLS`), and Stats shows the new planned hours against the targets.

---

## Phase T6: Docs and finish
- README: the "Week template" and "Plan my week" sections, and the new known limit (D7).
- SPEC: a section for the template model, the rules table and the generator.
- WAYFINDER: decisions D17 onward (this plan's D1–D7).
- Bump `VERSION` in `sw.js` each phase. Commit per phase, without co-author trailers. Every push deploys through Pages after `tests/check.js`.

## Critical files
- `js/schedule.js`: template data, compile, `chain()` ids, `buildDay()`; the old builders removed.
- `js/sync.js`: the `template` collection.
- `js/ui.js`: migration on boot, Settings cleanup, Stats targets, `show()` / `VIEWS`.
- `js/template-ui.js` (new): the editor, the step dialog, and the Plan my week sheet.
- `js/autoplan.js` (new): the generator.
- `index.html`, `planner.css`, `sw.js`.
- `tests/check.js`, `tests/legacy-schedule.js` (new, test only), `tests/e2e.js`.

**Reused as is:**
- `chain`, `buildDay`, `visible`, `plannedByCat`, `periodOf`, `norm`, `daySettings` (js/schedule.js)
- `weekStats` (js/habits.js)
- `dayPick`, `blockEl`, `fmtRange`, `dur`, `colorVars`, `changed`, the dialog close pattern (js/ui.js)
- `Sync.save` diffing, which needs no change beyond the collection map

## Verification
- `node tests/check.js`. Above all the **T1 equivalence test**: the new engine must reproduce today's week block for block, ids included, before any UI work.
- `node tests/e2e.js` (Playwright; set `CHROME`), extended with:
  - open the editor, reorder Gym above Lunch on Sunday, and the preview times update;
  - save, and the Plan day shows the new order;
  - an existing task linked to `Sun:gym` still shows on it;
  - add a block with a new type; copy Sunday to Monday;
  - Plan my week: set Startup to 10 h → Generate → the preview shows the placements and any unplaced items → Apply → Save → Stats shows about 10 h planned against the 10 h target;
  - running it again changes nothing;
  - no page errors.
- Manual pass on the phone:
  - edit the template, and the reminders follow the new times;
  - edits sync to the laptop;
  - a dated "only this date" edit still beats the template.
