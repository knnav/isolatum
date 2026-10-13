// The hero display: what the sound looks like right now. It draws the noise
// color's spectral slope through the real filter responses (the same biquads
// the engine uses, evaluated on an OfflineAudioContext, which needs no user
// gesture), raised and lowered by the volume and the live output level, so
// the waves swell and the sleep fade are visible.
//
// It only animates while something is changing; a steady sound with no waves
// costs no frames at all.

import { FILTER_Q, toneToHz, lowCutToHz, volumeToGain } from './audio-engine.js';

const POINTS = 96;
const F_LO = 20;
const F_HI = 20000;
const DB_TOP = 24;    // headroom above the 1 kHz anchor (pink/brown rise at the low end)
const DB_BOTTOM = -48;
const PLOT_TOP = 0.5; // fraction of the canvas height left clear above the curve

const freqs = new Float32Array(POINTS);
for (let i = 0; i < POINTS; i++) freqs[i] = F_LO * (F_HI / F_LO) ** (i / (POINTS - 1));

// Each color's shape relative to its level at 1 kHz. Brown is a leaky
// integrator, so it flattens out below its ~150 Hz corner rather than rising
// forever.
const SLOPE = {
  white: () => 0,
  pink: (f) => -3.01 * Math.log2(f / 1000),
  brown: (f) => 10 * Math.log10((1 + (1000 / 150) ** 2) / (1 + (f / 150) ** 2)),
};

export class Spectrum {
  #canvas;
  #g;
  #engine;
  #offline = new OfflineAudioContext(1, 128, 48000);
  #lp = new BiquadFilterNode(this.#offline, { type: 'lowpass', Q: FILTER_Q });
  #hp = new BiquadFilterNode(this.#offline, { type: 'highpass', Q: FILTER_Q });
  #mag = new Float32Array(POINTS);
  #phase = new Float32Array(POINTS);
  #target = new Float32Array(POINTS);
  #shown = null;
  #presence = 0; // 0 = paused (outline only), 1 = playing (filled)
  #raf = 0;
  #busyUntil = 0;
  #accent = '#888';
  #key = '';

  constructor(canvas, engine) {
    this.#canvas = canvas;
    this.#g = canvas.getContext('2d');
    this.#engine = engine;
    new ResizeObserver(() => this.#resize()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.update(true));
  }

  /** Call after any setting changes; cheap to call when nothing did. */
  update(force = false) {
    const e = this.#engine;
    const key = [e.color, e.volume, e.tone, e.lowCut, e.playing].join();
    if (key === this.#key && !force) return;
    this.#key = key;
    this.#lp.frequency.value = toneToHz(e.tone);
    this.#hp.frequency.value = lowCutToHz(e.lowCut);
    const slope = SLOPE[e.color] ?? SLOPE.pink;
    // The slider maps to 50 dB; drawing all of it would sink the curve off
    // the bottom. Half-scale still reads clearly as "quieter".
    const vol = 0.5 * 20 * Math.log10(Math.max(volumeToGain(e.volume), 1e-3));

    this.#target.fill(0);
    for (const node of [this.#lp, this.#hp]) {
      node.getFrequencyResponse(freqs, this.#mag, this.#phase);
      for (let i = 0; i < POINTS; i++) this.#target[i] += 20 * Math.log10(Math.max(this.#mag[i], 1e-4));
    }
    for (let i = 0; i < POINTS; i++) this.#target[i] += slope(freqs[i]) + vol;
    this.#shown ??= Float32Array.from(this.#target);

    this.#accent = getComputedStyle(this.#canvas).getPropertyValue('--accent').trim() || '#888';
    this.#busyUntil = performance.now() + 2200; // covers the 1.5 s fade-in
    this.#kick();
  }

  #kick() {
    this.#raf ||= requestAnimationFrame(this.#frame);
  }

  #frame = () => {
    this.#raf = 0;
    const e = this.#engine;
    // Ease toward the target so color changes morph instead of jumping.
    let moving = false;
    for (let i = 0; i < POINTS; i++) {
      const d = this.#target[i] - this.#shown[i];
      if (Math.abs(d) > 0.05) moving = true;
      this.#shown[i] += d * 0.18;
    }
    const want = e.playing ? 1 : 0;
    this.#presence += (want - this.#presence) * 0.12;
    if (Math.abs(want - this.#presence) > 0.01) moving = true;

    this.#draw();

    const fading = e.sleepEndsAt && e.sleepEndsAt - Date.now() < 31_000;
    const live = e.playing && (e.waves > 0 || fading);
    if (moving || live || performance.now() < this.#busyUntil) this.#kick();
  };

  #resize() {
    const { width, height } = this.#canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.#canvas.width = Math.round(width * dpr);
    this.#canvas.height = Math.round(height * dpr);
    this.#g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.#shown) this.#draw();
  }

  #draw() {
    const g = this.#g;
    const w = this.#canvas.width / (devicePixelRatio || 1);
    const h = this.#canvas.height / (devicePixelRatio || 1);
    g.clearRect(0, 0, w, h);
    if (!w || !h) return;

    // Live output: transport fades and the waves swell, in dB, at full scale.
    const level = this.#engine.playing ? this.#engine.outputLevel() : 1;
    const live = 20 * Math.log10(Math.max(level, 1e-3)) * this.#presence;

    // The curve lives in the lower part of the card, under the play button
    // and title; DB_TOP lands at PLOT_TOP.
    const top = h * PLOT_TOP;
    const y = (db) => {
      const t = (DB_TOP - db) / (DB_TOP - DB_BOTTOM);
      return Math.min(h + 2, Math.max(top, top + t * (h - top)));
    };

    g.beginPath();
    for (let i = 0; i < POINTS; i++) {
      const px = (i / (POINTS - 1)) * w;
      const py = y(this.#shown[i] + live);
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }

    const p = this.#presence;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.strokeStyle = this.#accent;
    g.globalAlpha = 0.35 + 0.65 * p;
    g.stroke();

    if (p > 0.01) {
      g.lineTo(w, h);
      g.lineTo(0, h);
      g.closePath();
      const fill = g.createLinearGradient(0, 0, 0, h);
      fill.addColorStop(0, this.#accent);
      fill.addColorStop(1, `${this.#accent}00`); // --accent is #rrggbb
      g.fillStyle = fill;
      g.globalAlpha = 0.28 * p;
      g.fill();
    }
    g.globalAlpha = 1;
  }
}
