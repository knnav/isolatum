//! Native shell: tray icon, global shortcut, close-to-tray.
//!
//! All audio lives in the webview. Rust never touches it; it only emits a
//! `toggle-playback` event that the frontend listens for. That keeps one
//! source of truth for playback state (the JS engine) instead of two that can
//! drift apart.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const TOGGLE_EVENT: &str = "toggle-playback";

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
        .setup(move |app| {
            // Menu-bar-only app on macOS: no Dock icon, no app menu.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // If another app already owns the shortcut, carry on without it
            // rather than refusing to start.
            if let Err(err) = app.global_shortcut().register(shortcut) {
                eprintln!("hush: could not register global shortcut: {err}");
            }

            let toggle = MenuItem::with_id(app, "toggle", "Play / Pause", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show Hush", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Hush", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&toggle, &show, &separator, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("bundle has an icon"))
                .tooltip("Hush")
                .menu(&menu)
                // Platform conventions: on macOS a menu-bar click opens the
                // menu; on Windows a left click opens the app and the menu is
                // on right click.
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => {
                        let _ = app.emit(TOGGLE_EVENT, ());
                    }
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
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
        // in the tray. "Quit Hush" in the tray menu is the real exit.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Hush");
}
