// Measures every sound the worklet makes and prints what to paste back after
// changing a generator:
//   - GAIN for src/noise-processor.js (equal A-weighted loudness, pink fixed,
//     offset by TARGET_DB where a sound can't reach pink's level)
//   - BANDS for src/spectrum.js (third-octave levels, dB re pink at 1 kHz)
// With --wav, also writes a 30 s stereo clip of each sound to dist/samples/
// so you can listen without launching the app.
//
// Run: node scripts/measure-sounds.mjs [--wav]   (takes a few minutes)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SR, TARGET_DB, render, psd, aWeightedDb, peak, limited } from '../test/harness.mjs';

const SOUNDS = ['white', 'pink', 'brown', 'rain', 'fan', 'snow', 'ocean', 'stream', 'fire', 'rumble'];
// Steady noises settle fast; the textures swell over seconds (waves, gusts,
// showers), so they need minutes for a stable long-run average.
const STEADY = ['white', 'pink', 'brown', 'fan'];
const seconds = (k) => +(process.env.DURATION ?? (STEADY.includes(k) ? 60 : 240));
const src = readFileSync(new URL('../src/noise-processor.js', import.meta.url), 'utf8');
const GAIN = Function(`return ${src.match(/const GAIN = (\{[\s\S]*?\});/)[1]}`)();

// Mean power density per third-octave band centred on 20·2^(i/3) Hz.
function bands(x) {
  const { power, binHz } = psd(x, 32768);
  return Array.from({ length: 31 }, (_, i) => {
    const f = 20 * 2 ** (i / 3);
    const lo = Math.max(1, Math.round(f * 2 ** (-1 / 6) / binHz));
    const hi = Math.max(lo, Math.round(f * 2 ** (1 / 6) / binHz));
    let s = 0;
    for (let k = lo; k <= hi; k++) s += power[k];
    return 10 * Math.log10(s / (hi - lo + 1));
  });
}

function wav(L, R) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const q = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(q(L[i]), 44 + i * 4); buf.writeInt16LE(q(R[i]), 46 + i * 4); }
  return buf;
}

const writeWav = process.argv.includes('--wav');
if (writeWav) mkdirSync('dist/samples', { recursive: true });

const loud = {};
const band = {};
for (const sound of SOUNDS) {
  const { L, R } = render(sound, seconds(sound));
  loud[sound] = aWeightedDb(L);
  band[sound] = bands(L);
  console.error(`${sound.padEnd(6)} peak ${peak(L).toFixed(3)}  limited ${(limited(L) * 100).toFixed(4)}%`);
  if (writeWav) writeFileSync(`dist/samples/${sound}.wav`, wav(L.subarray(0, SR * 30), R.subarray(0, SR * 30)));
}

const gain = Object.fromEntries(SOUNDS.map((k) => [k, +(GAIN[k] * 10 ** ((loud.pink + (TARGET_DB[k] ?? 0) - loud[k]) / 20)).toPrecision(3)]));
console.log('GAIN:', JSON.stringify(gain).replace(/"/g, '').replace(/,/g, ', '));
// Bands scale with the gain change, so they are already loudness-matched.
const ref = band.pink[17];
console.log('BANDS:');
for (const k of SOUNDS) {
  const shift = 20 * Math.log10(gain[k] / GAIN[k]);
  console.log(`  ${k}: [${band[k].map((v) => (v - ref + shift).toFixed(1)).join(', ')}],`);
}
if (writeWav) console.error('Wrote dist/samples/*.wav');
