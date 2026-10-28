import { AudioEngine } from './audio.js';
import { Visualizer } from './visualizer.js';
import { store, trackKey, weekKey, nextWeekStart } from './store.js';
import { recordClip, identify } from './recognizer.js';
import { deezer, fromDeezerTrack, pool } from './deezer.js';
import { buildProfile, describePersona, generateWeekly } from './recommend.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const engine = new AudioEngine();
let viz = null;
try { viz = new Visualizer($('#stage')); } catch (e) { console.error(e); }

/* ---------------- Render loop ---------------- */
let frameN = 0;
function loop(t) {
  const f = engine.update(t);
  viz?.render(t, f, engine.mode === 'idle' ? null : engine.freq);
  if (++frameN % 6 === 0 && currentView === 'live') {
    $('#bpmValue').textContent = f.bpm ? Math.round(f.bpm) : '--';
    $('#energyValue').textContent = Math.round(f.level * 100);
    $('#brightValue').textContent = Math.round(f.centroid * 100);
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
$('#introStart').addEventListener('click', () => {
  $('#intro').classList.add('leave');
  setTimeout(() => $('#intro').remove(), 1200);
});

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
  if (name === 'discover') renderDiscover();
  if (name === 'you') renderYou();
}
tabs.forEach((t) => t.addEventListener('click', () => switchView(t.dataset.tab)));

/* ---------------- Live: mic / file ---------------- */
const micBtn = $('#micBtn');
micBtn.addEventListener('click', async () => {
  if (engine.mode === 'mic') {
    engine.stop();
    micBtn.classList.remove('live');
    stopAuto();
    return;
  }
  try {
    await engine.startMic();
    micBtn.classList.add('live');
    toast('マイクで聴いています。他のアプリで音楽を流してください');
    if (store.get().settings.autoListen) startAuto();
  } catch (e) {
    toast(location.protocol !== 'https:' && location.hostname !== 'localhost'
      ? 'マイクには HTTPS 接続が必要です'
      : 'マイクを使用できませんでした');
  }
});

$('#fileBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stopAuto();
  engine.startFile(file);
  micBtn.classList.remove('live');
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
  if (engine.mode !== 'mic') { if (!silent) toast('まずマイクをオンにしてください'); return; }
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
    if (engine.mode === 'mic') startAuto();
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
    store.update((st) => (st.weeks[wk] = { generatedAt: Date.now(), tracks }));
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
      <div class="card-bg" style="background-image:url('${esc(t.cover)}')"></div>
      <div class="card-tint" style="background:${TINTS[i % TINTS.length]}"></div>
      <div class="card-sheen"></div>
      <div class="card-content">
        <div class="card-top"><span class="badge">${t.deep ? 'Deep Cut' : 'New'}</span><span class="badge badge-like">${s.liked.includes(t.deezerId) ? '♥' : esc((t.genres || [])[0] || '')}</span></div>
        <div class="card-num">${String(i + 1).padStart(2, '0')}<sup>/${n}</sup></div>
        <div>
          <div class="card-cover" style="background-image:url('${esc(t.cover)}')"></div>
          <div class="card-title" style="margin-top:12px">${esc(t.title)}</div>
          <div class="card-artist">${esc(t.artist)}</div>
        </div>
      </div>
    </div>`).join('');
  el.dataset.radius = radius;
  el.dataset.step = step;
  focusIdx = Math.min(focusIdx, n - 1);
  rot = -focusIdx * step;
  applyRot(false);
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
    if (dragMoved) return;
    const i = +c.dataset.i;
    if (i === focusIdx) togglePreview();
    else snapTo(i);
  }));
}

function applyRot(animate = true) {
  const el = $('#carousel');
  const radius = +el.dataset.radius || 0;
  el.style.transition = animate ? 'transform .7s cubic-bezier(.2,.8,.2,1)' : 'none';
  el.style.transform = `translateZ(${-radius}px) rotateY(${rot}deg)`;
  const n = weekTracks.length;
  const step = +el.dataset.step;
  const idx = ((Math.round(-rot / step) % n) + n) % n;
  el.querySelectorAll('.card').forEach((c) => c.classList.toggle('focus', +c.dataset.i === idx));
  if (idx !== focusIdx || $('#focusPanel').hidden) { focusIdx = idx; updateFocus(); }
}

function snapTo(i) {
  const n = weekTracks.length;
  const step = 360 / n;
  // Shortest way round the ring.
  const cur = Math.round(-rot / step);
  let delta = ((i - cur) % n + n) % n;
  if (delta > n / 2) delta -= n;
  rot = -(cur + delta) * step;
  applyRot(true);
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
  $('#previewBtn').disabled = !t.preview;
}

function togglePreview() {
  const t = weekTracks[focusIdx];
  if (!t?.preview) return;
  if (!audioEl.paused && audioEl.dataset.id === String(t.deezerId)) { stopPreview(); return; }
  audioEl.src = t.preview;
  audioEl.dataset.id = t.deezerId;
  audioEl.play().catch(() => toast('試聴を再生できませんでした'));
  $('#previewBtn').textContent = '❚❚ 停止';
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('playing', +c.dataset.i === focusIdx));
}
function stopPreview() {
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
let dragStart = null, dragMoved = false;
const wrap = document.querySelector('.carousel-wrap');
wrap.addEventListener('pointerdown', (e) => {
  if (!weekTracks.length) return;
  dragStart = { x: e.clientX, rot };
  dragMoved = false;
});
window.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const dx = e.clientX - dragStart.x;
  if (Math.abs(dx) > 6) dragMoved = true;
  if (!dragMoved) return;
  rot = dragStart.rot + dx * 0.28;
  applyRot(false);
});
window.addEventListener('pointerup', () => {
  if (!dragStart) return;
  dragStart = null;
  if (dragMoved) {
    const step = 360 / weekTracks.length;
    rot = Math.round(rot / step) * step;
    applyRot(true);
    setTimeout(() => (dragMoved = false), 50);
  }
});

function renderPastWeeks() {
  const s = store.get();
  const wk = weekKey();
  const past = Object.entries(s.weeks).filter(([k]) => k !== wk).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 8);
  $('#pastWeeks').innerHTML = past.length ? `<h4>これまでの提案</h4>` + past.map(([k, w]) => `
    <div class="past-week">
      <div class="past-week-label">Week ${k.split('-W')[1]} · ${k.split('-W')[0]}</div>
      <div class="mini-row">${w.tracks.map((t) => `
        <a class="mini" href="https://music.apple.com/search?term=${encodeURIComponent(t.artist + ' ' + t.title)}" target="_blank" rel="noopener" style="text-decoration:none">
          <div class="mini-cover" style="background-image:url('${esc(t.cover)}')"></div>
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

/* ---------------- You ---------------- */
function animateNumber(el, to, suffix = '') {
  if (to == null) { el.textContent = '—'; return; }
  const from = 0, start = performance.now(), dur = 900;
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.innerHTML = Math.round(from + (to - from) * e) + (suffix ? `<small>${suffix}</small>` : '');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderYou() {
  const s = store.get();
  const p = buildProfile(s);
  animateNumber($('#statPlays'), p.plays);
  animateNumber($('#statArtists'), p.artists.length);
  animateNumber($('#statBpm'), p.bpm);
  animateNumber($('#statBright'), p.brightness != null ? Math.round(p.brightness * 100) : null, '%');

  const persona = describePersona(p);
  $('#persona').innerHTML = persona || '記録が増えると、あなたの音の好みが見えてきます。';

  const top = p.artists.slice(0, 6);
  const max = top[0]?.weight || 1;
  $('#topArtists').innerHTML = top.length ? top.map((a, i) => `
    <li><span class="rank">${i + 1}</span><span class="bar-name">${esc(a.name)}</span><span class="count">${a.count}回</span>
    <span class="bar-track"><span class="bar-fill" style="width:${(a.weight / max) * 100}%;display:block;animation-delay:${i * 80}ms"></span></span></li>`).join('')
    : '<p class="muted">まだデータがありません</p>';

  $('#genres').innerHTML = p.genres.length ? p.genres.slice(0, 14).map(([g], i) =>
    `<span class="genre ${i < 2 ? 'hot' : i < 5 ? 'warm' : ''}">${esc(g)}</span>`).join('')
    : '<p class="muted">ジャンル情報は曲の記録時に取得されます</p>';

  const hmax = Math.max(1, ...p.hours);
  $('#hours').innerHTML = p.hours.map((v, i) =>
    `<div class="h" style="height:${Math.max(3, (v / hmax) * 100)}%;background-position:${(i / 23) * 100}% 0;opacity:${v ? 0.95 : 0.2}" title="${i}時 ${v}回"></div>`).join('');
  if (!$('.hours-axis')) $('#hours').insertAdjacentHTML('afterend', '<div class="hours-axis"><span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>24時</span></div>');

  $('#history').innerHTML = s.plays.slice(0, 60).map((pl) => `
    <li><div class="h-cover" style="background-image:url('${esc(pl.cover)}')"></div>
      <div class="h-text"><div class="h-title">${esc(pl.title)}</div>
      <div class="h-sub">${esc(pl.artist)} · ${fmtWhen(pl.at)}${pl.features?.bpm ? ` · ${pl.features.bpm} BPM` : ''}</div></div>
      <button class="h-del" data-id="${pl.id}" aria-label="削除">×</button></li>`).join('') || '<p class="muted">まだ記録がありません</p>';
  $('#history').querySelectorAll('.h-del').forEach((b) => b.addEventListener('click', () => { store.removePlay(b.dataset.id); renderYou(); }));
}

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
  openSheet('#settingsSheet');
});
$('#closeSettings').addEventListener('click', () => {
  store.update((s) => {
    s.settings.auddToken = $('#auddToken').value.trim();
    s.settings.autoInterval = +$('#autoInterval').value;
  });
  if (autoTimer) startAuto();
  closeSheets();
});

$('#exportBtn').addEventListener('click', () => {
  const data = { ...store.get(), settings: { ...store.get().settings, auddToken: '' } };
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
    const token = store.get().settings.auddToken;
    store.replace({ ...data, settings: { ...data.settings, auddToken: token } });
    toast(`${data.plays.length} 件の記録を読み込みました`);
  } catch { toast('読み込めないファイルです'); }
  e.target.value = '';
});
$('#clearBtn').addEventListener('click', () => {
  if (!confirm('すべての記録と提案を消去しますか？')) return;
  const token = store.get().settings.auddToken;
  store.clear();
  store.update((s) => (s.settings.auddToken = token));
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
$('#addManualBtn').addEventListener('click', () => { openSheet('#manualSheet'); $('#manualQuery').focus(); });
$('#closeManual').addEventListener('click', () => { closeSheets(); renderYou(); });
let searchTimer;
$('#manualQuery').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('#manualResults').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = (await deezer.searchTracks(q, 12)).map(fromDeezerTrack);
      $('#manualResults').innerHTML = res.map((t, i) => `
        <li data-i="${i}"><div class="h-cover" style="background-image:url('${esc(t.cover)}')"></div>
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
