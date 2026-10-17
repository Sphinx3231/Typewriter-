//! Typewriter desktop shell.
//!
//! The web app (../src) does all planning: it turns the text and settings into a
//! timeline of typing events. For "Type into another app" it hands that timeline
//! to `typewriter-native`, which sends real key events on its own thread, so
//! timing doesn't depend on a background webview's timers. Status updates come
//! back as `external://update` events to the main window and the small
//! always-on-top status window ("hud").

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use typewriter_native::{check_support, spawn_session, Command, Config, Control, Event, Support};

/// Emergency stop while typing into another app: Ctrl+Shift+Space (all platforms).
fn stop_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}

#[derive(Default)]
struct AppState {
    /// The current session's control, with the id of the session it belongs to.
    control: Mutex<Option<(u64, Control)>>,
    /// Id of the newest session. Updates and endings of older sessions are ignored, so a
    /// session stopped just before a new Start can't take over the new one.
    current: AtomicU64,
    /// Starts run one at a time (async commands can run concurrently).
    starting: Mutex<()>,
    /// The latest status of the current session, for a status window that opens late.
    last: Mutex<Option<serde_json::Value>>,
    /// Typing threads that may still be running or restoring the keymap.
    workers: Mutex<Vec<std::thread::JoinHandle<String>>>,
    /// Set once the typing threads have been waited for, so the final exit can proceed.
    cleaned_up: std::sync::atomic::AtomicBool,
}

/// Longest the app waits on exit for typing threads to stop and clean up (on X11,
/// removing temporary key bindings takes up to a few seconds).
const EXIT_GRACE: Duration = Duration::from_secs(10);

/// Longest the keyboard may take to get ready before the session fails with an explanation.
const PREPARE_TIMEOUT_MS: u64 = 15_000;
/// Longest a session waits for the user to click into another window.
const WAIT_TIMEOUT_MS: u64 = 180_000;

/// Stops any session and waits (bounded) for every typing thread to finish, so
/// nothing is left behind in the user's keymap when the process exits. Runs off the
/// main thread: the typing thread's last steps (status event, shortcut removal) may
/// need the event loop, so blocking the loop here could deadlock.
fn finish_sessions(app: &AppHandle) {
    stop_session(app);
    let workers = std::mem::take(&mut *app.state::<AppState>().workers.lock().unwrap());
    let deadline = std::time::Instant::now() + EXIT_GRACE;
    for w in workers {
        while !w.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if w.is_finished() {
            let _ = w.join();
        }
    }
}

fn stop_session(app: &AppHandle) {
    if let Some((_, c)) = app.state::<AppState>().control.lock().unwrap().as_ref() {
        c.send(Command::Stop);
    }
}

fn workers_running(app: &AppHandle) -> bool {
    app.state::<AppState>().workers.lock().unwrap().iter().any(|w| !w.is_finished())
}

#[tauri::command]
fn external_support(prompt: bool) -> Support {
    check_support(prompt)
}

/// What the windows receive: the native update plus whether the emergency-stop
/// shortcut is really registered (so the status window never shows a dead hint).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent<'a> {
    #[serde(flatten)]
    update: &'a typewriter_native::Update,
    shortcut_registered: bool,
    /// The token the window passed to `external_start`.
    session: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StartResult {
    shortcut_registered: bool,
}

/// Async on purpose: it creates the status window, and on Windows creating a window
/// in a synchronous command deadlocks (see WebviewWindowBuilder's "Known issues").
/// That deadlock left the status window blank and typing never started.
/// `session` is a token chosen by the window; every update of this session carries it.
#[tauri::command]
async fn external_start(app: AppHandle, events: Vec<Event>, countdown_ms: u64, minimize: bool, session: u64) -> Result<StartResult, String> {
    let state = app.state::<AppState>();
    // One start at a time, so each one stops the previous session before starting its own.
    let _starting = state.starting.lock().unwrap_or_else(|e| e.into_inner());
    stop_session(&app);
    let support = check_support(false);
    if !support.available {
        return Err(serde_json::to_string(&support).unwrap_or(support.message));
    }

    let gs = app.global_shortcut();
    let _ = gs.unregister(stop_shortcut());
    let shortcut_registered = gs.register(stop_shortcut()).is_ok();

    let cfg = Config {
        events,
        countdown_ms,
        resume_countdown_ms: 3000,
        own_pid: std::process::id() as u64,
        prepare_timeout_ms: PREPARE_TIMEOUT_MS,
        wait_timeout_ms: WAIT_TIMEOUT_MS,
    };
    let id = state.current.fetch_add(1, Ordering::SeqCst) + 1;
    *state.last.lock().unwrap() = None;
    let handle = app.clone();
    let (control, worker) = spawn_session(cfg, move |update| {
        let st = handle.state::<AppState>();
        if st.current.load(Ordering::SeqCst) != id {
            return; // an older session, already replaced
        }
        let done = matches!(update.phase.as_str(), "completed" | "stopped" | "failed");
        let event = UpdateEvent { update: &update, shortcut_registered, session };
        *st.last.lock().unwrap() = serde_json::to_value(&event).ok();
        let _ = handle.emit("external://update", event);
        if done {
            // Under the start lock, so a Start that is just beginning keeps its shortcut and control.
            let _starting = st.starting.lock().unwrap_or_else(|e| e.into_inner());
            if st.current.load(Ordering::SeqCst) != id {
                return;
            }
            let _ = handle.global_shortcut().unregister(stop_shortcut());
            st.control.lock().unwrap().take();
            let h = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(6));
                // Close the status window unless a new session has started meanwhile.
                if h.state::<AppState>().current.load(Ordering::SeqCst) == id {
                    if let Some(hud) = h.get_webview_window("hud") {
                        let _ = hud.close();
                    }
                }
            });
        }
    })
    .map_err(|s| serde_json::to_string(&s).unwrap_or(s.message))?;
    // Stored before the status window appears, so its Stop and the shortcut work at once.
    *state.control.lock().unwrap() = Some((id, control));
    {
        let mut workers = state.workers.lock().unwrap();
        workers.retain(|w| !w.is_finished());
        workers.push(worker);
    }

    show_hud(&app);
    if minimize {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.minimize();
        }
    }
    Ok(StartResult { shortcut_registered })
}

/// The current session's latest status (or null), so a window can catch up.
#[tauri::command]
fn external_state(app: AppHandle) -> Option<serde_json::Value> {
    app.state::<AppState>().last.lock().unwrap().clone()
}

#[tauri::command]
fn external_control(app: AppHandle, command: String) -> Result<(), String> {
    let cmd = match command.as_str() {
        "pause" => Command::Pause,
        "resume" => Command::Resume,
        "stop" => Command::Stop,
        other => return Err(format!("unknown command {other}")),
    };
    match app.state::<AppState>().control.lock().unwrap().as_ref() {
        Some((_, c)) => {
            c.send(cmd);
            Ok(())
        }
        None => Err("No typing session is running.".into()),
    }
}

/// Reads the clipboard so the user can verify the document text (they copy it
/// from the document themselves). Nothing is sent anywhere.
#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_main(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn show_hud(app: &AppHandle) {
    if let Some(hud) = app.get_webview_window("hud") {
        let _ = hud.show();
        return;
    }
    let mut b = WebviewWindowBuilder::new(app, "hud", WebviewUrl::App("hud.html".into()))
        .title("Typewriter status")
        .inner_size(380.0, 176.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false);
    // Top-right corner of the primary monitor.
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = m.scale_factor();
        let w = m.size().width as f64 / scale;
        b = b.position(w - 400.0, 24.0);
    }
    let _ = b.build();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && *shortcut == stop_shortcut() {
                        stop_session(app);
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![external_support, external_start, external_state, external_control, read_clipboard, show_main])
        .setup(|app| {
            // The window starts hidden so there's no flash before the theme is applied.
            // The web app shows it after its first paint; this is a fallback.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(2500));
                if let Some(main) = handle.get_webview_window("main") {
                    if !main.is_visible().unwrap_or(true) {
                        let _ = main.show();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // When the main window is really gone, end any typing session and the app.
            // (Not on CloseRequested: the window may ask the user first and stay open.)
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    stop_session(window.app_handle());
                    if let Some(hud) = window.app_handle().get_webview_window("hud") {
                        let _ = hud.close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Typewriter")
        .run(|app, event| {
            // Before the process ends, let typing threads stop and restore the keymap.
            // The exit is postponed (not blocked) and resumed once they are done.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                if !state.cleaned_up.load(std::sync::atomic::Ordering::SeqCst) && workers_running(app) {
                    api.prevent_exit();
                    let h = app.clone();
                    std::thread::spawn(move || {
                        finish_sessions(&h);
                        h.state::<AppState>().cleaned_up.store(true, std::sync::atomic::Ordering::SeqCst);
                        h.exit(0);
                    });
                }
            }
        });
}
