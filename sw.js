const CACHE = 'cursor-calc-v13';
// Increment CACHE whenever app shell files or cached CDN dependencies change.
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './models.json',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Manrope:wght@500;600;700;800&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.2/babel.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(err => {
    console.warn('Failed to pre-cache app shell', err);
  })));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

const sameOrigin = url => {
  try { return new URL(url).origin === self.location.origin; }
  catch { return false; }
};

// Network-first: always try the network, fall back to cache when offline.
// Used for the app shell so users immediately get the latest deploy.
const networkFirst = (request) => {
  return fetch(request).then(res => {
    if (res && res.ok) {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(request, clone)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(request).then(r => {
    if (r) return r;
    if (request.mode === 'navigate') return caches.match('./index.html');
    return new Response('Offline', {status:503, headers:{'Content-Type':'text/plain'}});
  }));
};

// Cache-first: serve from cache, fall back to network. Used for versioned
// 3rd-party CDN libs whose URL changes when the version changes.
const cacheFirst = (request) => {
  return caches.match(request).then(r => r || fetch(request).then(res => {
    if (res && res.ok) {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(request, clone)).catch(() => {});
    }
    return res;
  }).catch(() => new Response('Offline', {status:503, headers:{'Content-Type':'text/plain'}})));
};

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Always go network-first for navigations and same-origin app shell so the
  // newest deploy wins immediately when online; cache is only a fallback.
  if (e.request.mode === 'navigate' || sameOrigin(e.request.url)) {
    e.respondWith(networkFirst(e.request));
    return;
  }
  // Versioned CDN libraries: cache-first is fine because the URL changes
  // whenever the version changes.
  e.respondWith(cacheFirst(e.request));
});
