//! Runs a typing timeline against the desktop with safety guards.
//!
//! Lifecycle (one session):
//!   preparing – the keyboard backend gets ready (on X11: binds symbols that aren't on the
//!              layout). At most `prepare_timeout_ms`, after which the remaining symbols
//!              are bound as they are typed; Stop ends it at once
//!   waiting  – Typewriter still has focus; nothing is typed until the user switches away.
//!              Bounded by `wait_timeout_ms` (then the session fails and says why)
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
    /// Longest the backend may spend preparing characters up front; the rest are prepared
    /// as they are typed. (In `spawn_session` the same limit, counted from Start, also
    /// bounds the wait for the keyboard itself, which fails the session when exceeded.)
    pub prepare_timeout_ms: u64,
    /// Longest the session waits for the user to switch to another window (including
    /// countdowns that restarted) before it fails, so it never waits silently forever.
    pub wait_timeout_ms: u64,
}

impl Update {
    /// A status update before any key has been sent.
    pub fn status(phase: &str, reason: Option<&str>, message: Option<String>) -> Self {
        Self { phase: phase.into(), index: 0, elapsed_ms: 0.0, total_ms: 0.0, countdown_ms: 0.0, target: None, reason: reason.map(String::from), message }
    }
}

/// What the user sees when the keyboard couldn't be made ready in time.
pub fn prepare_timeout_message(ms: u64) -> String {
    format!(
        "Typewriter couldn't get the keyboard ready within {} seconds, so nothing was typed. \
         Another typing session may still be finishing: wait a few seconds, then press Type into app again. \
         If this keeps happening, restart Typewriter.",
        (ms as f64 / 1000.0).round()
    )
}

/// How long the focused window may be unknown before the user is told.
const UNKNOWN_FOCUS_NOTICE: Duration = Duration::from_secs(2);
/// A momentarily unknown focus (Windows reports none while focus moves) isn't a reason to pause.
const FOCUS_SETTLE: Duration = Duration::from_millis(300);

const TICK: Duration = Duration::from_millis(10);

/// How often a session waiting for its window checks whether the window is back.
const RECHECK: Duration = Duration::from_millis(150);

/// The second half of every automatic pause message.
const BACK: &str = "Click back into your document and it continues by itself.";

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

/// Receives the session's diagnostic trail, one line at a time (see `Session::with_diag`).
pub type DiagSink = Box<dyn FnMut(&str) + Send>;

/// Describes a window for the diagnostic trail without its title (titles can name documents).
pub fn describe_window(w: &WindowInfo) -> String {
    format!("\"{}\" (process {}, window {}, title of {} characters)", w.app_name, w.process_id, w.window_id, w.title.chars().count())
}

/// What kind of key an action is, for the diagnostic trail (never the text itself).
fn action_kind(a: &crate::keys::KeyAction) -> String {
    use crate::keys::KeyAction::*;
    match a {
        Text(t) => format!("text of {} characters", t.chars().count()),
        Enter => "Enter".into(),
        Tab => "Tab".into(),
        Backspace => "Backspace".into(),
        Left => "Left arrow".into(),
        Right => "Right arrow".into(),
    }
}

pub struct Session<D: Desktop> {
    cfg: Config,
    desktop: D,
    control: Control,
    emit: Box<dyn FnMut(Update) + Send>,
    index: usize,
    elapsed_ms: f64,
    target: Option<WindowInfo>,
    /// Key actions actually handed to the desktop; a session that sent none never "completes".
    keys_sent: usize,
    /// Time the last guard spent waiting for an unknown focus to settle; the schedule
    /// moves forward by it, so the keys that fell due meanwhile don't arrive in a burst.
    settled: Duration,
    diag: Option<DiagSink>,
    born: Instant,
    /// Number of password-field checks made, for the diagnostic trail.
    checks: usize,
}

enum Flow {
    Continue,
    End,
    Failed,
}

impl<D: Desktop> Session<D> {
    pub fn new(cfg: Config, desktop: D, control: Control, emit: Box<dyn FnMut(Update) + Send>) -> Self {
        Self { cfg, desktop, control, emit, index: 0, elapsed_ms: 0.0, target: None, keys_sent: 0, settled: Duration::ZERO, diag: None, born: Instant::now(), checks: 0 }
    }

    /// Sends a diagnostic trail of this session (phases, timings, focus checks, key-send
    /// results; never the text or window titles) to `diag`.
    pub fn with_diag(mut self, diag: DiagSink) -> Self {
        self.diag = Some(diag);
        self
    }

    fn log(&mut self, line: impl AsRef<str>) {
        let ms = self.born.elapsed().as_millis();
        if let Some(d) = self.diag.as_mut() {
            d(&format!("+{ms} ms  {}", line.as_ref()));
        }
    }

    fn log_focus(&mut self, what: &str) {
        let focused = self.desktop.focused_window().map(|w| describe_window(&w)).unwrap_or_else(|| "unknown".into());
        let detail = self.desktop.focus_detail().map(|d| format!("; {d}")).unwrap_or_default();
        self.log(format!("{what}: focused window {focused}{detail}"));
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
            self.update("failed", 0.0, Some("nothing-to-type"), Some("There was nothing to type.".into()));
            return "failed".into();
        }
        self.update("preparing", 0.0, None, Some("Getting the keyboard ready…".into()));
        let distinct = session_chars(&self.cfg.events).len();
        let (n, total, countdown) = (self.cfg.events.len(), self.total(), self.cfg.countdown_ms);
        self.log(format!("session: {n} timeline events, {distinct} distinct characters, {total:.0} ms planned, countdown {countdown} ms"));
        let prepare_started = Instant::now();
        // Let the backend prepare for every character up front (on X11: bind the ones
        // that aren't on the keyboard layout), well before the first key is due.
        // This only saves time later (characters left out are bound when typed), so when
        // the time limit is reached it stops early and the session carries on. It ends at
        // once when Stop is requested.
        let chars = session_chars(&self.cfg.events);
        let deadline = Instant::now() + Duration::from_millis(self.cfg.prepare_timeout_ms);
        let control = self.control.clone();
        let cancelled = move || control.stop_requested() || Instant::now() >= deadline;
        let total = self.total();
        let emit = &mut self.emit;
        self.desktop.prepare(&chars, &cancelled, &mut |done, of| {
            let mut u = Update::status("preparing", None, Some(format!("Setting up {done} of {of} characters that aren't on your keyboard…")));
            u.total_ms = total;
            emit(u);
        });
        let prepared = prepare_started.elapsed().as_millis();
        self.log(format!("preparing finished in {prepared} ms; waiting for another window to get focus"));
        if self.control.stop_requested() {
            self.control.take();
            return self.stop("user", None);
        }
        match self.wait_and_count_down() {
            Flow::End => return "stopped".into(),
            Flow::Failed => return "failed".into(),
            Flow::Continue => {}
        }
        // The window focused at the end of the countdown becomes the target.
        let target = self.desktop.focused_window();
        match target {
            Some(t) if !self.is_own(&t) => self.target = Some(t),
            _ => {
                self.log_focus("no target at the end of the countdown");
                self.update("failed", 0.0, Some("no-target"), Some("Couldn't tell which window to type into. Nothing was typed.".into()));
                return "failed".into();
            }
        }
        self.log_focus("countdown ended, target chosen");
        self.type_all()
    }

    /// Waits until Typewriter loses focus, then counts down. Returning to
    /// Typewriter during the countdown starts over. Nothing is typed here.
    fn wait_and_count_down(&mut self) -> Flow {
        let mut countdown_started: Option<Instant> = None;
        let mut last_emit = Instant::now() - EMIT_EVERY;
        let waiting_since = Instant::now();
        let mut unknown_since: Option<Instant> = None;
        let mut last_seen: Option<Option<(u64, String)>> = None;
        loop {
            match self.control.take() {
                Some(Command::Stop) => {
                    self.stop("user", None);
                    return Flow::End;
                }
                _ => {}
            }
            if self.desktop.failsafe_triggered() {
                self.stop("failsafe", Some("Stopped: mouse moved to the top-left corner.".into()));
                return Flow::End;
            }
            if waiting_since.elapsed() >= Duration::from_millis(self.cfg.wait_timeout_ms) {
                self.log("failed: no other window was chosen in time");
                let mins = (self.cfg.wait_timeout_ms as f64 / 60_000.0).round().max(1.0);
                self.update(
                    "failed",
                    0.0,
                    Some("no-target"),
                    Some(format!("Nothing was typed: no other window was chosen within {mins} minutes. Press Type into app again, then click into your document.")),
                );
                return Flow::Failed;
            }
            let focused = self.desktop.focused_window();
            let seen = focused.as_ref().map(|w| (w.process_id, w.window_id.clone()));
            if last_seen.as_ref() != Some(&seen) {
                let line = match &focused {
                    Some(w) if self.is_own(w) => format!("focus: Typewriter's own window {}", describe_window(w)),
                    Some(w) => format!("focus: {}", describe_window(w)),
                    None => "focus: the focused window can't be read".into(),
                };
                self.log(line);
                last_seen = Some(seen);
            }
            if focused.is_some() {
                unknown_since = None;
            } else if unknown_since.is_none() {
                unknown_since = Some(Instant::now());
            }
            let away = focused.map(|w| !self.is_own(&w)).unwrap_or(false);
            match (away, countdown_started) {
                (false, _) => {
                    let restarted = countdown_started.take().is_some();
                    if restarted {
                        self.log("countdown cancelled: focus came back to Typewriter or can't be read");
                    }
                    if restarted || last_emit.elapsed() >= Duration::from_millis(250) {
                        // Say so when the active window can't be read, instead of waiting silently.
                        let note = unknown_since.filter(|t| t.elapsed() >= UNKNOWN_FOCUS_NOTICE).map(|_| {
                            "Typewriter can't tell which window is active, so it won't type yet. Click into your document. \
                             (On Windows, apps running as administrator can't receive typing from Typewriter.)"
                                .to_string()
                        });
                        let reason = note.as_ref().map(|_| "focus-unknown");
                        self.update("waiting", self.cfg.countdown_ms as f64, reason, note);
                        last_emit = Instant::now();
                    }
                }
                (true, None) => {
                    self.log("countdown started");
                    countdown_started = Some(Instant::now());
                }
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
        // The password-field check can be slow (it asks the focused app); run it first, so the
        // focused window is read last, right before the key is sent.
        let t0 = Instant::now();
        let sensitive = self.desktop.sensitive_focus();
        let took = t0.elapsed().as_millis();
        self.checks += 1;
        if self.checks == 1 || took >= 250 {
            let n = self.checks;
            self.log(format!("password-field check #{n} took {took} ms"));
        }
        let mut focused = self.desktop.focused_window();
        if focused.is_none() {
            // Often a momentary blip while windows change; give it a moment to settle
            // (unless Stop was pressed: the pause below then ends at once).
            let t0 = Instant::now();
            while focused.is_none() && t0.elapsed() < FOCUS_SETTLE && !self.control.stop_requested() {
                std::thread::sleep(Duration::from_millis(20));
                focused = self.desktop.focused_window();
            }
            self.settled = t0.elapsed();
        }
        match focused {
            None => return Some(("focus-unknown", format!("Lost track of the focused window, so typing is waiting. {BACK}"))),
            Some(w) if self.is_own(&w) => return Some(("focus-typewriter", format!("Typewriter has focus, so typing is waiting (it never types into itself). {BACK}"))),
            Some(w) if w.other_tab_of(&target) => {
                return Some(("tab-changed", format!("You switched to another tab, so typing is waiting. Go back to the tab \"{}\" and it continues by itself.", target.title)));
            }
            Some(w) if !w.same_window(&target) => {
                // Some windows (pop-ups, overlays) have no title: name the app instead.
                let name = if !w.title.trim().is_empty() {
                    w.title.clone()
                } else if !w.app_name.trim().is_empty() {
                    w.app_name.clone()
                } else {
                    "another window".into()
                };
                return Some(("focus-changed", format!("Focus moved to \"{name}\", so typing is waiting. {BACK}")));
            }
            Some(w) => {
                if let Some(why) = sensitive_title(&w.title) {
                    return Some(("sensitive", why));
                }
            }
        }
        sensitive.map(|why| ("sensitive", why))
    }

    fn type_all(&mut self) -> String {
        self.log("typing started");
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
                            self.log("paused by the user");
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
                    let held = self.desktop.held_modifiers().join(", ");
                    self.log(format!("waiting for modifier keys to be released before key #{}: reported held: {held}", self.keys_sent + 1));
                    // Name the key when the platform can tell, so a key stuck "down" can be found.
                    let msg = if held.is_empty() {
                        "Waiting for you to release Ctrl, Alt, Shift or Cmd.".to_string()
                    } else {
                        format!("Waiting for you to release {held}. If you aren't holding it, press and release it once.")
                    };
                    self.update("typing", 0.0, Some("modifiers-held"), Some(msg));
                    waited = true;
                }
                if let Some(Command::Stop) = self.control.take() {
                    return self.stop("user", None);
                }
                std::thread::sleep(TICK);
            }
            if waited {
                let ms = held_since.elapsed().as_millis();
                self.log(format!("modifier keys released after {ms} ms"));
            }
            anchor += held_since.elapsed();
            let guard = self.guard();
            anchor += std::mem::take(&mut self.settled);
            if let Some((reason, msg)) = guard {
                let line = format!("paused before key #{} ({reason})", self.keys_sent + 1);
                self.log_focus(&line);
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
                let first = self.keys_sent == 0;
                if first {
                    let kind = action_kind(&action);
                    self.log(format!("first key: sending {kind}"));
                }
                let t0 = Instant::now();
                if let Err(e) = self.desktop.send(&action) {
                    let n = self.keys_sent;
                    self.log(format!("key send failed after {n} keys sent: {e}"));
                    self.log_focus("at the failed key");
                    self.update("failed", 0.0, Some("send-failed"), Some(format!("Couldn't send a key: {e}")));
                    return "failed".into();
                }
                if first {
                    let ms = t0.elapsed().as_millis();
                    self.log_focus(&format!("first key accepted by the system in {ms} ms"));
                }
                self.keys_sent += 1;
            }
            self.index += 1;
            self.elapsed_ms = due;
            if last_emit.elapsed() >= EMIT_EVERY || self.index == self.cfg.events.len() {
                self.update("typing", 0.0, None, None);
                last_emit = Instant::now();
            }
        }
        self.elapsed_ms = total;
        if self.keys_sent == 0 {
            self.log("failed: the timeline ended without any key sent");
            self.update("failed", 0.0, Some("nothing-sent"), Some("No keys were sent, so nothing was typed.".into()));
            return "failed".into();
        }
        let n = self.keys_sent;
        self.log(format!("completed: {n} key actions sent"));
        self.update("completed", 0.0, None, Some("Every key was sent. Check the document to confirm the text.".into()));
        "completed".into()
    }

    fn stop(&mut self, reason: &str, message: Option<String>) -> String {
        let n = self.keys_sent;
        self.log(format!("stopped ({reason}) after {n} key actions"));
        let message = message.or_else(|| (self.keys_sent == 0).then(|| "Stopped before typing began. Nothing was typed.".to_string()));
        self.update("stopped", 0.0, Some(reason), message);
        "stopped".into()
    }

    /// Paused until Resume (then a short countdown and waiting for the target to
    /// have focus again) or Stop. Returns None when stopped.
    ///
    /// A pause the session made by itself (focus or tab moved, a password field, focus
    /// unknown) also ends by itself: as soon as the target window and tab have focus
    /// again, the short countdown runs and typing continues. Pressing Pause meanwhile
    /// turns it into the user's pause, which only Resume ends.
    fn pause(&mut self, reason: &str, message: String, anchor: &mut Instant) -> Option<()> {
        let paused_at = Instant::now();
        let mut auto = reason != "user";
        let mut explicit = false;
        self.update("paused", 0.0, Some(reason), Some(message));
        let mut last_check = Instant::now();
        loop {
            match self.control.take() {
                Some(Command::Stop) => {
                    self.stop("user", None);
                    return None;
                }
                Some(Command::Resume) => {
                    self.log("resume requested");
                    explicit = true;
                    break;
                }
                Some(Command::Pause) if auto => {
                    self.log("paused by the user while waiting for the target");
                    auto = false;
                    self.update("paused", 0.0, Some("user"), Some("Paused.".into()));
                }
                _ => {}
            }
            if self.desktop.failsafe_triggered() {
                self.stop("failsafe", Some("Stopped: mouse moved to the top-left corner.".into()));
                return None;
            }
            if auto && last_check.elapsed() >= RECHECK {
                last_check = Instant::now();
                let back = self.guard().is_none();
                self.settled = Duration::ZERO;
                if back {
                    self.log("the target has focus again: continuing by itself");
                    break;
                }
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
        // Resume pressed while the target window shows another tab: the user chose to
        // continue in this tab (for example, a page that renamed itself), so it becomes
        // the target.
        if explicit {
            if let (Some(t), Some(w)) = (self.target.clone(), self.desktop.focused_window()) {
                if w.other_tab_of(&t) {
                    self.log("resumed in another tab of the target window: that tab is the target now");
                    self.target = Some(w);
                }
            }
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
                    } else if reason == "tab-changed" {
                        format!("Go back to the tab \"{title}\" to continue typing.")
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
        self.log_focus("typing resumed");
        self.update("typing", 0.0, None, None);
        Some(())
    }
}
