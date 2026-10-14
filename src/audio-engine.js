// Main-thread side of the audio graph:
//
//   NoiseProcessor (worklet: sound layers + stereo width) → high-pass "low cut" → low-pass "tone"
//     → swell ("waves") → volume → master → speakers
//
// `volume` is the user's level. `master` is owned by transport: the play/pause
// fades. Keeping them separate means dragging the volume
// slider mid-fade can't fight the fade-out.

export const SOUNDS = ['white', 'pink', 'brown', 'rain', 'fan', 'snow', 'ocean', 'stream', 'fire'];

const FADE_IN = 1.5;   // seconds
const FADE_OUT = 0.4;  // seconds, for a manual pause
export const FILTER_Q = 0.5; // gentle shelves, no resonant bump at the corner

// Two slow, unrelated LFOs summed: the swells never line up the same way
// twice, so it reads as surf rather than a metronome. Periods ≈ 11 s and 7 s.
const WAVE_HZ = [0.09, 0.137];

export class NoiseEngine {
  #ctx = null;
  #nodes = null;
  #ready = null;
  #pauseTimer = null;

  constructor({ mix = { pink: 1 }, volume = 0.6, tone = 1, lowCut = 0, waves = 0, width = 1 } = {}) {
    this.mix = { ...mix }; // layer levels 0..1, keyed by SOUNDS
    this.width = width;
    this.volume = volume;
    this.tone = tone;
    this.lowCut = lowCut;
    this.waves = waves;
    this.playing = false;
  }

  // Build the graph lazily: an AudioContext created before a user gesture
  // starts suspended, and on macOS WebKit won't resume it without one.
  #init() {
    this.#ready ??= (async () => {
      // 'playback' trades latency for bigger buffers → fewer wakeups, less CPU.
      // Nobody needs low latency from a noise machine.
      const ctx = new AudioContext({ latencyHint: 'playback' });
      await ctx.audioWorklet.addModule(new URL('./noise-processor.js', import.meta.url).href);

      const source = new AudioWorkletNode(ctx, 'noise', {
        numberOfInputs: 0,
        outputChannelCount: [2],
        processorOptions: { mix: this.mix, width: this.width },
      });
      const highpass = new BiquadFilterNode(ctx, { type: 'highpass', Q: FILTER_Q, frequency: lowCutToHz(this.lowCut) });
      const filter = new BiquadFilterNode(ctx, { type: 'lowpass', Q: FILTER_Q, frequency: toneToHz(this.tone) });
      // swell.gain = base + depth·(lfo₁ + lfo₂)/2, peaking at exactly 1 so
      // waves only ever dip below the set volume, never above it.
      const { base, depth } = wavesToSwell(this.waves);
      const swell = new GainNode(ctx, { gain: base });
      const lfoDepth = new GainNode(ctx, { gain: depth / 2 });
      for (const frequency of WAVE_HZ) {
        const lfo = new OscillatorNode(ctx, { frequency });
        lfo.connect(lfoDepth);
        lfo.start();
      }
      lfoDepth.connect(swell.gain);
      const volume = new GainNode(ctx, { gain: volumeToGain(this.volume) });
      const master = new GainNode(ctx, { gain: 0 });
      source.connect(highpass).connect(filter).connect(swell).connect(volume).connect(master).connect(ctx.destination);

      this.#ctx = ctx;
      this.#nodes = { source, highpass, filter, swell, lfoDepth, volume, master };
    })();
    return this.#ready;
  }

  /** Returns true if audio is actually running (false = blocked by autoplay policy). */
  async play() {
    await this.#init();
    clearTimeout(this.#pauseTimer);
    await this.#ctx.resume();
    if (this.#ctx.state !== 'running') return false;

    const g = this.#nodes.master.gain;
    const now = this.#ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1, now + FADE_IN);
    this.playing = true;
    return true;
  }

  async pause({ fade = FADE_OUT } = {}) {
    if (!this.#ctx || !this.playing) return;
    const g = this.#nodes.master.gain;
    const now = this.#ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    this.playing = false;
    // Suspending after the fade stops the audio thread entirely: zero CPU
    // while paused instead of rendering silence forever.
    this.#pauseTimer = setTimeout(() => this.#ctx.suspend(), fade * 1000 + 50);
  }

  async toggle() {
    return this.playing ? (await this.pause(), false) : this.play();
  }

  /** Set some or all layer levels; layers not named keep their level. */
  setMix(levels) {
    this.mix = { ...this.mix, ...levels };
    this.#nodes?.source.port.postMessage({ mix: this.mix });
  }

  setWidth(w) {
    this.width = w;
    this.#nodes?.source.port.postMessage({ width: w });
  }

  setVolume(v) {
    this.volume = v;
    this.#smooth(this.#nodes?.volume.gain, volumeToGain(v));
  }

  setTone(t) {
    this.tone = t;
    this.#smooth(this.#nodes?.filter.frequency, toneToHz(t));
  }

  setLowCut(t) {
    this.lowCut = t;
    this.#smooth(this.#nodes?.highpass.frequency, lowCutToHz(t));
  }

  setWaves(w) {
    this.waves = w;
    const { base, depth } = wavesToSwell(w);
    this.#smooth(this.#nodes?.swell.gain, base);
    this.#smooth(this.#nodes?.lfoDepth.gain, depth / 2);
  }

  /**
   * Linear gain the listener hears right now relative to the volume setting:
   * transport fades × the waves swell. For the UI's level display only.
   * Reads the LFOs analytically: they started at phase 0 at context time 0,
   * and an AudioParam's .value doesn't include signals connected into it.
   */
  outputLevel() {
    if (!this.#ctx) return 0;
    const t = this.#ctx.currentTime;
    const { base, depth } = wavesToSwell(this.waves);
    const lfo = WAVE_HZ.reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * t), 0);
    return this.#nodes.master.gain.value * (base + (depth / 2) * lfo);
  }

  // setTargetAtTime instead of assigning .value: jumping a gain between audio
  // blocks produces "zipper" clicks while dragging a slider.
  #smooth(param, value) {
    if (!param) return;
    param.setTargetAtTime(value, this.#ctx.currentTime, 0.03);
  }
}

// Volume slider 0..1 → gain. Perceived loudness is roughly logarithmic, so a
// linear slider would put all the useful range in its bottom fifth. Map the
// slider onto a 50 dB range (-50 dB .. 0 dB), with 0 forced to true silence.
export function volumeToGain(v) {
  return v <= 0 ? 0 : 10 ** ((v - 1) * 50 / 20);
}

// Tone slider 0..1 → low-pass cutoff, exponentially from 300 Hz to 20 kHz.
// Pitch is perceived logarithmically too: each slider step should move the
// cutoff by the same musical interval, not the same number of Hz.
export function toneToHz(t) {
  return 300 * (20000 / 300) ** t;
}

// Low-cut slider 0..1 → high-pass corner, exponentially from 20 Hz (off, for
// all practical purposes) to 500 Hz, where even brown noise turns thin.
export function lowCutToHz(t) {
  return 20 * (500 / 20) ** t;
}

// Waves slider 0..1 → swell gain = base + depth·lfo, lfo ∈ [-1, 1]. At full
// depth the troughs dip to 0.1 (-20 dB) and the crests sit at the set volume.
export function wavesToSwell(w) {
  const depth = 0.45 * w;
  return { base: 1 - depth, depth };
}
