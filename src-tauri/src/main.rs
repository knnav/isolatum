// Without this, release builds on Windows also open a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    isolatum_lib::run()
}
