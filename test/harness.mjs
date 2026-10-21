// Shared by the test and scripts/measure-sounds.mjs: loads src/noise-processor.js
// in a sandbox with a fake AudioWorklet scope, renders it offline, and
// measures the result.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const SR = 48000;

// A-weighted level each sound is matched to, in dB relative to pink (0 if
// absent). Rumble's sub-bass can't reach pink's A-weighted level without
// clipping, so it sits as loud as its headroom allows.
export const TARGET_DB = { rumble: -6.5 };
const src = readFileSync(new URL('../src/noise-processor.js', import.meta.url), 'utf8');

// Seeded random so the statistics (peaks especially) are the same every run.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export let Processor;
const sandbox = {
  sampleRate: SR,
  Math: Object.assign(Object.create(Math), { random: mulberry32(1) }),
  AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null }; } },
  registerProcessor: (_name, cls) => { Processor = cls; },
};
vm.runInNewContext(src, sandbox);

// `sound` is a sound name or a mix object ({ pink: 1, rain: 0.5 }).
export const asMix = (sound) => (typeof sound === 'string' ? { [sound]: 1 } : sound);

export function render(sound, seconds, switchTo, width = 1) {
  const p = new Processor({ processorOptions: { mix: asMix(sound), width } });
  const block = 128;
  const total = Math.floor((SR * seconds) / block) * block;
  const L = new Float64Array(total);
  const R = new Float64Array(total);
  for (let off = 0; off < total; off += block) {
    if (switchTo && off === total / 2) p.port.onmessage({ data: { mix: asMix(switchTo) } });
    const out = [new Float32Array(block), new Float32Array(block)];
    p.process([], [out]);
    L.set(out[0], off);
    R.set(out[1], off);
  }
  return { L, R };
}

// In-place radix-2 FFT. Twiddles and windows are cached per size: computing
// them in the inner loop made long renders take minutes to analyse.
const twiddles = new Map();
function fft(re, im) {
  const n = re.length;
  if (!twiddles.has(n)) {
    const c = new Float64Array(n / 2), s = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) { c[k] = Math.cos((-2 * Math.PI * k) / n); s[k] = Math.sin((-2 * Math.PI * k) / n); }
    twiddles.set(n, [c, s]);
  }
  const [cos, sin] = twiddles.get(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

const windows = new Map();
const hann = (N) => {
  if (!windows.has(N)) windows.set(N, Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))));
  return windows.get(N);
};

// Welch-averaged power spectrum (Hann window, 50% overlap).
export function psd(x, N = 8192) {
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let off = 0; off + N <= x.length; off += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    const win = hann(N);
    for (let i = 0; i < N; i++) re[i] = x[off + i] * win[i];
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  return { power: acc.map((v) => v / frames), binHz: SR / N };
}

// Least-squares slope of dB vs octaves over [f1, f2], using octave-band averages.
export function slopeDbPerOctave(x, f1, f2) {
  const { power, binHz } = psd(x);
  const pts = [];
  for (let f = f1; f * 2 <= f2 * 1.0001; f *= Math.SQRT2) {
    const lo = Math.ceil(f / binHz), hi = Math.floor((f * Math.SQRT2) / binHz);
    let s = 0;
    for (let k = lo; k <= hi; k++) s += power[k];
    pts.push([Math.log2(f), 10 * Math.log10(s / (hi - lo + 1))]);
  }
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x0, y0] of pts) { num += (x0 - mx) * (y0 - my); den += (x0 - mx) ** 2; }
  return num / den;
}

// A-weighted level in dB: approximates how loud the ear perceives the signal.
// Equal RMS is not equal loudness — white noise piles its energy into 2–5 kHz,
// where hearing is most sensitive, so it sounds far louder than brown at the
// same RMS.
export function aWeightedDb(x) {
  const { power, binHz } = psd(x);
  const A = (f) => {
    const f2 = f * f;
    return (12194 ** 2 * f2 * f2) /
      ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  };
  let s = 0;
  for (let k = 1; k < power.length; k++) s += power[k] * A(k * binHz) ** 2;
  return 10 * Math.log10(s);
}

export const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
export const mean = (x) => x.reduce((a, v) => a + v, 0) / x.length;
export const peak = (x) => x.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
// Fraction of samples the worklet's soft limiter touched (it starts at 0.7).
export const limited = (x) => x.reduce((a, v) => a + (Math.abs(v) > 0.7), 0) / x.length;
export function correlation(a, b) {
  const ma = mean(a), mb = mean(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return s / Math.sqrt(sa * sb);
}
