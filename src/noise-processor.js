// Runs on the audio rendering thread (AudioWorkletGlobalScope).
// Generates every sound procedurally, so playback never repeats:
//
//   white, pink, brown   classic noise colors
//   rain                 a soft hiss bed, a dense patter of tiny noise ticks,
//                        and the odd nearby splat, swelling and easing
//   fan                  a band-limited whoosh with blade flutter and motor hum
//   snow                 a blizzard: gusting, howling wind with blown ice hiss
//   ocean                surf: each wave builds, breaks, and washes out
//   stream               a brook: a babble of small rising bubbles over a wash
//   fire                 a fireplace: low roar, clumped crackles, the odd pop
//
// The sounds are layered by a mixer. Each layer's weight slews toward its
// target, so moving a fader or switching presets is a ~80 ms crossfade, never
// a click. Stereo width is a mid/side blend applied last.

// Loudness-matching gains: equal *A-weighted* level (≈ perceived loudness),
// not equal RMS, so every layer at 100% sounds equally loud. White noise
// concentrates energy at 2–5 kHz where hearing is most sensitive, so at equal
// RMS it sounds ~11 dB louder than pink. Pink is scaled to 0.7 for headroom.
// Measured by `node scripts/measure-sounds.mjs`; re-run it if you change a generator.
const GAIN = {
  white: 0.2, pink: 0.7, brown: 0.874, rain: 0.731, fan: 0.514,
  snow: 2.46, ocean: 1.22, stream: 1.43, fire: 1.07,
};

const SOUNDS = ['white', 'pink', 'brown', 'rain', 'fan', 'snow', 'ocean', 'stream', 'fire'];
const [WHITE, PINK, BROWN, RAIN, FAN, SNOW, OCEAN, STREAM, FIRE] = SOUNDS.keys();
const SLEW_SECONDS = 0.08;

const white = () => Math.random() * 2 - 1;
// Seconds until the next event of a Poisson process with `rate` events/s, in samples.
const nextEvent = (rate) => Math.ceil(-Math.log(1 - Math.random()) * (sampleRate / rate));
// Log-uniform pick in [lo, hi]: even spread across octaves, as pitch is heard.
const logRand = (lo, hi, u = Math.random()) => lo * (hi / lo) ** u;
// One-pole low-pass coefficient for a corner frequency.
const onePole = (hz) => 1 - Math.exp((-2 * Math.PI * hz) / sampleRate);
// Per-sample decay multiplier for an exponential with time constant `sec`.
const decayFor = (sec) => Math.exp(-1 / (sec * sampleRate));

// Safety net for rare peaks (a splat or crackle landing on a loud stretch of
// the bed): transparent below KNEE, then a tanh curve that approaches but
// never reaches full scale. The test checks it almost never engages.
const KNEE = 0.7;
function softLimit(x) {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  return Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
}

// A slow random wander: an Ornstein–Uhlenbeck process with unit variance and
// time constant `tau` seconds. Used for gusts, rain intensity, flame flicker:
// anything that should drift unpredictably but never jump.
class Drift {
  constructor(tau) {
    this.a = decayFor(tau);
    this.b = Math.sqrt(1 - this.a * this.a) * Math.sqrt(3); // white() has variance 1/3
    this.x = 0;
  }
  step() { return (this.x = this.a * this.x + this.b * white()); }
}

// Band-pass: a topology-preserving state-variable filter (Zavalishin), which
// stays stable while its centre moves, as the wind's does. Peak gain is 1.
// tune() is the expensive part (a tan), so moving filters retune every
// TUNE_EVERY samples rather than every sample; nobody hears the steps.
const TUNE_EVERY = 32;
const svf = (hz = 1000, q = 1) => tune({ ic1: 0, ic2: 0, k: 0, a1: 0, a2: 0, a3: 0 }, hz, q);
function tune(st, hz, q) {
  const g = Math.tan((Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate);
  st.k = 1 / q;
  st.a1 = 1 / (1 + g * (g + st.k));
  st.a2 = g * st.a1;
  st.a3 = g * st.a2;
  return st;
}
function bandpass(st, x) {
  const v3 = x - st.ic2;
  const v1 = st.a1 * st.ic1 + st.a2 * v3;
  const v2 = st.ic2 + st.a2 * st.ic1 + st.a3 * v3;
  st.ic1 = 2 * v1 - st.ic1;
  st.ic2 = 2 * v2 - st.ic2;
  return v1 * st.k;
}

// Sine by table lookup (phase in cycles, 0..1): the stream runs a dozen
// oscillators per channel, and Math.sin was most of its cost.
const SINE_SIZE = 4096;
const SINE = Float64Array.from({ length: SINE_SIZE + 1 }, (_, i) => Math.sin((2 * Math.PI * i) / SINE_SIZE));
function sine(phase) {
  const x = phase * SINE_SIZE;
  const i = x | 0;
  return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i);
}

// Steal the quietest voice in a pool for a new event.
function quietest(pool) {
  let v = pool[0];
  for (const p of pool) if (p.env < v.env) v = p;
  return v;
}

// A short burst of filtered noise with an exponential decay: the building
// block of rain patter, ice ticks and fire crackles. The band (hp..lp) sets
// its color; anything above a few ms starts to sound like a "tsh".
const grain = () => ({ env: 0, decay: 0, hp: 0, lp: 0, hpC: 0, lpC: 0 });
function startGrain(pool, amp, sec, hpHz, lpHz) {
  const v = quietest(pool);
  v.env = amp;
  v.decay = decayFor(sec);
  v.hpC = onePole(hpHz);
  v.lpC = onePole(lpHz);
}
function grainsStep(pool) {
  let out = 0;
  for (const v of pool) {
    if (v.env < 1e-5) continue;
    const x = white() * v.env;
    v.env *= v.decay;
    v.hp += v.hpC * (x - v.hp);
    v.lp += v.lpC * ((x - v.hp) - v.lp);
    out += v.lp;
  }
  return out;
}

function makeChannelState() {
  return {
    b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0, brown: 0,
    // rain
    rainHp: 0, rainLp: 0, rainLp2: 0, rainLow: 0,
    patter: Array.from({ length: 24 }, grain), nextPatter: 0,
    splats: Array.from({ length: 4 }, () => ({ env: 0, decay: 0, f: svf() })), nextSplat: 0,
    // fan
    fanLp: 0, fanLp2: 0, fanSub: 0,
    // snow
    snowBody: 0, snowBody2: 0, howl: svf(), whistle: svf(), snowTick: 0, iceHp: 0, iceHp2: 0,
    ice: Array.from({ length: 4 }, grain), nextIce: 0, gust: new Drift(1.3),
    // ocean
    seaLow: 0, seaLp: 0, seaLp2: 0, fizzHp: 0, fizzHp2: 0,
    // stream
    brook: svf(900, 0.6),
    bubbles: Array.from({ length: 16 }, () => ({ env: 0, decay: 0, phase: 0, inc: 0, rise: 1 })), nextBubble: 0,
    // fire
    roar: 0, roar2: 0, fireHiss: svf(3000, 0.7),
    crackles: Array.from({ length: 12 }, grain), nextCrackle: 0, burstLeft: 0, burstGap: 0,
    pops: Array.from({ length: 2 }, grain), nextPop: 0,
  };
}

// Pink: Paul Kellet's "refined" filter. A bank of one-pole low-passes at
// staggered corners whose sum approximates a -3 dB/octave slope (1/f power)
// to within ~0.05 dB across the audible band.
function pinkStep(s, w) {
  s.b0 = 0.99886 * s.b0 + w * 0.0555179;
  s.b1 = 0.99332 * s.b1 + w * 0.0750759;
  s.b2 = 0.969 * s.b2 + w * 0.153852;
  s.b3 = 0.8665 * s.b3 + w * 0.3104856;
  s.b4 = 0.55 * s.b4 + w * 0.5329522;
  s.b5 = -0.7616 * s.b5 - w * 0.016898;
  const pink = s.b0 + s.b1 + s.b2 + s.b3 + s.b4 + s.b5 + s.b6 + w * 0.5362;
  s.b6 = w * 0.115926;
  return pink * 0.11;
}

// ---- rain -------------------------------------------------------------------
// Real rain is overwhelmingly noise: thousands of tiny broadband impacts per
// second, not pitched "plinks" (ringing resonators read as water drops in a
// bucket). So: a hiss bed rolled off above 5 kHz, a little low body (rain on
// the ground and roof), a dense patter of sub-millisecond noise ticks, and a
// few broad, unpitched splats from drops landing close by. `intensity`
// (shared, ~0.7..1.3) swells the shower slowly.
const RAIN_HP = onePole(500);
const RAIN_LP = onePole(5000);
const RAIN_LOW = onePole(250);
const PATTER_RATE = 900;
const SPLAT_RATE = 5;

function rainStep(s, intensity) {
  const w = white();
  s.rainHp += RAIN_HP * (w - s.rainHp);
  s.rainLp += RAIN_LP * ((w - s.rainHp) - s.rainLp);
  s.rainLp2 += RAIN_LP * (s.rainLp - s.rainLp2);
  s.rainLow += RAIN_LOW * (white() - s.rainLow);
  let out = (s.rainLp2 * 0.5 + s.rainLow * 0.6) * intensity;

  // Patter: most ticks are faint and distant; amplitude is heavily skewed.
  if (--s.nextPatter <= 0) {
    s.nextPatter = nextEvent(PATTER_RATE * intensity);
    const u = Math.random();
    startGrain(s.patter, 0.9 * u ** 4, logRand(0.00012, 0.0009), logRand(700, 4000), logRand(3500, 12000));
  }
  out += grainsStep(s.patter);

  // Splats: a broad (Q < 1, so unpitched) band of noise, a few ms long.
  if (--s.nextSplat <= 0) {
    s.nextSplat = nextEvent(SPLAT_RATE * intensity);
    const v = quietest(s.splats);
    v.env = 0.25 + 0.5 * Math.random() ** 2;
    v.decay = decayFor(logRand(0.002, 0.007));
    tune(v.f, logRand(500, 2500), 0.8);
  }
  for (const v of s.splats) {
    if (v.env < 1e-5) continue;
    out += bandpass(v.f, white() * v.env);
    v.env *= v.decay;
  }
  return out;
}

// ---- fan --------------------------------------------------------------------
// Per channel: noise low-passed twice at 700 Hz with the sub-bass taken out,
// then fluttered by the blades (`flutter`, shared by both channels since it's
// one physical fan).
const FAN_LP = onePole(700);
const FAN_SUB = onePole(70);

function fanStep(s, flutter) {
  const w = white();
  s.fanLp += FAN_LP * (w - s.fanLp);
  s.fanLp2 += FAN_LP * (s.fanLp - s.fanLp2);
  s.fanSub += FAN_SUB * (s.fanLp2 - s.fanSub);
  return (s.fanLp2 - s.fanSub) * 3.2 * flutter + w * 0.04;
}

// ---- snowstorm --------------------------------------------------------------
// Wind is noise through a resonance whose pitch and level follow the gust:
// stronger gusts howl higher and louder. `gust` (shared, ~0.2..1.1) is the
// storm; each channel adds its own small wander so gusts move across the
// stereo field. On top: a narrow whistle that only sings in strong gusts, and
// the hiss and tick of blown snow and ice, also riding the gust.
const SNOW_BODY = onePole(180);
const ICE_HP = onePole(3500);

function snowStep(s, gust) {
  const g = Math.max(0.1, gust + 0.12 * s.gust.step());
  const g2 = g * g;
  s.snowBody += SNOW_BODY * (white() - s.snowBody);
  s.snowBody2 += SNOW_BODY * (s.snowBody - s.snowBody2);
  let out = s.snowBody2 * 0.8 * (0.5 + 0.5 * g);
  if (--s.snowTick <= 0) {
    s.snowTick = TUNE_EVERY;
    tune(s.howl, 280 * 2 ** (1.6 * g), 2.5);
    tune(s.whistle, 650 * 2 ** (1.5 * g), 22);
  }
  out += bandpass(s.howl, white()) * 0.5 * (0.3 + g);
  out += bandpass(s.whistle, white()) * 0.8 * Math.max(0, g - 0.75) ** 1.5;

  const w = white();
  s.iceHp += ICE_HP * (w - s.iceHp);
  s.iceHp2 += ICE_HP * ((w - s.iceHp) - s.iceHp2);
  out += (w - s.iceHp - s.iceHp2) * 0.1 * (0.3 + g);
  if (--s.nextIce <= 0) {
    s.nextIce = nextEvent(10 + 50 * g2);
    startGrain(s.ice, 0.25 * Math.random() ** 2, logRand(0.00005, 0.0002), 3000, 14000);
  }
  return out + grainsStep(s.ice);
}

// ---- ocean ------------------------------------------------------------------
// One shared surf cycle drives both channels (it's one shoreline): `swell`
// rises as a wave approaches, `crash` jumps when it breaks and fades over a
// couple of seconds, `wash` is the long fizzing retreat. The crash opens a
// low-pass, so the break is bright and the tail darkens as it recedes.
const SEA_LOW = onePole(120);
const FIZZ_HP = onePole(2500);

function oceanStep(s, swell, crash, wash) {
  s.seaLow += SEA_LOW * (white() - s.seaLow);
  let out = s.seaLow * 1.0 * (0.35 + 0.65 * swell);
  const lp = onePole(700 + 2300 * crash);
  const w = white();
  s.seaLp += lp * (w - s.seaLp);
  s.seaLp2 += lp * (s.seaLp - s.seaLp2);
  out += s.seaLp2 * 1.4 * (0.45 + 0.6 * crash);
  const f = white();
  s.fizzHp += FIZZ_HP * (f - s.fizzHp);
  s.fizzHp2 += FIZZ_HP * ((f - s.fizzHp) - s.fizzHp2);
  return out + (f - s.fizzHp - s.fizzHp2) * 0.15 * wash * (0.6 + 0.8 * Math.random() ** 3);
}

// ---- stream -----------------------------------------------------------------
// A brook's babble is bubbles: each a sine whose pitch rises as it decays
// (a collapsing air pocket shrinks, so it rings higher). Small bubbles are
// higher and shorter. Under them, a broad wash of moving water.
function streamStep(s, flow) {
  let out = bandpass(s.brook, white()) * 0.18;
  if (--s.nextBubble <= 0) {
    s.nextBubble = nextEvent(110 * flow);
    const v = quietest(s.bubbles);
    const hz = logRand(450, 3500);
    const sec = 0.008 * (600 / hz) ** 0.7 + 0.002;
    v.env = (0.04 + 0.16 * Math.random() ** 2) * (hz / 1000) ** 0.3;
    v.decay = decayFor(sec);
    v.phase = 0;
    v.inc = hz / sampleRate;
    v.rise = Math.exp(Math.log(1 + 0.3 + Math.random()) / (sec * 3 * sampleRate));
  }
  for (const v of s.bubbles) {
    if (v.env < 1e-5) continue;
    out += v.env * sine(v.phase);
    v.phase += v.inc;
    if (v.phase >= 1) v.phase -= 1;
    v.inc = Math.min(v.inc * v.rise, 0.2);
    v.env *= v.decay;
  }
  return out;
}

// ---- fire -------------------------------------------------------------------
// A fireplace: a dark roar and a soft hiss, both breathing with the shared
// `flicker`, under crackles. Crackles come in bursts of a few sharp ticks
// (sap and gas escaping), and the burst rate itself drifts (`crackle`), so
// they clump the way a real fire's do. Now and then a log pops: a duller,
// longer thump.
const ROAR_LP = onePole(400);

function fireStep(s, flicker, crackle) {
  s.roar += ROAR_LP * (white() - s.roar);
  s.roar2 += ROAR_LP * (s.roar - s.roar2);
  let out = s.roar2 * 2 * flicker;
  out += bandpass(s.fireHiss, white()) * 0.2 * flicker;

  if (--s.nextCrackle <= 0) {
    s.nextCrackle = nextEvent(4 * crackle);
    s.burstLeft = 1 + Math.floor(Math.random() ** 2 * 7);
    s.burstGap = 0;
  }
  if (s.burstLeft > 0 && --s.burstGap <= 0) {
    s.burstLeft--;
    s.burstGap = Math.ceil(logRand(0.0008, 0.015) * sampleRate);
    startGrain(s.crackles, 0.1 + 0.35 * Math.random() ** 2, logRand(0.00008, 0.0005), logRand(1000, 3000), 12000);
  }
  // Embers: faint ticks between the crackles.
  if (Math.random() < 25 / sampleRate) {
    startGrain(s.crackles, 0.08 * Math.random(), 0.0001, 2000, 10000);
  }
  if (--s.nextPop <= 0) {
    s.nextPop = nextEvent(0.25);
    startGrain(s.pops, 0.5 + 0.4 * Math.random(), logRand(0.002, 0.005), 150, 1200);
  }
  return out + grainsStep(s.crackles) + grainsStep(s.pops) * 1.5;
}

class NoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    this.target = new Float64Array(SOUNDS.length);
    this.setMix(opts.mix ?? { pink: 1 });
    this.weights = Float64Array.from(this.target);
    this.on = new Uint8Array(SOUNDS.length); // per block: which layers to run
    this.widthTarget = opts.width ?? 1;
    this.width = this.widthTarget;
    // Independent state per channel: decorrelated L/R noise sounds wide and
    // enveloping; identical L/R collapses to a point in the middle of your head.
    this.channels = [makeChannelState(), makeChannelState()];
    this.slew = 1 / (SLEW_SECONDS * sampleRate);
    // Fan mechanics, shared across channels.
    this.bladePhase = 0;
    this.bladeHz = 23;
    this.humPhase = 0;
    // Weather and water, shared across channels: one storm, one shoreline.
    this.rainDrift = new Drift(4);
    this.gustDrift = new Drift(2.5);
    this.flowDrift = new Drift(2);
    this.flickerDrift = new Drift(0.5);
    this.crackleDrift = new Drift(3);
    this.surf = { t: 0, build: 3, next: 10, peak: 0.8, swell: 0, kick: 0, crash: 0, wash: 0 };
    this.mod = { flutter: 1, hum: 0, intensity: 1, gust: 0.6, flow: 1, flicker: 1, crackle: 1 };
    this.crashAttack = onePole(1 / (2 * Math.PI * 0.25)); // ~0.25 s break
    this.crashDecay = decayFor(1.8);
    this.washDecay = decayFor(4);

    this.port.onmessage = ({ data }) => {
      if (data?.mix) this.setMix(data.mix);
      if (typeof data?.width === 'number') this.widthTarget = Math.min(1, Math.max(0, data.width));
    };
  }

  // Layers are independent noises, so their powers add. Normalizing by the
  // root-sum-square of the levels keeps a full mix as loud as a single layer
  // at 100%, and keeps it from clipping.
  setMix(mix) {
    const levels = SOUNDS.map((k) => Math.min(1, Math.max(0, +mix[k] || 0)));
    const norm = Math.max(1, Math.hypot(...levels));
    levels.forEach((v, i) => { this.target[i] = v / norm; });
  }

  // Advance the surf cycle one sample: a wave builds for `build` seconds,
  // breaks, and the next one arrives 8–14 s after the last.
  #surfStep() {
    const u = this.surf;
    u.t += 1 / sampleRate;
    if (u.t >= u.next) {
      u.t = 0;
      u.build = 2.5 + 2 * Math.random();
      u.next = 8 + 6 * Math.random();
      u.peak = 0.6 + 0.4 * Math.random();
    }
    const approaching = u.t < u.build;
    if (!approaching && u.t - 1 / sampleRate < u.build) {
      u.kick = u.peak;
      u.wash = Math.max(u.wash, u.kick);
    }
    u.swell += 0.00005 * ((approaching ? (u.t / u.build) ** 2 : u.kick) - u.swell);
    u.kick *= this.crashDecay;
    u.crash += this.crashAttack * (u.kick - u.crash);
    u.wash *= this.washDecay;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const w = this.weights;
    const t = this.target;
    const slew = this.slew;
    const [sL, sR] = this.channels;
    // Skip layers that are silent and staying that way. A skipped layer's
    // filter state just pauses; it fades back in from weight 0, so resuming
    // from stale state can't click.
    const on = this.on;
    for (let k = 0; k < w.length; k++) on[k] = w[k] > 0 || t[k] > 0;
    const m = this.mod;

    for (let i = 0; i < n; i++) {
      for (let k = 0; k < w.length; k++) {
        const d = t[k] - w[k];
        w[k] += d > slew ? slew : d < -slew ? -slew : d;
      }
      const dw = this.widthTarget - this.width;
      this.width += dw > slew ? slew : dw < -slew ? -slew : dw;

      m.flutter = 1;
      m.hum = 0;
      if (on[FAN]) {
        // Blade-pass rate wanders slowly, the way a real motor's speed does.
        this.bladeHz += (23 - this.bladeHz) * 1e-5 + (Math.random() - 0.5) * 0.002;
        this.bladePhase = (this.bladePhase + this.bladeHz / sampleRate) % 1;
        this.humPhase = (this.humPhase + 100 / sampleRate) % 1;
        m.flutter = 1 + 0.16 * Math.sin(2 * Math.PI * this.bladePhase);
        m.hum = 0.012 * Math.sin(2 * Math.PI * this.humPhase) + 0.005 * Math.sin(4 * Math.PI * this.humPhase);
      }
      if (on[RAIN]) m.intensity = Math.max(0.6, 1 + 0.15 * this.rainDrift.step());
      if (on[SNOW]) m.gust = Math.min(1.1, Math.max(0.2, 0.6 + 0.25 * this.gustDrift.step()));
      if (on[OCEAN]) this.#surfStep();
      if (on[STREAM]) m.flow = Math.max(0.4, 1 + 0.3 * this.flowDrift.step());
      if (on[FIRE]) {
        m.flicker = Math.max(0.6, 1 + 0.12 * this.flickerDrift.step());
        m.crackle = Math.exp(0.8 * this.crackleDrift.step());
      }

      const L = this.#sample(sL, w, on, m);
      const R = this.#sample(sR, w, on, m);

      // Width: mid/side blend. At width 0 both channels carry the mid; the
      // gain makes up the 3 dB that summing decorrelated channels loses.
      const wd = this.width;
      const mid = (L + R) * 0.5;
      const side = (L - R) * 0.5 * wd;
      const g = Math.sqrt(2 / (1 + wd * wd));
      out[0][i] = softLimit((mid + side) * g);
      if (out[1]) out[1][i] = softLimit((mid - side) * g);
    }
    return true; // keep the node alive
  }

  // Each layer draws its own randomness: layers built from one shared white
  // sample would be correlated and add up louder than the mixer expects.
  #sample(s, w, on, m) {
    let x = 0;
    if (on[WHITE]) x += white() * GAIN.white * w[WHITE];
    if (on[PINK]) x += pinkStep(s, white()) * GAIN.pink * w[PINK];
    if (on[BROWN]) {
      // Brown: a leaky integrator of white noise (-6 dB/octave). The leak
      // (/1.02) pulls the random walk back toward zero so it can't drift into
      // DC and clip.
      s.brown = (s.brown + 0.02 * white()) / 1.02;
      x += s.brown * 3.5 * GAIN.brown * w[BROWN];
    }
    if (on[RAIN]) x += rainStep(s, m.intensity) * GAIN.rain * w[RAIN];
    if (on[FAN]) x += (fanStep(s, m.flutter) + m.hum) * GAIN.fan * w[FAN];
    if (on[SNOW]) x += snowStep(s, m.gust) * GAIN.snow * w[SNOW];
    if (on[OCEAN]) {
      const u = this.surf;
      x += oceanStep(s, u.swell, u.crash, u.wash) * GAIN.ocean * w[OCEAN];
    }
    if (on[STREAM]) x += streamStep(s, m.flow) * GAIN.stream * w[STREAM];
    if (on[FIRE]) x += fireStep(s, m.flicker, m.crackle) * GAIN.fire * w[FIRE];
    return x;
  }
}

registerProcessor('noise', NoiseProcessor);
