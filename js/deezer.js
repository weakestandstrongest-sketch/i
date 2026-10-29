// Deezer public API via JSONP (no key needed, and it sidesteps CORS).

const BASE = 'https://api.deezer.com';
let seq = 0;

function jsonp(path, params = {}, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const cb = `__dz${Date.now()}${seq++}`;
    const qs = new URLSearchParams({ ...params, output: 'jsonp', callback: cb });
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }
    window[cb] = (data) => {
      cleanup();
      if (data && data.error) reject(new Error(data.error.message || 'deezer error'));
      else resolve(data);
    };
    script.onerror = () => { cleanup(); reject(new Error('network')); };
    script.src = `${BASE}${path}?${qs}`;
    document.head.appendChild(script);
  });
}

export const deezer = {
  searchTracks: (q, limit = 10) => jsonp('/search', { q, limit }).then((r) => r.data || []),
  searchArtist: (q) => jsonp('/search/artist', { q, limit: 1 }).then((r) => (r.data || [])[0] || null),
  related: (artistId, limit = 10) => jsonp(`/artist/${artistId}/related`, { limit }).then((r) => r.data || []),
  top: (artistId, limit = 5) => jsonp(`/artist/${artistId}/top`, { limit }).then((r) => r.data || []),
  album: (albumId) => jsonp(`/album/${albumId}`),
  chart: (limit = 20) => jsonp('/chart/0/tracks', { limit }).then((r) => r.data || []),
  // Preview URLs are signed and expire, so fetch a fresh one right before playing.
  track: (id) => jsonp(`/track/${id}`),
};

// Deezer artwork URLs encode their size (…/1000x1000-000000-80-0-0.jpg). Asking for the
// size actually shown keeps image memory low; 12 full-size covers can exceed what iOS
// Safari will paint, leaving covers half-drawn. Other URLs are returned unchanged.
export function coverAt(url, px = 250) {
  return url ? url.replace(/\/(\d{2,4})x\1-/, `/${px}x${px}-`) : '';
}

export function fromDeezerTrack(t) {
  return {
    deezerId: t.id,
    title: t.title_short || t.title,
    artist: t.artist?.name,
    artistId: t.artist?.id,
    album: t.album?.title,
    albumId: t.album?.id,
    cover: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || '',
    preview: t.preview || '',
    rank: t.rank || 0,
  };
}

// Run async jobs with a small concurrency limit.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch { out[k] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}
