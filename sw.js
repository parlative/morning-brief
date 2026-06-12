// Service Worker — Maya's Morning Brief
const CACHE_NAME = 'maya-brief-v11';
const DATA_CACHE = 'maya-data-v11';

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

  if (url.endsWith('.html') || url.endsWith('/') || url.includes('index')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  if (
    url.includes('open-meteo.com') || url.includes('ipapi.co') ||
    url.includes('ipwho.is') || url.includes('ip-api.com') ||
    url.includes('rss2json.com') || url.includes('mymemory')
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

  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ═══════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════
self.addEventListener('push', e => {
  let data = { title: "Maya's Morning Brief", body: '🌅 Dein Brief ist bereit!', tag: 'brief-refresh' };
  try { data = { ...data, ...e.data.json() }; } catch {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icon.png',
      badge: './icon.png',
      tag: data.tag || 'brief-refresh',
      renotify: true,
      requireInteraction: false,
      data: { url: data.url || './' }
    })
  );
});

// Tap on notification → open / focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('maysbrief') || client.url.includes('Morning-Brief')) {
          client.focus();
          client.postMessage({ type: 'PUSH_REFRESH' });
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
