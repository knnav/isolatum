import { NoiseEngine, toneToHz, lowCutToHz } from './audio-engine.js';
import { Spectrum } from './spectrum.js';

const $ = (sel) => document.querySelector(sel);
const tauri = window.__TAURI__; // present when running inside the app (withGlobalTauri)
const isMac = /Mac/.test(navigator.platform);

const COLORS = ['white', 'pink', 'brown'];
const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

// ---- settings ---------------------------------------------------------------
// localStorage is fine for a single-user, single-machine app; wrapped because
// it can throw if site data is blocked.
const KEY = 'hush.settings.v1';
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}
function save() {
  const { color, volume, tone, lowCut, waves } = engine;
  try {
    localStorage.setItem(KEY, JSON.stringify({ color, volume, tone, lowCut, waves }));
  } catch { /* not fatal */ }
}

const saved = load();
const engine = new NoiseEngine({
  color: COLORS.includes(saved.color) ? saved.color : 'pink',
  volume: clamp01(saved.volume ?? 0.6),
  tone: clamp01(saved.tone ?? 1),
  lowCut: clamp01(saved.lowCut ?? 0),
  waves: clamp01(saved.waves ?? 0),
});

// ---- elements ---------------------------------------------------------------
const playBtn = $('#play');
const status = $('#status');
const statusText = $('#statusText');
const title = $('#title');
const subtitle = $('#subtitle');
const sleepArc = $('#sleepArc');
const hint = $('#hint');
const spectrum = new Spectrum($('#spectrum'), engine);

const SHORTCUT = isMac ? '⌘ ⌥ N' : 'Ctrl Alt N';
hint.innerHTML = `<kbd>${SHORTCUT}</kbd> toggles from anywhere`;
hint.title = 'In this window: Space plays/pauses, ↑ ↓ change volume, 1 2 3 pick the sound';

// Set when the webview refused to start audio (autoplay policy); cleared by
// the first play that works.
let needsClick = false;

// ---- sliders ------------------------------------------------------------------
const formatHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`);

const SLIDERS = {
  volume: {
    set: (v) => engine.setVolume(v),
    format: (v) => (v <= 0 ? 'Muted' : `${Math.round(v * 100)}%`),
  },
  tone: {
    set: (v) => engine.setTone(v),
    format: (v) => (v >= 0.99 ? 'Bright' : formatHz(toneToHz(v))),
  },
  lowCut: {
    set: (v) => engine.setLowCut(v),
    format: (v) => (v <= 0.01 ? 'Off' : formatHz(lowCutToHz(v))),
  },
  waves: {
    set: (v) => engine.setWaves(v),
    format: (v) => (v <= 0 ? 'Off' : v < 0.34 ? 'Gentle' : v < 0.67 ? 'Rolling' : 'Deep'),
  },
};

function paintSlider(id) {
  const input = $(`#${id}`);
  const text = SLIDERS[id].format(+input.value);
  input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  input.setAttribute('aria-valuetext', text);
  $(`#${id}Out`).textContent = text;
}

for (const [id, { set }] of Object.entries(SLIDERS)) {
  const input = $(`#${id}`);
  input.value = engine[id];
  paintSlider(id);
  input.addEventListener('input', () => {
    set(+input.value);
    paintSlider(id);
    save();
    render();
  });
}

function nudgeVolume(delta) {
  const input = $('#volume');
  input.value = clamp01(+input.value + delta);
  input.dispatchEvent(new Event('input'));
}

// ---- render -----------------------------------------------------------------
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function sleepRemaining() {
  return engine.sleepEndsAt ? Math.max(0, Math.round((engine.sleepEndsAt - Date.now()) / 1000)) : 0;
}

function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function render() {
  const { playing } = engine;
  document.documentElement.dataset.color = engine.color;

  playBtn.classList.toggle('on', playing);
  playBtn.setAttribute('aria-pressed', String(playing));
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  status.classList.toggle('on', playing);
  statusText.textContent = playing ? 'Playing' : 'Paused';
  title.textContent = `${cap(engine.color)} noise`;

  const left = sleepRemaining();
  playBtn.classList.toggle('sleeping', Boolean(engine.sleepEndsAt));
  if (engine.sleepEndsAt) {
    const total = engine.sleepMinutes * 60;
    sleepArc.style.setProperty('--elapsed', String(100 * (1 - left / total)));
  }

  subtitle.classList.toggle('warn', needsClick);
  if (needsClick) {
    subtitle.textContent = 'Click play to enable audio';
  } else if (engine.sleepEndsAt) {
    subtitle.textContent = left <= 30 ? 'Fading out…' : `Sleep in ${formatDuration(left)}`;
  } else if (playing && engine.volume <= 0) {
    subtitle.textContent = 'Muted';
  } else {
    subtitle.textContent = playing ? 'Playing' : 'Paused';
  }

  spectrum.update();
}

// ---- transport ----------------------------------------------------------------
document.querySelector(`input[name="color"][value="${engine.color}"]`).checked = true;

async function play() {
  const ok = await engine.play();
  if (ok) needsClick = false;
  return ok;
}

async function toggle() {
  if (engine.playing) {
    await engine.pause();
    resetSleepChips(); // pausing cancels any sleep timer
  } else {
    await play();
  }
  render();
  return engine.playing;
}

playBtn.addEventListener('click', toggle);

function setColor(color) {
  engine.setColor(color);
  document.querySelector(`input[name="color"][value="${color}"]`).checked = true;
  save();
  render();
}
for (const input of document.querySelectorAll('input[name="color"]')) {
  input.addEventListener('change', () => setColor(input.value));
}

// ---- sleep timer ------------------------------------------------------------
function resetSleepChips() {
  document.querySelector('input[name="sleep"][value="0"]').checked = true;
}

for (const input of document.querySelectorAll('input[name="sleep"]')) {
  input.addEventListener('change', async () => {
    const minutes = +input.value;
    if (!minutes) {
      engine.cancelSleep();
    } else {
      // Picking a timer while paused starts playback: that's what you want at bedtime.
      if (!engine.playing) await play();
      if (engine.playing) engine.startSleep(minutes);
      else resetSleepChips(); // audio blocked: don't show a timer that isn't running
    }
    render();
  });
}

engine.onSleepEnd = () => { resetSleepChips(); render(); };

// Countdown display only; the actual fade is scheduled on the audio clock.
// Timers are throttled while hidden, so catch up as soon as we're visible.
setInterval(() => { if (engine.sleepEndsAt) render(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

// ---- keyboard (window focused) ----------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const onRange = e.target instanceof HTMLInputElement && e.target.type === 'range';

  if (e.code === 'Space') {
    // A focused button already toggles on Space by itself (on keyup);
    // handling it here too would toggle twice.
    if (e.target === playBtn || onRange) return;
    e.preventDefault();
    toggle();
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !onRange) {
    e.preventDefault();
    nudgeVolume(e.key === 'ArrowUp' ? 0.05 : -0.05);
  } else if (['1', '2', '3'].includes(e.key)) {
    setColor(COLORS[+e.key - 1]);
  }
});

// ---- desktop integration ----------------------------------------------------
// The tray menu and the global shortcut live in Rust and emit this event.
if (tauri) {
  tauri.event.listen('toggle-playback', async () => {
    const wasPlaying = engine.playing;
    const nowPlaying = await toggle();
    if (!wasPlaying && !nowPlaying) {
      // Autoplay policy: the webview refuses to start audio until the user has
      // clicked inside it at least once this session. Surface the window and
      // ask for that one click; after it, the tray and hotkey work while hidden.
      needsClick = true;
      render();
      const win = tauri.window.getCurrentWindow();
      await win.show();
      await win.setFocus();
    }
  });
}

render();
