'use strict';
// سرویس‌ورکر: پوسته برنامه آفلاین باز می‌شود؛ داده‌ها (API) هرگز کش نمی‌شوند.
const V = 'kz-v4', SHELL = ['/', '/theme.js', '/app.css', '/app.js', '/features.js', '/icon.svg', '/manifest.webmanifest', '/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  if (u.origin === location.origin) {
    if (u.pathname.startsWith('/api/') || u.pathname === '/healthz') return;
    // شبکه اول، با بازگشت به کش (به‌روزرسانی‌ها همیشه می‌رسند)
    e.respondWith(fetch(r).then((res) => { const c = res.clone(); if (res.ok) caches.open(V).then((x) => x.put(r, c)); return res; })
      .catch(() => caches.match(r).then((m) => m || (r.mode === 'navigate' ? caches.match('/') : Response.error()))));
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) {
    e.respondWith(caches.match(r).then((m) => m || fetch(r).then((res) => { const c = res.clone(); caches.open(V).then((x) => x.put(r, c)); return res; })));
  }
});
