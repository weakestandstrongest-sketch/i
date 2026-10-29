// Local persistence. Everything lives in this browser's localStorage.

const KEY = 'resonance.v1';

const empty = () => ({
  plays: [],          // { id, title, artist, artistId, album, cover, genres[], deezerId, at, source, features }
  weeks: {},          // weekKey -> { generatedAt, tracks[] }
  liked: [],          // deezer track ids
  heard: [],          // deezer track ids marked "already heard" from recommendations
  ytLikes: [],        // { videoId, title, artist, artistId, cover, genres[], deezerId } liked on YouTube Music
  settings: { auddToken: '', autoListen: false, autoInterval: 45, lastfmUser: '', lastfmKey: '', lastfmCursor: 0, lastfmSyncedAt: 0, googleClientId: '', ytSyncedAt: 0, sensitivity: 1.5, sensBass: 1, sensMid: 1, sensTreble: 1, showMeter: false },
});

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const s = JSON.parse(raw);
    const base = empty();
    return { ...base, ...s, settings: { ...base.settings, ...(s.settings || {}) } };
  } catch {
    return empty();
  }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  listeners.forEach((fn) => fn(state));
}

export const store = {
  get: () => state,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  update(mutator) { mutator(state); save(); },
  replace(next) { state = { ...empty(), ...next, settings: { ...empty().settings, ...(next.settings || {}) } }; save(); },
  clear() { state = empty(); save(); },

  addPlay(play) {
    state.plays.unshift({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), at: Date.now(), ...play });
    save();
  },
  removePlay(id) { state.plays = state.plays.filter((p) => p.id !== id); save(); },
};

export function trackKey(title, artist) {
  const norm = (s) => (s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/feat\..*$|ft\..*$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return norm(artist) + '::' + norm(title);
}

// ISO-8601 week key, e.g. "2026-W44".
export function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Next Monday 00:00 local time — when a new weekly drop unlocks.
export function nextWeekStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + (8 - day));
  return d;
}
