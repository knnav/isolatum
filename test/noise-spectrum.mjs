// Loads src/noise-processor.js in a sandbox with a fake AudioWorklet scope,
// renders a few seconds of each sound, and checks:
//   1. spectral slope (white ≈ 0, pink ≈ -3, brown ≈ -6 dB/octave)
//   2. perceived loudness is matched across sounds, and across mixes
//   3. no clipping, no DC offset, decorrelated stereo
//   4. switching sounds mid-stream produces no discontinuity
//   5. the width control collapses to mono without changing loudness
//
// Run: node test/noise-spectrum.mjs   (or: npm test)

import { SR, render, slopeDbPerOctave, aWeightedDb, rms, mean, peak, limited, correlation } from './harness.mjs';

// Brown noise's leak puts its corner around fs*0.02/2π ≈ 150 Hz, so measure
// slopes in a band above that where all three should follow their ideal.
const BAND = [400, 12800];
const SOUNDS = ['white', 'pink', 'brown', 'rain', 'fan', 'snow', 'ocean', 'stream', 'fire'];
// Sounds that swell slowly (waves, gusts) need a longer render for a stable average.
const SECONDS = { rain: 60, snow: 120, ocean: 120, stream: 60, fire: 60 };
const expected = { white: 0, pink: -3, brown: -6 }; // the textures have no single slope
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

const levels = {};
const loudness = {};
for (const sound of SOUNDS) {
  const { L, R } = render(sound, SECONDS[sound] ?? 20);
  levels[sound] = rms(L);
  loudness[sound] = aWeightedDb(L);
  if (sound in expected) {
    const slope = slopeDbPerOctave(L, ...BAND);
    check(Math.abs(slope - expected[sound]) < 0.5,
      `${sound.padEnd(6)} slope ${slope.toFixed(2)} dB/oct (want ${expected[sound]})`);
  }
  check(peak(L) < 1, `${sound.padEnd(6)} peak ${peak(L).toFixed(3)} < 1.0 (no clipping)`);
  check(limited(L) < 1e-4, `${sound.padEnd(6)} limiter engaged on ${(limited(L) * 100).toFixed(4)}% of samples (< 0.01%)`);
  check(Math.abs(mean(L)) < 0.01, `${sound.padEnd(6)} DC offset ${mean(L).toFixed(4)}`);
  check(Math.abs(correlation(L, R)) < 0.05, `${sound.padEnd(6)} L/R correlation ${correlation(L, R).toFixed(3)} (stereo is decorrelated)`);
}

console.log('RMS:', Object.entries(levels).map(([k, v]) => `${k}=${v.toFixed(3)}`).join('  '));
const rel = Object.fromEntries(Object.entries(loudness).map(([k, v]) => [k, v - loudness.pink]));
console.log('A-weighted, relative to pink:', Object.entries(rel).map(([k, v]) => `${k}=${v.toFixed(2)} dB`).join('  '));
// Steady noises are loudness-matched tightly. The textures swell (showers,
// gusts, waves), so any finite render lands a little off their long-run level;
// each must still be within 1 dB of pink.
const steady = ['white', 'pink', 'brown', 'fan'].map((k) => rel[k]);
const spread = Math.max(...steady) - Math.min(...steady);
check(spread < 1, `perceived-loudness spread across steady noises ${spread.toFixed(2)} dB (< 1 dB)`);
for (const k of SOUNDS.filter((k) => !['white', 'pink', 'brown', 'fan'].includes(k))) {
  check(Math.abs(rel[k]) < 1, `${k.padEnd(6)} loudness ${rel[k].toFixed(2)} dB vs pink (within 1 dB)`);
}

// Mixer: layering everything at 100% is normalized back to about one layer's
// loudness, and must not clip.
{
  const all = Object.fromEntries(SOUNDS.map((k) => [k, 1]));
  const { L } = render(all, 10);
  const d = aWeightedDb(L) - loudness.pink;
  check(Math.abs(d) < 1.5, `full mix loudness ${d.toFixed(2)} dB vs pink (within 1.5 dB)`);
  check(peak(L) < 1, `full mix peak ${peak(L).toFixed(3)} < 1.0 (no clipping)`);
}

// Width: 0 is mono at the same perceived loudness, and still doesn't clip.
for (const sound of ['brown', 'rain']) {
  const { L, R } = render(sound, 10, null, 0);
  const d = aWeightedDb(L) - loudness[sound];
  check(correlation(L, R) > 0.999, `${sound.padEnd(6)} width 0 is mono (L/R correlation ${correlation(L, R).toFixed(4)})`);
  check(Math.abs(d) < 1, `${sound.padEnd(6)} width 0 loudness ${d.toFixed(2)} dB vs stereo (within 1 dB)`);
  check(peak(L) < 1, `${sound.padEnd(6)} width 0 peak ${peak(L).toFixed(3)} < 1.0`);
}

// Sound switch: the largest sample-to-sample jump around the switch point
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
