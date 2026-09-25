/* =====================================================================
   sync.js: local-first storage plus Supabase sync. Replaces store.js.

   Every piece of user data is a record {collection, id, data, deleted,
   updated_at}. There is one IndexedDB store here and one `records` table
   in Supabase (supabase/migrations/001_init.sql).
   - save() diffs the in-memory state against the stored records. Changed
     ones get a new updated_at and are marked dirty; missing ones become
     tombstones.
   - Dirty records are pushed about 1 s later. The pull runs on boot,
     focus and reconnect, and Realtime covers live edits from the other
     device.
   - Conflicts: last write wins by updated_at (wins()). The server trigger
     enforces the same rule.
   Without a Supabase config (config.js) or a sign-in, it just works
   locally. Records stay dirty and go up on the first sign-in.
   Device-only things (prefs, notifyLog) live in the `meta` store and
   never sync.
   ===================================================================== */
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// ui.js state key → record collection
const COLLS = { settings:'settings', categories:'category', customBlocks:'customBlock', overrides:'override', tasks:'task', blockDone:'blockDone' };

/* ---------- state <-> records (pure, tested) ---------- */
// One ui.js state key → {recordId: data}
function toRecords(key, v){
  const o = {};
  switch (key){
    case 'settings':     o.main = v; break;
    case 'categories':   Object.assign(o, v); break;
    case 'customBlocks': for (const c of v) o[c.id] = c; break;
    case 'tasks':        for (const t of v) o[t.id] = t; break;
    case 'overrides':
      for (const [id, f] of Object.entries(v.weekly)) o['w:' + id] = f;
      for (const [iso, m] of Object.entries(v.dated)) for (const [id, f] of Object.entries(m)) o[`d:${iso}:${id}`] = f;
      break;
    case 'blockDone':    for (const [iso, ids] of Object.entries(v)) for (const id of ids) o[iso + '|' + id] = { done:true }; break;
  }
  return o;
}
function toState(recs){
  const s = { settings:{...DEFAULTS}, categories:structuredClone(DEFAULT_CATEGORIES), customBlocks:[], overrides:{weekly:{}, dated:{}}, tasks:[], blockDone:{} };
  for (const r of recs){
    if (r.deleted || !r.data) continue;
    const d = r.data;
    switch (r.collection){
      case 'settings':    s.settings = { ...DEFAULTS, ...d }; break;
      case 'category':    s.categories[r.id] = d; break;
      case 'customBlock': s.customBlocks.push(d); break;
      case 'task':        s.tasks.push(d); break;
      case 'override': {
        if (r.id.startsWith('w:')) s.overrides.weekly[r.id.slice(2)] = d;
        else { const iso = r.id.slice(2, 12), id = r.id.slice(13); (s.overrides.dated[iso] ||= {})[id] = d; }
        break;
      }
      case 'blockDone': { const [iso, id] = r.id.split('|'); (s.blockDone[iso] ||= []).push(id); break; }
    }
  }
  s.customBlocks.sort((a, b) => a.id.localeCompare(b.id));
  s.tasks.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return s;
}
// Should a remote copy replace the local one? Newer wins; on a tie the local copy stays (same write, or local unpushed edits).
const ts = r => Date.parse(r.updated_at);
const wins = (remote, local) => !local || ts(remote) > ts(local);
const rkey = r => r.collection + '|' + r.id;
const clean = r => ({ collection:r.collection, id:r.id, data:r.data ?? null, deleted:!!r.deleted, updated_at:r.updated_at });

/* ---------- the store ---------- */
const Sync = {
  recs: new Map(), meta: {}, db: null, mode: 'memory',
  client: null, user: null, busy: false, error: '', timer: null,
  onRemote: () => {}, onStatus: () => {},

  async open(){
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('planner3', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('records', { keyPath:'k' }); r.result.createObjectStore('meta'); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      this.mode = 'indexeddb';
      for (const r of await this.all('records')) this.recs.set(r.k, r);
      const keys = await this.all('meta', true), vals = await this.all('meta');
      keys.forEach((k, i) => this.meta[k] = vals[i]);
    } catch (e) { this.db = null; this.mode = 'memory'; }
    try { this.persisted = navigator.storage && await navigator.storage.persist(); } catch (e) {}
    return this.mode;
  },
  all(store, keys){
    return new Promise((res, rej) => { const q = this.db.transaction(store).objectStore(store)[keys ? 'getAllKeys' : 'getAll'](); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  },
  write(fn){
    if (!this.db) return Promise.resolve();
    return new Promise((res, rej) => { const t = this.db.transaction(['records', 'meta'], 'readwrite'); fn(t.objectStore('records'), t.objectStore('meta')); t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  put(list){ for (const r of list){ r.k = rkey(r); this.recs.set(r.k, r); } return this.write(s => list.forEach(r => s.put(r))); },
  setMeta(k, v){ this.meta[k] = v; return this.write((_, m) => m.put(v, k)); },
  state(){ return toState(this.recs.values()); },

  // Diff the given state keys against the stored records and persist the changes.
  async save(keys, state){
    const now = new Date().toISOString(), changed = [];
    for (const key of keys){
      const coll = COLLS[key]; if (!coll) continue;
      const next = toRecords(key, state[key]);
      for (const [id, data] of Object.entries(next)){
        const cur = this.recs.get(coll + '|' + id);
        if (!cur || cur.deleted || JSON.stringify(cur.data) !== JSON.stringify(data)) changed.push({ collection:coll, id, data:structuredClone(data), deleted:false, updated_at:now, dirty:true });
      }
      for (const r of this.recs.values())
        if (r.collection === coll && !r.deleted && !(r.id in next)) changed.push({ collection:coll, id:r.id, data:null, deleted:true, updated_at:now, dirty:true });
    }
    if (!changed.length) return;
    await this.put(changed);
    clearTimeout(this.timer); this.timer = setTimeout(() => this.syncNow(), 1000);
  },

  // Apply records from the server or a backup file. Returns how many replaced the local copy.
  async apply(rows, dirty = false){
    const won = rows.filter(r => wins(r, this.recs.get(rkey(r)))).map(r => ({ ...clean(r), dirty }));
    if (won.length) await this.put(won);
    return won.length;
  },

  // One-time: the v2 app's IndexedDB (database "planner", store "kv", one record per collection).
  async migrateV2(){
    if (this.meta.migratedV2 || this.recs.size) return false;
    const old = await new Promise(res => {
      try {
        const r = indexedDB.open('planner');
        r.onupgradeneeded = () => r.transaction.abort();   // didn't exist: don't create it
        r.onsuccess = () => res(r.result); r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    let found = false;
    if (old && old.objectStoreNames.contains('kv')){
      const get = k => new Promise(res => { const q = old.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); });
      const st = {};
      for (const k of Object.keys(COLLS)) st[k] = await get(k);
      const base = toState([]);
      if (st.settings) st.settings = { ...DEFAULTS, ...st.settings };
      if (st.categories) st.categories = { ...base.categories, ...st.categories };
      if (st.overrides) st.overrides = { weekly:{}, dated:{}, ...st.overrides };
      const keys = Object.keys(COLLS).filter(k => st[k]);
      found = keys.length > 0;
      await this.save(keys, st);
      const prefs = await get('prefs'), log = await get('notifyLog');
      if (prefs) await this.setMeta('prefs', prefs);
      if (log) await this.setMeta('notifyLog', log);
    }
    if (old) old.close();
    await this.setMeta('migratedV2', true);
    return found;
  },

  backup(){ return JSON.stringify({ app:'planner', version:3, exportedAt:new Date().toISOString(), records:[...this.recs.values()].map(clean) }); },
  async restore(text){
    const j = JSON.parse(text);
    if (j.app !== 'planner' || !Array.isArray(j.records)) throw new Error('Not a planner backup file');
    const n = await this.apply(j.records.filter(r => r.collection && r.id && r.updated_at), true);
    this.syncNow();
    return n;
  },

  /* ---------- cloud ---------- */
  configured: () => typeof SUPABASE_URL !== 'undefined' && !!SUPABASE_URL && !!SUPABASE_ANON_KEY,
  connect(){ return this.connecting ||= this.connect1().finally(() => { if (!this.client) this.connecting = null; }); },
  async connect1(){
    if (!this.configured()) return;
    try { const { createClient } = await import(SUPABASE_JS); this.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); }
    catch (e) { this.error = 'Offline: sync starts when you reconnect'; return this.onStatus(); }   // first load offline: CDN not reachable
    const { data } = await this.client.auth.getSession();
    this.setUser(data.session?.user || null);
    this.client.auth.onAuthStateChange((_, s) => this.setUser(s?.user || null));
  },
  setUser(u){
    if ((u && u.id) === (this.user && this.user.id)) return;
    this.user = u; this.channel && this.client.removeChannel(this.channel); this.channel = null;
    if (u){
      // Realtime: the other device's edits arrive within a second or two.
      this.channel = this.client.channel('records')
        .on('postgres_changes', { event:'*', schema:'public', table:'records', filter:`user_id=eq.${u.id}` }, p => this.incoming([p.new]))
        .subscribe();
      this.syncNow();
    }
    this.onStatus();
  },
  async incoming(rows){ if (await this.apply(rows)) this.onRemote(this.state()); },
  signIn(email){ return this.client.auth.signInWithOtp({ email, options:{ emailRedirectTo:location.origin + location.pathname } }); },
  signOut(){ return this.client.auth.signOut(); },
  pending(){ let n = 0; for (const r of this.recs.values()) if (r.dirty) n++; return n; },

  async syncNow(){
    if (!this.client){ if (navigator.onLine) await this.connect(); return; }
    if (!this.user || this.busy) return;
    this.busy = true;
    try { await this.push(); await this.pull(); this.error = ''; await this.setMeta('lastSync', Date.now()); }
    catch (e) { this.error = e.message || String(e); }
    finally { this.busy = false; this.onStatus(); }
  },
  async push(){
    const dirty = [...this.recs.values()].filter(r => r.dirty);
    for (let i = 0; i < dirty.length; i += 500){
      const part = dirty.slice(i, i + 500);
      const { error } = await this.client.from('records').upsert(part.map(r => ({ user_id:this.user.id, ...clean(r) })), { onConflict:'user_id,collection,id' });
      if (error) throw error;
      // Only clear the flag if the record wasn't edited again while the request ran.
      await this.put(part.filter(r => this.recs.get(r.k) === r).map(r => ({ ...r, dirty:false })));
    }
  },
  // ponytail: pulls by server_ts high-water mark; a row committed late with an older server_ts is missed here, and Realtime covers that case.
  async pull(){
    const key = 'lastPull:' + this.user.id;
    let from = this.meta[key] || '1970-01-01T00:00:00Z', got = 0;
    for (;;){
      const { data, error } = await this.client.from('records').select('collection,id,data,deleted,updated_at,server_ts')
        .gte('server_ts', from).order('server_ts').limit(1000);
      if (error) throw error;
      got += await this.apply(data);
      if (data.length) from = data[data.length - 1].server_ts;
      if (data.length < 1000) break;
    }
    await this.setMeta(key, from);
    if (got) this.onRemote(this.state());
  },
};
