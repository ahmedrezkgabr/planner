// Browser checks: node tests/e2e.js  (needs Playwright: npm i --no-save playwright; set CHROME=/path/to/chrome if Playwright's own isn't installed)
// Serves the repo on a local port, fakes a signed-in session (sync calls fail quietly), and runs the main flows.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..'), PORT = 8140, U = `http://localhost:${PORT}/`;
const TYPES = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };
const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type':TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); }).listen(PORT);
const KEY = 'sb-tohbcduymsuaqivuabei-auth-token', b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const session = (uid, exp = Math.floor(Date.parse('2026-12-31') / 1000)) => JSON.stringify({ access_token:`${b64({ alg:'HS256' })}.${b64({ sub:uid, exp })}.s`,
  refresh_token:'r', token_type:'bearer', expires_in:3600, expires_at:exp, user:{ id:uid, aud:'authenticated' } });
const settle = p => p.waitForTimeout(250);   // let IndexedDB commit before a reload

async function page(b, opts = {}){
  const ctx = await b.newContext({ viewport:{ width:390, height:844 }, timezoneId:'Africa/Cairo', serviceWorkers:'block', ...opts });
  const p = await ctx.newPage(); p.errs = []; p.csp = [];
  p.on('pageerror', e => p.errs.push(e.message)); p.on('dialog', d => d.accept());
  p.on('console', m => /Content Security Policy/i.test(m.text()) && p.csp.push(m.text()));
  return p;
}
const signIn = async (p, uid = 'user-a') => { await p.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, session(uid)]); await p.reload(); await p.waitForTimeout(800); };

(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath:process.env.CHROME } : {});

  { // Sign-in gate, account switch, sign-out wipe.
    const p = await page(b);
    await p.goto(U); await p.waitForTimeout(800);
    assert.ok(await p.isVisible('#gate')); assert.equal(await p.isVisible('#wrap'), false, 'stranger sees only the gate');
    await signIn(p, 'user-a'); assert.ok(await p.isVisible('#wrap'), 'signed in: app opens');
    await p.click('nav [data-view=tasks]'); await p.fill('#quickText', 'Secret task'); await p.press('#quickText', 'Enter');
    await p.click('#taskView .tt'); await p.click('#taskDlg button[value=save]'); assert.equal(await p.isVisible('#taskDlg'), false, 'dialogs work under the CSP');
    await settle(p); await signIn(p, 'user-b'); await p.waitForTimeout(1500);
    assert.ok(!(await p.evaluate(() => tasks.map(t => t.title))).includes('Secret task'), "another account's session wipes, not uploads");
    await p.click('#gear'); await p.click('#acctSignOut'); await p.waitForTimeout(1500);
    assert.ok(await p.isVisible('#gate'), 'gate after sign-out');
    const left = await p.evaluate(() => new Promise(r => { const q = indexedDB.open('planner3'); q.onsuccess = () => { const g = q.result.transaction('records').objectStore('records').count(); g.onsuccess = () => r(g.result); }; }));
    assert.equal(left, 0, 'nothing left on the device');
    assert.deepEqual([p.errs, p.csp], [[], []]); await p.context().close(); console.log('gate ok');
  }

  { // Edits to state loaded from storage are saved (the "done reverts after refresh" bug).
    const p = await page(b); await p.goto(U); await signIn(p);
    await p.click('nav [data-view=tasks]'); await p.click('#filters button:has-text("All")');
    for (const t of ['First', 'Second']) { await p.fill('#quickText', t); await p.press('#quickText', 'Enter'); }
    await settle(p); await p.reload(); await p.waitForTimeout(800); await p.click('nav [data-view=tasks]'); await p.click('#filters button:has-text("All")');
    await p.click('#taskView li:has-text("First") input[type=checkbox]'); await settle(p); await p.reload(); await p.waitForTimeout(800);
    assert.ok((await p.evaluate(() => tasks.map(t => t.title + ':' + t.status))).includes('First:Completed'), 'tick after refresh survives');
    assert.deepEqual(p.errs, []); await p.context().close(); console.log('persistence ok');
  }

  { // Habits and timers.
    const p = await page(b);
    await p.clock.install({ time:new Date('2026-09-29T16:40:00+03:00') });   // a Tuesday, during Gym
    await p.goto(U); await signIn(p);
      await p.click('nav [data-view=tasks]'); await p.click('#filters button:has-text("Habits")');
      await p.fill('#habitName', 'Read 10 pages'); await p.press('#habitName', 'Enter');
      await p.fill('#habitName', 'Stretch'); for (const d of [0,2,3,4,5,6]) await p.click(`#habitDays [data-d="${d}"]`); await p.click('#habitAdd');   // Mondays only
      assert.equal(await p.locator('#habitList li').count(), 2);
      await p.fill('#quickText', 'Write report 30m !high'); await p.press('#quickText', 'Enter');
      await p.click('nav [data-view=now]');
      assert.equal(await p.locator('#dHabitPills button').count(), 1, 'only Read is due on a Tuesday');
      await p.click('#dHabitPills button'); await p.waitForTimeout(200); await settle(p); await p.reload(); await p.waitForTimeout(800);
      assert.equal(await p.getAttribute('#dHabitPills button', 'aria-pressed'), 'true', 'tick survives reload');
      // Track the current block, then a task: the block timer stops.
      const blk = await p.evaluate(() => status(plan, Date.now()).current.name);
      await p.click('#dTrack'); assert.ok(await p.isVisible('#timer'));
      await p.clock.fastForward('03:00');
      await p.click('nav [data-view=tasks]'); await p.click('#filters button:has-text("All")');
      await p.click('#taskView li:has-text("Write report") .play');
      assert.equal(await p.textContent('#timerLabel'), 'Write report');
      assert.equal(await p.evaluate(() => timeEntries.length), 2); assert.ok(await p.evaluate(() => !!timeEntries[0].end), 'block timer stopped'); await p.waitForTimeout(200);
      await settle(p); await p.reload(); await p.waitForTimeout(800);
      assert.ok(await p.isVisible('#timer'), 'running timer survives reload');
      await p.clock.fastForward('25:00'); await p.waitForTimeout(1200);
      const el = await p.textContent('#timerEl'); assert.match(el, /^25:0\d$/, el);
      await p.click('#timerStop'); assert.equal(await p.isVisible('#timer'), false);
      await p.click('nav [data-view=tasks]'); await p.click('#filters button:has-text("All")');
      const tag = await p.textContent('#taskView li:has-text("Write report")'); assert.match(tag, /25 min \/ 30 min est/, tag);
      // A block timer stops by itself when the block ends.
      await p.click('nav [data-view=now]'); await p.click('#dTrack');
      const until = await p.evaluate(() => running(timeEntries).until);
      await p.clock.fastForward(Math.ceil((Date.parse(until) - (await p.evaluate(() => Date.now()))) / 1000) * 1000 + 16000);
      await p.waitForTimeout(500);
      assert.equal(await p.evaluate(() => running(timeEntries)), null, 'stopped at block end');
      assert.equal(await p.evaluate(() => timeEntries[timeEntries.length - 1].end), until);
      // Edit & delete a habit.
      await p.click('nav [data-view=tasks]'); await p.click('#filters button:has-text("Habits")');
      await p.click('#habitList li:has-text("Stretch") .tt'); await p.click('#habitDlg button[value=delete]'); await p.waitForTimeout(300);
      assert.equal(await p.locator('#habitList li').count(), 1);
    assert.deepEqual(p.errs, []); await p.context().close(); console.log('habits and timers ok');
  }

  await b.close(); srv.close(); console.log('all browser checks passed');
})().catch(e => { console.error(e); process.exit(1); });
