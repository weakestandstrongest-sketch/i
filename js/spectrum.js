// 2D spectrum analyser: what the microphone hears, frequency by frequency.
// Bars are log-spaced from 31 Hz to 16 kHz (like a studio analyser), with peak-hold
// caps. The bass / mid / treble ranges the visualizer listens to are shaded in their
// colours and light up when that band registers a hit.

const MIN_DB = -82, MAX_DB = -20;          // must match the analyser range in audio.js
const F_LO = 31.25, F_HI = 16000;
const BARS = 56;
const ZONES = [
  { key: 'bass', lo: 30, hi: 120, label: '低音', color: [255, 106, 61] },
  { key: 'mid', lo: 250, hi: 2000, label: '中音', color: [176, 107, 255] },
  { key: 'treble', lo: 4000, hi: 12000, label: '高音', color: [191, 244, 255] },
];
const TICKS = [[62.5, '62'], [125, '125'], [250, '250'], [500, '500'], [1000, '1k'], [2000, '2k'], [4000, '4k'], [8000, '8k'], [16000, '16k']];

export class SpectrumView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.val = new Float32Array(BARS);
    this.peak = new Float32Array(BARS);
    this.peakAt = new Float32Array(BARS);
    this.readout = '';
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // x position (0..1) of a frequency on the log axis.
  xOf(hz) { return Math.log(hz / F_LO) / Math.log(F_HI / F_LO); }

  draw(freq, nyq, f, t, live) {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    const top = 16, bottom = h - 16, plotH = bottom - top;
    ctx.clearRect(0, 0, w, h);

    // Band zones behind the bars; a hit in that band makes its zone flash.
    ctx.font = '600 10px -apple-system, "SF Pro Text", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const z of ZONES) {
      const x0 = this.xOf(z.lo) * w, x1 = this.xOf(z.hi) * w;
      const hit = live ? Math.min(1, f[z.key + 'Hit'] || 0) : 0;
      const [r, g, b] = z.color;
      ctx.fillStyle = `rgba(${r},${g},${b},${0.06 + hit * 0.22})`;
      ctx.fillRect(x0, top, x1 - x0, plotH);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.55 + hit * 0.45})`;
      ctx.fillText(z.label, x0 + 3, 2);
      // The band's sustained level (what drives that band's objects) as a thin line.
      const lv = live ? Math.min(1, f[z.key] || 0) : 0;
      ctx.fillRect(x0, top - 2, (x1 - x0) * lv, 2);
    }

    // Faint dB grid: -60, -40 dB.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (const db of [-60, -40]) {
      const y = bottom - ((db - MIN_DB) / (MAX_DB - MIN_DB)) * plotH;
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
    }

    // Bars.
    const bins = freq ? freq.length : 0;
    const gap = 1.5;
    const bw = w / BARS;
    let maxV = 0, maxHz = 0;
    for (let i = 0; i < BARS; i++) {
      const f0 = F_LO * Math.pow(F_HI / F_LO, i / BARS);
      const f1 = F_LO * Math.pow(F_HI / F_LO, (i + 1) / BARS);
      let v = 0;
      if (live && bins) {
        // Low bars span less than one FFT bin, so they share the nearest bin; higher bars take the loudest bin in range.
        const a = Math.max(1, Math.floor((f0 / nyq) * bins));
        const b = Math.max(a, Math.min(bins - 1, Math.floor((f1 / nyq) * bins)));
        for (let k = a; k <= b; k++) if (freq[k] > v) v = freq[k];
        v /= 255;
        if (v > maxV) { maxV = v; maxHz = Math.sqrt(f0 * f1); }
      }
      // Instant rise, smooth fall; peak caps hold briefly, then drop.
      this.val[i] = v > this.val[i] ? v : this.val[i] * 0.86 + v * 0.14;
      if (this.val[i] >= this.peak[i]) { this.peak[i] = this.val[i]; this.peakAt[i] = t; }
      else if (t - this.peakAt[i] > 450) this.peak[i] = Math.max(this.val[i], this.peak[i] - 0.012);

      const x = i * bw + gap / 2;
      const center = Math.sqrt(f0 * f1);
      const zone = ZONES.find((z) => center >= z.lo && center <= z.hi);
      const [r, g, b] = zone ? zone.color : [120, 140, 170];
      const bh = this.val[i] * plotH;
      if (bh > 0.5) {
        const grad = ctx.createLinearGradient(0, bottom - bh, 0, bottom);
        grad.addColorStop(0, `rgba(${r},${g},${b},${zone ? 0.95 : 0.6})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},${zone ? 0.35 : 0.2})`);
        ctx.fillStyle = grad;
        ctx.fillRect(x, bottom - bh, bw - gap, bh);
      }
      const py = bottom - this.peak[i] * plotH;
      if (this.peak[i] > 0.02) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(x, py - 1.5, bw - gap, 1.5);
      }
    }

    // Frequency axis.
    ctx.fillStyle = 'rgba(245,245,247,0.45)';
    ctx.font = '500 9px -apple-system, "SF Pro Text", system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const [hz, label] of TICKS) {
      const x = this.xOf(hz) * w;
      ctx.textAlign = hz >= 16000 ? 'right' : 'center';
      ctx.fillText(label, Math.min(w - 1, x), h);
    }
    ctx.textAlign = 'left';

    // Loudest frequency right now, like a tuner readout (shown above the canvas).
    if (live && maxV > 0.05) {
      const db = MIN_DB + maxV * (MAX_DB - MIN_DB);
      const hzText = maxHz >= 1000 ? `${(maxHz / 1000).toFixed(1)} kHz` : `${Math.round(maxHz)} Hz`;
      this.readout = `${hzText} · ${db.toFixed(0)} dB`;
    } else if (!live) this.readout = '';
  }
}
