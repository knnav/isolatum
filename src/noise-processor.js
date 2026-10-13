// Runs on the audio rendering thread (AudioWorkletGlobalScope).
// Generates white, pink and brown noise procedurally, so playback never repeats.
//
// All three generators run every sample and are mixed with weights that slew
// toward the selected color. Switching color is therefore a ~80 ms crossfade
// instead of a click, and costs nothing extra: the generators are a handful of
// multiply-adds each.

// Loudness-matching gains: equal *A-weighted* level (≈ perceived loudness),
// not equal RMS. White noise concentrates energy at 2–5 kHz where hearing is
// most sensitive, so at equal RMS it sounds ~11 dB louder than pink. Pink is
// scaled to 0.7 for headroom so brown's peaks stay below full scale.
// Measured by test/noise-spectrum.mjs; re-run it if you change a filter.
const GAIN = { white: 0.199, pink: 0.7, brown: 0.87 };

const ONE_HOT = {
  white: [1, 0, 0],
  pink: [0, 1, 0],
  brown: [0, 0, 1],
};

function makeChannelState() {
  return { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0, brown: 0 };
}

// One sample of each color for one channel. Returns [white, pink, brown].
function step(s) {
  const white = Math.random() * 2 - 1;

  // Pink: Paul Kellet's "refined" filter. A bank of one-pole low-passes at
  // staggered corners whose sum approximates a -3 dB/octave slope (1/f power)
  // to within ~0.05 dB across the audible band.
  s.b0 = 0.99886 * s.b0 + white * 0.0555179;
  s.b1 = 0.99332 * s.b1 + white * 0.0750759;
  s.b2 = 0.969 * s.b2 + white * 0.153852;
  s.b3 = 0.8665 * s.b3 + white * 0.3104856;
  s.b4 = 0.55 * s.b4 + white * 0.5329522;
  s.b5 = -0.7616 * s.b5 - white * 0.016898;
  const pink = s.b0 + s.b1 + s.b2 + s.b3 + s.b4 + s.b5 + s.b6 + white * 0.5362;
  s.b6 = white * 0.115926;

  // Brown: a leaky integrator of white noise (-6 dB/octave). The leak (/1.02)
  // pulls the random walk back toward zero so it can't drift into DC and clip.
  s.brown = (s.brown + 0.02 * white) / 1.02;

  return [white * GAIN.white, pink * 0.11 * GAIN.pink, s.brown * 3.5 * GAIN.brown];
}

class NoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const color = options?.processorOptions?.color ?? 'pink';
    this.target = ONE_HOT[color] ?? ONE_HOT.pink;
    this.weights = this.target.slice();
    // Independent state per channel: decorrelated L/R noise sounds wide and
    // enveloping; identical L/R collapses to a point in the middle of your head.
    this.channels = [makeChannelState(), makeChannelState()];
    this.slew = 1 / (0.08 * sampleRate);

    this.port.onmessage = (e) => {
      if (e.data?.color && ONE_HOT[e.data.color]) this.target = ONE_HOT[e.data.color];
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const w = this.weights;
    const t = this.target;

    for (let i = 0; i < n; i++) {
      // Linear slew of each weight toward its target.
      for (let k = 0; k < 3; k++) {
        const d = t[k] - w[k];
        w[k] += d > this.slew ? this.slew : d < -this.slew ? -this.slew : d;
      }
      for (let c = 0; c < out.length; c++) {
        const [wh, pk, br] = step(this.channels[c % 2]);
        out[c][i] = wh * w[0] + pk * w[1] + br * w[2];
      }
    }
    return true; // keep the node alive
  }
}

registerProcessor('noise', NoiseProcessor);
