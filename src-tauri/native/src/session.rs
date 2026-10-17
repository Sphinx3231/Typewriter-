//! Runs a typing timeline against the desktop with safety guards.
//!
//! Lifecycle (one session):
//!   waiting  – Typewriter still has focus; nothing is typed until the user switches away
//!   countdown – visible countdown; switching back to Typewriter returns to `waiting`
//!   typing   – keys are sent on the timeline into the window that had focus when the
//!              countdown ended (the "target")
//!   paused   – by the user, or automatically when focus leaves the target, a password
//!              field gets focus, or keys can't be sent
//!   resuming – short countdown, then waits until the target window has focus again
//!   completed / stopped / failed
//!
//! Timing follows the planned event times on a monotonic clock, so a slow key send
//! never accumulates drift. Pauses shift the clock by exactly the paused time.

use crate::keys::{Event, Translator};
use crate::platform::{sensitive_title, Desktop, WindowInfo};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Pause,
    Resume,
    Stop,
}

/// Shared handle used by the app to steer a running session.
#[derive(Clone, Default)]
pub struct Control(Arc<Mutex<Option<Command>>>);

impl Control {
    pub fn send(&self, c: Command) {
        let mut slot = self.0.lock().unwrap();
        // Stop always wins over a pending pause/resume.
        if *slot != Some(Command::Stop) {
            *slot = Some(c);
        }
    }
    /// True once Stop has been requested (without consuming it).
    pub fn stop_requested(&self) -> bool {
        *self.0.lock().unwrap() == Some(Command::Stop)
    }
    fn take(&self) -> Option<Command> {
        self.0.lock().unwrap().take()
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    /// waiting | countdown | typing | paused | resuming | completed | stopped | failed
    pub phase: String,
    /// Number of timeline events whose keys have been sent.
    pub index: usize,
    pub elapsed_ms: f64,
    pub total_ms: f64,
    pub countdown_ms: f64,
    pub target: Option<WindowInfo>,
    /// Machine-readable reason for a pause, stop or failure.
    pub reason: Option<String>,
    pub message: Option<String>,
}

pub struct Config {
    pub events: Vec<Event>,
    pub countdown_ms: u64,
    pub resume_countdown_ms: u64,
    /// Process id of Typewriter itself; keys are never sent to its windows.
    pub own_pid: u64,
}

const TICK: Duration = Duration::from_millis(10);

const EMIT_EVERY: Duration = Duration::from_millis(40);

/// Every distinct character the timeline types, in order of first appearance.
pub fn session_chars(events: &[Event]) -> Vec<char> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut add = |t: &str| {
        for c in t.chars() {
            if seen.insert(c) {
                out.push(c);
            }
        }
    };
    for e in events {
        match e {
            Event::Type { text, .. } => add(text),
            Event::Replace { replacement, .. } => replacement.iter().for_each(|g| add(g)),
            _ => {}
        }
    }
    out
}

pub struct Session<D: Desktop> {
    cfg: Config,
    desktop: D,
    control: Control,
    emit: Box<dyn FnMut(Update) + Send>,
    index: usize,
    elapsed_ms: f64,
    target: Option<WindowInfo>,
}

enum Flow {
    Continue,
    End,
}

impl<D: Desktop> Session<D> {
    pub fn new(cfg: Config, desktop: D, control: Control, emit: Box<dyn FnMut(Update) + Send>) -> Self {
        Self { cfg, desktop, control, emit, index: 0, elapsed_ms: 0.0, target: None }
    }

    fn total(&self) -> f64 {
        self.cfg.events.last().map(|e| e.at()).unwrap_or(0.0)
    }

    fn update(&mut self, phase: &str, countdown_ms: f64, reason: Option<&str>, message: Option<String>) {
        let u = Update {
            phase: phase.into(),
            index: self.index,
            elapsed_ms: self.elapsed_ms,
            total_ms: self.total(),
            countdown_ms,
            target: self.target.clone(),
            reason: reason.map(String::from),
            message,
        };
        (self.emit)(u);
    }

    fn is_own(&self, w: &WindowInfo) -> bool {
        w.process_id == self.cfg.own_pid
    }

    /// Runs to completion. Returns the final phase.
    pub fn run(mut self) -> String {
        if self.cfg.events.is_empty() {
            self.update("completed", 0.0, None, None);
            return "completed".into();
        }
        // Let the backend prepare for every character up front (on X11: bind the ones
        // that aren't on the keyboard layout), well before the first key is due.
        // Preparing can take a moment, so it gives up as soon as Stop is requested.
        let chars = session_chars(&self.cfg.events);
        let control = self.control.clone();
        self.desktop.prepare(&chars, &|| control.stop_requested());
        match self.wait_and_count_down() {
            Flow::End => return "stopped".into(),
            Flow::Continue => {}
        }
        // The window focused at the end of the countdown becomes the target.
        let target = self.desktop.focused_window();
        match target {
            Some(t) if !self.is_own(&t) => self.target = Some(t),
            _ => {
                self.update("failed", 0.0, Some("no-target"), Some("Couldn't tell which window to type into. Nothing was typed.".into()));
                return "failed".into();
            }
        }
        self.type_all()
    }

    /// Waits until Typewriter loses focus, then counts down. Returning to
    /// Typewriter during the countdown starts over. Nothing is typed here.
    fn wait_and_count_down(&mut self) -> Flow {
        let mut countdown_started: Option<Instant> = None;
        let mut last_emit = Instant::now() - EMIT_EVERY;
        loop {
            match self.control.take() {
                Some(Command::Stop) => {
                    self.update("stopped", 0.0, Some("user"), None);
                    return Flow::End;
                }
                _ => {}
            }
            if self.desktop.failsafe_triggered() {
                self.update("stopped", 0.0, Some("failsafe"), Some("Stopped: mouse moved to the top-left corner.".into()));
                return Flow::End;
            }
            let away = self.desktop.focused_window().map(|w| !self.is_own(&w)).unwrap_or(false);
            match (away, countdown_started) {
                (false, _) => {
                    if countdown_started.take().is_some() || last_emit.elapsed() >= Duration::from_millis(250) {
                        self.update("waiting", self.cfg.countdown_ms as f64, None, None);
                        last_emit = Instant::now();
                    }
                }
                (true, None) => countdown_started = Some(Instant::now()),
                (true, Some(t0)) => {
                    let left = self.cfg.countdown_ms as f64 - t0.elapsed().as_secs_f64() * 1000.0;
                    if left <= 0.0 {
                        return Flow::Continue;
                    }
                    if last_emit.elapsed() >= Duration::from_millis(100) {
                        self.update("countdown", left, None, None);
                        last_emit = Instant::now();
                    }
                }
            }
            std::thread::sleep(TICK);
        }
    }

    /// Checks that typing may continue right now. Returns a pause reason if not.
    fn guard(&mut self) -> Option<(&'static str, String)> {
        let target = self.target.clone()?;
        match self.desktop.focused_window() {
            None => return Some(("focus-unknown", "Lost track of the focused window. Paused to be safe.".into())),
            Some(w) if self.is_own(&w) => return Some(("focus-typewriter", "Typewriter has focus, so typing paused. It never types into itself.".into())),
            Some(w) if !w.same_window(&target) => {
                return Some(("focus-changed", format!("Focus moved to \"{}\", so typing paused.", w.title)));
            }
            Some(w) => {
                if let Some(why) = sensitive_title(&w.title) {
                    return Some(("sensitive", why));
                }
            }
        }
        if let Some(why) = self.desktop.sensitive_focus() {
            return Some(("sensitive", why));
        }
        None
    }

    fn type_all(&mut self) -> String {
        self.update("typing", 0.0, None, None);
        // The guard runs before every event, including the first, so a session that
        // starts in a password field or the wrong window pauses before any key is sent.
        self.type_from(Translator::new(), Instant::now())
    }

    fn type_from(&mut self, mut tr: Translator, mut anchor: Instant) -> String {
        let total = self.total();
        let mut last_emit = Instant::now() - EMIT_EVERY;
        while self.index < self.cfg.events.len() {
            let due = self.cfg.events[self.index].at();
            // Wait for the event's planned time, staying responsive to commands.
            loop {
                if let Some(cmd) = self.control.take() {
                    match cmd {
                        Command::Stop => return self.stop("user", None),
                        Command::Pause => {
                            self.elapsed_ms = anchor.elapsed().as_secs_f64() * 1000.0;
                            match self.pause("user", "Paused.".into(), &mut anchor) {
                                Some(()) => continue,
                                None => return "stopped".into(),
                            }
                        }
                        Command::Resume => {}
                    }
                }
                if self.desktop.failsafe_triggered() {
                    return self.stop("failsafe", Some("Stopped: mouse moved to the top-left corner.".into()));
                }
                let now = anchor.elapsed().as_secs_f64() * 1000.0;
                if now >= due {
                    break;
                }
                std::thread::sleep(TICK.min(Duration::from_secs_f64((due - now) / 1000.0)));
            }
            // Don't type while the user holds a modifier: keys would become shortcuts.
            let held_since = Instant::now();
            let mut waited = false;
            while self.desktop.modifiers_held() {
                if !waited {
                    self.update("typing", 0.0, Some("modifiers-held"), Some("Waiting for you to release Ctrl, Alt, Shift or Cmd.".into()));
                    waited = true;
                }
                if let Some(Command::Stop) = self.control.take() {
                    return self.stop("user", None);
                }
                std::thread::sleep(TICK);
            }
            anchor += held_since.elapsed();
            if let Some((reason, msg)) = self.guard() {
                self.elapsed_ms = (anchor.elapsed().as_secs_f64() * 1000.0).min(due);
                if self.pause(reason, msg, &mut anchor).is_none() {
                    return "stopped".into();
                }
                continue;
            }
            let ev = self.cfg.events[self.index].clone();
            for action in tr.actions(&ev) {
                if let Some(Command::Stop) = self.control.take() {
                    // Mid-burst stop: report where we are; the translator state is lost anyway.
                    return self.stop("user", None);
                }
                if let Err(e) = self.desktop.send(&action) {
                    self.update("failed", 0.0, Some("send-failed"), Some(format!("Couldn't send a key: {e}")));
                    return "failed".into();
                }
            }
            self.index += 1;
            self.elapsed_ms = due;
            if last_emit.elapsed() >= EMIT_EVERY || self.index == self.cfg.events.len() {
                self.update("typing", 0.0, None, None);
                last_emit = Instant::now();
            }
        }
        self.elapsed_ms = total;
        self.update("completed", 0.0, None, Some("Every key was sent. Check the document to confirm the text.".into()));
        "completed".into()
    }

    fn stop(&mut self, reason: &str, message: Option<String>) -> String {
        self.update("stopped", 0.0, Some(reason), message);
        "stopped".into()
    }

    /// Paused until Resume (then a short countdown and waiting for the target to
    /// have focus again) or Stop. Returns None when stopped.
    fn pause(&mut self, reason: &str, message: String, anchor: &mut Instant) -> Option<()> {
        let paused_at = Instant::now();
        self.update("paused", 0.0, Some(reason), Some(message));
        loop {
            match self.control.take() {
                Some(Command::Stop) => {
                    self.stop("user", None);
                    return None;
                }
                Some(Command::Resume) => break,
                _ => {}
            }
            if self.desktop.failsafe_triggered() {
                self.stop("failsafe", Some("Stopped: mouse moved to the top-left corner.".into()));
                return None;
            }
            std::thread::sleep(TICK);
        }
        // Short countdown so the user can click back into the document.
        let t0 = Instant::now();
        loop {
            if let Some(Command::Stop) = self.control.take() {
                self.stop("user", None);
                return None;
            }
            let left = self.cfg.resume_countdown_ms as f64 - t0.elapsed().as_secs_f64() * 1000.0;
            if left <= 0.0 {
                break;
            }
            self.update("resuming", left, None, None);
            std::thread::sleep(Duration::from_millis(100).min(Duration::from_secs_f64(left / 1000.0)));
        }
        // Wait until the target window has focus again (never type elsewhere).
        let mut announced = false;
        loop {
            if let Some(Command::Stop) = self.control.take() {
                self.stop("user", None);
                return None;
            }
            match self.guard() {
                None => break,
                Some((reason, _)) if !announced => {
                    let title = self.target.as_ref().map(|t| t.title.clone()).unwrap_or_default();
                    let msg = if reason == "sensitive" {
                        "A password or login field has focus. Click back into your document.".to_string()
                    } else {
                        format!("Click back into \"{title}\" to continue typing.")
                    };
                    self.update("resuming", 0.0, Some("waiting-for-target"), Some(msg));
                    announced = true;
                }
                _ => {}
            }
            std::thread::sleep(TICK);
        }
        *anchor += paused_at.elapsed();
        self.update("typing", 0.0, None, None);
        Some(())
    }
}
