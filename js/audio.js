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

    this.f = { bass: 0, mid: 0, treble: 0, level: 0, centroid: 0, beat: 0, bpm: 0 };
    this._bassAvg = 0;
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
      this.analyser.smoothingTimeConstant = 0.78;
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

    const k = 0.35;
    f.bass += (bass - f.bass) * k;
    f.mid += (mid - f.mid) * k;
    f.treble += (treble - f.treble) * k;
    f.level += (level - f.level) * k;
    f.centroid += (centroid - f.centroid) * 0.05;

    // Beat detection: bass energy spike over its running average.
    this._bassAvg = this._bassAvg * 0.96 + bass * 0.04;
    f.beat *= 0.88;
    if (bass > this._bassAvg * 1.28 && bass > 0.18 && t - this._lastBeat > 280) {
      const dt = t - this._lastBeat;
      this._lastBeat = t;
      f.beat = 1;
      if (dt < 1500) {
        this._intervals.push(dt);
        if (this._intervals.length > 24) this._intervals.shift();
        if (this._intervals.length >= 6) f.bpm = estimateBpm(this._intervals);
      }
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
