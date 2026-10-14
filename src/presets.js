// Presets capture the sound, not the loudness: mix levels and the shape
// controls, but never the master volume, so picking one can't blast you.

import { SOUNDS } from './audio-engine.js';

export const BUILT_IN = [
  { id: 'rain', name: 'Rain', mix: { rain: 1, pink: 0.3 }, tone: 0.85, lowCut: 0.15, waves: 0.1, width: 1 },
  { id: 'storm', name: 'Storm', mix: { rain: 1, brown: 0.8 }, tone: 0.75, lowCut: 0, waves: 0.45, width: 1 },
  { id: 'snowstorm', name: 'Snowstorm', mix: { snow: 1 }, tone: 0.9, lowCut: 0.05, waves: 0, width: 1 },
  { id: 'ocean', name: 'Ocean', mix: { ocean: 1, brown: 0.3 }, tone: 0.8, lowCut: 0, waves: 0, width: 1 },
  { id: 'brook', name: 'Brook', mix: { stream: 1, pink: 0.2 }, tone: 0.85, lowCut: 0.1, waves: 0, width: 1 },
  { id: 'fireplace', name: 'Fireplace', mix: { fire: 1 }, tone: 0.8, lowCut: 0, waves: 0, width: 0.8 },
  { id: 'fan', name: 'Fan', mix: { fan: 1 }, tone: 0.8, lowCut: 0.15, waves: 0, width: 0.5 },
  { id: 'deep', name: 'Deep sleep', mix: { brown: 1 }, tone: 0.45, lowCut: 0, waves: 0.15, width: 0.8 },
  { id: 'focus', name: 'Focus', mix: { pink: 1, white: 0.2 }, tone: 0.85, lowCut: 0.3, waves: 0, width: 1 },
];

const SHAPE = ['tone', 'lowCut', 'waves', 'width'];

/** Snapshot the engine's current sound as a preset body. */
export function capture(engine) {
  const mix = {};
  for (const k of SOUNDS) if (engine.mix[k] > 0) mix[k] = engine.mix[k];
  return { mix, ...Object.fromEntries(SHAPE.map((k) => [k, engine[k]])) };
}

/** Whether the engine currently sounds exactly like `preset`. */
export function matches(engine, preset) {
  const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.004;
  return SOUNDS.every((k) => near(engine.mix[k], preset.mix[k])) && SHAPE.every((k) => near(engine[k], preset[k]));
}

/** Validate a preset read back from storage; returns null if it's unusable. */
export function sanitize(p) {
  if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.mix !== 'object' || !p.mix) return null;
  const unit = (x, d) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d);
  const mix = {};
  for (const k of SOUNDS) if (unit(p.mix[k], 0) > 0) mix[k] = unit(p.mix[k], 0);
  return {
    id: p.id, name: p.name.slice(0, 40), mix,
    tone: unit(p.tone, 1), lowCut: unit(p.lowCut, 0), waves: unit(p.waves, 0), width: unit(p.width, 1),
  };
}
