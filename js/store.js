/* =====================================================================
   store.js: persistence.

   IndexedDB database "planner", one key-value store. Each collection
   (settings, categories, customBlocks, overrides, blockDone, tasks,
   prefs, notifyLog) is one record. For a personal planner that is a few
   hundred KB at most.
   ponytail: whole-collection writes. Split tasks into their own object
   store if sync needs per-record writes.

   If IndexedDB is unavailable (some private modes), it falls back to
   localStorage. If that also fails, data lasts for this session only,
   and the UI says so.
   ===================================================================== */
const DB = {
  db: null, mode: 'memory', mem: {},
  async open(){
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('planner', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      this.mode = 'indexeddb';
    } catch (e) {
      try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); this.mode = 'localstorage'; } catch (e2) { this.mode = 'memory'; }
    }
    // Ask the browser not to evict this data under storage pressure (granted automatically for installed apps).
    try { this.persisted = navigator.storage && await navigator.storage.persist(); } catch (e) {}
    return this.mode;
  },
  tx(mode, fn){
    return new Promise((res, rej) => { const t = this.db.transaction('kv', mode); const r = fn(t.objectStore('kv')); t.oncomplete = () => res(r.result); t.onerror = () => rej(t.error); });
  },
  async get(k){
    if (this.mode === 'indexeddb') return (await this.tx('readonly', s => s.get(k))) ?? null;
    if (this.mode === 'localstorage') { const v = localStorage.getItem('planner:' + k); return v ? JSON.parse(v) : null; }
    return this.mem[k] ?? null;
  },
  async set(k, v){
    if (this.mode === 'indexeddb') return this.tx('readwrite', s => s.put(v, k));
    if (this.mode === 'localstorage') return localStorage.setItem('planner:' + k, JSON.stringify(v));
    this.mem[k] = v;
  },
  // The original planner's data, still in localStorage for this origin.
  legacyEntries(){
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++){
        const k = localStorage.key(i);
        if (k === 'settings' || /^(tasks|done):\d{4}-\d{2}-\d{2}$/.test(k)) out.push([k, JSON.parse(localStorage.getItem(k))]);
      }
    } catch (e) {}
    return out;
  },
};
