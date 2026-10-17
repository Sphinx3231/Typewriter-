//! Native keyboard output for Typewriter.
//!
//! `keys` turns timeline events into key presses, `platform` talks to the
//! operating system, and `session` runs a timeline with safety guards.

pub mod keys;
pub mod platform;
pub mod session;
#[cfg(target_os = "linux")]
pub mod xtyper;

pub use keys::{Event, KeyAction, Translator, VirtualField};
pub use platform::{check_support, linux_session_problem, lock_unless, Desktop, RealDesktop, Support, WindowInfo};
pub use session::{describe_window, prepare_timeout_message, session_chars, Command, Config, Control, DiagSink, Session, Update};
use std::time::{Duration, Instant};

/// Starts a session on its own thread using the real desktop.
/// `emit` receives every status update; the returned `Control` steers it.
/// The first update ("preparing") is sent at once; getting the keyboard ready,
/// including waiting for a previous session to release the keymap, is bounded by
/// `cfg.prepare_timeout_ms` and ends as soon as Stop is requested.
/// `diag` receives the session's diagnostic trail (never the text or window titles).
pub fn spawn_session(cfg: Config, emit: impl FnMut(Update) + Send + 'static, mut diag: DiagSink) -> Result<(Control, std::thread::JoinHandle<String>), Support> {
    let control = Control::default();
    let c = control.clone();
    // Fail fast (permission denied, no display) before starting the thread.
    let probe = check_support(false);
    if !probe.available {
        diag(&format!("refused before starting: {} ({})", probe.state, probe.message));
        return Err(probe);
    }
    let handle = std::thread::Builder::new()
        .name("typewriter-typing".into())
        .spawn(move || {
            let mut emit = emit;
            let mut cfg = cfg;
            emit(Update::status("preparing", None, Some("Getting the keyboard ready…".into())));
            let deadline = Instant::now() + Duration::from_millis(cfg.prepare_timeout_ms);
            let stop = c.clone();
            let cancelled = move || stop.stop_requested() || Instant::now() >= deadline;
            let started = Instant::now();
            diag(&format!("+0 ms  opening the keyboard backend ({} {})", std::env::consts::OS, std::env::consts::ARCH));
            match RealDesktop::new(&cancelled) {
                Ok(desktop) => {
                    diag(&format!("+{} ms  keyboard backend ready", started.elapsed().as_millis()));
                    // The session's own preparation gets what is left of the same time limit.
                    cfg.prepare_timeout_ms = deadline.saturating_duration_since(Instant::now()).as_millis() as u64;
                    let result = Session::new(cfg, desktop, c, Box::new(emit)).with_diag(diag).run();
                    result
                }
                Err(s) if s.state == "cancelled" && c.stop_requested() => {
                    diag(&format!("+{} ms  stopped while the keyboard backend was opening", started.elapsed().as_millis()));
                    emit(Update::status("stopped", Some("user"), None));
                    "stopped".into()
                }
                Err(s) if s.state == "cancelled" => {
                    diag(&format!("+{} ms  failed: the keyboard backend wasn't ready in time", started.elapsed().as_millis()));
                    emit(Update::status("failed", Some("prepare-timeout"), Some(session::prepare_timeout_message(cfg.prepare_timeout_ms))));
                    "failed".into()
                }
                Err(s) => {
                    diag(&format!("+{} ms  failed to open the keyboard backend: {} ({})", started.elapsed().as_millis(), s.state, s.message));
                    emit(Update::status("failed", Some(&s.state), Some(s.message)));
                    "failed".into()
                }
            }
        })
        .expect("spawn typing thread");
    Ok((control, handle))
}
