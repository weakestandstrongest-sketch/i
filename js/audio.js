// Audio input + feature extraction.
//
// The spectrum is split into three independent bands. Each band yields:
//   <band>      sustained level 0..1 (auto-gained, smoothed, relative to its own recent average)
//   <band>Hit   onset envelope: jumps to the hit strength on an attack, then decays
//   <band>Hits  running count of onsets, so the visuals can fire one event per hit
//   <band>Str   strength 0.3..1 of the latest onset (varies hit to hit)
// plus beat/BPM (from bass onsets), beatPhase (0..1 within the current beat),
// and active (0..1 gate that falls to 0 in silence).

const BANDS = {
  bass: { lo: 30, hi: 120, attack: 0.65, release: 0.10, hitDecay: 0.90, refractory: 200, k: 1.5 },
  mid: { lo: 250, hi: 2000, attack: 0.45, release: 0.12, hitDecay: 0.87, refractory: 110, k: 1.6 },
  treble: { lo: 4000, hi: 12000, attack: 0.8, release: 0.30, hitDecay: 0.72, refractory: 60, k: 1.7 },
};

// Byte spectrum (dB, -82..-20) -> compressed magnitude 0..1. In dB terms a loud kick's
// window leakage (~-58 dB) looks like real mid-band energy; on this scale it's ~3 %.
const MIN_DB = -82, MAX_DB = -20;
const MAG = new Float32Array(256);
for (let i = 0; i < 256; i++) MAG[i] = i === 0 ? 0 : Math.pow(10, ((i / 255) * (MAX_DB - MIN_DB)) / 40);
const MAG_NORM = MAG[255];
for (let i = 0; i < 256; i++) MAG[i] /= MAG_NORM;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.fileEl = null;
    this.mode = 'idle'; // idle | mic | file
    this.freq = new Uint8Array(1024);

    this.f = {
      bass: 0, mid: 0, treble: 0, level: 0, centroid: 0,
      bassHit: 0, midHit: 0, trebleHit: 0,
      bassHits: 0, midHits: 0, trebleHits: 0,
      bassStr: 0, midStr: 0, trebleStr: 0,
      beat: 0, snare: 0, bpm: 0, beatCount: 0, beatPhase: 0, active: 0,
    };
    this.sensitivity = 1.5;                         // overall, 0.5 (calm) .. 3 (very reactive)
    this.bandSens = { bass: 1, mid: 1, treble: 1 }; // per band, 0.3 .. 2
    this._resetState();
    this._acc = { n: 0, energy: 0, centroid: 0 };   // features for a captured track
  }

  _resetState() {
    this._b = {};
    for (const name of Object.keys(BANDS)) {
      // peak: recent maximum, floor: ~0.7 s average, fm/fv: flux mean/variance,
      // prev: last spectrum slice for flux, last: time of last onset.
      this._b[name] = { peak: 0.05, floor: 0, fm: 0, fv: 0, n: 0, prev: null, last: 0 };
    }
    this._noise = 0.02;     // adaptive noise floor of the whole input
    this._lastBeat = 0;
    this._intervals = [];
    this._lastT = 0;
  }

  _ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;                // ~23 Hz bins at 48 kHz: enough to separate kick from bass line
      this.analyser.smoothingTimeConstant = 0.4;   // light: our own smoothing is per band
      this.analyser.minDecibels = MIN_DB;
      this.analyser.maxDecibels = MAX_DB;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  async startMic() {
    this._ensureCtx();
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    this.mode = 'mic';
  }

  startFile(file) {
    this._ensureCtx();
    this.stop();
    const el = new Audio();
    el.src = URL.createObjectURL(file);
    el.loop = true;
    this.fileEl = el;
    this.source = this.ctx.createMediaElementSource(el);
    this.source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    el.play();
    this.mode = 'file';
  }

  stop() {
    this._resetState();
    if (this.source) { try { this.source.disconnect(); } catch {} this.source = null; }
    if (this.analyser) { try { this.analyser.disconnect(); } catch {} }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.fileEl) { this.fileEl.pause(); URL.revokeObjectURL(this.fileEl.src); this.fileEl = null; }
    this.mode = 'idle';
  }

  update(t) {
    const f = this.f;
    // Per-tick decay scaled to elapsed time so analysis behaves the same at any tick rate.
    const dt = this._lastT ? Math.min(100, t - this._lastT) : 16;
    this._lastT = t;
    const k60 = dt / 16.67;

    if (this.mode === 'idle') {
      // Gentle synthetic breathing so the space is alive before any sound.
      const s = 0.5 + 0.5 * Math.sin(t * 0.0008);
      f.bass += (0.12 + 0.1 * s - f.bass) * 0.05;
      f.mid += (0.1 + 0.08 * Math.sin(t * 0.0011) - f.mid) * 0.05;
      f.treble += (0.06 - f.treble) * 0.05;
      f.level += (0.1 - f.level) * 0.05;
      f.centroid += (0.35 + 0.15 * Math.sin(t * 0.0003) - f.centroid) * 0.02;
      f.active += (0.35 - f.active) * 0.05;
      for (const n of Object.keys(BANDS)) f[n + 'Hit'] *= 0.9;
      f.beat *= 0.9; f.snare *= 0.85;
      return f;
    }

    this.analyser.getByteFrequencyData(this.freq);
    const freq = this.freq;
    const bins = freq.length;
    const nyq = this.ctx.sampleRate / 2;
    const idx = (hz) => Math.max(1, Math.min(bins - 1, Math.round((hz / nyq) * bins)));

    // Whole-input loudness and an adaptive noise floor (slowly follows the quietest level),
    // so room noise from a phone mic doesn't keep everything moving.
    let total = 0;
    const top = idx(12000);
    for (let i = 1; i < top; i++) total += freq[i];
    const raw = total / (top * 255);
    this._noise = raw < this._noise ? this._noise + (raw - this._noise) * 0.05 : this._noise + (raw - this._noise) * 0.0008;
    const gateTarget = Math.min(1, Math.max(0, (raw - this._noise * 1.15) / Math.max(this._noise * 1.5, 0.01)));
    f.active += (gateTarget - f.active) * (gateTarget > f.active ? 0.3 : 0.04) * k60;

    const sens = this.sensitivity;
    let num = 0, den = 0;
    for (let i = 1; i < top; i++) { num += i * freq[i]; den += freq[i]; }
    const centroid = den > 0 ? Math.min(1, (num / den) / idx(5000)) : 0;
    f.centroid += (centroid - f.centroid) * 0.05 * k60;

    let rawLevel = 0;
    const z = {};   // how far each band's flux is above its usual (in standard deviations)
    for (const [name, cfg] of Object.entries(BANDS)) {
      const st = this._b[name];
      const lo = idx(cfg.lo), hi = Math.max(lo + 1, idx(cfg.hi));
      const bs = sens * this.bandSens[name];

      // Band energy on the compressed-magnitude scale.
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += MAG[freq[i]];
      const e = sum / (hi - lo + 1);
      rawLevel += e * (name === 'bass' ? 0.45 : name === 'mid' ? 0.4 : 0.15);
      st.e = e;

      // Sustained level: how far the band rises above its own recent average,
      // relative to its recent peak. Loud, compressed music doesn't pin it at max.
      st.peak = Math.max(e, st.peak * Math.pow(0.997, k60), 0.03);
      st.floor += (e - st.floor) * 0.025 * k60;
      const base = st.floor * 0.92;
      const rise = Math.max(0, e - base) / Math.max(st.peak - base, 0.008);
      const n = Math.pow(Math.min(1, rise * 0.8 + (e / st.peak) * 0.2), 2.0 - Math.min(1.6, bs * 0.4));
      const target = Math.min(1, n * (0.6 + bs * 0.3)) * f.active;
      const rate = target > f[name] ? cfg.attack : cfg.release;
      f[name] += (target - f[name]) * Math.min(1, rate * k60);

      // Onset: positive spectral flux in this band only. Separates attacks from sustained sound.
      let flux = 0;
      const prev = st.prev;
      for (let i = lo; i <= hi; i++) {
        const d = MAG[freq[i]] - (prev ? MAG[prev[i - lo]] : MAG[freq[i]]);
        if (d > 0) flux += d;
      }
      if (!prev || prev.length !== hi - lo + 1) st.prev = new Uint8Array(hi - lo + 1);
      st.prev.set(freq.subarray(lo, hi + 1));
      flux /= hi - lo + 1;
      st.flux = flux;
      st.sd = Math.sqrt(st.fv);
      z[name] = st.n > 30 ? (flux - st.fm) / (st.sd + 0.002) : 0;
    }

    // Decide hits after all bands are measured. A loud hi-hat can leak downwards,
    // so bass/mid have to be at least half as strong as a treble attack in the same
    // frame. Treble itself is never masked, so hats landing on a snare still register.
    // Bass <-> mid leakage is resolved by the delayed confirmation below.
    const B = this._b;
    const masked = { bass: z.treble * 0.5, mid: z.treble * 0.5, treble: 0 };
    // A nearly silent band makes any trace of leakage look like a big jump against its
    // own quiet history, so bass/mid also need a real share of energy next to each other.
    const quiet = { bass: B.bass.e < B.mid.e * 0.3, mid: B.mid.e < B.bass.e * 0.3, treble: false };
    for (const [name, cfg] of Object.entries(BANDS)) {
      const st = this._b[name];
      const bs = sens * this.bandSens[name];
      const kEff = cfg.k + 0.6 - bs * 0.4;
      f[name + 'Hit'] *= Math.pow(cfg.hitDecay, k60);
      const own = z[name];
      if (own > kEff && own >= masked[name] && !quiet[name] && st.flux > st.fm + 0.002
          && t - st.last > cfg.refractory && f.active > 0.3) {
        st.last = t;
        // Strength varies with how far past the threshold the attack went.
        const cand = { t, z: own, e: st.e, strength: Math.max(0.3, Math.min(1, 0.3 + (own - kEff) / 6)) };
        st.cand = cand;
        if (name === 'treble') this._fire(name, cand, f);   // hats are short: fire at once
        else if (!st.pending) st.pending = cand;
      }
      // Bass/mid are confirmed ~33 ms later. The first frames of any attack read as
      // wide-band energy in a 46 ms FFT window (a snare shows up as "bass" for one
      // frame), so a hit only counts if the band's energy is still there afterwards
      // and the neighbouring band didn't have the stronger attack.
      if (st.pending && t - st.pending.t >= 33) {
        const p = st.pending;
        st.pending = null;
        const other = name === 'bass' ? B.mid : name === 'mid' ? B.bass : null;
        const sustained = st.e >= p.e * 0.7;
        const beaten = other && other.cand && Math.abs(other.cand.t - p.t) < 50 && other.cand.z > p.z * 0.6
          && other.e > st.e * 1.2;
        if (sustained && !beaten) this._fire(name, p, f);
      }
      // Update running flux statistics after the test, so a hit is judged against the past.
      const a = 0.03 * k60;
      st.fm += (st.flux - st.fm) * a;
      st.fv += ((st.flux - st.fm) ** 2 - st.fv) * a;
      st.n++;
    }

    f.level += (f.bass * 0.45 + f.mid * 0.4 + f.treble * 0.15 - f.level) * 0.3 * k60;
    // Back-compat aliases used elsewhere in the app.
    f.beat = f.bassHit;
    f.snare = f.midHit;

    // Where we are inside the current beat, from the tempo estimate.
    if (f.bpm) {
      const period = 60000 / f.bpm;
      f.beatPhase = ((t - this._lastBeat) / period) % 1;
    }
    // Forget the tempo after a long silence.
    if (t - this._lastBeat > 4000) { f.bpm = 0; this._intervals = []; }

    if (rawLevel > 0.05) {
      const acc = this._acc;
      acc.n++; acc.energy += rawLevel; acc.centroid += centroid;
    }
    return f;
  }

  _fire(name, c, f) {
    f[name + 'Str'] = c.strength;
    f[name + 'Hit'] = Math.max(f[name + 'Hit'], c.strength);
    f[name + 'Hits']++;
    if (name === 'bass') this._onKick(c.t, f);
  }

  _onKick(t, f) {
    const dt = t - this._lastBeat;
    this._lastBeat = t;
    f.beatCount++;
    if (dt > 250 && dt < 1500) {
      this._intervals.push(dt);
      if (this._intervals.length > 24) this._intervals.shift();
      if (this._intervals.length >= 6) f.bpm = estimateBpm(this._intervals);
    }
  }

  // Averages since the last call; used to annotate a captured track.
  takeFeatures() {
    const a = this._acc;
    const out = a.n > 30
      ? { bpm: this.f.bpm ? Math.round(this.f.bpm) : null, energy: +(a.energy / a.n).toFixed(3), brightness: +(a.centroid / a.n).toFixed(3) }
      : { bpm: this.f.bpm ? Math.round(this.f.bpm) : null, energy: null, brightness: null };
    this._acc = { n: 0, energy: 0, centroid: 0 };
    return out;
  }
}

function estimateBpm(intervals) {
  const sorted = [...intervals].sort((a, b) => a - b);
  let bpm = 60000 / sorted[Math.floor(sorted.length / 2)];
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return bpm;
}
