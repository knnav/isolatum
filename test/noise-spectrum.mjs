// Loads src/noise-processor.js in a sandbox with a fake AudioWorklet scope,
// renders a few seconds of each color, and checks:
//   1. spectral slope (white ≈ 0, pink ≈ -3, brown ≈ -6 dB/octave)
//   2. RMS level is roughly matched across colors
//   3. no clipping, no DC offset
//   4. switching color mid-stream produces no discontinuity
//
// Run: node test/noise-spectrum.mjs   (or: npm test)

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SR = 48000;
const src = readFileSync(new URL('../src/noise-processor.js', import.meta.url), 'utf8');

let Processor;
const sandbox = {
  sampleRate: SR,
  Math,
  AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null }; } },
  registerProcessor: (_name, cls) => { Processor = cls; },
};
vm.runInNewContext(src, sandbox);

function render(color, seconds, switchTo) {
  const p = new Processor({ processorOptions: { color } });
  const block = 128;
  const total = Math.floor((SR * seconds) / block) * block;
  const L = new Float64Array(total);
  const R = new Float64Array(total);
  for (let off = 0; off < total; off += block) {
    if (switchTo && off === total / 2) p.port.onmessage({ data: { color: switchTo } });
    const out = [new Float32Array(block), new Float32Array(block)];
    p.process([], [out]);
    L.set(out[0], off);
    R.set(out[1], off);
  }
  return { L, R };
}

// In-place radix-2 FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// Welch-averaged power spectrum (Hann window, 50% overlap).
function psd(x, N = 8192) {
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let off = 0; off + N <= x.length; off += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[off + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  return { power: acc.map((v) => v / frames), binHz: SR / N };
}

// Least-squares slope of dB vs octaves over [f1, f2], using octave-band averages.
function slopeDbPerOctave(x, f1, f2) {
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
function aWeightedDb(x) {
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

const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
const mean = (x) => x.reduce((a, v) => a + v, 0) / x.length;
const peak = (x) => x.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
function correlation(a, b) {
  const ma = mean(a), mb = mean(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return s / Math.sqrt(sa * sb);
}

// Brown noise's leak puts its corner around fs*0.02/2π ≈ 150 Hz, so measure
// slopes in a band above that where all three should follow their ideal.
const BAND = [400, 12800];
const expected = { white: 0, pink: -3, brown: -6 };
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

const levels = {};
const loudness = {};
for (const color of Object.keys(expected)) {
  const { L, R } = render(color, 20);
  const slope = slopeDbPerOctave(L, ...BAND);
  levels[color] = rms(L);
  loudness[color] = aWeightedDb(L);
  check(Math.abs(slope - expected[color]) < 0.5,
    `${color.padEnd(5)} slope ${slope.toFixed(2)} dB/oct (want ${expected[color]})`);
  check(peak(L) < 1, `${color.padEnd(5)} peak ${peak(L).toFixed(3)} < 1.0 (no clipping)`);
  check(Math.abs(mean(L)) < 0.01, `${color.padEnd(5)} DC offset ${mean(L).toFixed(4)}`);
  check(Math.abs(correlation(L, R)) < 0.05, `${color.padEnd(5)} L/R correlation ${correlation(L, R).toFixed(3)} (stereo is decorrelated)`);
}

console.log('RMS:', Object.entries(levels).map(([k, v]) => `${k}=${v.toFixed(3)}`).join('  '));
const rel = Object.fromEntries(Object.entries(loudness).map(([k, v]) => [k, v - loudness.pink]));
console.log('A-weighted, relative to pink:', Object.entries(rel).map(([k, v]) => `${k}=${v.toFixed(2)} dB`).join('  '));
const spread = Math.max(...Object.values(rel)) - Math.min(...Object.values(rel));
check(spread < 1, `perceived-loudness spread across colors ${spread.toFixed(2)} dB (< 1 dB)`);

// Color switch: the largest sample-to-sample jump around the switch point
// should be no bigger than what the noise does on its own.
{
  const { L } = render('white', 2, 'brown');
  const mid = L.length / 2;
  let around = 0, baseline = 0;
  for (let i = 1; i < L.length; i++) {
    const d = Math.abs(L[i] - L[i - 1]);
    if (Math.abs(i - mid) < SR * 0.2) around = Math.max(around, d); else baseline = Math.max(baseline, d);
  }
  check(around <= baseline * 1.05, `crossfade: max step near switch ${around.toFixed(3)} vs elsewhere ${baseline.toFixed(3)}`);
}

process.exitCode = failures ? 1 : 0;
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
