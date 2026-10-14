//! Native shell: tray icon and menu, global shortcut, close-to-tray.
//!
//! All audio lives in the webview. Rust never touches it; it only emits events
//! (`toggle-playback`, `tray-preset`) that the frontend listens for. That
//! keeps one source of truth for playback state (the JS engine) instead of two
//! that can drift apart. The frontend in turn pushes what the tray menu should
//! show through the `sync_tray` command.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const TOGGLE_EVENT: &str = "toggle-playback";
const PRESET_EVENT: &str = "tray-preset";
const TRAY_ID: &str = "main";

/// What the tray menu shows, as sent by the frontend.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TrayState {
    playing: bool,
    /// One line describing the sound, e.g. "Rain · paused".
    now_playing: String,
    presets: Vec<TrayPreset>,
    active_preset: Option<String>,
}

#[derive(Deserialize, PartialEq, Clone)]
struct TrayPreset {
    id: String,
    name: String,
}

/// Menu labels treat `&` as a mnemonic marker on every platform (muda strips
/// it on macOS, turns it into `_` on GTK); `&&` is a literal ampersand.
fn label(text: &str) -> String {
    text.replace('&', "&&")
}

/// Handles to the live menu, so a state change updates items in place
/// instead of replacing the whole menu (which would close it if it's open).
struct TrayMenu {
    now: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    presets: Submenu<Wry>,
    preset_items: Vec<(String, CheckMenuItem<Wry>)>,
    /// The (id, name) list `preset_items` was built from.
    built_from: Vec<TrayPreset>,
}

/// The latest state from the frontend, and the menu once the tray exists.
/// Both `sync_tray` and `setup` run on the main thread, so whichever comes
/// first, the tray ends up showing the latest state.
#[derive(Default)]
struct Tray {
    state: TrayState,
    menu: Option<TrayMenu>,
}

impl TrayMenu {
    fn build(app: &AppHandle, state: &TrayState) -> tauri::Result<(Menu<Wry>, TrayMenu)> {
        let now = MenuItem::with_id(app, "now", "Isolatum", false, None::<&str>)?;
        let toggle = MenuItem::with_id(app, "toggle", "Play", true, None::<&str>)?;
        let presets = Submenu::with_id(app, "presets", "Presets", false)?;
        let show = MenuItem::with_id(app, "show", "Show Isolatum", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit Isolatum", true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[
                &now,
                &toggle,
                &PredefinedMenuItem::separator(app)?,
                &presets,
                &PredefinedMenuItem::separator(app)?,
                &show,
                &quit,
            ],
        )?;
        let mut tray_menu = TrayMenu {
            now,
            toggle,
            presets,
            preset_items: Vec::new(),
            built_from: Vec::new(),
        };
        tray_menu.apply(app, state)?;
        Ok((menu, tray_menu))
    }

    fn apply(&mut self, app: &AppHandle, state: &TrayState) -> tauri::Result<()> {
        let now_playing = if state.now_playing.is_empty() {
            "Isolatum"
        } else {
            &state.now_playing
        };
        self.now.set_text(label(now_playing))?;
        self.toggle
            .set_text(if state.playing { "Pause" } else { "Play" })?;

        // Only the preset list changing (saved or deleted) needs new items.
        if self.built_from != state.presets {
            for (_, item) in self.preset_items.drain(..) {
                self.presets.remove(&item)?;
            }
            for p in &state.presets {
                let id = format!("preset:{}", p.id);
                let item =
                    CheckMenuItem::with_id(app, id, label(&p.name), true, false, None::<&str>)?;
                self.presets.append(&item)?;
                self.preset_items.push((p.id.clone(), item));
            }
            self.built_from = state.presets.clone();
            self.presets.set_enabled(!state.presets.is_empty())?;
        }
        // Always reassert every check mark: a native check item flips itself
        // when clicked, even when it was already the active one.
        for (id, item) in &self.preset_items {
            item.set_checked(state.active_preset.as_deref() == Some(id.as_str()))?;
        }
        Ok(())
    }
}

fn tooltip(state: &TrayState) -> String {
    if state.now_playing.is_empty() {
        "Isolatum".into()
    } else {
        format!("Isolatum · {}", state.now_playing)
    }
}

/// Updates the tray from the frontend's state. Not `async`, so Tauri runs it
/// on the main thread, which macOS requires for menu changes.
#[tauri::command]
fn sync_tray(app: AppHandle, tray: State<Mutex<Tray>>, state: TrayState) -> Result<(), String> {
    let mut tray = tray.lock().map_err(|e| e.to_string())?;
    if let Some(menu) = tray.menu.as_mut() {
        menu.apply(&app, &state).map_err(|e| e.to_string())?;
        if let Some(icon) = app.tray_by_id(TRAY_ID) {
            icon.set_tooltip(Some(tooltip(&state)))
                .map_err(|e| e.to_string())?;
        }
    }
    // Before the tray exists this is all we do; `setup` builds from it.
    tray.state = state;
    Ok(())
}

/// Cmd+Option+N on macOS, Ctrl+Alt+N on Windows.
fn toggle_shortcut() -> Shortcut {
    #[cfg(target_os = "macos")]
    let primary = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let primary = Modifiers::CONTROL;
    Shortcut::new(Some(primary | Modifiers::ALT), Code::KeyN)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut = toggle_shortcut();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, pressed, event| {
                    if pressed == &shortcut && event.state() == ShortcutState::Pressed {
                        let _ = app.emit(TOGGLE_EVENT, ());
                    }
                })
                .build(),
        )
        .manage(Mutex::new(Tray::default()))
        .invoke_handler(tauri::generate_handler![sync_tray])
        .setup(move |app| {
            // Menu-bar-only app on macOS: no Dock icon, no app menu.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // If another app already owns the shortcut, carry on without it
            // rather than refusing to start.
            if let Err(err) = app.global_shortcut().register(shortcut) {
                eprintln!("isolatum: could not register global shortcut: {err}");
            }

            // Built from whatever the frontend has sent so far (usually
            // nothing yet: `sync_tray` fills it in once the page loads).
            let tray_state = app.state::<Mutex<Tray>>();
            let mut tray = tray_state.lock().expect("tray state lock");
            let (menu, tray_menu) = TrayMenu::build(app.handle(), &tray.state)?;
            tray.menu = Some(tray_menu);
            let tooltip = tooltip(&tray.state);
            drop(tray);

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("bundle has an icon"),
                )
                .tooltip(tooltip)
                .menu(&menu)
                // Platform conventions: on macOS a menu-bar click opens the
                // menu; on Windows a left click opens the app and the menu is
                // on right click.
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    if let Some(preset) = id.strip_prefix("preset:") {
                        let _ = app.emit(PRESET_EVENT, preset);
                    } else {
                        match id {
                            "toggle" => {
                                let _ = app.emit(TOGGLE_EVENT, ());
                            }
                            "show" => show_main_window(app),
                            "quit" => app.exit(0),
                            _ => {}
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if cfg!(target_os = "macos") {
                        return;
                    }
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        // Closing the window hides it; the app (and the audio) keeps running
        // in the tray. "Quit Isolatum" in the tray menu is the real exit.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Isolatum");
}

#[cfg(test)]
mod tests {
    use super::label;

    #[test]
    fn ampersands_are_literal_in_menu_labels() {
        assert_eq!(label("Rain & Fan"), "Rain && Fan");
        assert_eq!(label("R&B&&"), "R&&B&&&&");
        assert_eq!(label("Plain"), "Plain");
    }
}
