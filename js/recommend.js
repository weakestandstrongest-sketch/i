// Taste profile + weekly discovery generation.
import { deezer, fromDeezerTrack, pool } from './deezer.js';
import { trackKey } from './store.js';

const HALF_LIFE_DAYS = 21;
const YT_LIKE_WEIGHT = 1.5;   // a YouTube like counts a bit more than one recent play

export function buildProfile(state) {
  const now = Date.now();
  const artists = new Map(); // name -> { name, id, weight, count }
  const genres = new Map();
  const hours = new Array(24).fill(0);
  let bpmSum = 0, bpmN = 0, enSum = 0, enN = 0, brSum = 0, brN = 0;

  for (const p of state.plays) {
    const ageDays = (now - p.at) / 86400000;
    const w = Math.pow(0.5, ageDays / HALF_LIFE_DAYS) * (state.liked.includes(p.deezerId) ? 1.5 : 1);
    const key = (p.artist || '').toLowerCase();
    if (key) {
      const a = artists.get(key) || { name: p.artist, id: p.artistId || null, weight: 0, count: 0 };
      a.weight += w; a.count++;
      if (!a.id && p.artistId) a.id = p.artistId;
      artists.set(key, a);
    }
    for (const g of p.genres || []) genres.set(g, (genres.get(g) || 0) + w);
    hours[new Date(p.at).getHours()]++;
    const f = p.features || {};
    if (f.bpm) { bpmSum += f.bpm; bpmN++; }
    if (f.energy != null) { enSum += f.energy; enN++; }
    if (f.brightness != null) { brSum += f.brightness; brN++; }
  }

  // Likes carry no listening time, so they shape taste but not hours or counts.
  for (const l of state.ytLikes || []) {
    const key = (l.artist || '').toLowerCase();
    if (key) {
      const a = artists.get(key) || { name: l.artist, id: l.artistId || null, weight: 0, count: 0 };
      a.weight += YT_LIKE_WEIGHT;
      a.likes = (a.likes || 0) + 1;
      if (!a.id && l.artistId) a.id = l.artistId;
      artists.set(key, a);
    }
    for (const g of l.genres || []) genres.set(g, (genres.get(g) || 0) + YT_LIKE_WEIGHT);
  }

  return {
    plays: state.plays.length,
    likes: (state.ytLikes || []).length,
    artists: [...artists.values()].sort((a, b) => b.weight - a.weight),
    genres: [...genres.entries()].sort((a, b) => b[1] - a[1]),
    hours,
    bpm: bpmN ? Math.round(bpmSum / bpmN) : null,
    energy: enN ? enSum / enN : null,
    brightness: brN ? brSum / brN : null,
  };
}

export function describePersona(profile) {
  if (profile.plays + profile.likes < 3) return null;
  const parts = [];
  const top = profile.artists[0];
  const g = profile.genres[0]?.[0];
  if (profile.bpm) {
    const tempo = profile.bpm >= 128 ? '速いビート' : profile.bpm >= 100 ? 'ミッドテンポ' : 'ゆったりしたテンポ';
    parts.push(`<b>${tempo}</b>（平均 ${profile.bpm} BPM）`);
  }
  if (profile.brightness != null) {
    parts.push(profile.brightness > 0.55 ? '<b>きらびやかで明るい音色</b>' : profile.brightness > 0.35 ? '<b>バランスの取れた音色</b>' : '<b>深く温かい低音寄りの音色</b>');
  }
  let s = parts.length ? `あなたは${parts.join('と')}を好む傾向があります。` : '';
  if (g) s += `中心にあるのは <b>${g}</b>`;
  if (top) s += g ? `、そして <b>${top.name}</b>。` : `中心にいるのは <b>${top.name}</b>。`;
  const night = profile.hours.slice(21).concat(profile.hours.slice(0, 4)).reduce((a, b) => a + b, 0);
  if (night / profile.plays > 0.4) s += ' 夜に音楽を深く聴くタイプです。';
  return s;
}

// Builds ~12 picks the user hasn't heard, seeded by their top artists'
// related artists on Deezer. Falls back to the global chart with no history.
export async function generateWeekly(state, { onProgress } = {}) {
  const profile = buildProfile(state);
  const known = [...state.plays, ...(state.ytLikes || [])];
  const heardKeys = new Set(known.map((p) => trackKey(p.title, p.artist)));
  const heardIds = new Set([...known.map((p) => p.deezerId).filter(Boolean), ...state.heard]);
  const pastRecIds = new Set(Object.values(state.weeks).flatMap((w) => w.tracks.map((t) => t.deezerId)));
  const knownArtists = new Set(profile.artists.map((a) => a.name.toLowerCase()));
  const isFresh = (t) => !heardIds.has(t.deezerId) && !pastRecIds.has(t.deezerId) && !heardKeys.has(trackKey(t.title, t.artist));

  if (!profile.artists.length) {
    const chart = (await deezer.chart(30)).map(fromDeezerTrack).filter(isFresh).slice(0, 12);
    return chart.map((t) => ({ ...t, reason: 'いま世界で聴かれている曲' }));
  }

  // Resolve Deezer artist ids for the top seeds.
  const seeds = profile.artists.slice(0, 6);
  await pool(seeds, 4, async (s) => {
    if (!s.id) s.id = (await deezer.searchArtist(s.name))?.id || null;
  });
  const usable = seeds.filter((s) => s.id);
  onProgress?.(0.2);

  // Score related artists by how strongly (and how many) seeds point at them.
  const cands = new Map();
  const relLists = await pool(usable, 4, (s) => deezer.related(s.id, 12));
  usable.forEach((seed, si) => {
    (relLists[si] || []).forEach((a, rank) => {
      if (knownArtists.has(a.name.toLowerCase())) return;
      const c = cands.get(a.id) || { id: a.id, name: a.name, score: 0, via: [] };
      c.score += seed.weight * (1 - rank / 14) + Math.log10((a.nb_fan || 10) + 10) * 0.05;
      c.via.push(seed.name);
      cands.set(a.id, c);
    });
  });
  onProgress?.(0.45);

  const ranked = [...cands.values()]
    .map((c) => ({ ...c, score: c.score * (1 + 0.35 * (c.via.length - 1)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 18);

  const tops = await pool(ranked, 5, (c) => deezer.top(c.id, 5));
  onProgress?.(0.8);

  const picks = [];
  ranked.forEach((c, i) => {
    const tracks = (tops[i] || []).map(fromDeezerTrack).filter(isFresh);
    if (!tracks.length) return;
    // Not always the #1 hit: rotate by week so repeat artists surface different songs.
    const t = tracks[Math.min(tracks.length - 1, Object.keys(state.weeks).length % 2)];
    picks.push({ ...t, reason: `${[...new Set(c.via)].slice(0, 2).join(' と ')} が好きなあなたへ`, score: c.score });
  });

  // Two deep cuts from artists you already love.
  const deep = await pool(usable.slice(0, 3), 3, (s) => deezer.top(s.id, 15));
  usable.slice(0, 3).forEach((s, i) => {
    const t = (deep[i] || []).map(fromDeezerTrack).filter(isFresh)[2];
    if (t && picks.filter((p) => p.deep).length < 2) picks.push({ ...t, reason: `${s.name} のまだ聴いていない一曲`, deep: true, score: 0 });
  });

  const main = picks.filter((p) => !p.deep).slice(0, 10);
  const deepCuts = picks.filter((p) => p.deep);
  const out = [...main];
  deepCuts.forEach((d, i) => out.splice(Math.min(out.length, 3 + i * 4), 0, d));

  // Attach genres for the final list (one album lookup per pick).
  await pool(out, 5, async (t) => {
    if (!t.albumId) return;
    const al = await deezer.album(t.albumId);
    t.genres = (al.genres?.data || []).map((g) => g.name);
  });
  onProgress?.(1);
  return out.slice(0, 12);
}
