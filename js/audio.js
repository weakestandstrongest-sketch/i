// Audio input + feature extraction (bands, energy, brightness, beat, BPM).

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.fileEl = null;
    this.mode = 'idle'; // idle | mic | file
    this.freq = new Uint8Array(1024);
    this.time = new Uint8Array(2048);

    // bass/mid/treble/level are auto-gained to 0..1 so quiet sound still moves the scene.
    // beat: kick onset (1 then decays), snare: high-band onset, beatCount: kicks so far.
    this.f = { bass: 0, mid: 0, treble: 0, level: 0, centroid: 0, beat: 0, snare: 0, bpm: 0, beatCount: 0 };
    this.sensitivity = 1.5;   // 0.5 (calm) .. 3 (very reactive)
    this._peak = { bass: 0.05, mid: 0.05, treble: 0.05 };
    this._prevLow = null;
    this._prevHigh = null;
    this._flux = [];          // recent kick onset strengths
    this._fluxHi = [];
    this._lastSnare = 0;
    this._lastBeat = 0;
    this._intervals = [];
    // Running feature accumulators, reset whenever a track is captured.
    this._acc = { n: 0, energy: 0, centroid: 0 };
  }

  _ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      // Less smoothing and a narrower dB window make the spectrum jumpier and louder.
      this.analyser.smoothingTimeConstant = 0.55;
      this.analyser.minDecibels = -88;
      this.analyser.maxDecibels = -22;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.time = new Uint8Array(this.analyser.fftSize);
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
    this._prevLow = this._prevHigh = null;
    this._flux = []; this._fluxHi = [];
    if (this.source) { try { this.source.disconnect(); } catch {} this.source = null; }
    if (this.analyser) { try { this.analyser.disconnect(); } catch {} }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.fileEl) { this.fileEl.pause(); URL.revokeObjectURL(this.fileEl.src); this.fileEl = null; }
    this.mode = 'idle';
    this._intervals = [];
  }

  update(t) {
    const f = this.f;
    if (this.mode === 'idle') {
      // Gentle synthetic breathing so the space is alive before any sound.
      const s = 0.5 + 0.5 * Math.sin(t * 0.0008);
      f.bass += (0.12 + 0.1 * s - f.bass) * 0.05;
      f.mid += (0.1 + 0.08 * Math.sin(t * 0.0011) - f.mid) * 0.05;
      f.treble += (0.06 - f.treble) * 0.05;
      f.level += (0.1 - f.level) * 0.05;
      f.centroid += (0.35 + 0.15 * Math.sin(t * 0.0003) - f.centroid) * 0.02;
      f.beat *= 0.9;
      f.snare *= 0.85;
      return f;
    }

    this.analyser.getByteFrequencyData(this.freq);
    const bins = this.freq.length;
    const nyq = this.ctx.sampleRate / 2;
    const idx = (hz) => Math.min(bins - 1, Math.round((hz / nyq) * bins));
    const avg = (a, b) => {
      let s = 0;
      for (let i = a; i <= b; i++) s += this.freq[i];
      return s / ((b - a + 1) * 255);
    };
    const bass = avg(idx(25), idx(180));
    const mid = avg(idx(180), idx(2200));
    const treble = avg(idx(2200), idx(11000));

    let num = 0, den = 0;
    for (let i = 1; i < idx(12000); i++) { num += i * this.freq[i]; den += this.freq[i]; }
    const centroid = den > 0 ? Math.min(1, (num / den) / idx(5000)) : 0;
    const level = bass * 0.45 + mid * 0.4 + treble * 0.15;

    // Auto gain: each band is measured against its own recent peak, so a phone
    // mic across the room moves the scene as much as a loud speaker does.
    const sens = this.sensitivity;
    const gain = (band, raw) => {
      const pk = this._peak;
      pk[band] = Math.max(raw, pk[band] * 0.997, 0.03);
      const gate = Math.min(1, raw / 0.015);              // stay calm in silence
      const n = Math.pow(raw / pk[band], 2.2 - sens * 0.4); // >1 exponent = punchier peaks
      return Math.min(1, n * (0.55 + sens * 0.3) * gate);
    };
    const nb = gain('bass', bass), nm = gain('mid', mid), nt = gain('treble', treble);
    const nl = nb * 0.45 + nm * 0.4 + nt * 0.15;

    // Fast attack, slower release: hits land instantly and fall off smoothly.
    const ease = (cur, v) => cur + (v - cur) * (v > cur ? 0.7 : 0.18);
    f.bass = ease(f.bass, nb);
    f.mid = ease(f.mid, nm);
    f.treble = ease(f.treble, nt);
    f.level = ease(f.level, nl);
    f.centroid += (centroid - f.centroid) * 0.05;

    // Onsets via spectral flux (rise in energy since last frame) with an
    // adaptive threshold: mean + k * std of the last ~1.5 s.
    const flux = (lo, hi, key) => {
      const prev = this[key];
      let sum = 0;
      for (let i = lo; i <= hi; i++) {
        const d = this.freq[i] - (prev ? prev[i - lo] : this.freq[i]);
        if (d > 0) sum += d;
      }
      this[key] = this.freq.slice(lo, hi + 1);
      return sum / ((hi - lo + 1) * 255);
    };
    const isOnset = (hist, v, k) => {
      hist.push(v);
      if (hist.length > 90) hist.shift();
      if (hist.length < 20) return false;
      const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
      const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
      return v > mean + sd * k && v > 0.004;
    };
    const k = 1.9 - sens * 0.3;   // more sensitive = lower threshold
    const low = flux(idx(30), idx(160), '_prevLow');
    const high = flux(idx(2500), idx(9000), '_prevHigh');
    f.beat *= 0.86;
    f.snare *= 0.82;
    if (isOnset(this._flux, low, k) && t - this._lastBeat > 230) {
      const dt = t - this._lastBeat;
      this._lastBeat = t;
      f.beat = 1;
      f.beatCount++;
      if (dt < 1500) {
        this._intervals.push(dt);
        if (this._intervals.length > 24) this._intervals.shift();
        if (this._intervals.length >= 6) f.bpm = estimateBpm(this._intervals);
      }
    }
    if (isOnset(this._fluxHi, high, k + 0.2) && t - this._lastSnare > 120) {
      this._lastSnare = t;
      f.snare = 1;
    }

    if (level > 0.05) {
      const a = this._acc;
      a.n++; a.energy += level; a.centroid += centroid;
    }
    return f;
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
