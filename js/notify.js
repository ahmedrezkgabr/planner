/* =====================================================================
   notify.js: reminders.

   Reminders are sent by the server as Web Push, so they arrive with the
   app closed and the phone locked:
   - materialize() (pure, tested) turns the plan into block occurrences
     for the next 14 days, with remind_at = start − lead for block types
     that have reminders on. sync.js uploads them to `occurrences`.
   - The `tick` edge function runs every minute. It claims due rows
     (sent_at) and pushes them to every device in `push_subs`. A reminder
     more than 5 min late is skipped.
   - A moved block gets a new remind_at, so a new reminder.
   ponytail: if no device opens the app for 14 days, reminders run out.
   Settings shows the date. Upgrade: run the schedule engine in the edge
   function nightly.
   ===================================================================== */
const HORIZON_DAYS = 14;
const hashStr = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

// Every visible block that hasn't ended, from now to the end of day `days`. Yesterday is included for the Sleep block running past midnight.
function materialize(plan, fromMs, days = HORIZON_DAYS){
  const out = [], from = new Date(fromMs);
  for (let k = -1; k < days; k++) for (const b of visible(buildDay(plan, addDays(from, k)))){
    if (b.endAt <= fromMs) continue;
    const c = plan.categories[b.cat] || {};
    const row = { id:`${b.id}|${b.date}`, name:b.name, cat:b.cat, color:c.color || null,
                  body:`${fromMin(b.start)}–${fromMin(b.end)}` + (b.note ? ' · ' + b.note : ''),
                  start_at:new Date(b.startAt).toISOString(), end_at:new Date(b.endAt).toISOString(),
                  remind_at:c.remind ? new Date(b.startAt - c.lead * 60000).toISOString() : null };
    row.hash = hashStr(JSON.stringify(row));
    out.push(row);
  }
  return out;
}

// The next few reminders that will fire, for the dashboard.
function upcomingReminders(plan, occ, nowMs, n = 4){
  return occ.filter(b => plan.categories[b.cat]?.remind && b.startAt > nowMs)
            .map(b => ({ block:b, at:b.startAt - plan.categories[b.cat].lead * 60000 }))
            .filter(r => r.at > nowMs && r.at < nowMs + 86400000).slice(0, n);
}

/* ---------- browser side: this device's push subscription ---------- */
const b64u = s => { const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const Push = {
  supported: () => typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window,
  // iPhone/iPad only allow web push from the Home Screen app.
  needsInstall: () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone,
  permission: () => typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  async current(){ try { const reg = await navigator.serviceWorker.getRegistration(); return reg && await reg.pushManager.getSubscription(); } catch (e) { return null; } },
  async enable(){
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not allowed');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:b64u(VAPID_PUBLIC_KEY) });
    const j = sub.toJSON(), device = (navigator.userAgentData?.platform || navigator.platform || '') + ' · ' + (/Edg\//.test(navigator.userAgent) ? 'Edge' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : 'Safari');
    const { error } = await Sync.client.from('push_subs').upsert({ endpoint:j.endpoint, user_id:Sync.user.id, p256dh:j.keys.p256dh, auth:j.keys.auth, device });
    if (error) throw error;
  },
  async disable(){
    const sub = await this.current(); if (!sub) return;
    await Sync.client.from('push_subs').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  },
  // A real push through the server: a one-off occurrence due now. The next tick (≤ 1 min) sends it.
  async test(){
    const now = Date.now(), iso = ms => new Date(ms).toISOString();
    const { error } = await Sync.client.from('occurrences').insert({ user_id:Sync.user.id, id:'test|' + now, name:'Test reminder', cat:null, color:'#2F6B4F',
      body:'Reminders reach this device.', start_at:iso(now + 60000), end_at:iso(now + 120000), remind_at:iso(now), hash:'test' });
    if (error) throw error;
  },
};
