// Service Worker — Maya's Morning Brief
const CACHE_NAME = 'maya-brief-v9';
const DATA_CACHE = 'maya-data-v9';

// Install: skip waiting immediately
self.addEventListener('install', e => {
  self.skipWaiting();
});

// Activate: delete ALL old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: ALWAYS network-first for HTML/JS — never serve stale app shell
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // HTML pages: always fetch fresh from network
  if (url.endsWith('.html') || url.endsWith('/') || url.includes('index')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // API/data requests: network first, cache as offline fallback
  if (
    url.includes('open-meteo.com') ||
    url.includes('ipapi.co') ||
    url.includes('rss2json.com') ||
    url.includes('allorigins.win') ||
    url.includes('corsproxy.io') ||
    url.includes('gnews.io') ||
    url.includes('mymemory')
  ) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(DATA_CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Everything else: network first
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
