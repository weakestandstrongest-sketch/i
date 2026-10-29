// Offline shell cache. Network first so updates show up immediately; requests
// revalidate with the server (no-cache) so the browser's own HTTP cache can't
// serve a stale file mixed with fresh ones. Asset URLs carry ?v=N (see
// tools/bump_version.py), which the version below must match.
const CACHE = 'resonance-assets-v3';
const V = '?v=3';
const SHELL = ['./', 'index.html', 'styles.css' + V, 'manifest.webmanifest',
  ...['main', 'audio', 'visualizer', 'spectrum', 'store', 'deezer', 'recognizer', 'recommend', 'lastfm', 'youtube'].map((n) => `js/${n}.js${V}`)];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
