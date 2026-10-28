// Imports listening history from Last.fm. Anything that scrobbles (e.g. the
// Web Scrobbler extension on YouTube Music) ends up here, earphones or not.
import { deezer, fromDeezerTrack, pool } from './deezer.js';
import { trackKey } from './store.js';

const API = 'https://ws.audioscrobbler.com/2.0/';
const FIRST_SYNC_DAYS = 30;
const MAX_PAGES = 5;          // 5 x 200 scrobbles per sync
const MAX_ENRICH = 60;        // Deezer lookups per sync (cover, ids, genres)

async function call(params) {
  const qs = new URLSearchParams({ ...params, format: 'json' });
  const res = await fetch(`${API}?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    const msg = { 6: 'Last.fm のユーザー名が見つかりません', 10: 'Last.fm の API キーが正しくありません', 17: 'Last.fm の再生履歴が非公開になっています' }[json.error];
    throw new Error(msg || json.message || 'Last.fm に接続できませんでした');
  }
  if (!res.ok) throw new Error('Last.fm に接続できませんでした');
  return json;
}

function toPlay(t) {
  const images = t.image || [];
  const cover = images.length ? images[images.length - 1]['#text'] : '';
  return {
    title: t.name,
    artist: t.artist?.['#text'] || t.artist?.name || '',
    album: t.album?.['#text'] || '',
    // Last.fm's placeholder star image is not real artwork.
    cover: cover && !cover.includes('2a96cbd8b46e442fc41c2b86b821562f') ? cover : '',
    at: Number(t.date?.uts || 0) * 1000,
    source: 'lastfm',
    features: {},
  };
}

// Returns { plays, nowPlaying, latest } for scrobbles newer than `since` (ms).
export async function fetchRecent(user, apiKey, since) {
  const from = Math.floor((since || Date.now() - FIRST_SYNC_DAYS * 86400000) / 1000) + 1;
  const plays = [];
  let nowPlaying = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await call({ method: 'user.getrecenttracks', user, api_key: apiKey, limit: 200, page, from });
    const rt = json.recenttracks || {};
    const list = Array.isArray(rt.track) ? rt.track : rt.track ? [rt.track] : [];
    for (const t of list) {
      if (t['@attr']?.nowplaying === 'true') { nowPlaying = toPlay(t); continue; }
      plays.push(toPlay(t));
    }
    const total = Number(rt['@attr']?.totalPages || 1);
    if (page >= total) break;
  }
  const latest = plays.reduce((m, p) => Math.max(m, p.at), since || 0);
  return { plays, nowPlaying, latest };
}

// Fills in Deezer ids, artwork and genres so recommendations can use the plays.
export async function enrich(plays) {
  const cache = new Map();
  const targets = plays.slice(0, MAX_ENRICH);
  await pool(targets, 4, async (p) => {
    const key = trackKey(p.title, p.artist);
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const hit = (await deezer.searchTracks(`artist:"${p.artist}" track:"${p.title}"`, 1))[0]
          || (await deezer.searchTracks(`${p.artist} ${p.title}`, 1))[0];
        if (!hit) return null;
        const t = fromDeezerTrack(hit);
        // Guard against a search that matched a different artist.
        const [a, b] = [trackKey('', t.artist), trackKey('', p.artist)];
        if (!a.includes(b) && !b.includes(a)) return null;
        const al = await deezer.album(t.albumId).catch(() => null);
        t.genres = (al?.genres?.data || []).map((g) => g.name);
        return t;
      })().catch(() => null));
    }
    const t = await cache.get(key);
    if (!t) return;
    Object.assign(p, {
      deezerId: t.deezerId, artistId: t.artistId, albumId: t.albumId,
      cover: p.cover || t.cover, genres: t.genres,
    });
  });
  return plays;
}
