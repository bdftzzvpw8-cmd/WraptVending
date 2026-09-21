// Wrapt Command service worker — caches the app shell so Command opens
// instantly (and offline). Touches ONLY command.html + its icons; the
// marketing site and all /.netlify/functions requests pass straight through.
const CACHE = 'wrapt-cmd-v1';
const SHELL = ['/command.html', '/command-manifest.json', '/img/command-icon-192.png', '/img/command-icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/command.html') {
    // network first (updates flow through), cache fallback (offline still opens)
    e.respondWith(
      fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; })
        .catch(() => caches.match('/command.html'))
    );
  } else if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
