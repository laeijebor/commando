#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(target_os = "macos"))]
compile_error!("The native terminal spike requires macOS AppKit.");

#[cfg(target_os = "macos")]
mod macos {
    use serde::Deserialize;
    use std::ffi::c_void;
    use std::io;
    use std::sync::atomic::{AtomicPtr, Ordering};
    use tauri::{AppHandle, Manager, State};

    #[derive(Default)]
    struct NativeTerminalState {
        // AppKit owns the view through the window hierarchy. Rust only passes the
        // stable address back to AppKit while the application is alive.
        view: AtomicPtr<c_void>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(tag = "kind", rename_all = "lowercase")]
    enum NativeTerminalMessage {
        Frame {
            x: f64,
            y: f64,
            width: f64,
            height: f64,
            visible: bool,
            scale: f64,
        },
        Focus,
    }

    extern "C" {
        fn native_terminal_create(window: *mut c_void) -> *mut c_void;
        fn native_terminal_set_frame(
            view: *mut c_void,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
            visible: bool,
            scale: f64,
        );
        fn native_terminal_focus(view: *mut c_void);
    }

    #[tauri::command]
    fn native_terminal_message(
        app: AppHandle,
        state: State<'_, NativeTerminalState>,
        message: NativeTerminalMessage,
    ) -> Result<(), String> {
        let view = state.view.load(Ordering::Acquire);
        if view.is_null() {
            return Err("native terminal view is not initialized".into());
        }

        match message {
            NativeTerminalMessage::Frame {
                x,
                y,
                width,
                height,
                visible,
                scale,
            } => {
                if ![x, y, width, height, scale]
                    .iter()
                    .all(|value| value.is_finite())
                    || width < 0.0
                    || height < 0.0
                    || scale <= 0.0
                {
                    return Err("invalid native terminal frame".into());
                }

                let view_address = view as usize;
                app.run_on_main_thread(move || unsafe {
                    native_terminal_set_frame(
                        view_address as *mut c_void,
                        x,
                        y,
                        width,
                        height,
                        visible,
                        scale,
                    );
                })
                .map_err(|error| error.to_string())?;
            }
            NativeTerminalMessage::Focus => {
                let view_address = view as usize;
                app.run_on_main_thread(move || unsafe {
                    native_terminal_focus(view_address as *mut c_void);
                })
                .map_err(|error| error.to_string())?;
            }
        }

        Ok(())
    }

    pub fn run() {
        tauri::Builder::default()
            .manage(NativeTerminalState::default())
            .setup(|app| {
                let window = app.get_webview_window("main").ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "main window missing")
                })?;
                let ns_window = window.ns_window()?;
                let view = unsafe { native_terminal_create(ns_window) };

                if view.is_null() {
                    return Err(io::Error::other("failed to create native terminal view").into());
                }

                app.state::<NativeTerminalState>()
                    .view
                    .store(view, Ordering::Release);
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![native_terminal_message])
            .run(tauri::generate_context!())
            .expect("error while running Tauri native terminal spike");
    }
}

fn main() {
    macos::run();
}
