# Isolatum

A white noise machine for macOS and Windows. It generates the noise procedurally, so playback never loops. It lives in the menu bar or tray, and you can toggle it from anywhere with a global shortcut.

- **Nine sounds**: white, pink and brown noise, plus
  - **rain**: a soft hiss under a dense patter of drops, swelling and easing
  - **fan**: a whoosh with blade flutter and a faint motor hum
  - **snow**: a blizzard, with gusting, howling wind and blown ice
  - **ocean**: surf, where each wave builds, breaks and washes out
  - **stream**: a babbling brook, with small rising bubbles over moving water
  - **fire**: a fireplace, with a low roar, clumped crackles and the odd pop

  All are loudness-matched, so switching doesn't change perceived volume.
- **Mixer**: layer any of the sounds at their own levels. The mix is power-normalized, so stacking layers can't get louder than one layer at 100% or clip. Click a layer's name to mute or unmute it.
- **Presets**: Rain, Storm, Snowstorm, Ocean, Brook, Fireplace, Fan, Deep sleep and Focus are built in, and you can save your own. Presets store the sound (mix and shape) but never the volume, so picking one can't blast you. Keys <kbd>1</kbd>–<kbd>9</kbd> pick them.
- **Tone**: a low-pass filter from 300 Hz to 20 kHz to warm any color
- **Low cut**: a high-pass filter from 20 Hz to 500 Hz to take out rumble
- **Width**: stereo width, from mono (both ears identical) to fully wide, loudness-compensated
- **Waves**: slow, uneven volume swells (two unrelated LFOs, ~7 s and ~11 s), from gentle to deep
- **Live spectrum**: the hero card draws the sound's actual shape (color slope through the real filter responses), and it swells with the waves
- **Tray menu**: play/pause, what's playing, and a Presets submenu, so you rarely need the window
- **Keyboard** (window focused): <kbd>Space</kbd> play/pause, <kbd>↑</kbd> <kbd>↓</kbd> volume, <kbd>1</kbd>–<kbd>9</kbd> presets
- **Global shortcut**: <kbd>⌘ ⌥ N</kbd> on macOS, <kbd>Ctrl Alt N</kbd> on Windows
- **Close to tray**: closing the window keeps the noise playing. Quit from the tray menu.

Built with [Tauri 2](https://v2.tauri.app). The frontend is plain HTML/CSS/JS with no bundler, and all audio is Web Audio (AudioWorklet).

## Build it

### macOS

```sh
xcode-select --install                                           # if you don't have the CLI tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
# plus Node 18+ (e.g. `brew install node`)

npm install
npm run dev      # run it in development
npm run build:mac  # → src-tauri/target/release/bundle/macos/Isolatum.app (+ a .dmg)
```

Drag `Isolatum.app` into `/Applications`. A build made on your own machine has no quarantine flag, so Gatekeeper won't block it even though it's unsigned. Signing only matters for downloaded apps.

### Windows, cross-compiled from Linux or WSL

```sh
sudo apt install nsis lld llvm clang
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin

npm install
npm run build:win   # → dist/Isolatum_0.1.0_x64_portable.exe
```

The `.exe` is portable: one file with the frontend embedded, and no installer. It's unsigned, so SmartScreen may show a warning. Click **More info → Run anyway**. It needs WebView2, which ships with Windows 11 and current Windows 10.

### Linux

```sh
npm install
npm run build       # → dist/Isolatum_0.1.0_amd64.AppImage
```

The first Rust build takes a few minutes while it compiles Tauri. Later builds are incremental.

## How it works

```
src/
  noise-processor.js   AudioWorklet: generates and mixes the sounds, applies stereo width
  audio-engine.js      Builds the graph: worklet → high-pass → low-pass → swell → volume → master
  spectrum.js          The spectrum display (canvas; only animates while something changes)
  presets.js           Built-in presets, matching, validation of saved ones
  main.js              UI wiring, settings, tray/shortcut events
src-tauri/src/lib.rs   Tray icon and menu, global shortcut, close-to-tray
test/                  Spectrum test for the noise generator
scripts/               measure-sounds.mjs (calibration), collect-portable.mjs (build output)
```

- **Sounds.** White noise is uniform random samples. Pink noise comes from Paul Kellet's filter bank, which approximates −3 dB/octave. Brown noise is leaky-integrated white, at −6 dB/octave. Rain is a band-limited hiss with a little low body, a dense Poisson patter of sub-millisecond noise ticks, and a few broad, unpitched splats. It avoids pitched resonators, which make rain sound like drops falling into a bucket. Snow is noise through a state-variable band-pass whose centre and level follow a random gust, plus a narrow whistle in strong gusts and gust-driven ice hiss. Ocean runs one shared surf cycle: the swell builds, the break opens a low-pass, and a fizzing wash decays slowly. Stream is a babble of sine "bubbles" whose pitch rises as they decay, which is how a collapsing air pocket rings. Fire is a breathing low roar and hiss under bursts of sharp crackles, with occasional duller pops. Slow variation (gusts, showers, flicker) comes from Ornstein–Uhlenbeck drifts, so it wanders without jumping. Fan is doubly low-passed noise, amplitude-modulated at a wandering ~23 Hz blade rate, with a quiet 100 Hz motor hum. Every layer draws its own randomness, and each stereo channel has independent state, so the sound is wide instead of sitting in the center of your head.
- **Mixing.** Layer levels are divided by their root-sum-square before mixing, which keeps a full mix at about the loudness of one layer. A soft limiter at the worklet's output (transparent below 0.7) catches the rare peak from a splat, crackle or wave break. The tests check that it touches fewer than 0.01% of samples.
- **Rust never touches audio.** The tray and the shortcut only emit events (`toggle-playback`, `tray-preset`), and the JS engine is the single source of truth for playback state. The webview pushes what the tray menu should show through the `sync_tray` command, and only when it changes. Rust updates the existing menu items in place rather than replacing the menu, so a change can't close it while it's open.
- **Pausing suspends the AudioContext.** That means zero CPU while paused, instead of rendering silence.
- **Autoplay policy.** Webviews won't start audio until you've clicked inside them once per launch. If you press the shortcut before that, Isolatum brings its window up and asks for one click. After that click, the shortcut works with the window hidden.

## Tests

```sh
npm test
```

This renders each sound through the real worklet code in Node, with a seeded random generator so results are repeatable. It checks:

- spectral slope (0 / −3 / −6 dB per octave for white / pink / brown)
- that perceived loudness is matched (A-weighted): within 1 dB across the steady noises, and each texture within 1 dB of pink. A full mix must also stay at about one layer's loudness.
- that there's no clipping or DC offset, and the limiter almost never engages
- that the stereo channels are decorrelated, and width 0 really is mono at the same loudness
- that switching sounds is click-free

It takes about two minutes, because the swelling textures need long renders to average out.

If you change a generator, run `node scripts/measure-sounds.mjs` (a few minutes). It prints the loudness-matching `GAIN` for `src/noise-processor.js` and the `BANDS` for `src/spectrum.js`, which drive the display. With `--wav` it also writes 30 s clips to `dist/samples/` to listen to.

## Customizing

- **Shortcut:** `toggle_shortcut()` in `src-tauri/src/lib.rs`. Note that ⌘⌥N is "New Smart Folder" in Finder, and the global shortcut takes precedence over it.
- **Volume range:** `volumeToGain()` maps the slider onto −50 dB … 0 dB.
- **Presets:** `BUILT_IN` in `src/presets.js`.
- **Rain density:** `PATTER_RATE` and `SPLAT_RATE` in `src/noise-processor.js`.
- **Waves:** `WAVE_HZ` (swell rates) and `wavesToSwell()` (depth, −20 dB troughs at full) in `src/audio-engine.js`.
