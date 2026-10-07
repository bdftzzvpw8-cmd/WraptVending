// Wrapt Command service worker — caches the app shell so Command opens
// instantly (and offline). Touches ONLY command.html + its icons; the
// marketing site and all /.netlify/functions requests pass straight through.
const CACHE = 'wrapt-cmd-v3';
const PAGE = '/command.html';
const SHELL = [PAGE, '/command-manifest.json', '/img/command-icon-180.png', '/img/command-icon-192.png', '/img/command-icon-512.png', '/img/command-icon-maskable-512.png'];
const NET_WAIT = 3000; // weak field signal: after this long, open from cache and let the network finish in the background

self.addEventListener('install', (e) => {
  // one missing icon must not stop the shell from installing
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// fetch and store only OK responses (never an error page), always under the canonical path
function refresh(req, key) {
  return fetch(req).then((r) => {
    if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(key, cp)).catch(() => {}); } // storage full: just don't cache
    return r;
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/.netlify/')) return; // functions: never cached, never touched
  if (url.pathname === PAGE || url.pathname === '/command') {
    // network first so updates flow through, but don't make a weak signal wait: after NET_WAIT serve the
    // cached copy; the network response still lands in the cache for next open
    const net = refresh(req, PAGE);
    e.waitUntil(net.catch(() => {}));
    e.respondWith(new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const fromCache = () => caches.match(PAGE);
      const timer = setTimeout(() => fromCache().then((c) => { if (c) finish(c); }), NET_WAIT);
      net.then((r) => {
        if (r.ok) finish(r);
        else fromCache().then((c) => finish(c || r)); // server error: the cached copy beats an error page
      }).catch(() => fromCache().then((c) => finish(c ||
        new Response('Offline, and Command has not been cached on this phone yet.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }))));
    }));
  } else if (SHELL.includes(url.pathname)) {
    // icons + manifest: stale-while-revalidate, so a changed icon arrives without bumping CACHE
    const net = refresh(req, url.pathname);
    e.waitUntil(net.catch(() => {}));
    e.respondWith(caches.match(url.pathname).then((c) => c || net));
  }
  // anything else (the marketing site): no respondWith → the browser handles it normally
});
