// Offline shell cache. Network first so updates show up immediately.
const CACHE = 'resonance-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'js/main.js', 'js/audio.js', 'js/visualizer.js', 'js/store.js', 'js/deezer.js', 'js/recognizer.js', 'js/recommend.js', 'js/lastfm.js', 'js/youtube.js', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
