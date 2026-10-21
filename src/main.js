import { NoiseEngine, SOUNDS, toneToHz, lowCutToHz } from './audio-engine.js';
import { Spectrum } from './spectrum.js';
import { BUILT_IN, capture, matches, sanitize } from './presets.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const tauri = window.__TAURI__; // present when running inside the app (withGlobalTauri)
const isMac = /Mac/.test(navigator.platform);

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
const SOUND_NAMES = {
  white: 'White noise', pink: 'Pink noise', brown: 'Brown noise', rain: 'Rain', fan: 'Fan',
  snow: 'Snowstorm', ocean: 'Ocean', stream: 'Stream', fire: 'Fireplace', rumble: 'Rumble',
};

// ---- settings ---------------------------------------------------------------
// localStorage is fine for a single-user, single-machine app; wrapped because
// it can throw if site data is blocked.
const KEY = 'hush.settings.v2';
const OLD_KEY = 'hush.settings.v1'; // { color, volume, tone, lowCut, waves }

function load() {
  try {
    const v2 = JSON.parse(localStorage.getItem(KEY));
    if (v2) return v2;
    const v1 = JSON.parse(localStorage.getItem(OLD_KEY));
    if (v1) return { ...v1, mix: SOUNDS.includes(v1.color) ? { [v1.color]: 1 } : undefined };
  } catch { /* fall through to defaults */ }
  return {};
}

function save() {
  const { mix, volume, tone, lowCut, waves, width } = engine;
  try {
    localStorage.setItem(KEY, JSON.stringify({ mix, volume, tone, lowCut, waves, width, tab, presets: userPresets }));
  } catch { /* not fatal */ }
}

const saved = load();
const savedMix = Object.fromEntries(SOUNDS.map((k) => [k, clamp01(saved.mix?.[k] ?? 0)]));
if (!Object.values(savedMix).some((v) => v > 0)) savedMix.pink = 1;

const engine = new NoiseEngine({
  mix: savedMix,
  volume: clamp01(saved.volume ?? 0.6),
  tone: clamp01(saved.tone ?? 1),
  lowCut: clamp01(saved.lowCut ?? 0),
  waves: clamp01(saved.waves ?? 0),
  width: clamp01(saved.width ?? 1),
});
let userPresets = (Array.isArray(saved.presets) ? saved.presets : []).map(sanitize).filter(Boolean);
let tab = saved.tab === 'shape' ? 'shape' : 'mix';

// ---- elements ---------------------------------------------------------------
const playBtn = $('#play');
const status = $('#status');
const statusText = $('#statusText');
const title = $('#title');
const subtitle = $('#subtitle');
const hint = $('#hint');
const spectrum = new Spectrum($('#spectrum'), engine);

const SHORTCUT = isMac ? '⌘ ⌥ N' : 'Ctrl Alt N';
hint.innerHTML = `<kbd>${SHORTCUT}</kbd> toggles from anywhere`;
hint.title = 'In this window: Space plays/pauses, ↑ ↓ change volume, 1–9 pick a preset';

// Set when the webview refused to start audio (autoplay policy); cleared by
// the first play that works.
let needsClick = false;

// ---- sliders ------------------------------------------------------------------
const formatHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`);
const percent = (v) => (v <= 0 ? 'Off' : `${Math.round(v * 100)}%`);

// Every slider: how to read it from the engine, apply it, and label it.
const SLIDERS = {
  volume: {
    get: () => engine.volume,
    set: (v) => engine.setVolume(v),
    format: (v) => (v <= 0 ? 'Muted' : `${Math.round(v * 100)}%`),
  },
  tone: {
    get: () => engine.tone,
    set: (v) => engine.setTone(v),
    format: (v) => (v >= 0.99 ? 'Bright' : formatHz(toneToHz(v))),
  },
  lowCut: {
    get: () => engine.lowCut,
    set: (v) => engine.setLowCut(v),
    format: (v) => (v <= 0.01 ? 'Off' : formatHz(lowCutToHz(v))),
  },
  waves: {
    get: () => engine.waves,
    set: (v) => engine.setWaves(v),
    format: (v) => (v <= 0 ? 'Off' : v < 0.34 ? 'Gentle' : v < 0.67 ? 'Rolling' : 'Deep'),
  },
  width: {
    get: () => engine.width,
    set: (v) => engine.setWidth(v),
    format: (v) => (v <= 0.01 ? 'Mono' : v >= 0.99 ? 'Wide' : `${Math.round(v * 100)}%`),
  },
  ...Object.fromEntries(SOUNDS.map((k) => [k, {
    get: () => engine.mix[k] ?? 0,
    set: (v) => engine.setMix({ [k]: v }),
    format: percent,
  }])),
};

// The level each layer returns to when its name is clicked to unmute.
const lastLevel = Object.fromEntries(SOUNDS.map((k) => [k, engine.mix[k] || 1]));

function paintSlider(id) {
  const input = $(`#${id}`);
  const text = SLIDERS[id].format(+input.value);
  input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  input.setAttribute('aria-valuetext', text);
  $(`#${id}Out`).textContent = text;
}

/** Push engine state into every slider (after a preset, a mute, a key). */
function syncSliders() {
  for (const [id, { get }] of Object.entries(SLIDERS)) {
    $(`#${id}`).value = get();
    paintSlider(id);
  }
  for (const btn of $$('.layer')) btn.classList.toggle('muted', !(engine.mix[btn.dataset.sound] > 0));
}

for (const [id, { set }] of Object.entries(SLIDERS)) {
  const input = $(`#${id}`);
  input.addEventListener('input', () => {
    set(+input.value);
    if (SOUNDS.includes(id) && +input.value > 0) lastLevel[id] = +input.value;
    paintSlider(id);
    $(`.layer[data-sound="${id}"]`)?.classList.toggle('muted', !(+input.value > 0));
    save();
    render();
  });
}

for (const btn of $$('.layer')) {
  btn.addEventListener('click', () => {
    const k = btn.dataset.sound;
    engine.setMix({ [k]: engine.mix[k] > 0 ? 0 : lastLevel[k] });
    syncSliders();
    save();
    render();
  });
}

function nudgeVolume(delta) {
  engine.setVolume(clamp01(engine.volume + delta));
  syncSliders();
  save();
  render();
}

// ---- tabs ---------------------------------------------------------------------
function showTab(name, focus = false) {
  tab = name;
  for (const t of $$('[role="tab"]')) {
    const on = t.id === `tab-${name}`;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  }
  $('#panel-mix').hidden = name !== 'mix';
  $('#panel-shape').hidden = name !== 'shape';
}
$('#tab-mix').addEventListener('click', () => { showTab('mix'); save(); });
$('#tab-shape').addEventListener('click', () => { showTab('shape'); save(); });
$('.tabs').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    showTab(tab === 'mix' ? 'shape' : 'mix', true);
    save();
  }
});

// ---- presets --------------------------------------------------------------------
const allPresets = () => [...BUILT_IN, ...userPresets];
// User presets first: a preset saved from an untouched built-in should show
// as itself, not as the built-in it copies.
const activePreset = () => [...userPresets, ...BUILT_IN].find((p) => matches(engine, p)) ?? null;

function applyPreset(p) {
  engine.setMix(Object.fromEntries(SOUNDS.map((k) => [k, p.mix[k] ?? 0])));
  engine.setTone(p.tone);
  engine.setLowCut(p.lowCut);
  engine.setWaves(p.waves);
  engine.setWidth(p.width);
  for (const k of SOUNDS) if (p.mix[k] > 0) lastLevel[k] = p.mix[k];
  syncSliders();
  save();
  render();
}

function renderPresets() {
  const list = $('#presets');
  const active = activePreset();
  list.replaceChildren(...allPresets().map((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.setAttribute('role', 'listitem');

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'pick';
    pick.textContent = p.name;
    pick.setAttribute('aria-pressed', String(p === active));
    if (i < 9) pick.title = `Key ${i + 1}`;
    pick.addEventListener('click', () => applyPreset(p));
    chip.append(pick);

    if (!BUILT_IN.includes(p)) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '✕';
      del.setAttribute('aria-label', `Delete preset ${p.name}`);
      del.addEventListener('click', () => {
        userPresets = userPresets.filter((u) => u !== p);
        save();
        render();
        // The chips were rebuilt, taking the focused button with them; land
        // on the chip that took this one's place (or the last one).
        const chips = $('#presets').children;
        (chips[Math.min(i, chips.length - 1)]?.querySelector('.pick') ?? saveOpen).focus();
      });
      chip.append(del);
    }
    return chip;
  }));
}

const saveOpen = $('#saveOpen');
const saveForm = $('#saveForm');
const saveName = $('#saveName');

function openSave(open) {
  saveOpen.hidden = open;
  saveForm.hidden = !open;
  if (open) {
    saveName.value = '';
    saveName.focus();
  } else {
    saveOpen.focus();
  }
}
saveOpen.addEventListener('click', () => openSave(true));
$('#saveCancel').addEventListener('click', () => openSave(false));
saveName.addEventListener('keydown', (e) => { if (e.key === 'Escape') openSave(false); });
saveName.addEventListener('input', () => saveName.setCustomValidity(''));
saveForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = saveName.value.trim();
  if (!name) return saveName.focus();
  if (BUILT_IN.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    saveName.setCustomValidity(`“${name}” is a built-in preset. Pick another name.`);
    saveName.reportValidity();
    return;
  }
  // Saving under an existing name of yours replaces it.
  const existing = userPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const preset = { id: existing?.id ?? `u${Date.now().toString(36)}`, name, ...capture(engine) };
  userPresets = existing ? userPresets.map((p) => (p === existing ? preset : p)) : [...userPresets, preset];
  save();
  openSave(false);
  render();
});

// ---- render -----------------------------------------------------------------
/** The loudest layer, which sets the accent color; null if the mix is empty. */
function dominant() {
  let best = null;
  for (const k of SOUNDS) if ((engine.mix[k] ?? 0) > (engine.mix[best] ?? 0)) best = k;
  return best;
}

function soundTitle(active) {
  if (active) return active.name;
  const on = SOUNDS.filter((k) => engine.mix[k] > 0);
  if (on.length === 1) return SOUND_NAMES[on[0]];
  return on.length ? 'Custom mix' : 'Empty mix';
}

function render() {
  const { playing } = engine;
  const active = activePreset();
  const lead = dominant();
  if (lead) document.documentElement.dataset.color = lead;

  playBtn.classList.toggle('on', playing);
  playBtn.setAttribute('aria-pressed', String(playing));
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  status.classList.toggle('on', playing);
  statusText.textContent = playing ? 'Playing' : 'Paused';
  title.textContent = soundTitle(active);

  subtitle.classList.toggle('warn', needsClick || !lead);
  if (needsClick) {
    subtitle.textContent = 'Click play to enable audio';
  } else if (!lead) {
    subtitle.textContent = 'Raise a layer to hear something';
  } else if (playing && engine.volume <= 0) {
    subtitle.textContent = 'Muted';
  } else {
    subtitle.textContent = playing ? 'Playing' : 'Paused';
  }

  // Rebuilding the chips steals focus from them, so only do it on change.
  const presetsKey = JSON.stringify([allPresets().map((p) => p.id + p.name), active?.id]);
  if (presetsKey !== renderPresets.key) {
    renderPresets.key = presetsKey;
    renderPresets();
  }

  spectrum.update();
  syncTray(active);
}

// ---- tray menu ----------------------------------------------------------------
// Rust updates the native menu from this. Only send it when it changes.
let trayKey = '';
function syncTray(active) {
  if (!tauri) return;
  const state = {
    playing: engine.playing,
    nowPlaying: soundTitle(active) + (engine.playing ? '' : ' · paused'),
    presets: allPresets().map(({ id, name }) => ({ id, name })),
    activePreset: active?.id ?? null,
  };
  const key = JSON.stringify(state);
  if (key === trayKey) return;
  trayKey = key;
  tauri.core.invoke('sync_tray', { state }).catch((err) => {
    trayKey = ''; // so the next render tries again
    console.warn('isolatum: tray sync failed', err);
  });
}

// ---- transport ----------------------------------------------------------------
async function play() {
  const ok = await engine.play();
  if (ok) needsClick = false;
  return ok;
}

async function toggle() {
  if (engine.playing) {
    await engine.pause();
  } else {
    await play();
  }
  render();
  return engine.playing;
}

/**
 * Start playback for a request from outside the window (tray, hotkey).
 * Autoplay policy: the webview refuses to start audio until the user has
 * clicked inside it at least once this session. If that's why it failed,
 * surface the window and ask for that one click; after it, the tray and
 * hotkey work while hidden.
 */
async function playFromBackground() {
  if (engine.playing || (await play())) return true;
  needsClick = true;
  render();
  const win = tauri.window.getCurrentWindow();
  await win.show();
  await win.setFocus();
  return false;
}

playBtn.addEventListener('click', toggle);

// ---- keyboard (window focused) ----------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type === 'text') return; // naming a preset
  const onRange = t instanceof HTMLInputElement && t.type === 'range';

  if (e.code === 'Space') {
    // A focused button already acts on Space by itself (on keyup);
    // handling it here too would act twice.
    if (t instanceof HTMLButtonElement || onRange) return;
    e.preventDefault();
    toggle();
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !onRange && !t.closest?.('[role="tablist"]')) {
    e.preventDefault();
    nudgeVolume(e.key === 'ArrowUp' ? 0.05 : -0.05);
  } else if (/^[1-9]$/.test(e.key)) {
    const p = allPresets()[+e.key - 1];
    if (p) applyPreset(p);
  }
});

// ---- desktop integration ----------------------------------------------------
// The tray menu and the global shortcut live in Rust and emit these events.
if (tauri) {
  const { listen } = tauri.event;
  listen('toggle-playback', async () => {
    if (engine.playing) await toggle();
    else await playFromBackground();
    render();
  });
  listen('tray-preset', async ({ payload: id }) => {
    // A native check item flips itself when clicked, even when it was
    // already the active one, so the next sync must go out even if our
    // state is unchanged.
    trayKey = '';
    const p = allPresets().find((x) => x.id === id);
    if (p) applyPreset(p); else render();
    await playFromBackground();
    render();
  });
}

showTab(tab);
syncSliders();
render();
