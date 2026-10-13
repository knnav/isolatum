// Main-thread side of the audio graph:
//
//   NoiseProcessor (worklet) → low-pass "tone" → volume → master → speakers
//
// `volume` is the user's level. `master` is owned by transport: play/pause
// fades and the sleep timer. Keeping them separate means dragging the volume
// slider mid-fade can't fight the fade-out.

const FADE_IN = 1.5;   // seconds
const FADE_OUT = 0.4;  // seconds, for a manual pause
const SLEEP_FADE = 30; // seconds, for the sleep timer's final fade

export class NoiseEngine {
  #ctx = null;
  #nodes = null;
  #ready = null;
  #sleepStopTimer = null;
  #pauseTimer = null;

  constructor({ color = 'pink', volume = 0.6, tone = 1 } = {}) {
    this.color = color;
    this.volume = volume;
    this.tone = tone;
    this.playing = false;
    this.sleepEndsAt = null; // epoch ms, for the UI countdown
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
        processorOptions: { color: this.color },
      });
      const filter = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.5, frequency: toneToHz(this.tone) });
      const volume = new GainNode(ctx, { gain: volumeToGain(this.volume) });
      const master = new GainNode(ctx, { gain: 0 });
      source.connect(filter).connect(volume).connect(master).connect(ctx.destination);

      this.#ctx = ctx;
      this.#nodes = { source, filter, volume, master };
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
    this.cancelSleep();
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

  setColor(color) {
    this.color = color;
    this.#nodes?.source.port.postMessage({ color });
  }

  setVolume(v) {
    this.volume = v;
    this.#smooth(this.#nodes?.volume.gain, volumeToGain(v));
  }

  setTone(t) {
    this.tone = t;
    this.#smooth(this.#nodes?.filter.frequency, toneToHz(t));
  }

  // setTargetAtTime instead of assigning .value: jumping a gain between audio
  // blocks produces "zipper" clicks while dragging a slider.
  #smooth(param, value) {
    if (!param) return;
    param.setTargetAtTime(value, this.#ctx.currentTime, 0.03);
  }

  /**
   * Fade out and stop after `minutes`. The fade is scheduled as AudioParam
   * automation, which runs on the audio thread with sample accuracy. A
   * setTimeout-driven fade would be at the mercy of timer throttling: a hidden
   * webview can delay timers by up to a minute.
   */
  startSleep(minutes) {
    this.cancelSleep();
    if (!this.playing || !minutes) return;
    const total = minutes * 60;
    const fade = Math.min(SLEEP_FADE, total);
    const g = this.#nodes.master.gain;
    const now = this.#ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    // Exponential ramp = straight line in dB = an evenly paced fade to the ear.
    // A linear gain ramp sounds loud for most of the fade, then falls off a
    // cliff at the end. (Exponential ramps can't reach 0, so stop at -60 dB.)
    g.setValueAtTime(1, now + total - fade);
    g.exponentialRampToValueAtTime(0.001, now + total);
    g.setValueAtTime(0, now + total);
    this.sleepEndsAt = Date.now() + total * 1000;
    // Only the cleanup (suspend + UI state) rides on a timer; if it fires late
    // the output is already silent.
    this.#sleepStopTimer = setTimeout(() => {
      this.sleepEndsAt = null;
      this.pause({ fade: 0.05 });
      this.onSleepEnd?.();
    }, total * 1000 + 100);
  }

  cancelSleep() {
    clearTimeout(this.#sleepStopTimer);
    if (this.sleepEndsAt && this.playing) {
      // Undo a pending fade: hold the current level and ramp back to full.
      const g = this.#nodes.master.gain;
      const now = this.#ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(1, now + 0.5);
    }
    this.sleepEndsAt = null;
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
