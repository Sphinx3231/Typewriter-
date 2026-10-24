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
use typewriter_native::{check_support, spawn_session, Command, Config, Control, DiagSink, Event, Support};

// ---------------------------------------------------------------- diagnostics

/// Typing diagnostics: one file in the app's log folder, kept under ~512 KB. It records
/// phases, timings, focus checks and key-send results, never the text or window titles.
fn diag_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    Some(app.path().app_log_dir().ok()?.join("typing-diagnostics.log"))
}

/// UTC time as `YYYY-MM-DD hh:mm:ss`.
fn utc_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn diag_append(path: &std::path::Path, line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// One line about the app's exit (Windows: whether page storage had time to reach the disk).
fn exit_note(app: &AppHandle, what: &str) {
    if what.is_empty() {
        return;
    }
    if let Some(path) = diag_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        diag_append(&path, &format!("\n=== {} UTC · exit · {what}", utc_now()));
    }
}

/// Starts a session's section of the diagnostics file and returns its sink.
fn diag_sink(app: &AppHandle, id: u64) -> DiagSink {
    let Some(path) = diag_path(app) else { return Box::new(|_: &str| {}) };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Keep the file small: when it passes 512 KB, keep its last 256 KB.
    if std::fs::metadata(&path).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let cut = text.len().saturating_sub(256 * 1024);
            let start = text[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(cut);
            let _ = std::fs::write(&path, &text[start..]);
        }
    }
    let version = app.package_info().version.to_string();
    let info = install_info();
    let others = if info.others.is_empty() { String::new() } else { format!(" · other installed copies: {}", info.others.join(", ")) };
    diag_append(
        &path,
        &format!("\n=== {} UTC · session {id} · Typewriter {version} build {} · {} {} · running from {}{others}", utc_now(), env!("TYPEWRITER_COMMIT"), std::env::consts::OS, std::env::consts::ARCH, info.exe),
    );
    Box::new(move |line: &str| diag_append(&path, line))
}

/// The end of the diagnostics file (the latest sessions) and where it is.
#[tauri::command]
fn diagnostics(app: AppHandle) -> (String, String) {
    let path = diag_path(&app);
    let text = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let cut = text.len().saturating_sub(64 * 1024);
    let start = text[cut..].find('\n').map(|i| cut + i + 1).filter(|_| cut > 0).unwrap_or(cut);
    (path.map(|p| p.display().to_string()).unwrap_or_default(), text[start..].to_string())
}

/// Where this copy of Typewriter runs from, and other installed copies of it. Two copies
/// (for example one from the old .msi in Program Files and one from the setup.exe in the
/// user's AppData) mean the Start menu may open the older one.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallInfo {
    exe: String,
    others: Vec<String>,
}

fn other_installs(exe: &std::path::Path, candidates: &[std::path::PathBuf]) -> Vec<String> {
    let me = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    let same = |p: &std::path::Path| std::fs::canonicalize(p).map(|c| c.to_string_lossy().to_lowercase() == me.to_string_lossy().to_lowercase()).unwrap_or(false);
    let mut out: Vec<String> = candidates.iter().filter(|p| p.is_file() && !same(p)).map(|p| p.display().to_string()).collect();
    out.dedup();
    out
}

/// Where the installers put Typewriter on this system.
fn install_candidates() -> Vec<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut v = Vec::new();
        for (var, sub) in [("LOCALAPPDATA", "Typewriter"), ("LOCALAPPDATA", "Programs\\Typewriter"), ("ProgramFiles", "Typewriter"), ("ProgramFiles(x86)", "Typewriter")] {
            if let Ok(base) = std::env::var(var) {
                v.push(std::path::Path::new(&base).join(sub).join("typewriter.exe"));
            }
        }
        v
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

#[tauri::command]
fn install_info() -> InstallInfo {
    let exe = std::env::current_exe().unwrap_or_default();
    InstallInfo { others: other_installs(&exe, &install_candidates()), exe: exe.display().to_string() }
}

/// Copies the latest diagnostics to the clipboard so the user can paste them into a report.
#[tauri::command]
fn copy_diagnostics(app: AppHandle) -> Result<usize, String> {
    let (path, text) = diagnostics(app);
    let report = format!("Typewriter typing diagnostics ({path})\n{text}");
    arboard::Clipboard::new().and_then(|mut c| c.set_text(report.clone())).map_err(|e| e.to_string())?;
    Ok(report.len())
}

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
    /// Set while a postponed exit is being prepared, so a second exit request doesn't start another.
    exiting: std::sync::atomic::AtomicBool,
    /// Close requests of the main window, and the latest one its page has answered.
    close_requests: AtomicU64,
    close_answered: AtomicU64,
}

/// How long the main window's page has to answer a close request (it may ask the user
/// first) before the window is closed anyway: a page that doesn't answer is blank or
/// hung, and the user must always be able to close Typewriter.
const CLOSE_ANSWER_LIMIT: Duration = Duration::from_secs(3);

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
    let called = std::time::Instant::now();
    // One start at a time, so each one stops the previous session before starting its own.
    let _starting = state.starting.lock().unwrap_or_else(|e| e.into_inner());
    stop_session(&app);
    let id = state.current.fetch_add(1, Ordering::SeqCst) + 1;
    let mut diag = diag_sink(&app, id);
    let ms = |t: std::time::Instant| t.elapsed().as_millis();
    diag(&format!("app: Start received; previous session told to stop after {} ms", ms(called)));
    let support = check_support(false);
    if !support.available {
        diag(&format!("app: refused: {} ({})", support.state, support.message));
        return Err(serde_json::to_string(&support).unwrap_or(support.message));
    }

    let gs = app.global_shortcut();
    let _ = gs.unregister(stop_shortcut());
    let shortcut_registered = gs.register(stop_shortcut()).is_ok();
    diag(&format!("app: emergency-stop shortcut registered: {shortcut_registered}; {} events, countdown {countdown_ms} ms, minimize {minimize}", events.len()));

    let cfg = Config {
        events,
        countdown_ms,
        resume_countdown_ms: 3000,
        own_pid: std::process::id() as u64,
        prepare_timeout_ms: PREPARE_TIMEOUT_MS,
        wait_timeout_ms: WAIT_TIMEOUT_MS,
    };
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
                        let _ = hud.destroy();
                    }
                }
            });
        }
    }, diag)
    .map_err(|s| serde_json::to_string(&s).unwrap_or(s.message))?;
    // Stored before the status window appears, so its Stop and the shortcut work at once.
    *state.control.lock().unwrap() = Some((id, control));
    {
        let mut workers = state.workers.lock().unwrap();
        workers.retain(|w| !w.is_finished());
        workers.push(worker);
    }

    let hud = std::time::Instant::now();
    show_hud(&app);
    if minimize {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.minimize();
        }
    }
    if let Some(path) = diag_path(&app) {
        diag_append(&path, &format!("app: status window shown in {} ms; Start answered after {} ms", ms(hud), ms(called)));
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

/// The main window's page calls this as soon as it receives a close request, before
/// deciding whether to ask the user. It proves the page is alive.
#[tauri::command]
fn close_answered(app: AppHandle) {
    let st = app.state::<AppState>();
    st.close_answered.store(st.close_requests.load(Ordering::SeqCst), Ordering::SeqCst);
}

/// A close request for the main window: bring it to the front, so a "Quit Typewriter?"
/// question is never hidden in a minimized window (Typewriter minimizes itself while
/// typing, and closing from the taskbar doesn't restore it), and close it anyway when
/// its page doesn't answer.
fn main_close_requested(window: &tauri::Window) {
    let app = window.app_handle().clone();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let request = app.state::<AppState>().close_requests.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_ANSWER_LIMIT);
        let st = app.state::<AppState>();
        if st.close_answered.load(Ordering::SeqCst) < request {
            if let Some(main) = app.get_webview_window("main") {
                if let Some(path) = diag_path(&app) {
                    diag_append(&path, &format!("\n=== {} UTC · the main window didn't answer a close request within {} s: closed anyway", utc_now(), CLOSE_ANSWER_LIMIT.as_secs()));
                }
                let _ = main.destroy();
            }
        }
    });
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
/// Windows: WebView2 writes the pages' storage (settings, theme, history) to disk a few seconds
/// after a change, in its own browser process. If Typewriter exits before that process has shut
/// down, a change made just before closing is lost. So the exit waits for it (BrowserProcessExited),
/// with a time limit so closing can never hang.
#[cfg(windows)]
mod storage_flush {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};
    use webview2_com::{BrowserProcessExitedEventHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2Environment5};
    use windows_core::Interface;

    static WATCHING: AtomicBool = AtomicBool::new(false);
    static EXITED: AtomicBool = AtomicBool::new(false);
    static DONE: AtomicBool = AtomicBool::new(false);
    const LIMIT: Duration = Duration::from_secs(6);

    pub fn watch(window: &tauri::WebviewWindow) {
        let _ = window.with_webview(|w| {
            let Ok(env) = w.environment().cast::<ICoreWebView2Environment5>() else { return };
            let handler = BrowserProcessExitedEventHandler::create(Box::new(|_, _| {
                EXITED.store(true, Ordering::SeqCst);
                Ok(())
            }));
            let mut token = 0i64;
            if unsafe { env.add_BrowserProcessExited(&handler, &mut token) }.is_ok() {
                WATCHING.store(true, Ordering::SeqCst);
            }
        });
    }

    /// True while the exit still has to wait for the browser process.
    pub fn pending() -> bool {
        WATCHING.load(Ordering::SeqCst) && !DONE.load(Ordering::SeqCst)
    }

    /// Closes every webview (the browser process only shuts down once none is left), then waits
    /// for it to exit. Runs off the event loop, which must keep running to deliver the event.
    /// Returns what happened, for the diagnostics file.
    pub fn wait(app: &AppHandle) -> String {
        let windows = app.webview_windows();
        let mut destroyed = 0;
        for w in windows.values() {
            if w.destroy().is_ok() {
                destroyed += 1;
            }
        }
        let t0 = Instant::now();
        while !EXITED.load(Ordering::SeqCst) && t0.elapsed() < LIMIT {
            std::thread::sleep(Duration::from_millis(20));
        }
        DONE.store(true, Ordering::SeqCst);
        let waited = t0.elapsed().as_millis();
        let what = if EXITED.load(Ordering::SeqCst) { format!("the browser process exited after {waited} ms") } else { format!("the browser process had not exited after {waited} ms (limit reached)") };
        format!("storage flush: closed {destroyed} of {} webviews; {what}", windows.len())
    }

    /// Why the exit doesn't wait, when it doesn't ("" once the wait has run: wait() said so).
    pub fn skipped() -> &'static str {
        if DONE.load(Ordering::SeqCst) { "" } else { "storage flush: not waiting (BrowserProcessExited could not be watched)" }
    }
}
#[cfg(not(windows))]
mod storage_flush {
    pub fn pending() -> bool {
        false
    }
    pub fn wait(_: &tauri::AppHandle) -> String {
        String::new()
    }
    pub fn skipped() -> &'static str {
        ""
    }
}

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
        .invoke_handler(tauri::generate_handler![external_support, external_start, external_state, external_control, read_clipboard, show_main, close_answered, install_info, diagnostics, copy_diagnostics])
        .setup(|app| {
            // The window starts hidden so there's no flash before the theme is applied.
            // The web app shows it after its first paint; this is a fallback.
            let handle = app.handle().clone();
            #[cfg(windows)]
            if let Some(main) = app.get_webview_window("main") {
                storage_flush::watch(&main);
            }
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
                match event {
                    tauri::WindowEvent::CloseRequested { .. } => main_close_requested(window),
                    tauri::WindowEvent::Destroyed => {
                        stop_session(window.app_handle());
                        // destroy, not close: the status window must go even if its page is blank or hung.
                        if let Some(hud) = window.app_handle().get_webview_window("hud") {
                            let _ = hud.destroy();
                        }
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Typewriter")
        .run(|app, event| {
            // Before the process ends, let typing threads stop and restore the keymap, and (on
            // Windows) let the webviews' storage reach the disk. The exit is postponed (not
            // blocked) and resumed once they are done.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                let cleanup = !state.cleaned_up.load(Ordering::SeqCst) && workers_running(app);
                let flush = storage_flush::pending();
                if !flush && !app.state::<AppState>().exiting.load(Ordering::SeqCst) {
                    exit_note(app, storage_flush::skipped());
                }
                if cleanup || flush {
                    api.prevent_exit();
                    if state.exiting.swap(true, Ordering::SeqCst) {
                        return; // already on its way out
                    }
                    let h = app.clone();
                    std::thread::spawn(move || {
                        if cleanup {
                            finish_sessions(&h);
                            h.state::<AppState>().cleaned_up.store(true, Ordering::SeqCst);
                        }
                        let flushed = storage_flush::wait(&h);
                        exit_note(&h, &flushed);
                        h.state::<AppState>().exiting.store(false, Ordering::SeqCst);
                        h.exit(0);
                    });
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn other_installs_lists_existing_copies_but_not_this_one() {
        let dir = std::env::temp_dir().join(format!("tw-installs-{}", std::process::id()));
        let (a, b, missing) = (dir.join("a/typewriter.exe"), dir.join("b/typewriter.exe"), dir.join("c/typewriter.exe"));
        for p in [&a, &b] {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        let found = other_installs(&a, &[a.clone(), b.clone(), missing]);
        assert_eq!(found, vec![b.display().to_string()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn utc_dates_are_civil_dates() {
        let now = utc_now();
        assert_eq!(now.len(), 19, "{now}");
        assert!(now.starts_with("20"), "{now}");
    }
}
