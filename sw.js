// Service worker : app utilisable hors-ligne + cache des tuiles de carte consultées
const APP = 'capnord-app-v103';
const TILES = 'voyage-tiles-v1';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/etapa.svg', 'icons/etapa-180.png', 'icons/etapa-192.png',
  'js/app.js', 'js/utils.js', 'js/constants.js', 'js/store.js', 'js/services.js', 'js/mapview.js', 'js/cloud.js', 'js/config.js', 'js/share.js', 'js/picto.js', 'js/collab.js',
  'share.html', 'css/share.css', 'vendor/supabase.js',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js', 'vendor/sortable.min.js',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const TILE_HOSTS = ['basemaps.cartocdn.com', 'tile.openstreetmap.org', 'tile.opentopomap.org', 'server.arcgisonline.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Tuiles : cache d'abord (elles changent rarement), réseau sinon
  // Polices de la charte : gardées en cache pour fonctionner hors-ligne
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h)) || FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(TILES).then(async (c) => {
        const hit = await c.match(req.url);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) c.put(req.url, res.clone());
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      }),
    );
    return;
  }

  // Fichiers de l'app : réseau d'abord (mises à jour), cache si hors-ligne
  if (url.origin === location.origin) {
    e.respondWith(
      // reload : ignore le cache HTTP du navigateur, pour toujours avoir la dernière version
      // Requête recréée à partir de l'adresse : une navigation ne peut pas recevoir d'options de cache
      fetch(new Request(req.url, { cache: 'reload', credentials: 'same-origin' }))
        .then((res) => {
          if (res.ok) caches.open(APP).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
    );
  }
});

// Toucher une notification de réaction : rouvre l'app
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = all.find((x) => x.url.startsWith(self.registration.scope));
    if (c) return c.focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});
