# Hush

A white noise machine for macOS and Windows. It generates the noise procedurally, so playback never loops. It lives in the menu bar or tray, and you can toggle it from anywhere with a global shortcut.

- **White / pink / brown noise**, loudness-matched so switching color doesn't change perceived volume, with an 80 ms crossfade between colors
- **Tone**: a low-pass filter from 300 Hz to 20 kHz to warm any color
- **Low cut**: a high-pass filter from 20 Hz to 500 Hz to take out rumble
- **Waves**: slow, uneven volume swells (two unrelated LFOs, ~7 s and ~11 s), from gentle to deep
- **Live spectrum**: the hero card draws the sound's actual shape (color slope through the real filter responses), and it swells with the waves and sinks during the sleep fade
- **Sleep timer** (15 min – 2 h) with a 30-second fade that sounds evenly paced, and a countdown ring around the play button
- **Keyboard** (window focused): <kbd>Space</kbd> play/pause, <kbd>↑</kbd> <kbd>↓</kbd> volume, <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> white/pink/brown
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
npm run build    # → src-tauri/target/release/bundle/macos/Hush.app (+ a .dmg)
```

Drag `Hush.app` into `/Applications`. A build made on your own machine has no quarantine flag, so Gatekeeper won't block it even though it's unsigned. Signing only matters for downloaded apps.

### Windows

1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **"Desktop development with C++"** workload. Rust's MSVC toolchain needs its linker.
2. Install Rust from <https://rustup.rs> (keep the default `x86_64-pc-windows-msvc`).
3. Install Node 18+.
4. WebView2 ships with Windows 11 and current Windows 10, so there's nothing to install for it.

```powershell
npm install
npm run dev
npm run build    # → src-tauri\target\release\bundle\msi\Hush_0.1.0_x64_en-US.msi
                 #   and   ...\bundle\nsis\Hush_0.1.0_x64-setup.exe
```

The installer is unsigned, so SmartScreen may show a warning. Click **More info → Run anyway**.

The first Rust build takes a few minutes while it compiles Tauri. Later builds are incremental.

## How it works

```
src/
  noise-processor.js   AudioWorklet: generates the noise on the audio thread
  audio-engine.js      Builds the graph: worklet → high-pass → low-pass → swell → volume → master
  spectrum.js          The spectrum display (canvas; only animates while something changes)
  main.js              UI wiring, settings, tray/shortcut events
src-tauri/src/lib.rs   Tray icon, global shortcut, close-to-tray
test/                  Spectrum test for the noise generator
```

- **Noise colors.** White noise is uniform random samples. Pink noise comes from Paul Kellet's filter bank, which approximates −3 dB/octave. Brown noise is leaky-integrated white, at −6 dB/octave. Each stereo channel has independent state, so the sound is wide instead of sitting in the center of your head.
- **Rust never touches audio.** The tray and the shortcut only emit a `toggle-playback` event, and the JS engine is the single source of truth for playback state.
- **The sleep fade is AudioParam automation** on the audio clock, not a `setTimeout` loop. A hidden webview can throttle timers by up to a minute; the audio thread isn't throttled.
- **Pausing suspends the AudioContext.** That means zero CPU while paused, instead of rendering silence.
- **Autoplay policy.** Webviews won't start audio until you've clicked inside them once per launch. If you press the shortcut before that, Hush brings its window up and asks for one click. After that click, the shortcut works with the window hidden.

## Tests

```sh
npm test
```

This renders each color through the real worklet code in Node. It checks spectral slope (0 / −3 / −6 dB per octave), that perceived loudness is matched across colors (A-weighted, within 1 dB), that there's no clipping or DC offset, that the stereo channels are decorrelated, and that switching colors is click-free. Re-run it if you change a filter or a gain constant.

## Customizing

- **Shortcut:** `toggle_shortcut()` in `src-tauri/src/lib.rs`. Note that ⌘⌥N is "New Smart Folder" in Finder, and the global shortcut takes precedence over it.
- **Sleep fade length:** `SLEEP_FADE` in `src/audio-engine.js`.
- **Volume range:** `volumeToGain()` maps the slider onto −50 dB … 0 dB.
- **Waves:** `WAVE_HZ` (swell rates) and `wavesToSwell()` (depth, −20 dB troughs at full) in `src/audio-engine.js`.
