import { NoiseEngine, toneToHz } from './audio-engine.js';

const $ = (sel) => document.querySelector(sel);
const tauri = window.__TAURI__; // present when running inside the app (withGlobalTauri)
const isMac = /Mac/.test(navigator.platform);

// ---- settings ---------------------------------------------------------------
// localStorage is fine for a single-user, single-machine app; wrapped because
// it can throw if site data is blocked.
const KEY = 'hush.settings.v1';
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ color: engine.color, volume: engine.volume, tone: engine.tone }));
  } catch { /* not fatal */ }
}

const saved = load();
const engine = new NoiseEngine({
  color: ['white', 'pink', 'brown'].includes(saved.color) ? saved.color : 'pink',
  volume: saved.volume ?? 0.6,
  tone: saved.tone ?? 1,
});

// ---- elements ---------------------------------------------------------------
const playBtn = $('#play');
const status = $('#status');
const volume = $('#volume');
const tone = $('#tone');
const toneHz = $('#toneHz');
const countdown = $('#countdown');
const hint = $('#hint');

const SHORTCUT = isMac ? '⌘ ⌥ N' : 'Ctrl Alt N';
const setHint = (html, warn = false) => { hint.innerHTML = html; hint.classList.toggle('warn', warn); };
setHint(`<kbd>${SHORTCUT}</kbd> toggles from anywhere`);

// ---- render -----------------------------------------------------------------
function fill(input) {
  input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
}

function formatHz(hz) {
  return hz >= 19500 ? 'open' : hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

function render() {
  playBtn.classList.toggle('on', engine.playing);
  playBtn.setAttribute('aria-pressed', String(engine.playing));
  playBtn.setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
  status.textContent = engine.playing ? `Playing ${engine.color}` : 'Paused';
  toneHz.textContent = formatHz(toneToHz(engine.tone));

  if (engine.sleepEndsAt) {
    const s = Math.max(0, Math.round((engine.sleepEndsAt - Date.now()) / 1000));
    countdown.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  } else {
    countdown.textContent = '';
  }
}

// ---- controls ---------------------------------------------------------------
document.querySelector(`input[name="color"][value="${engine.color}"]`).checked = true;
volume.value = engine.volume;
tone.value = engine.tone;
fill(volume);
fill(tone);

async function toggle() {
  await engine.toggle();
  if (!engine.playing) resetSleepChips(); // pausing cancels any sleep timer
  render();
  return engine.playing;
}

playBtn.addEventListener('click', async () => {
  await toggle();
  setHint(`<kbd>${SHORTCUT}</kbd> toggles from anywhere`);
});

for (const input of document.querySelectorAll('input[name="color"]')) {
  input.addEventListener('change', () => { engine.setColor(input.value); save(); render(); });
}

volume.addEventListener('input', () => { engine.setVolume(+volume.value); fill(volume); save(); });
tone.addEventListener('input', () => { engine.setTone(+tone.value); fill(tone); save(); render(); });

// ---- sleep timer ------------------------------------------------------------
function selectedSleep() {
  return +document.querySelector('input[name="sleep"]:checked').value;
}
function resetSleepChips() {
  document.querySelector('input[name="sleep"][value="0"]').checked = true;
}
function applySleepChoice() {
  const minutes = selectedSleep();
  if (minutes) engine.startSleep(minutes); else engine.cancelSleep();
}

for (const input of document.querySelectorAll('input[name="sleep"]')) {
  input.addEventListener('change', async () => {
    // Picking a timer while paused starts playback: that's what you want at bedtime.
    if (+input.value && !engine.playing) await engine.play();
    applySleepChoice();
    render();
  });
}

engine.onSleepEnd = () => { resetSleepChips(); render(); };

// Countdown display only; the actual fade is scheduled on the audio clock.
setInterval(() => { if (engine.sleepEndsAt) render(); }, 1000);

// ---- keyboard (window focused) ----------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement && e.target.type === 'range')) {
    e.preventDefault();
    toggle();
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
      const win = tauri.window.getCurrentWindow();
      await win.show();
      await win.setFocus();
      setHint('Click play once to enable audio — after that the shortcut works in the background.', true);
    }
  });
}

render();
