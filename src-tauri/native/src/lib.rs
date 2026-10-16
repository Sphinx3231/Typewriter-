//! Native keyboard output for Typewriter.
//!
//! `keys` turns timeline events into key presses, `platform` talks to the
//! operating system, and `session` runs a timeline with safety guards.

pub mod keys;
pub mod platform;
pub mod session;

pub use keys::{Event, KeyAction, Translator, VirtualField};
pub use platform::{check_support, Desktop, RealDesktop, Support, WindowInfo};
pub use session::{Command, Config, Control, Session, Update};

/// Starts a session on its own thread using the real desktop.
/// `emit` receives every status update; the returned `Control` steers it.
pub fn spawn_session(cfg: Config, emit: impl FnMut(Update) + Send + 'static) -> Result<(Control, std::thread::JoinHandle<String>), Support> {
    let control = Control::default();
    let c = control.clone();
    // Fail fast (permission denied, no display) before starting the thread.
    let probe = check_support(false);
    if !probe.available {
        return Err(probe);
    }
    let handle = std::thread::Builder::new()
        .name("typewriter-typing".into())
        .spawn(move || {
            let mut emit = emit;
            match RealDesktop::new() {
                Ok(desktop) => Session::new(cfg, desktop, c, Box::new(emit)).run(),
                Err(s) => {
                    emit(Update {
                        phase: "failed".into(),
                        index: 0,
                        elapsed_ms: 0.0,
                        total_ms: 0.0,
                        countdown_ms: 0.0,
                        target: None,
                        reason: Some(s.state.clone()),
                        message: Some(s.message),
                    });
                    "failed".into()
                }
            }
        })
        .expect("spawn typing thread");
    Ok((control, handle))
}
