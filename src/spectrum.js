// The hero display: what the sound looks like right now. It draws the mix's
// spectrum (measured band levels per layer, power-summed the way the worklet
// mixes them) through the real filter responses (the same biquads
// the engine uses, evaluated on an OfflineAudioContext, which needs no user
// gesture), raised and lowered by the volume and the live output level, so
// the waves swell and the play/pause fades are visible.
//
// It only animates while something is changing; a steady sound with no waves
// costs no frames at all.

import { FILTER_Q, SOUNDS, toneToHz, lowCutToHz, volumeToGain } from './audio-engine.js';

const POINTS = 96;
const F_LO = 20;
const F_HI = 20000;
const DB_TOP = 24;    // headroom above the anchor (pink at 1 kHz = 0 dB; brown and pink rise at the low end)
const DB_BOTTOM = -48;
const PLOT_TOP = 0.5; // fraction of the canvas height left clear above the curve

const freqs = new Float32Array(POINTS);
for (let i = 0; i < POINTS; i++) freqs[i] = F_LO * (F_HI / F_LO) ** (i / (POINTS - 1));

// Each sound's measured spectrum in third-octave bands from 20 Hz to 20 kHz
// (band i is centred on 20·2^(i/3) Hz), at its loudness-matched gain, in dB
// relative to pink at 1 kHz. Measured by `node scripts/measure-sounds.mjs`,
// which renders minutes of each sound; regenerate if you change a generator or a GAIN.
const BANDS = {
  white: [-5.9, -5.0, -5.6, -5.4, -5.7, -5.4, -5.3, -5.5, -5.5, -5.4, -5.4, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5, -5.5],
  pink: [16.9, 16.1, 15.1, 14.0, 13.1, 12.2, 11.0, 9.8, 8.9, 8.1, 6.9, 6.0, 4.9, 4.0, 3.0, 1.9, 1.0, 0.0, -1.0, -2.0, -3.1, -4.1, -5.1, -6.1, -7.1, -8.1, -9.1, -10.1, -11.1, -12.1, -13.1],
  brown: [17.9, 18.0, 18.1, 18.1, 17.8, 17.2, 17.2, 16.6, 15.9, 15.0, 13.9, 12.3, 10.8, 9.1, 7.3, 5.5, 3.6, 1.6, -0.3, -2.4, -4.3, -6.3, -8.3, -10.3, -12.2, -14.1, -16.0, -17.8, -19.4, -20.7, -21.6],
  rain: [1.0, 1.2, 1.1, 1.1, 1.0, 1.1, 1.0, 0.6, 0.5, 0.0, -0.3, -0.8, -1.2, -1.5, -1.6, -1.5, -1.4, -1.4, -1.4, -1.5, -1.8, -2.4, -3.3, -4.5, -6.0, -7.9, -10.0, -12.2, -14.2, -16.0, -17.2],
  fan: [1.7, 3.8, 5.5, 6.8, 8.2, 9.3, 10.5, 11.3, 11.5, 11.7, 11.7, 11.6, 11.1, 10.3, 9.2, 7.6, 5.5, 2.9, 0.0, -3.4, -7.1, -11.2, -15.3, -19.5, -23.2, -25.1, -25.3, -24.8, -24.4, -24.1, -23.9],
  snow: [12.1, 12.3, 12.1, 11.9, 11.6, 11.3, 10.8, 10.0, 8.9, 7.4, 5.5, 3.9, 3.5, 4.9, 6.5, 6.9, 5.6, 2.7, -1.0, -4.4, -6.8, -9.1, -10.4, -10.9, -10.7, -10.3, -9.8, -9.5, -9.2, -9.1, -9.0],
  ocean: [9.4, 9.5, 9.5, 9.5, 9.5, 9.1, 9.1, 8.9, 8.6, 8.4, 8.1, 7.7, 7.2, 6.8, 6.1, 5.3, 4.2, 3.0, 1.4, -0.6, -2.7, -5.2, -7.9, -10.9, -13.7, -16.2, -17.9, -18.9, -19.4, -19.7, -19.7],
  stream: [-12.0, -12.1, -11.9, -12.0, -11.7, -11.6, -11.3, -10.9, -10.4, -9.6, -8.6, -7.3, -5.7, -3.1, 1.9, 3.1, 2.5, 1.9, 1.1, 0.0, -1.0, -2.0, -3.2, -8.1, -13.5, -16.3, -18.8, -21.4, -24.5, -28.5, -35.5],
  fire: [15.0, 15.1, 15.0, 15.0, 15.0, 15.0, 14.8, 14.6, 14.2, 13.9, 13.1, 12.1, 10.8, 9.0, 6.8, 4.2, 1.3, -1.8, -4.2, -5.4, -5.3, -4.9, -4.8, -5.7, -7.1, -9.0, -11.3, -13.8, -16.8, -20.7, -27.2],
  rumble: [20.1, 20.5, 20.7, 20.7, 20.2, 19.2, 18.1, 16.9, 15.6, 14.1, 12.5, 10.6, 8.3, 5.6, 2.6, -0.8, -4.4, -8.1, -11.9, -15.8, -19.7, -23.7, -27.6, -31.5, -35.4, -39.2, -42.9, -46.4, -49.7, -52.4, -54.2],
};

// A sound's level at f, as linear power, interpolating between bands in dB.
function bandPower(sound, f) {
  const b = BANDS[sound];
  const x = Math.min(b.length - 1, Math.max(0, 3 * Math.log2(f / 20)));
  const i = Math.min(b.length - 2, Math.floor(x));
  return 10 ** ((b[i] + (b[i + 1] - b[i]) * (x - i)) / 10);
}

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
    // Waves doesn't change the curve's shape, but it's in the key because
    // turning it on has to restart the frame loop that draws the swell.
    const key = [...SOUNDS.map((k) => e.mix[k]), e.volume, e.tone, e.lowCut, e.waves, e.playing].join();
    if (key === this.#key && !force) return;
    this.#key = key;
    this.#lp.frequency.value = toneToHz(e.tone);
    this.#hp.frequency.value = lowCutToHz(e.lowCut);
    // Same normalization as the worklet: levels scaled by their root-sum-square.
    const levels = SOUNDS.map((k) => e.mix[k] || 0);
    const norm = Math.max(1, Math.hypot(...levels));
    // The slider maps to 50 dB; drawing all of it would sink the curve off
    // the bottom. Half-scale still reads clearly as "quieter".
    const vol = 0.5 * 20 * Math.log10(Math.max(volumeToGain(e.volume), 1e-3));

    this.#target.fill(0);
    for (const node of [this.#lp, this.#hp]) {
      node.getFrequencyResponse(freqs, this.#mag, this.#phase);
      for (let i = 0; i < POINTS; i++) this.#target[i] += 20 * Math.log10(Math.max(this.#mag[i], 1e-4));
    }
    for (let i = 0; i < POINTS; i++) {
      let p = 0;
      SOUNDS.forEach((k, j) => { p += (levels[j] / norm) ** 2 * bandPower(k, freqs[i]); });
      this.#target[i] += 10 * Math.log10(Math.max(p, 1e-12)) + vol;
    }
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
    // Ease toward the target so mix changes morph instead of jumping.
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

    const live = e.playing && e.waves > 0;
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
