// Records a short clip from the mic stream and asks AudD which song it is.

const CLIP_MS = 8000;

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

export function recordClip(stream, ms = CLIP_MS) {
  return new Promise((resolve, reject) => {
    if (!window.MediaRecorder) return reject(new Error('このブラウザは録音に対応していません'));
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = (e) => reject(e.error || new Error('record error'));
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' }));
    rec.start();
    setTimeout(() => rec.state !== 'inactive' && rec.stop(), ms);
  });
}

export async function identify(blob, token) {
  const fd = new FormData();
  fd.append('api_token', token);
  fd.append('return', 'apple_music,deezer,spotify');
  const ext = blob.type.includes('mp4') || blob.type.includes('aac') ? 'm4a' : 'webm';
  fd.append('file', blob, `clip.${ext}`);
  const res = await fetch('https://api.audd.io/', { method: 'POST', body: fd });
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.error?.error_message || '認識に失敗しました');
  const r = json.result;
  if (!r) return null;
  const dz = r.deezer || {};
  const am = r.apple_music || {};
  const sp = r.spotify || {};
  const cover = dz.album?.cover_xl || dz.album?.cover_big
    || (am.artwork?.url ? am.artwork.url.replace('{w}', '600').replace('{h}', '600') : '')
    || sp.album?.images?.[0]?.url || '';
  return {
    title: r.title,
    artist: r.artist,
    album: r.album,
    cover,
    deezerId: dz.id || null,
    artistId: dz.artist?.id || null,
    albumId: dz.album?.id || null,
    genres: (am.genreNames || []).filter((g) => g !== 'Music' && g !== 'ミュージック'),
  };
}
