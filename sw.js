/* =====================================================================
   sw.js: service worker. Three jobs:
   1. Offline: the app shell is cached, so the planner opens with no
      network. Your data is already local in IndexedDB.
   2. Installability: Chrome/Edge/Android need a service worker to offer
      "Install app".
   3. Reminders: shows the Web Push messages sent by the tick edge
      function (it does no scheduling itself), and focuses or opens the
      planner when you tap one.
   Bump VERSION when you change any file so phones pick up the update.
   ===================================================================== */
const VERSION = 'planner-v3.6';
const SHELL = ['./', 'index.html', 'planner.css', 'manifest.webmanifest',
  'js/schedule.js', 'js/tasks.js', 'js/notify.js', 'js/config.js', 'js/sync.js', 'js/ui.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Stale-while-revalidate for same-origin files: serve from cache immediately, refresh the cache in the background.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // fonts etc. go straight to the network
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch:true });
    const net = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || (e.request.mode === 'navigate' ? cache.match('index.html') : Response.error());
  }));
});

// A reminder from the tick edge function. Always show it (iOS revokes push for silent pushes); an open planner also gets a toast.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: e.data && e.data.text() }; }
  const title = d.title || 'Planner';
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, { body:d.body || '', tag:d.tag, renotify:true, icon:'icons/icon-192.png', badge:'icons/icon-192.png', data:{ url:'./' } }),
    self.clients.matchAll({ type:'window' }).then(list => list.forEach(c => c.postMessage({ type:'reminder', title, body:d.body }))),
  ]));
});

// Tapping a notification brings the planner to the front, or opens it.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow('./');
  }));
});
