/* Service worker template: vite.config.ts fills in the version and precache
 * list below and emits the result as /sw.js. Not bundled into the app. */
const CACHE = 'editordoc-__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = new URL('./', self.location).href;
// Servers may send `Vary: Origin`; module scripts carry an Origin header the
// precache requests lacked. Precached files are content-hashed, so ignore Vary.
const MATCH = { ignoreVary: true };

self.addEventListener('install', (event) => {
  // No skipWaiting here: a new version waits until the page asks (update banner),
  // so a running editor never mixes old page code with new cached assets.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('editordoc-') && k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // App shell is cache-first: on slow or absent networks it opens instantly.
  // Any ?doc=... navigation gets the same shell.
  if (req.mode === 'navigate') {
    event.respondWith(caches.match(SHELL, MATCH).then((hit) => hit || fetch(req)));
    return;
  }

  event.respondWith(
    caches.match(req, MATCH).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          // Hashed build files not precached (e.g. non-Latin font subsets): keep for offline.
          if (res.ok && new URL(req.url).pathname.includes('/assets/')) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
    )
  );
});
