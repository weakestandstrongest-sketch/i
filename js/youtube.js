// Imports the songs you liked on YouTube / YouTube Music via the YouTube Data API.
// Sign-in uses Google Identity Services in the browser; the access token is kept
// in memory only (it lasts about an hour), so nothing secret is stored.
import { deezer, fromDeezerTrack, pool } from './deezer.js';
import { trackKey } from './store.js';

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const MAX_PAGES = 20;      // 50 likes per page
const MAX_ENRICH = 100;    // Deezer lookups per sync

let gsiReady = null;
let token = null;          // { value, expires }

function loadGsi() {
  if (!gsiReady) {
    gsiReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GSI_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gsiReady = null; reject(new Error('Google のログイン画面を読み込めませんでした')); };
      document.head.appendChild(s);
    });
  }
  return gsiReady;
}

// Preload so the popup can open straight from the user's tap (iOS blocks
// popups that open after an await).
export function preloadGoogle() { loadGsi().catch(() => {}); }

export function hasToken() { return !!token && token.expires > Date.now() + 60000; }

export function signIn(clientId) {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) { reject(new Error('Google のログイン画面を準備中です。もう一度押してください')); preloadGoogle(); return; }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) { reject(new Error(r.error === 'access_denied' ? 'YouTube へのアクセスが許可されませんでした' : `ログインに失敗しました（${r.error}）`)); return; }
        token = { value: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        resolve();
      },
      error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'ログインがキャンセルされました' : e?.type === 'popup_failed_to_open' ? 'ポップアップがブロックされました。ブラウザでポップアップを許可してください' : 'ログインに失敗しました')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

async function api(path, params) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token.value}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json.error?.errors?.[0]?.reason;
    if (res.status === 401) { token = null; throw new Error('ログインの有効期限が切れました。もう一度同期してください'); }
    if (reason === 'accessNotConfigured') throw new Error('Google Cloud で YouTube Data API v3 が有効になっていません');
    if (reason === 'quotaExceeded') throw new Error('今日の YouTube API の利用上限に達しました。明日もう一度試してください');
    throw new Error(json.error?.message || 'YouTube に接続できませんでした');
  }
  return json;
}

const NOISE = /(official|music\s*video|video|lyrics?|lyric\s*video|audio|visualizer|mv|m\/v|hd|4k|full|ver\.?|version|公式|歌詞|ミュージック\s*ビデオ|ミュージックビデオ|フル)/i;

function clean(s) {
  return s
    .replace(/[(\[【〔［（][^)\]】〕］）]*[)\]】〕］）]/g, (m) => (NOISE.test(m) ? '' : m))
    .replace(/\s*(official\s*(music\s*)?video|music\s*video|\bMV\b)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Turns a video's title/channel into { artist, title }.
export function parseVideo(title, channel) {
  const ch = (channel || '').trim();
  if (/ - Topic$/.test(ch)) return { artist: ch.replace(/ - Topic$/, ''), title: clean(title) };
  const quoted = title.match(/^(.*?)[\s「『]*[「『](.+?)[」』]/);
  if (quoted && quoted[1].trim()) {
    return { artist: clean(quoted[1].replace(/\b(MV|PV)\b/gi, '').replace(/[-–—:|／/]\s*$/, '')), title: quoted[2].trim() };
  }
  const dash = title.match(/^(.+?)\s+[-–—|／]\s+(.+)$/);
  if (dash) return { artist: clean(dash[1]), title: clean(dash[2]) };
  // "Vaundy：踊り子": a colon split is trusted only when the left side is the channel's name.
  const colon = title.match(/^(.+?)\s*[：:]\s*(.+)$/);
  const chName = ch.replace(/VEVO$/i, '').toLowerCase();
  if (colon && chName && chName.includes(colon[1].trim().toLowerCase())) return { artist: colon[1].trim(), title: clean(colon[2]) };
  const artist = ch.replace(/VEVO$/i, '').replace(/\s*(official|公式|オフィシャル)\s*(channel|youtube\s*channel|チャンネル)?$/i, '').trim();
  return { artist, title: clean(title) };
}

// All liked music videos (YouTube Music likes are YouTube likes).
export async function fetchLikes() {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < MAX_PAGES; i++) {
    const json = await api('videos', { part: 'snippet', myRating: 'like', maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    for (const v of json.items || []) {
      const sn = v.snippet || {};
      const isMusic = sn.categoryId === '10' || / - Topic$/.test(sn.channelTitle || '');
      if (!isMusic) continue;
      const { artist, title } = parseVideo(sn.title || '', sn.channelTitle || '');
      if (!title) continue;
      out.push({ videoId: v.id, title, artist, cover: sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || '' });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

// Adds Deezer ids, artwork and genres, like Last.fm imports.
export async function enrichLikes(likes) {
  await pool(likes.slice(0, MAX_ENRICH), 4, async (l) => {
    const hit = (await deezer.searchTracks(`artist:"${l.artist}" track:"${l.title}"`, 1))[0]
      || (await deezer.searchTracks(`${l.artist} ${l.title}`, 1))[0];
    if (!hit) return;
    const t = fromDeezerTrack(hit);
    const [a, b] = [trackKey('', t.artist), trackKey('', l.artist)];
    if (!a.includes(b) && !b.includes(a)) return;
    const al = await deezer.album(t.albumId).catch(() => null);
    Object.assign(l, {
      deezerId: t.deezerId, artistId: t.artistId, albumId: t.albumId,
      artist: t.artist, title: t.title,
      cover: t.cover || l.cover,
      genres: (al?.genres?.data || []).map((g) => g.name),
    });
  });
  return likes;
}
