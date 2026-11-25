// Pragati's service worker: keeps the app's screens available when the network drops, so staff can
// record checks on a weak signal. It never stores community data: /api/ requests always go to the
// network, and checks recorded offline wait in the page until they can be sent.
const SHELL = 'pragati-shell-v1';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(['/'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Screens: the network first, the last copy when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(SHELL).then(c => c.put('/', copy));
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  // Built files have content hashes in their names, so a stored copy is always right.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
