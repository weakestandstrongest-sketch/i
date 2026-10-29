import { AudioEngine } from './audio.js';
import { Visualizer } from './visualizer.js';
import { SpectrumView } from './spectrum.js';
import { store, trackKey, weekKey, nextWeekStart } from './store.js';
import { recordClip, identify } from './recognizer.js';
import { deezer, fromDeezerTrack, pool, coverAt } from './deezer.js';
import { buildProfile, describePersona, generateWeekly } from './recommend.js';
import { fetchRecent, enrich } from './lastfm.js';
import { preloadGoogle, hasToken, signIn, fetchLikes, enrichLikes } from './youtube.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const engine = new AudioEngine();
engine.sensitivity = store.get().settings.sensitivity ?? 1.5;
{
  const st = store.get().settings;
  engine.bandSens = { bass: st.sensBass ?? 1, mid: st.sensMid ?? 1, treble: st.sensTreble ?? 1 };
}
let viz = null;
try { viz = new Visualizer($('#stage')); } catch (e) { console.error(e); }

/* ---------------- Render loop ---------------- */
let frameN = 0;
let renderErrorShown = false;
// Audio is analysed on its own ~60 Hz clock so beats are caught even when
// rendering drops frames on a slower phone.
setInterval(() => engine.update(performance.now()), 16);

function loop(t) {
  const f = engine.f;
  // A drawing error must never stop the loop (and with it the BPM display and meters);
  // show it once so it can be reported.
  try {
    viz?.render(t, f, engine.mode === 'idle' ? null : engine.freq, engine.ctx ? engine.ctx.sampleRate / 2 : 24000);
  } catch (e) {
    if (!renderErrorShown) { renderErrorShown = true; console.error(e); toast(`描画エラー: ${e.message}`, 8000); }
  }
  if (++frameN % 6 === 0 && currentView === 'live') {
    $('#bpmValue').textContent = f.bpm ? Math.round(f.bpm) : '--';
    $('#energyValue').textContent = Math.round(f.level * 100);
    $('#brightValue').textContent = Math.round(f.centroid * 100);
  }
  if (spectrumOn && currentView === 'live') {
    spectrum.draw(engine.freq, engine.ctx ? engine.ctx.sampleRate / 2 : 24000, f, t, engine.mode !== 'idle');
    if (frameN % 6 === 0) $('#specReadout').textContent = spectrum.readout || (engine.mode === 'idle' ? 'マイクをオンにすると表示されます' : '');
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/* ---------------- Intro ---------------- */
// The opening animation runs from js/intro.js, loaded separately so it starts before
// the 3D library has downloaded.

/* ---------------- Tabs ---------------- */
let currentView = 'live';
const tabs = [...document.querySelectorAll('.tab')];
function switchView(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const i = tabs.findIndex((t) => t.dataset.tab === name);
  $('#tabIndicator').style.transform = `translateX(${i * 88}px)`;
  document.body.classList.toggle('dim-stage', name !== 'live');
  viz?.setLowPower(name !== 'live');
  if (name === 'discover') renderDiscover();
  if (name === 'you') renderYou();
}
tabs.forEach((t) => t.addEventListener('click', () => switchView(t.dataset.tab)));

/* ---------------- Live: mic / file ---------------- */
const micBtn = $('#micBtn');
const tabBtn = $('#tabBtn');
const LISTENING = ['mic', 'tab'];   // sources that can be identified / auto-recorded
function syncSourceUI() {
  micBtn.classList.toggle('live', engine.mode === 'mic');
  tabBtn.classList.toggle('on', engine.mode === 'tab');
  if (!LISTENING.includes(engine.mode)) stopAuto();
}

micBtn.addEventListener('click', async () => {
  if (engine.mode === 'mic') {
    engine.stop();
    syncSourceUI();
    return;
  }
  try {
    await engine.startMic();
    syncSourceUI();
    toast('マイクで聴いています。他のアプリで音楽を流してください');
    if (store.get().settings.autoListen) startAuto();
  } catch (e) {
    toast(location.protocol !== 'https:' && location.hostname !== 'localhost'
      ? 'マイクには HTTPS 接続が必要です'
      : 'マイクを使用できませんでした');
  }
});

// PC only: listen to what another app or tab is playing, via screen/tab sharing with
// audio (Chrome, Edge, Brave). Works with headphones since nothing goes through the mic.
const isPhone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
tabBtn.hidden = isPhone || !navigator.mediaDevices?.getDisplayMedia;
tabBtn.addEventListener('click', async () => {
  if (engine.mode === 'tab') { engine.stop(); syncSourceUI(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,   // browsers require video to be requested; it's dropped right away
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (e) {
    toast(e?.name === 'NotAllowedError' || e?.name === 'AbortError'
      ? '共有がキャンセルされました'
      : 'このブラウザでは PC の音を取り込めませんでした。Chrome / Edge / Brave でお試しください', 6000);
    return;
  }
  const audio = stream.getAudioTracks();
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!audio.length) {
    toast('音声が共有されていません。共有画面で「タブの音声を共有」（画面全体ならシステム音声）をオンにしてください', 7000);
    return;
  }
  engine.startStream(new MediaStream(audio), 'tab');
  // Sharing ended from the browser's own "stop sharing" bar.
  audio[0].addEventListener('ended', () => { if (engine.mode === 'tab') { engine.stop(); syncSourceUI(); toast('PC の音の共有を終了しました'); } });
  syncSourceUI();
  setNow({ title: 'PC で再生中の音', artist: '共有したタブ・画面の音で動いています', cover: '' }, 'Listening');
  toast('PC の音で動かしています。イヤホンで聴いていても反応します');
  if (store.get().settings.autoListen) startAuto();
});

$('#fileBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stopAuto();
  engine.startFile(file);
  syncSourceUI();
  setNow({ title: file.name.replace(/\.[^.]+$/, ''), artist: 'ローカルファイル', cover: '' }, 'Visualizing');
  e.target.value = '';
});

function setNow(t, kicker = 'Now Listening') {
  $('#nowKicker').textContent = kicker;
  $('#nowTitle').textContent = t.title;
  $('#nowArtist').textContent = t.artist;
  $('#nowArt').style.backgroundImage = t.cover ? `url("${t.cover}")` : '';
  const card = $('#nowCard');
  card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop');
}

/* ---------------- Recognition ---------------- */
let identifying = false;
let lastCapture = null;

async function captureCurrentSong({ silent = false } = {}) {
  if (identifying) return;
  const { auddToken } = store.get().settings;
  if (!LISTENING.includes(engine.mode)) { if (!silent) toast('まずマイク（PC では PC の音）をオンにしてください'); return; }
  if (!auddToken) { if (!silent) { toast('設定で曲認識トークンを入力してください'); openSheet('#settingsSheet'); } return; }
  if (engine.f.level < 0.03) { if (!silent) toast('音が小さすぎます'); return; }

  identifying = true;
  $('#identifyBtn').classList.add('busy');
  $('#nowKicker').textContent = 'Listening…';
  try {
    const clip = await recordClip(engine.stream);
    const hit = await identify(clip, auddToken);
    if (!hit) { if (!silent) toast('曲を特定できませんでした'); $('#nowKicker').textContent = 'Now Listening'; return; }

    const key = trackKey(hit.title, hit.artist);
    // Same song still playing: don't double count it.
    if (lastCapture && lastCapture.key === key && Date.now() - lastCapture.at < 6 * 60 * 1000) {
      lastCapture.at = Date.now();
      setNow(hit);
      return;
    }
    lastCapture = { key, at: Date.now() };
    store.addPlay({ ...hit, source: 'mic', features: engine.takeFeatures() });
    setNow(hit, 'Recorded');
    toast(`記録しました：${hit.title}`);
  } catch (e) {
    if (!silent) toast(e.message || '認識に失敗しました');
    $('#nowKicker').textContent = 'Now Listening';
  } finally {
    identifying = false;
    $('#identifyBtn').classList.remove('busy');
  }
}
$('#identifyBtn').addEventListener('click', () => captureCurrentSong());

let autoTimer = null;
function startAuto() {
  stopAuto();
  const sec = store.get().settings.autoInterval || 45;
  captureCurrentSong({ silent: true });
  autoTimer = setInterval(() => captureCurrentSong({ silent: true }), sec * 1000);
}
function stopAuto() { clearInterval(autoTimer); autoTimer = null; }

const autoBox = $('#autoListen');
autoBox.checked = store.get().settings.autoListen;
autoBox.addEventListener('change', () => {
  store.update((s) => (s.settings.autoListen = autoBox.checked));
  if (autoBox.checked) {
    if (!store.get().settings.auddToken) { toast('自動記録には曲認識トークンが必要です'); openSheet('#settingsSheet'); }
    if (LISTENING.includes(engine.mode)) startAuto();
    else toast('マイクをオンにすると自動で記録を始めます');
  } else stopAuto();
});

/* ---------------- Discover ---------------- */
let rot = 0;           // carousel rotation in degrees
let focusIdx = 0;
let weekTracks = [];
let generating = false;
const audioEl = $('#previewAudio');

async function ensureWeek(force = false) {
  const wk = weekKey();
  const s = store.get();
  if (!force && s.weeks[wk]) return s.weeks[wk];
  if (generating) return null;
  generating = true;
  showCarouselState('loading');
  try {
    const stateForGen = force ? { ...s, weeks: Object.fromEntries(Object.entries(s.weeks).filter(([k]) => k !== wk)) } : s;
    const tracks = await generateWeekly(stateForGen);
    store.update((st) => (st.weeks[wk] = { generatedAt: Date.now(), basedOn: st.plays.length + st.ytLikes.length, tracks }));
    return store.get().weeks[wk];
  } catch (e) {
    toast('提案の生成に失敗しました。通信状況を確認してください');
    return null;
  } finally {
    generating = false;
  }
}

function showCarouselState(kind) {
  const empty = $('#carouselEmpty');
  const p = empty.querySelector('p');
  if (kind === 'loading') {
    empty.hidden = false;
    empty.classList.add('carousel-loading');
    p.innerHTML = 'あなたの好みを分析して<br />今週の曲を選んでいます…';
    $('#carousel').innerHTML = '';
    $('#focusPanel').hidden = true;
  } else if (kind === 'empty') {
    empty.hidden = false;
    empty.classList.remove('carousel-loading');
    p.innerHTML = 'まだ提案がありません。<br />Live で曲を記録するか、設定からデモデータを読み込んでください。';
  } else {
    empty.hidden = true;
    empty.classList.remove('carousel-loading');
  }
}

async function renderDiscover(force = false) {
  const wk = weekKey();
  $('#weekLabel').textContent = `Week ${wk.split('-W')[1]} · ${new Date().getFullYear()}`;
  const s = store.get();
  const week = s.weeks[wk] || (s.plays.length || force ? await ensureWeek(force) : null);
  if (!week || !week.tracks.length) {
    weekTracks = [];
    $('#carousel').innerHTML = '';
    $('#focusPanel').hidden = true;
    showCarouselState('empty');
  } else {
    weekTracks = week.tracks;
    showCarouselState('ready');
    $('#discoverSub').textContent = `${s.plays.length} 件の記録をもとに、まだ聴いたことのない ${weekTracks.length} 曲を選びました。`;
    buildCarousel();
  }
  renderPastWeeks();
}

const TINTS = [
  'linear-gradient(160deg,#ff8a00,#ff2d7a 55%,#8b3dff)',
  'linear-gradient(160deg,#2bd9ff,#2f7bff 50%,#8b3dff)',
  'linear-gradient(160deg,#9dff3d,#1fd1a0 50%,#ff8a00)',
  'linear-gradient(160deg,#ff2d7a,#8b3dff 50%,#2bd9ff)',
  'linear-gradient(160deg,#ffd200,#ff8a00 45%,#ff2d7a)',
  'linear-gradient(160deg,#8b3dff,#ff2d7a 60%,#ffb300)',
];

function buildCarousel() {
  const n = weekTracks.length;
  const step = 360 / n;
  const radius = Math.round((250 / 2) / Math.tan(Math.PI / n));
  const s = store.get();
  const el = $('#carousel');
  el.innerHTML = weekTracks.map((t, i) => `
    <div class="card ${s.liked.includes(t.deezerId) ? 'liked' : ''}" data-i="${i}" style="transform: rotateY(${i * step}deg) translateZ(${radius}px)">
      <div class="card-bg" style="background-image:url('${esc(coverAt(t.cover, 250))}')"></div>
      <div class="card-tint" style="background:${TINTS[i % TINTS.length]}"></div>
      <div class="card-sheen"></div>
      <div class="card-content">
        <div class="card-top"><span class="badge">${t.deep ? 'Deep Cut' : 'New'}</span><span class="badge badge-like">${s.liked.includes(t.deezerId) ? '♥' : esc((t.genres || [])[0] || '')}</span></div>
        <div class="card-num">${String(i + 1).padStart(2, '0')}<sup>/${n}</sup></div>
        <div>
          <div class="card-cover" style="background-image:url('${esc(coverAt(t.cover, 250))}')"></div>
          <div class="card-title" style="margin-top:12px">${esc(t.title)}</div>
          <div class="card-artist">${esc(t.artist)}</div>
        </div>
      </div>
    </div>`).join('');
  el.dataset.radius = radius;
  el.dataset.step = step;
  focusIdx = Math.min(focusIdx, n - 1);
  rot = rotTarget = -focusIdx * step;
  rotVel = 0;
  applyRot();
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
    if (dragMoved) return;
    const i = +c.dataset.i;
    if (i === focusIdx) togglePreview();
    else snapTo(i);
  }));
}

function applyRot() {
  const el = $('#carousel');
  const radius = +el.dataset.radius || 0;
  el.style.transform = `translateZ(${-radius}px) rotateY(${rot}deg)`;
  const n = weekTracks.length;
  const step = +el.dataset.step;
  const idx = ((Math.round(-rot / step) % n) + n) % n;
  if (idx !== focusIdx || $('#focusPanel').hidden) {
    el.querySelectorAll('.card').forEach((c) => c.classList.toggle('focus', +c.dataset.i === idx));
    focusIdx = idx;
    updateFocus();
  }
}

// Ring physics: the ring follows the finger 1:1 while dragging, keeps the flick's
// momentum on release, and settles on a card with a critically damped spring.
let rotTarget = 0, rotVel = 0, rotAnim = 0, rotLastT = 0;
function animateRing() {
  if (rotAnim) return;
  rotLastT = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.033, (now - rotLastT) / 1000);
    rotLastT = now;
    if (!dragStart) {
      const k = 200, c = 2 * Math.sqrt(k);     // stiffness, critical damping
      rotVel += (k * (rotTarget - rot) - c * rotVel) * dt;
      rot += rotVel * dt;
      if (Math.abs(rotTarget - rot) < 0.02 && Math.abs(rotVel) < 0.5) { rot = rotTarget; rotVel = 0; }
    }
    applyRot();
    if (dragStart || rot !== rotTarget) rotAnim = requestAnimationFrame(tick);
    else rotAnim = 0;
  };
  rotAnim = requestAnimationFrame(tick);
}

function snapTo(i) {
  const n = weekTracks.length;
  const step = 360 / n;
  // Shortest way round the ring.
  const cur = Math.round(-rotTarget / step);
  let delta = ((i - cur) % n + n) % n;
  if (delta > n / 2) delta -= n;
  rotTarget = -(cur + delta) * step;
  animateRing();
}

function updateFocus() {
  const t = weekTracks[focusIdx];
  if (!t) return;
  const s = store.get();
  $('#focusPanel').hidden = false;
  $('#focusReason').textContent = t.reason || '';
  $('#focusTitle').textContent = t.title;
  $('#focusArtist').textContent = t.artist + (t.genres?.length ? ` · ${t.genres.slice(0, 2).join(' / ')}` : '');
  const liked = s.liked.includes(t.deezerId);
  $('#likeBtn').textContent = liked ? '♥ 好き' : '♡ 好き';
  $('#likeBtn').classList.toggle('on', liked);
  const q = encodeURIComponent(`${t.artist} ${t.title}`);
  $('#openApple').href = `https://music.apple.com/search?term=${q}`;
  $('#openSpotify').href = `https://open.spotify.com/search/${q}`;
  $('#openYoutube').href = `https://music.youtube.com/search?q=${q}`;
  if (!audioEl.paused && audioEl.dataset.id !== String(t.deezerId)) stopPreview();
  $('#previewBtn').textContent = !audioEl.paused ? '❚❚ 停止' : '▶︎ 試聴';
  $('#previewBtn').disabled = !t.deezerId;
}

// A few ms of silence. Playing it inside the tap unlocks the element on iOS, so the
// real preview can start after the fresh URL arrives asynchronously.
const SILENCE = (() => {
  const n = 400;                                   // 50 ms at 8 kHz, 16-bit mono
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, t) => [...t].forEach((ch, i) => buf.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, 8000, true); buf.setUint32(28, 16000, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();
let previewReq = 0;

function togglePreview() {
  const t = weekTracks[focusIdx];
  if (!t?.deezerId) return;
  if (!audioEl.paused && audioEl.dataset.id === String(t.deezerId)) { stopPreview(); return; }
  const req = ++previewReq;
  audioEl.src = SILENCE;
  audioEl.play().catch(() => {});
  audioEl.dataset.id = t.deezerId;
  $('#previewBtn').textContent = '読み込み中…';
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('playing', +c.dataset.i === focusIdx));
  // Deezer preview links are signed and expire, so stored ones stop working; get a fresh one.
  deezer.track(t.deezerId)
    .then((d) => {
      if (req !== previewReq) return;
      if (!d.preview) throw new Error('no preview');
      t.preview = d.preview;
      audioEl.src = d.preview;
      return audioEl.play().then(() => { if (req === previewReq) $('#previewBtn').textContent = '❚❚ 停止'; });
    })
    .catch(() => {
      if (req !== previewReq) return;
      stopPreview();
      toast('この曲は試聴できませんでした');
    });
}
function stopPreview() {
  previewReq++;
  audioEl.pause();
  $('#previewBtn').textContent = '▶︎ 試聴';
  document.querySelectorAll('.card.playing').forEach((c) => c.classList.remove('playing'));
}
audioEl.addEventListener('ended', stopPreview);
$('#previewBtn').addEventListener('click', togglePreview);

$('#likeBtn').addEventListener('click', () => {
  const t = weekTracks[focusIdx];
  if (!t) return;
  store.update((s) => {
    const i = s.liked.indexOf(t.deezerId);
    if (i >= 0) s.liked.splice(i, 1); else s.liked.push(t.deezerId);
  });
  const liked = store.get().liked.includes(t.deezerId);
  if (liked) {
    // A like counts as a listen so it shapes next week's picks.
    store.addPlay({ ...t, source: 'like', features: {} });
    toast('好みに追加しました。来週の提案に反映されます');
  }
  buildCarousel();
});

$('#heardBtn').addEventListener('click', () => {
  const t = weekTracks[focusIdx];
  if (!t) return;
  store.update((s) => { if (!s.heard.includes(t.deezerId)) s.heard.push(t.deezerId); });
  toast('「聴いたことがある」として記録しました');
});

$('#regenBtn').addEventListener('click', async () => {
  stopPreview();
  focusIdx = 0;
  await ensureWeek(true);
  renderDiscover();
});

// Drag / swipe to spin the ring.
const DEG_PER_PX = 0.3;
let dragStart = null, dragMoved = false;
const wrap = document.querySelector('.carousel-wrap');
wrap.addEventListener('pointerdown', (e) => {
  if (!weekTracks.length) return;
  dragStart = { x: e.clientX, rot, lastX: e.clientX, lastT: performance.now() };
  dragMoved = false;
  rotVel = 0;
});
window.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const dx = e.clientX - dragStart.x;
  if (!dragMoved && Math.abs(dx) > 6) {
    dragMoved = true;
    try { wrap.setPointerCapture(e.pointerId); } catch {}
    animateRing();
  }
  if (!dragMoved) return;
  const now = performance.now();
  const dt = Math.max(1, now - dragStart.lastT);
  // Smoothed finger velocity in deg/s for the flick.
  rotVel = rotVel * 0.6 + (((e.clientX - dragStart.lastX) * DEG_PER_PX) / dt) * 1000 * 0.4;
  dragStart.lastX = e.clientX; dragStart.lastT = now;
  rot = dragStart.rot + dx * DEG_PER_PX;
  rotTarget = rot;
});
function endDrag() {
  if (!dragStart) return;
  const wasDrag = dragMoved;
  // Ignore stale velocity if the finger rested before lifting.
  if (performance.now() - dragStart.lastT > 120) rotVel = 0;
  dragStart = null;
  if (wasDrag) {
    const step = 360 / weekTracks.length;
    // Project where the flick would coast to, then land on the nearest card.
    const projected = rot + rotVel * 0.22;
    rotTarget = Math.round(projected / step) * step;
    animateRing();
    setTimeout(() => (dragMoved = false), 50);
  }
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

function renderPastWeeks() {
  const s = store.get();
  const wk = weekKey();
  const past = Object.entries(s.weeks).filter(([k]) => k !== wk).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 8);
  $('#pastWeeks').innerHTML = past.length ? `<h4>これまでの提案</h4>` + past.map(([k, w]) => `
    <div class="past-week">
      <div class="past-week-label">Week ${k.split('-W')[1]} · ${k.split('-W')[0]}</div>
      <div class="mini-row">${w.tracks.map((t) => `
        <a class="mini" href="https://music.apple.com/search?term=${encodeURIComponent(t.artist + ' ' + t.title)}" target="_blank" rel="noopener" style="text-decoration:none">
          <div class="mini-cover" style="background-image:url('${esc(coverAt(t.cover, 250))}')"></div>
          <div class="mini-t">${esc(t.title)}</div><div class="mini-a">${esc(t.artist)}</div>
        </a>`).join('')}</div>
    </div>`).join('') : '';
}

function tickCountdown() {
  const ms = nextWeekStart() - Date.now();
  const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60;
  $('#countdownText').textContent = `次の提案まで ${d}日 ${h}時間 ${m}分`;
}
tickCountdown();
setInterval(tickCountdown, 30000);

/* ---------------- You: fan of cards on a half circle ---------------- */
const YG = {
  a: 'radial-gradient(120% 90% at 20% 15%, #ffd200 0%, #ff8a00 30%, #ff2d7a 70%, #5a0b3a 100%)',
  b: 'radial-gradient(120% 90% at 80% 10%, #c08bff 0%, #8b3dff 35%, #3d1bff 70%, #0b0a3a 100%)',
  c: 'radial-gradient(120% 90% at 30% 85%, #e4ff6a 0%, #9dff3d 30%, #1fd1a0 65%, #063a35 100%)',
  d: 'radial-gradient(120% 90% at 60% 20%, #a6f2ff 0%, #2bd9ff 30%, #2f7bff 65%, #0a1a4a 100%)',
  e: 'radial-gradient(120% 90% at 50% 0%, #ffb3d1 0%, #ff2d7a 35%, #8b3dff 75%, #1a0630 100%)',
  f: 'radial-gradient(120% 90% at 15% 50%, #ffe08a 0%, #ff8a00 35%, #c2185b 75%, #2a0510 100%)',
  g: 'radial-gradient(120% 90% at 70% 80%, #8affd6 0%, #1fd1a0 30%, #2f7bff 70%, #07122e 100%)',
  h: 'radial-gradient(120% 90% at 40% 20%, #ff9de2 0%, #b06bff 35%, #2bd9ff 80%, #061830 100%)',
  i: 'radial-gradient(120% 90% at 50% 90%, #ffd0a8 0%, #ff6a3d 35%, #6b2bd9 80%, #12062a 100%)',
  j: 'radial-gradient(120% 90% at 30% 20%, #ffb0b0 0%, #ff1f3d 35%, #8b0a3a 75%, #1a0410 100%)',
};
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const BPM_BUCKETS = [[0, 90, '〜89'], [90, 110, '90–109'], [110, 130, '110–129'], [130, 150, '130–149'], [150, 999, '150+']];
const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);

function youStats(s) {
  const p = buildProfile(s);
  const plays = s.plays;
  const weekday = [1, 2, 3, 4, 5, 6, 0].map((d) => [WEEKDAYS[d], plays.filter((x) => new Date(x.at).getDay() === d).length]);
  const bpms = plays.map((x) => x.features?.bpm).filter(Boolean);
  const bpmDist = BPM_BUCKETS.map(([lo, hi, l]) => [l, bpms.filter((b) => b >= lo && b < hi).length]);
  const daypart = (h) => (h >= 5 && h < 11 ? 0 : h >= 11 && h < 18 ? 1 : 2);
  const bright = [[], [], []];
  plays.forEach((x) => x.features?.brightness != null && bright[daypart(new Date(x.at).getHours())].push(x.features.brightness));
  const brightBy = bright.map((a) => (a.length ? Math.round((a.reduce((m, n) => m + n, 0) / a.length) * 100) : null));
  const gTotal = p.genres.reduce((m, [, w]) => m + w, 0);
  const genres = p.genres.slice(0, 6).map(([g, w]) => [g, pct(w, gTotal)]);
  const peak = p.hours.indexOf(Math.max(...p.hours));
  const night = [20, 21, 22, 23, 0, 1, 2, 3].reduce((m, h) => m + p.hours[h], 0);
  const morning = [5, 6, 7, 8, 9, 10].reduce((m, h) => m + p.hours[h], 0);
  const weeks = Object.values(s.weeks);
  const suggested = weeks.reduce((m, w) => m + w.tracks.length, 0);
  // Persona = time of day × tempo.
  const when = plays.length && night / plays.length > 0.4 ? 'Night' : plays.length && morning / plays.length > 0.35 ? 'Morning' : 'All-day';
  const how = !p.bpm ? 'Listener' : p.bpm >= 128 ? 'Raver' : p.bpm >= 100 ? 'Groover' : 'Drifter';
  const top5 = p.artists.slice(0, 5).reduce((m, a) => m + a.count, 0);
  return { p, weekday, bpmDist, bpmN: bpms.length, brightBy, genres, peak, night, suggested, weeks: weeks.length, persona: `${when} ${how}`, when, how, top5 };
}

const ySpark = (vals) => (vals.some((v) => v > 0)
  ? `<div class="yc-spark">${vals.map((v) => `<i style="height:${Math.max(8, (v / Math.max(...vals)) * 100)}%"></i>`).join('')}</div>` : '');
const yRows = (rows, unit) => {
  const m = Math.max(1, ...rows.map((r) => r[1]));
  return `<div class="rows">${rows.map(([n, v], i) => `
    <div class="row"><span class="rk">${i + 1}</span><span class="nm">${esc(n)}</span><span class="ct">${rows[i][2] ?? `${v}${unit}`}</span>
    <span class="tr"><i style="width:${(v / m) * 100}%;animation-delay:${i * 70}ms"></i></span></div>`).join('')}</div>`;
};
const yCols = (rows) => {
  const m = Math.max(1, ...rows.map((r) => r[1]));
  const peak = rows.findIndex((r) => r[1] === m);
  return `<div class="vbars">${rows.map(([n, v], i) => `
    <div class="vbar ${i === peak ? '' : 'dim'}" title="${n}: ${v}">${i === peak ? `<em>${v}</em>` : ''}<i style="height:${(v / m) * 100}%;animation-delay:${i * 50}ms"></i><span>${n}</span></div>`).join('')}</div>`;
};
const EMPTY = '<p class="ys-lede">まだ記録がありません。Live で曲を記録するか、設定からデモデータを読み込んでください。</p>';

function buildYouCards(s) {
  const st = youStats(s);
  const { p } = st;
  const has = p.plays > 0;
  const top = p.artists[0];
  const bestDay = st.weekday.reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);
  const brightN = p.brightness != null ? Math.round(p.brightness * 100) : null;
  const persona = describePersona(p);
  return [
    { g: YG.a, glow: '#ff2d7a', label: '記録した再生', sub: 'Plays', num: has ? p.plays : '—', spark: st.weekday.map((d) => d[1]), cap: '',
      desc: 'マイク・手動追加・♡ から記録した曲の数',
      detail: () => (has ? `<p class="ys-lede">いちばん多いのは<b>${bestDay[0]}曜日</b>で、${bestDay[1]}回です。</p>
        <div class="ys-block"><h3>曜日別の再生数</h3>${yCols(st.weekday)}</div>` : EMPTY) },
    { g: YG.b, glow: '#8b3dff', label: 'トップアーティスト', sub: 'Top Artist', word: top ? esc(top.name) : '—', cap: top ? `${top.count}回${top.likes ? ` · ♥${top.likes}` : ''} · ${p.artists.length}組中` : '',
      desc: `よく聴いた ${p.artists.length} 組のうち上位`,
      detail: () => (top ? `<p class="ys-lede">上位5組で全体の<b>${pct(st.top5, p.plays)}%</b>。${pct(st.top5, p.plays) > 45 ? '好みがはっきりしているタイプです。' : 'いろいろなアーティストを幅広く聴いています。'}</p>
        <div class="ys-block"><h3>再生回数${p.likes ? ' と高評価' : ''}</h3>${yRows(p.artists.slice(0, 8).map((a) => [a.name, a.count + (a.likes || 0), `${a.count}回${a.likes ? ` · ♥${a.likes}` : ''}`]), '')}</div>` : EMPTY) },
    { g: YG.c, glow: '#1fd1a0', label: '平均テンポ', sub: 'BPM', num: p.bpm ?? '—', spark: st.bpmDist.map((b) => b[1]), cap: '',
      desc: 'マイクで拾った曲のビートから推定',
      detail: () => (st.bpmN ? `<p class="ys-lede">いちばん多いのは<b>${st.bpmDist.reduce((a, b) => (b[1] > a[1] ? b : a))[0]} BPM</b>。${p.bpm >= 128 ? '速いビートで体を動かしたいタイプです。' : p.bpm >= 100 ? '踊れるけれど速すぎない、グルーヴ重視のテンポです。' : 'ゆったりしたテンポが落ち着くタイプです。'}</p>
        <div class="ys-block"><h3>テンポの分布（曲数）</h3>${yCols(st.bpmDist)}</div>` : '<p class="ys-lede">テンポはマイクで記録した曲から計算します。Live でマイクをオンにして記録すると表示されます。</p>') },
    { g: YG.d, glow: '#2bd9ff', label: '音の明るさ', sub: 'Brightness', num: brightN ?? '—', unit: brightN != null ? '%' : '', cap: brightN == null ? '' : brightN > 55 ? 'きらびやか' : brightN > 35 ? 'バランス型' : '深く温かい',
      desc: '高音域の多さ。低いほど深く温かい音色',
      detail: () => (brightN != null ? `<p class="ys-lede">${brightN > 55 ? '高音のきらめきが多い、明るい音が好みです。' : brightN > 35 ? '低音の厚みと高音のきらめきのバランスが取れています。' : '低音が豊かで温かい音色が好みです。'}</p>
        <div class="ys-block"><h3>明るさ</h3><div class="gauge"><b style="left:${brightN}%"></b></div><div class="gauge-ends"><span>深い・温かい</span><span>きらびやか</span></div></div>
        <div class="ys-block"><h3>時間帯ごとの平均</h3><div class="kv">${['朝', '昼', '夜'].map((l, i) => `<div><b>${st.brightBy[i] ?? '—'}${st.brightBy[i] != null ? '%' : ''}</b><span>${l}</span></div>`).join('')}</div></div>`
        : '<p class="ys-lede">明るさはマイクで記録した曲から計算します。</p>') },
    { g: YG.e, glow: '#ff2d7a', label: 'メインのジャンル', sub: 'Genre', word: st.genres[0] ? esc(st.genres[0][0]) : '—', cap: st.genres[0] ? `全体の${st.genres[0][1]}%` : '',
      desc: '記録した曲のジャンル構成（最近の再生ほど重く数えます）',
      detail: () => (st.genres.length ? `<p class="ys-lede"><b>${esc(st.genres[0][0])}</b>を軸に${st.genres[1] ? `、${esc(st.genres[1][0])}も多く聴いています。` : '聴いています。'}</p>
        <div class="ys-block"><h3>割合</h3>${yRows(st.genres, '%')}</div>` : '<p class="ys-lede">ジャンルは曲を記録したときに取得します。</p>') },
    { g: YG.f, glow: '#ff8a00', label: 'よく聴く時間', sub: 'Peak Hour', num: has ? st.peak : '—', unit: has ? '時' : '', spark: has ? p.hours.slice(16).concat(p.hours.slice(0, 2)) : [], cap: '',
      desc: '時間帯ごとの再生数',
      detail: () => (has ? `<p class="ys-lede">再生の<b>${pct(st.night, p.plays)}%</b>が20時〜4時。${pct(st.night, p.plays) > 40 ? '夜にじっくり聴くタイプです。' : '一日のいろいろな時間に聴いています。'}</p>
        <div class="ys-block"><h3>時間帯別の再生数</h3>
          <div class="vbars hours24">${p.hours.map((v, i) => `<div class="vbar ${i === st.peak ? '' : 'dim'}" title="${i}時: ${v}"><i style="height:${(v / Math.max(1, ...p.hours)) * 100}%;animation-delay:${i * 18}ms"></i></div>`).join('')}</div>
          <div class="axis"><span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>23時</span></div></div>` : EMPTY) },
    { g: YG.g, glow: '#2f7bff', label: 'あなたのタイプ', sub: 'Persona', word: has ? st.persona.replace(' ', '<br>') : '—', cap: 'テンポ × 時間帯',
      desc: '記録全体から見えたリスナー像',
      detail: () => (persona ? `<p class="ys-lede">${persona}</p>
        <div class="ys-block"><h3>キーワード</h3><div class="tags">${[{ Night: '夜型', Morning: '朝型', 'All-day': '一日中' }[st.when], p.bpm ? `${p.bpm} BPM` : null, ...st.genres.slice(0, 2).map((g) => esc(g[0])), brightN != null ? (brightN > 55 ? '明るい音色' : brightN > 35 ? 'バランス型の音色' : '温かい音色') : null].filter(Boolean).map((t) => `<span>${t}</span>`).join('')}</div></div>`
        : '<p class="ys-lede">3曲以上記録すると、あなたのリスナー像が見えてきます。</p>') },
    { g: YG.h, glow: '#b06bff', label: '見つけた曲', sub: 'Discoveries', num: s.liked.length, cap: `提案${st.suggested}曲中 ♡`,
      desc: 'これまでの毎週の提案から',
      detail: () => `<p class="ys-lede">${st.suggested ? `${st.weeks}週分で ${st.suggested} 曲を提案し、<b>${s.liked.length} 曲</b>を好きに追加しました。` : 'Discover で毎週の提案が届くと、ここに記録されます。'}</p>
        <div class="ys-block"><h3>これまで</h3><div class="kv"><div><b>${st.suggested}</b><span>提案</span></div><div><b>${s.liked.length}</b><span>好き</span></div><div><b>${s.heard.length}</b><span>聴いたことあり</span></div></div></div>` },
    { g: YG.j, glow: '#ff1f3d', label: '高評価した曲', sub: 'YouTube Likes', num: s.ytLikes.length, cap: s.settings.ytSyncedAt ? `同期: ${fmtWhen(s.settings.ytSyncedAt)}` : 'YouTube Music と連携',
      desc: 'YouTube Music で 👍 した曲。好みの分析とおすすめに使います',
      detail: () => `<div class="ys-block"><div class="ys-block-head"><h3>${s.ytLikes.length ? `${s.ytLikes.length} 曲` : 'まだありません'}</h3><button class="link-btn" data-act="yt">YouTube から同期</button></div>
        <ul class="history">${s.ytLikes.slice(0, 150).map((l) => `
          <li><div class="h-cover" style="background-image:url('${esc(coverAt(l.cover, 250))}')"></div>
          <div class="h-text"><div class="h-title">${esc(l.title)}</div><div class="h-sub">${esc(l.artist)}${l.genres?.length ? ` · ${esc(l.genres[0])}` : ''}</div></div></li>`).join('')
          || '<p class="muted">設定で Google のクライアント ID を入れて同期すると、ここに表示されます。</p>'}</ul></div>` },
    { g: YG.i, glow: '#ff6a3d', label: '履歴', sub: 'History', num: s.plays.length, cap: s.plays[0] ? `最新: ${esc(s.plays[0].title)}` : '曲を手動で追加',
      desc: '記録した曲の一覧。× で削除できます',
      detail: () => `<div class="ys-block"><div class="ys-block-head"><h3>最近の記録</h3><button class="link-btn" data-act="add">＋ 手動で追加</button></div>
        <ul class="history">${s.plays.slice(0, 100).map((pl) => `
          <li><div class="h-cover" style="background-image:url('${esc(coverAt(pl.cover, 250))}')"></div>
          <div class="h-text"><div class="h-title">${esc(pl.title)}</div>
          <div class="h-sub">${esc(pl.artist)} · ${fmtWhen(pl.at)}${pl.features?.bpm ? ` · ${pl.features.bpm} BPM` : ''}</div></div>
          <button class="h-del" data-id="${pl.id}" aria-label="削除">×</button></li>`).join('') || '<p class="muted">まだ記録がありません</p>'}</ul></div>` },
  ];
}

const wheel = $('#wheel');
const Y_STEP = 19;   // degrees between cards on the arc
let yCards = [], yEls = [];
let yR = 520, yTop = 18;
const Y_CARD_H = 252;
let yPos = 0, yTarget = 0, yVel = 0, yDragging = false, yStartX = 0, yStartPos = 0, yLastX = 0, yMoved = false;
let yIntro = 0, yLoop = false, yShown = -1;
let ysOpen = false, ysIdx = -1;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function renderYou() {
  yCards = buildYouCards(store.get());
  yEls.forEach((el) => el.remove());
  yEls = yCards.map((c, i) => {
    const el = document.createElement('button');
    el.className = 'ycard';
    el.style.background = c.g;
    el.setAttribute('aria-label', `${c.label}を開く`);
    const big = c.word != null
      ? `<div class="yc-num word">${c.word}</div>`
      : `<div class="yc-num">${c.num}${c.unit ? `<sup>${c.unit}</sup>` : ''}</div>`;
    const foot = c.spark && c.spark.some((v) => v > 0) ? ySpark(c.spark) : `<div class="yc-cap">${c.cap || ''}</div>`;
    el.innerHTML = `<div class="yc-in"><div class="yc-label">${c.label}<small>${c.sub}</small></div>${big}${foot}</div>`;
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openYouCard(i, true); } });
    wheel.appendChild(el);
    return el;
  });
  yShown = -1;
  measureWheel();
  if (!yLoop) { yIntro = performance.now(); yLoop = true; requestAnimationFrame(yTick); }
}

function measureWheel() {
  const w = wheel.clientWidth, h = wheel.clientHeight;
  if (!w) return;
  yR = Math.max(420, Math.min(700, w * 1.25));
  yTop = Math.max(14, h * 0.1);
  yEls.forEach((el) => (el.style.top = yTop + 'px'));
  const pivotY = yTop + Y_CARD_H / 2 + yR;
  // A ring of ticks concentric with the fan, peeking up under the cards.
  const dialR = yR - Y_CARD_H / 2 - 34;
  const size = dialR * 2;
  const dial = $('#dial');
  Object.assign(dial.style, { width: size + 'px', height: size + 'px', marginLeft: -dialR + 'px', top: (pivotY - dialR) + 'px' });
  let ticks = '';
  // Ticks follow the card spacing: a long tick every Y_STEP degrees (one per card) with
  // four short ones between, centred on the needle, so a long tick sits under the
  // needle whenever the wheel rests on a card.
  const sub = Y_STEP / 5;
  for (let j = -Math.floor(180 / sub); j <= Math.floor(180 / sub); j++) {
    const k = j * sub;
    const major = j % 5 === 0;
    const a = (k - 90) * Math.PI / 180;
    const r1 = dialR - (major ? 16 : 9);
    ticks += `<line x1="${dialR + Math.cos(a) * r1}" y1="${dialR + Math.sin(a) * r1}" x2="${dialR + Math.cos(a) * dialR}" y2="${dialR + Math.sin(a) * dialR}" stroke="rgba(255,255,255,${major ? 0.55 : 0.22})" stroke-width="${major ? 2 : 1.2}" stroke-linecap="round"/>`;
  }
  dial.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${dialR}" cy="${dialR}" r="${dialR - 30}" fill="rgba(255,255,255,.04)"/>${ticks}</svg>`;
  $('#needle').style.top = (pivotY - dialR - 4) + 'px';
  $('#focusLabel').style.top = Math.min(pivotY - dialR + 34, h - 54) + 'px';
}
new ResizeObserver(measureWheel).observe(wheel);

const yWrapOff = (i, pos) => { const n = yEls.length; return ((i - pos + n / 2) % n + n) % n - n / 2; };

function yTick(now) {
  if (currentView !== 'you' && !ysOpen) { yLoop = false; return; }
  if (!yDragging) {
    const prev = yPos;
    yPos += (yTarget - yPos) * (reducedMotion ? 1 : 0.12);
    yVel = yPos - prev;
  }
  const ei = reducedMotion ? 1 : 1 - Math.pow(1 - Math.min(1, (now - yIntro) / 1300), 3);
  yEls.forEach((el, i) => {
    const off = yWrapOff(i, yPos);
    const deg = off * Y_STEP * ei;   // intro: the fan opens from a stack
    const a = deg * Math.PI / 180;
    const near = Math.max(0, 1 - Math.abs(off));
    const vis = 1 - Math.min(1, Math.max(0, (Math.abs(off) - 3) / 0.8));
    el.style.transform = `translate3d(${Math.sin(a) * yR}px, ${yR - Math.cos(a) * yR - near * 14}px, ${-Math.abs(off) * 40}px) rotate(${deg}deg) rotateY(${-off * 14}deg) scale(${0.86 + near * 0.16})`;
    el.style.opacity = vis;
    el.style.visibility = vis <= 0 || (ysOpen && i === ysIdx) ? 'hidden' : 'visible';
    el.style.zIndex = String(100 - Math.round(Math.abs(off) * 10));
    el.style.filter = `brightness(${0.62 + near * 0.38}) saturate(${0.85 + near * 0.25})`;
    el.tabIndex = Math.round(off) === 0 ? 0 : -1;
  });
  const svg = $('#dial svg');
  // The tick pattern repeats every card, so only the offset from the nearest card is needed
  // (this also keeps the seam of the ring at the bottom, out of view).
  if (svg) svg.style.transform = `rotate(${-(yPos - Math.round(yPos)) * Y_STEP}deg)`;
  const n = yEls.length;
  const f = ((Math.round(yPos) % n) + n) % n;
  if (f !== yShown && yCards[f]) {
    yShown = f;
    $('#flTitle').textContent = yCards[f].label;
    $('#flSub').textContent = 'タップして開く';
    $('#wheelGlow').style.background = yCards[f].glow;
  }
  requestAnimationFrame(yTick);
}

wheel.addEventListener('pointerdown', (e) => {
  if (ysOpen) return;
  yDragging = true; yMoved = false;
  yStartX = yLastX = e.clientX; yStartPos = yPos;
  wheel.setPointerCapture(e.pointerId);
});
wheel.addEventListener('pointermove', (e) => {
  if (!yDragging) return;
  if (Math.abs(e.clientX - yStartX) > 6) yMoved = true;
  yPos = yStartPos - (e.clientX - yStartX) / 120;
  yVel = -(e.clientX - yLastX) / 120;
  yLastX = e.clientX;
});
wheel.addEventListener('pointerup', (e) => {
  if (!yDragging) return;
  yDragging = false;
  if (yMoved) { yTarget = Math.round(yPos + yVel * 6); return; }
  // Tap: the centre card opens, a side card turns to the front.
  const hit = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList?.contains('ycard'));
  const i = yEls.indexOf(hit);
  if (i < 0) return;
  const off = yWrapOff(i, yPos);
  if (Math.abs(off) < 0.5) openYouCard(i);
  else yTarget = Math.round(yPos + off);
});
addEventListener('keydown', (e) => {
  if (ysOpen) { if (e.key === 'Escape') closeYouCard(); return; }
  if (currentView !== 'you') return;
  if (e.key === 'ArrowRight') yTarget = Math.round(yTarget) + 1;
  if (e.key === 'ArrowLeft') yTarget = Math.round(yTarget) - 1;
});

/* Expand: grow from the card's rectangle to full screen, then reveal the detail. */
const ysheet = $('#ysheet');
const ysClip = (r) => `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px round 26px)`;

function fillYouSheet(i) {
  const c = yCards[i];
  const big = c.word != null
    ? `<div class="ys-big word">${c.word}</div>`
    : `<div class="ys-big">${c.num}${c.unit ? `<sup>${c.unit}</sup>` : ''}</div>`;
  $('#ysheetBody').innerHTML = `<p class="ys-kicker">${c.sub}</p><h2 class="ys-title" id="ysTitle">${c.label}</h2>${big}<p class="ys-lede" style="margin-bottom:8px">${c.desc}</p>${c.detail()}`;
}

function openYouCard(i, viaKey = false) {
  ysIdx = i; ysOpen = true;
  const rect = yEls[i].getBoundingClientRect();
  $('#ysheetBg').style.background = yCards[i].g;
  fillYouSheet(i);
  $('#ysheetBody').scrollTop = 0;
  ysheet.classList.add('open');
  const anim = ysheet.animate([{ clipPath: ysClip(rect) }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }],
    { duration: reducedMotion ? 1 : 620, easing: 'cubic-bezier(.2,.9,.2,1)', fill: 'forwards' });
  anim.onfinish = () => { ysheet.classList.add('ready'); if (viaKey) $('#ysClose').focus(); };
}

function closeYouCard() {
  if (!ysOpen) return;
  ysheet.classList.remove('ready');
  const el = yEls[ysIdx];
  el.style.visibility = 'visible';
  const rect = el.getBoundingClientRect();
  const anim = ysheet.animate([{ clipPath: 'inset(0px 0px 0px 0px round 0px)' }, { clipPath: ysClip(rect) }],
    { duration: reducedMotion ? 1 : 480, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards', delay: reducedMotion ? 0 : 80 });
  anim.onfinish = () => {
    ysheet.classList.remove('open');
    ysOpen = false;
    renderYou();   // pick up edits made inside the sheet (deletes, manual adds)
  };
}
$('#ysClose').addEventListener('click', closeYouCard);
$('#ysDone').addEventListener('click', closeYouCard);
$('#ysheetBody').addEventListener('click', (e) => {
  const del = e.target.closest('.h-del');
  if (del) {
    store.removePlay(del.dataset.id);
    yCards = buildYouCards(store.get());
    fillYouSheet(ysIdx);
    return;
  }
  if (e.target.closest('[data-act="add"]')) { openSheet('#manualSheet'); $('#manualQuery').focus(); }
  if (e.target.closest('[data-act="yt"]')) syncYouTube({ manual: true });
});

function fmtWhen(ts) {
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------------- Sheets ---------------- */
function openSheet(sel) {
  $('#sheetBackdrop').hidden = false;
  $(sel).hidden = false;
}
function closeSheets() {
  $('#sheetBackdrop').hidden = true;
  document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true));
}
$('#sheetBackdrop').addEventListener('click', closeSheets);

$('#openSettings').addEventListener('click', () => {
  const st = store.get().settings;
  $('#auddToken').value = st.auddToken;
  $('#autoInterval').value = String(st.autoInterval);
  $('#lastfmUser').value = st.lastfmUser;
  $('#lastfmKey').value = st.lastfmKey;
  $('#googleClientId').value = st.googleClientId;
  $('#sensitivity').value = String(st.sensitivity ?? 1.5);
  $('#sensValue').textContent = Number(st.sensitivity ?? 1.5).toFixed(1);
  for (const id of ['sensBass', 'sensMid', 'sensTreble']) {
    $('#' + id).value = String(st[id] ?? 1);
    $('#' + id + 'Value').textContent = Number(st[id] ?? 1).toFixed(1);
  }
  $('#showSpectrum').checked = st.showSpectrum !== false;
  showLastfmStatus();
  showYtStatus();
  preloadGoogle();
  openSheet('#settingsSheet');
});
$('#closeSettings').addEventListener('click', () => {
  store.update((s) => {
    s.settings.auddToken = $('#auddToken').value.trim();
    s.settings.autoInterval = +$('#autoInterval').value;
  });
  saveLastfmFields();
  store.update((s) => (s.settings.googleClientId = $('#googleClientId').value.trim()));
  if (autoTimer) startAuto();
  closeSheets();
  syncLastfm();
});
// Keep the sphere centred in the open space between the numbers and the bottom panel.
function fitStage() {
  if (!viz) return;
  const top = $('#liveMetrics').getBoundingClientRect().bottom;
  const bottom = $('#liveBottom').getBoundingClientRect().top;
  viz.setFocus(top, bottom);
}
addEventListener('resize', fitStage);
requestAnimationFrame(fitStage);

// Spectrum analyser under the sphere.
let spectrumOn = store.get().settings.showSpectrum !== false;
const spectrum = new SpectrumView($('#spectrum'));
$('#spectrumBox').hidden = !spectrumOn;
$('#showSpectrum').addEventListener('change', (e) => {
  spectrumOn = e.target.checked;
  $('#spectrumBox').hidden = !spectrumOn;
  if (spectrumOn) spectrum.resize();
  fitStage();
  store.update((s) => (s.settings.showSpectrum = spectrumOn));
});

for (const [id, key, band] of [['sensBass', 'sensBass', 'bass'], ['sensMid', 'sensMid', 'mid'], ['sensTreble', 'sensTreble', 'treble']]) {
  $('#' + id).addEventListener('input', (e) => {
    const v = Number(e.target.value);
    engine.bandSens[band] = v;
    $('#' + id + 'Value').textContent = v.toFixed(1);
    store.update((s) => (s.settings[key] = v));
  });
}

// Applies live so you can tune it while music plays.
$('#sensitivity').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  engine.sensitivity = v;
  $('#sensValue').textContent = v.toFixed(1);
  store.update((s) => (s.settings.sensitivity = v));
});
$('#lastfmSyncBtn').addEventListener('click', () => { saveLastfmFields(); syncLastfm({ manual: true }); });

$('#exportBtn').addEventListener('click', () => {
  const data = { ...store.get(), settings: { ...store.get().settings, auddToken: '', lastfmKey: '' } };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `resonance-${weekKey()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.plays)) throw new Error();
    const { auddToken, lastfmUser, lastfmKey, googleClientId } = store.get().settings;
    store.replace({ ...data, settings: { ...data.settings, auddToken, lastfmUser, lastfmKey, googleClientId } });
    toast(`${data.plays.length} 件の記録を読み込みました`);
  } catch { toast('読み込めないファイルです'); }
  e.target.value = '';
});
$('#clearBtn').addEventListener('click', () => {
  if (!confirm('すべての記録と提案を消去しますか？')) return;
  // Keep the Last.fm cursor so cleared plays don't come straight back on the next sync.
  const { auddToken, lastfmUser, lastfmKey, lastfmCursor, lastfmSyncedAt, googleClientId } = store.get().settings;
  store.clear();
  store.update((s) => Object.assign(s.settings, { auddToken, lastfmUser, lastfmKey, lastfmCursor, lastfmSyncedAt, googleClientId }));
  toast('消去しました');
});

const DEMO = [
  'Daft Punk Get Lucky', 'The Weeknd Blinding Lights', 'Tame Impala The Less I Know The Better',
  'Fred again.. Delilah (pull me out of this)', 'Disclosure Latch', 'Kaytranada 10%',
  'Jamie xx Gosh', 'Bonobo Kerala', 'Fujii Kaze Shinunoga E-Wa', 'Yoasobi Idol',
  'Phoenix 1901', 'Justice D.A.N.C.E.', 'Kali Uchis telepatía', 'Glass Animals Heat Waves',
];
$('#demoBtn').addEventListener('click', async () => {
  toast('デモデータを読み込んでいます…', 6000);
  const found = await pool(DEMO, 5, async (q) => (await deezer.searchTracks(q, 1))[0]);
  const tracks = found.filter(Boolean).map(fromDeezerTrack);
  if (!tracks.length) { toast('通信できませんでした'); return; }
  await pool(tracks, 5, async (t) => { t.genres = ((await deezer.album(t.albumId)).genres?.data || []).map((g) => g.name); });
  const now = Date.now();
  store.update((s) => {
    tracks.forEach((t, i) => {
      const reps = 1 + ((i * 7) % 4);
      for (let r = 0; r < reps; r++) {
        const at = now - Math.random() * 20 * 86400000;
        const hourShift = new Date(at); hourShift.setHours([22, 23, 0, 1, 8, 13, 19][(i + r) % 7]);
        s.plays.push({
          id: `${t.deezerId}-${r}-${Math.random().toString(36).slice(2, 7)}`, at: +hourShift, source: 'demo', ...t,
          features: { bpm: 96 + ((i * 13) % 36), energy: 0.3 + ((i * 7) % 5) / 10, brightness: 0.35 + ((i * 3) % 5) / 20 },
        });
      }
    });
    s.plays.sort((a, b) => b.at - a.at);
    delete s.weeks[weekKey()];
  });
  toast(`${tracks.length} 曲のデモ記録を追加しました`);
  closeSheets();
  switchView('discover');
});

/* Manual add */
$('#closeManual').addEventListener('click', () => {
  closeSheets();
  if (ysOpen) { yCards = buildYouCards(store.get()); fillYouSheet(ysIdx); } else renderYou();
});
let searchTimer;
$('#manualQuery').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('#manualResults').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = (await deezer.searchTracks(q, 12)).map(fromDeezerTrack);
      $('#manualResults').innerHTML = res.map((t, i) => `
        <li data-i="${i}"><div class="h-cover" style="background-image:url('${esc(coverAt(t.cover, 250))}')"></div>
        <div class="h-text"><div class="h-title">${esc(t.title)}</div><div class="h-sub">${esc(t.artist)}</div></div><span class="link-btn">追加</span></li>`).join('');
      $('#manualResults').querySelectorAll('li').forEach((li) => li.addEventListener('click', async () => {
        const t = res[+li.dataset.i];
        try { t.genres = ((await deezer.album(t.albumId)).genres?.data || []).map((g) => g.name); } catch { t.genres = []; }
        store.addPlay({ ...t, source: 'manual', features: {} });
        toast(`追加しました：${t.title}`);
        li.style.opacity = 0.4;
      }));
    } catch { $('#manualResults').innerHTML = '<p class="muted">検索できませんでした</p>'; }
  }, 350);
});

/* ---------------- Last.fm sync (earphone listening) ---------------- */
let lastfmBusy = false;

function saveLastfmFields() {
  const user = $('#lastfmUser').value.trim();
  const key = $('#lastfmKey').value.trim();
  store.update((s) => {
    // A different account starts over from the last 30 days.
    if (user !== s.settings.lastfmUser) { s.settings.lastfmCursor = 0; s.settings.lastfmSyncedAt = 0; }
    s.settings.lastfmUser = user;
    s.settings.lastfmKey = key;
  });
}

function showLastfmStatus(msg) {
  const st = store.get().settings;
  $('#lastfmStatus').textContent = msg
    || (st.lastfmSyncedAt ? `最終同期: ${fmtWhen(st.lastfmSyncedAt)}（${st.lastfmUser}）` : st.lastfmUser ? 'まだ同期していません' : '');
}

async function syncLastfm({ manual = false } = {}) {
  const { lastfmUser, lastfmKey, lastfmCursor } = store.get().settings;
  if (!lastfmUser || !lastfmKey) { if (manual) toast('Last.fm のユーザー名と API キーを入力してください'); return; }
  if (lastfmBusy) return;
  lastfmBusy = true;
  showLastfmStatus('同期しています…');
  try {
    const { plays, nowPlaying, latest } = await fetchRecent(lastfmUser, lastfmKey, lastfmCursor);
    if (plays.length) await enrich(plays);
    let added = 0;
    store.update((s) => {
      const seen = new Set(s.plays.filter((p) => p.source === 'lastfm').map((p) => p.at + trackKey(p.title, p.artist)));
      plays.forEach((p) => {
        if (seen.has(p.at + trackKey(p.title, p.artist))) return;
        added++;
        s.plays.push({ id: `lf-${p.at}-${Math.random().toString(36).slice(2, 7)}`, ...p });
      });
      s.plays.sort((a, b) => b.at - a.at);
      s.settings.lastfmCursor = latest;
      s.settings.lastfmSyncedAt = Date.now();
    });
    showLastfmStatus();
    if (nowPlaying && engine.mode === 'idle') setNow(nowPlaying, 'Now Playing · Last.fm');
    if (added) {
      toast(`Last.fm から ${added} 曲を記録しました`);
      if (currentView === 'you' && !ysOpen) renderYou();
      refreshThinWeek();
    } else if (manual) toast('新しい再生はありませんでした');
  } catch (e) {
    showLastfmStatus(e.message);
    if (manual) toast(e.message);
  } finally {
    lastfmBusy = false;
  }
}

// This week's picks were made from too few plays: redo them once there's enough history.
function refreshThinWeek() {
  const s = store.get();
  const w = s.weeks[weekKey()];
  if (!w || (w.basedOn ?? 0) >= 10 || s.plays.length + s.ytLikes.length < 10) return;
  ensureWeek(true).then(() => { if (currentView === 'discover') renderDiscover(); });
}

/* ---------------- YouTube Music likes ---------------- */
let ytBusy = false;

function showYtStatus(msg) {
  const s = store.get();
  const el = $('#ytStatus');
  if (!el) return;
  el.textContent = msg || (s.settings.ytSyncedAt
    ? `最終同期: ${fmtWhen(s.settings.ytSyncedAt)} · 高評価 ${s.settings.ytScanned ? `${s.settings.ytScanned} 本のうち音楽 ` : ''}${s.ytLikes.length} 曲` : '');
}

// Must be called straight from a tap: the Google sign-in popup needs the user gesture.
function syncYouTube({ manual = false } = {}) {
  // Strip spaces and line breaks that sneak in when copying on a phone.
  const clientId = ($('#googleClientId')?.value || store.get().settings.googleClientId || '').replace(/\s+/g, '');
  if (!clientId) { if (manual) { toast('設定で Google のクライアント ID を入力してください'); openSheet('#settingsSheet'); } return Promise.resolve(); }
  if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    const msg = clientId.startsWith('GOCSPX-')
      ? 'これはクライアント シークレットです。「クライアント ID」（….apps.googleusercontent.com）を貼ってください'
      : 'クライアント ID の形式が違います。「数字-英数字.apps.googleusercontent.com」の全体をコピーしてください';
    if (manual) { showYtStatus(msg); toast(msg, 5000); }
    return Promise.resolve();
  }
  if ($('#googleClientId')) $('#googleClientId').value = clientId;
  if (ytBusy) return Promise.resolve();
  if (!hasToken() && !manual) return Promise.resolve();   // no silent popups
  store.update((s) => (s.settings.googleClientId = clientId));
  ytBusy = true;
  showYtStatus('ログインしています…');
  const ready = hasToken() ? Promise.resolve() : signIn(clientId);
  return ready
    .then(async () => {
      showYtStatus('高評価を読み込んでいます…');
      const { likes, scanned } = await fetchLikes((n, m) => showYtStatus(`高評価を読み込んでいます…（${n} 本中 音楽 ${m} 曲）`));
      const known = new Map(store.get().ytLikes.map((l) => [l.videoId, l]));
      const fresh = likes.filter((l) => !known.has(l.videoId));
      const next = likes.map((l) => known.get(l.videoId) || l);
      // Match on Deezer in batches: new likes plus any older ones not tried yet.
      const pending = next.filter((l) => !l.tried && !l.deezerId);
      await enrichLikes(pending, (d, n) => showYtStatus(`曲を照合しています…（${d} / ${n}）`));
      const removed = known.size - (next.length - fresh.length);
      store.update((s) => {
        s.ytLikes = next;   // unliked songs drop out
        s.settings.ytSyncedAt = Date.now();
        s.settings.ytScanned = scanned;
      });
      const left = next.filter((l) => !l.tried && !l.deezerId).length;
      showYtStatus(left ? `残り ${left} 曲は次回の同期で照合します` : undefined);
      toast(fresh.length ? `YouTube Music の高評価を ${fresh.length} 曲取り込みました（${scanned} 本を確認）` : removed > 0 ? '高評価の変更を反映しました' : '新しい高評価はありませんでした');
      if (fresh.length) refreshThinWeek();
      if (ysOpen) { yCards = buildYouCards(store.get()); fillYouSheet(ysIdx); }
      else if (currentView === 'you') renderYou();
    })
    .catch((e) => { showYtStatus(e.message); toast(e.message, 4000); })
    .finally(() => { ytBusy = false; });
}
$('#ytSyncBtn').addEventListener('click', () => syncYouTube({ manual: true }));
if (store.get().settings.googleClientId) preloadGoogle();
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncYouTube(); });

syncLastfm();
setInterval(syncLastfm, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncLastfm(); });

/* Weekly auto-refresh: a new ISO week unlocks a new drop the next time the app is open. */
setInterval(() => {
  const s = store.get();
  if (s.plays.length && !s.weeks[weekKey()] && !generating) {
    ensureWeek().then(() => { if (currentView === 'discover') renderDiscover(); toast('今週の新しい提案が届きました ✦'); });
  }
}, 60000);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
