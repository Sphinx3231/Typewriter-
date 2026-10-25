//! Session paths the main session tests don't reach: every way a session can end early
//! (nothing to type, nothing sent, no target, a failed key, the failsafe or Stop at each
//! stage) and the messages shown while it waits. Uses a scripted desktop whose events are
//! tied to the keys actually sent, so each case is deterministic.

use std::collections::VecDeque;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use typewriter_native::*;

const OWN: u64 = 1;

fn win(id: &str, pid: u64, app: &str, title: &str) -> WindowInfo {
    WindowInfo { window_id: id.into(), process_id: pid, app_name: app.into(), title: title.into() }
}

fn doc() -> WindowInfo {
    win("10", 50, "Editor", "Doc")
}

/// What happens right after the key with this number (0 = the first) is sent.
enum Hook {
    Stop,
    Resume,
    Focus(Option<WindowInfo>),
    Modifiers(bool),
    Failsafe,
}

#[derive(Default)]
struct State {
    focused: Option<WindowInfo>,
    /// Answers for the next focus queries, before `focused` applies again.
    script: VecDeque<Option<WindowInfo>>,
    sensitive: Option<String>,
    modifiers: bool,
    failsafe: bool,
    mouse: bool,
    held: Vec<&'static str>,
    detail: Option<String>,
    prepared: Vec<char>,
    fail_with: Option<String>,
    sent: Vec<KeyAction>,
    hooks: Vec<(usize, Hook)>,
}

#[derive(Clone)]
struct Scripted(Arc<Mutex<State>>, Control);

impl Scripted {
    fn new(control: &Control) -> Self {
        Scripted(Arc::new(Mutex::new(State { focused: Some(doc()), ..Default::default() })), control.clone())
    }
    fn set(&self, f: impl FnOnce(&mut State)) {
        f(&mut self.0.lock().unwrap());
    }
    fn sent(&self) -> Vec<KeyAction> {
        self.0.lock().unwrap().sent.clone()
    }
}

impl Desktop for Scripted {
    fn focused_window(&mut self) -> Option<WindowInfo> {
        let mut s = self.0.lock().unwrap();
        match s.script.pop_front() {
            Some(w) => w,
            None => s.focused.clone(),
        }
    }
    fn sensitive_focus(&mut self) -> Option<String> {
        self.0.lock().unwrap().sensitive.clone()
    }
    fn modifiers_held(&mut self) -> bool {
        self.0.lock().unwrap().modifiers
    }
    fn failsafe_triggered(&mut self) -> bool {
        self.0.lock().unwrap().failsafe
    }
    fn mouse_down(&mut self) -> bool {
        self.0.lock().unwrap().mouse
    }
    fn held_modifiers(&mut self) -> Vec<&'static str> {
        self.0.lock().unwrap().held.clone()
    }
    fn focus_detail(&mut self) -> Option<String> {
        self.0.lock().unwrap().detail.clone()
    }
    fn prepare(&mut self, chars: &[char], _cancelled: &dyn Fn() -> bool, progress: &mut dyn FnMut(usize, usize)) {
        self.0.lock().unwrap().prepared = chars.to_vec();
        progress(1, 1);
    }
    fn send(&mut self, a: &KeyAction) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        if let Some(e) = s.fail_with.clone() {
            return Err(e);
        }
        let n = s.sent.len();
        s.sent.push(a.clone());
        let hooks: Vec<(usize, Hook)> = std::mem::take(&mut s.hooks);
        for (at, h) in hooks {
            if at != n {
                s.hooks.push((at, h));
                continue;
            }
            match h {
                Hook::Stop => self.1.send(Command::Stop),
                Hook::Resume => self.1.send(Command::Resume),
                Hook::Focus(w) => s.focused = w,
                Hook::Modifiers(m) => s.modifiers = m,
                Hook::Failsafe => s.failsafe = true,
            }
        }
        Ok(())
    }
}

fn typed(text: &str, step_ms: f64) -> Vec<Event> {
    text.chars().enumerate().map(|(i, c)| Event::Type { at: (i + 1) as f64 * step_ms, text: c.to_string() }).collect()
}

fn cfg(events: Vec<Event>, countdown_ms: u64, resume_countdown_ms: u64) -> Config {
    Config { events, countdown_ms, resume_countdown_ms, own_pid: OWN, prepare_timeout_ms: 1000, wait_timeout_ms: 10_000 }
}

struct Run {
    handle: JoinHandle<String>,
    rx: Receiver<Update>,
    seen: Vec<Update>,
    diag: Arc<Mutex<Vec<String>>>,
}

impl Run {
    fn start(d: &Scripted, control: &Control, cfg: Config) -> Run {
        let (tx, rx) = mpsc::channel();
        let diag = Arc::new(Mutex::new(Vec::new()));
        let sink = diag.clone();
        let (d, c) = (d.clone(), control.clone());
        let handle = thread::spawn(move || {
            Session::new(cfg, d, c, Box::new(move |u| drop(tx.send(u)))).with_diag(Box::new(move |l: &str| sink.lock().unwrap().push(l.to_string()))).run()
        });
        Run { handle, rx, seen: Vec::new(), diag }
    }
    /// Waits for an update matching `p` and returns it.
    fn until(&mut self, what: &str, p: impl Fn(&Update) -> bool) -> Update {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(10) {
            if let Ok(u) = self.rx.recv_timeout(Duration::from_millis(50)) {
                self.seen.push(u.clone());
                if p(&u) {
                    return u;
                }
            }
        }
        panic!("no update for {what}; saw {:?}", self.seen.iter().map(|u| (&u.phase, &u.reason)).collect::<Vec<_>>());
    }
    /// Joins the session; returns its result and its last update.
    fn finish(mut self) -> (String, Update, Vec<String>) {
        let r = self.handle.join().expect("session thread");
        self.seen.extend(self.rx.try_iter());
        let diag = self.diag.lock().unwrap().clone();
        (r, self.seen.last().cloned().expect("an update"), diag)
    }
}

fn ended(r: &(String, Update, Vec<String>)) -> (&str, &str, Option<&str>) {
    (r.0.as_str(), r.1.phase.as_str(), r.1.reason.as_deref())
}

#[test]
fn an_empty_timeline_fails_at_once() {
    let c = Control::default();
    let d = Scripted::new(&c);
    let r = Run::start(&d, &c, cfg(vec![], 0, 0)).finish();
    assert_eq!(ended(&r), ("failed", "failed", Some("nothing-to-type")));
    assert_eq!(r.1.message.as_deref(), Some("There was nothing to type."));
    assert!(d.sent().is_empty());
}

#[test]
fn a_timeline_that_sends_no_key_fails_instead_of_completing() {
    let c = Control::default();
    let d = Scripted::new(&c);
    // A backspace at the start has nothing to delete, and a wait sends nothing.
    let r = Run::start(&d, &c, cfg(vec![Event::Backspace { at: 1.0 }, Event::Caret { at: 2.0, to: 0 }, Event::Wait { at: 3.0 }], 0, 0)).finish();
    assert_eq!(ended(&r), ("failed", "failed", Some("nothing-sent")));
    assert!(d.sent().is_empty());
    assert!(r.2.iter().any(|l| l.contains("without any key sent")));
}

#[test]
fn the_first_key_is_named_in_the_trail_by_its_kind() {
    for (first, kind) in [("\n", "Enter"), ("\t", "Tab"), ("x", "text of 1 characters")] {
        let c = Control::default();
        let d = Scripted::new(&c);
        let r = Run::start(&d, &c, cfg(typed(&format!("{first}a"), 1.0), 0, 0)).finish();
        assert_eq!(ended(&r), ("completed", "completed", None));
        assert!(r.2.iter().any(|l| l.ends_with(&format!("first key: sending {kind}"))), "{kind}: {:?}", r.2);
    }
}

#[test]
fn the_failsafe_stops_a_session_that_is_waiting_for_a_window() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| {
        s.focused = Some(win("1", OWN, "Typewriter", "Typewriter"));
        s.failsafe = true;
    });
    let r = Run::start(&d, &c, cfg(typed("abc", 1.0), 0, 0)).finish();
    assert_eq!(ended(&r), ("stopped", "stopped", Some("failsafe")));
    assert!(r.1.message.unwrap().contains("top-left corner"));
    assert!(d.sent().is_empty());
}

#[test]
fn losing_the_window_just_as_the_countdown_ends_fails_without_typing() {
    let c = Control::default();
    let d = Scripted::new(&c);
    // The countdown starts and ends on the document; the very next look finds nothing.
    d.set(|s| {
        s.script = VecDeque::from([Some(doc()), Some(doc())]);
        s.focused = None;
    });
    let r = Run::start(&d, &c, cfg(typed("abc", 1.0), 0, 0)).finish();
    assert_eq!(ended(&r), ("failed", "failed", Some("no-target")));
    assert!(r.1.message.unwrap().contains("Nothing was typed"));
    assert!(d.sent().is_empty());
    assert!(r.2.iter().any(|l| l.contains("no target at the end of the countdown: focused window unknown")));
}

#[test]
fn ending_the_countdown_on_typewriter_itself_fails_without_typing() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| {
        s.script = VecDeque::from([Some(doc()), Some(doc())]);
        s.focused = Some(win("1", OWN, "Typewriter", "Typewriter"));
    });
    let r = Run::start(&d, &c, cfg(typed("abc", 1.0), 0, 0)).finish();
    assert_eq!(ended(&r), ("failed", "failed", Some("no-target")));
    assert!(d.sent().is_empty());
}

#[test]
fn a_focused_window_that_stays_unknown_pauses_typing() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.hooks.push((0, Hook::Focus(None))));
    let mut r = Run::start(&d, &c, cfg(typed("abcdef", 5.0), 0, 0));
    let p = r.until("the focus-unknown pause", |u| u.phase == "paused");
    assert_eq!(p.reason.as_deref(), Some("focus-unknown"));
    assert!(p.message.unwrap().starts_with("Lost track of the focused window"));
    c.send(Command::Stop);
    let r = r.finish();
    assert_eq!(ended(&r), ("stopped", "stopped", Some("user")));
    assert_eq!(d.sent(), vec![KeyAction::Text("a".into())], "nothing was sent while the window was unknown");
}

#[test]
fn a_window_without_title_or_app_name_is_called_another_window() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.hooks.push((1, Hook::Focus(Some(win("77", 9, " ", ""))))));
    let mut r = Run::start(&d, &c, cfg(typed("abcdef", 5.0), 0, 0));
    let p = r.until("the focus-changed pause", |u| u.phase == "paused");
    assert_eq!(p.reason.as_deref(), Some("focus-changed"));
    assert!(p.message.unwrap().starts_with("Focus moved to \"another window\""));
    c.send(Command::Stop);
    assert_eq!(ended(&r.finish()), ("stopped", "stopped", Some("user")));
    assert_eq!(d.sent().len(), 2);
}

#[test]
fn a_resume_while_typing_changes_nothing() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.hooks.push((0, Hook::Resume)));
    let r = Run::start(&d, &c, cfg(typed("abc", 5.0), 0, 0)).finish();
    assert_eq!(ended(&r), ("completed", "completed", None));
    assert_eq!(d.sent().len(), 3);
    assert!(!r.2.iter().any(|l| l.contains("paused")));
}

#[test]
fn stop_while_paused_by_the_user_ends_the_session() {
    let c = Control::default();
    let d = Scripted::new(&c);
    let mut r = Run::start(&d, &c, cfg(typed("abcdefghij", 50.0), 0, 0));
    r.until("typing", |u| u.phase == "typing");
    c.send(Command::Pause);
    let p = r.until("the user's pause", |u| u.phase == "paused");
    assert_eq!(p.reason.as_deref(), Some("user"));
    let n = d.sent().len();
    c.send(Command::Stop);
    assert_eq!(ended(&r.finish()), ("stopped", "stopped", Some("user")));
    assert_eq!(d.sent().len(), n, "nothing more was typed");
}

#[test]
fn stop_while_waiting_for_modifier_keys_ends_the_session() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.hooks.push((0, Hook::Modifiers(true))));
    let mut r = Run::start(&d, &c, cfg(typed("abc", 5.0), 0, 0));
    let m = r.until("the modifiers notice", |u| u.reason.as_deref() == Some("modifiers-held"));
    // A backend that can't name the keys gets the generic wording.
    assert_eq!(m.message.as_deref(), Some("Waiting for you to release Ctrl, Alt, Shift or Cmd."));
    c.send(Command::Stop);
    assert_eq!(ended(&r.finish()), ("stopped", "stopped", Some("user")));
    assert_eq!(d.sent().len(), 1);
}

#[test]
fn stop_in_the_middle_of_a_multi_key_correction_ends_it_there() {
    let c = Control::default();
    let d = Scripted::new(&c);
    // "ab", then the correction of "a" (left, backspace, "x", right): Stop arrives after its first key.
    let events = vec![
        Event::Type { at: 1.0, text: "a".into() },
        Event::Type { at: 2.0, text: "b".into() },
        Event::Replace { at: 3.0, start: 0, end: 1, replacement: vec!["x".into()] },
    ];
    d.set(|s| s.hooks.push((2, Hook::Stop)));
    let r = Run::start(&d, &c, cfg(events, 0, 0)).finish();
    assert_eq!(ended(&r), ("stopped", "stopped", Some("user")));
    assert_eq!(d.sent(), vec![KeyAction::Text("a".into()), KeyAction::Text("b".into()), KeyAction::Left]);
}

#[test]
fn a_key_that_cannot_be_sent_fails_the_session_and_says_why() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| {
        s.fail_with = Some("the display went away".into());
        s.detail = Some("window class Edit".into());
    });
    let r = Run::start(&d, &c, cfg(typed("abc", 1.0), 0, 0)).finish();
    assert_eq!(ended(&r), ("failed", "failed", Some("send-failed")));
    assert_eq!(r.1.message.as_deref(), Some("Couldn't send a key: the display went away"));
    assert!(r.2.iter().any(|l| l.contains("key send failed after 0 keys sent")));
    // The backend's focus detail goes into the trail next to the window.
    assert!(r.2.iter().any(|l| l.contains("at the failed key: focused window") && l.ends_with("; window class Edit")), "{:?}", r.2);
}

#[test]
fn the_failsafe_stops_a_paused_session() {
    let c = Control::default();
    let d = Scripted::new(&c);
    let mut r = Run::start(&d, &c, cfg(typed("abcdefghij", 50.0), 0, 0));
    r.until("typing", |u| u.phase == "typing");
    c.send(Command::Pause);
    r.until("the user's pause", |u| u.phase == "paused");
    d.set(|s| s.failsafe = true);
    let r = r.finish();
    assert_eq!(ended(&r), ("stopped", "stopped", Some("failsafe")));
}

#[test]
fn stop_during_the_resume_countdown_ends_the_session() {
    let c = Control::default();
    let d = Scripted::new(&c);
    let mut r = Run::start(&d, &c, cfg(typed("abcdefghij", 50.0), 0, 5000));
    r.until("typing", |u| u.phase == "typing");
    c.send(Command::Pause);
    r.until("the user's pause", |u| u.phase == "paused");
    c.send(Command::Resume);
    r.until("the resume countdown", |u| u.phase == "resuming" && u.countdown_ms > 0.0);
    let n = d.sent().len();
    c.send(Command::Stop);
    assert_eq!(ended(&r.finish()), ("stopped", "stopped", Some("user")));
    assert_eq!(d.sent().len(), n);
}

#[test]
fn resuming_while_another_window_has_focus_waits_for_the_document_and_can_be_stopped() {
    let c = Control::default();
    let d = Scripted::new(&c);
    let mut r = Run::start(&d, &c, cfg(typed("abcdefghij", 50.0), 0, 0));
    r.until("typing", |u| u.phase == "typing");
    c.send(Command::Pause);
    r.until("the user's pause", |u| u.phase == "paused");
    d.set(|s| s.focused = Some(win("20", 60, "Mail", "Inbox")));
    c.send(Command::Resume);
    let w = r.until("waiting for the document", |u| u.reason.as_deref() == Some("waiting-for-target"));
    assert_eq!(w.message.as_deref(), Some("Click back into \"Doc\" to continue typing."));
    let n = d.sent().len();
    c.send(Command::Stop);
    assert_eq!(ended(&r.finish()), ("stopped", "stopped", Some("user")));
    assert_eq!(d.sent().len(), n, "nothing went to the other window");
}

#[test]
fn a_password_field_after_the_resume_countdown_is_named_while_waiting() {
    let c = Control::default();
    let d = Scripted::new(&c);
    let mut r = Run::start(&d, &c, cfg(typed("abcdefghij", 50.0), 0, 300));
    r.until("typing", |u| u.phase == "typing");
    c.send(Command::Pause);
    r.until("the user's pause", |u| u.phase == "paused");
    c.send(Command::Resume);
    r.until("the resume countdown", |u| u.phase == "resuming");
    d.set(|s| s.sensitive = Some("The focused field is a password field.".into()));
    let w = r.until("waiting for the document", |u| u.reason.as_deref() == Some("waiting-for-target"));
    assert_eq!(w.message.as_deref(), Some("A password or login field has focus. Click back into your document."));
    // Still waiting a while later, without repeating the notice.
    thread::sleep(Duration::from_millis(60));
    let n = d.sent().len();
    d.set(|s| s.sensitive = None);
    let r = r.finish();
    assert_eq!(ended(&r), ("completed", "completed", None));
    assert_eq!(d.sent().len(), 10);
    assert!(n < 10);
}

#[test]
fn a_tab_switch_during_the_resume_countdown_names_the_tab_to_go_back_to() {
    let c = Control::default();
    let d = Scripted::new(&c);
    let tab = |t: &str| win("30", 70, "Google Chrome", t);
    d.set(|s| s.focused = Some(tab("Essay - Google Docs")));
    let mut r = Run::start(&d, &c, cfg(typed("abcdefghij", 50.0), 0, 300));
    r.until("typing", |u| u.phase == "typing");
    // Another tab: an automatic pause, which ends by itself when the tab is back.
    d.set(|s| s.focused = Some(tab("YouTube")));
    r.until("the tab pause", |u| u.reason.as_deref() == Some("tab-changed"));
    d.set(|s| s.focused = Some(tab("Essay - Google Docs")));
    r.until("the resume countdown", |u| u.phase == "resuming");
    // Away again before the countdown ends.
    d.set(|s| s.focused = Some(tab("YouTube")));
    let w = r.until("waiting for the tab", |u| u.reason.as_deref() == Some("waiting-for-target"));
    assert_eq!(w.message.as_deref(), Some("Go back to the tab \"Essay - Google Docs\" to continue typing."));
    d.set(|s| s.focused = Some(tab("Essay - Google Docs")));
    let r = r.finish();
    assert_eq!(ended(&r), ("completed", "completed", None));
    assert_eq!(d.sent().len(), 10);
}

#[test]
fn the_keyboard_timeout_message_rounds_to_whole_seconds() {
    assert!(prepare_timeout_message(15_000).contains("within 15 seconds"));
    assert!(prepare_timeout_message(2_400).contains("within 2 seconds"));
}

#[test]
fn a_lock_left_poisoned_by_a_crashed_holder_is_still_taken() {
    static M: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _ = thread::spawn(|| {
        let _g = M.lock().unwrap();
        panic!("holder crashed (expected in this test)");
    })
    .join();
    assert!(M.is_poisoned());
    assert!(lock_unless(&M, &|| false).is_some());
}

#[test]
fn stop_before_the_session_starts_types_nothing() {
    let c = Control::default();
    let d = Scripted::new(&c);
    c.send(Command::Stop);
    let r = Run::start(&d, &c, cfg(typed("abc", 1.0), 0, 0)).finish();
    assert_eq!(ended(&r), ("stopped", "stopped", Some("user")));
    assert_eq!(r.1.message.as_deref(), Some("Stopped before typing began. Nothing was typed."));
    assert_eq!(d.0.lock().unwrap().prepared, vec!['a', 'b', 'c'], "the backend was still told what was coming");
    assert!(d.sent().is_empty());
}

#[test]
fn waiting_for_a_window_ends_when_its_time_runs_out() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.focused = Some(win("1", OWN, "Typewriter", "Typewriter")));
    let mut config = cfg(typed("abc", 1.0), 0, 0);
    config.wait_timeout_ms = 200;
    let t0 = Instant::now();
    let r = Run::start(&d, &c, config).finish();
    assert!(t0.elapsed() >= Duration::from_millis(200));
    assert_eq!(ended(&r), ("failed", "failed", Some("no-target")));
    assert!(r.1.message.unwrap().contains("no other window was chosen within 1 minutes"));
    assert!(d.sent().is_empty());
}

#[test]
fn stop_while_waiting_for_a_window_ends_the_session() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.focused = Some(win("1", OWN, "Typewriter", "Typewriter")));
    let mut r = Run::start(&d, &c, cfg(typed("abc", 1.0), 0, 0));
    r.until("waiting", |u| u.phase == "waiting");
    c.send(Command::Stop);
    assert_eq!(ended(&r.finish()), ("stopped", "stopped", Some("user")));
    assert!(d.sent().is_empty());
}

#[test]
fn the_countdown_restarts_on_a_click_or_another_window_and_stops_when_typewriter_is_back() {
    let c = Control::default();
    let d = Scripted::new(&c);
    // At first the focused window can't be read: after a while the user is told.
    d.set(|s| s.focused = None);
    let mut r = Run::start(&d, &c, cfg(typed("abc", 1.0), 400, 0));
    let w = r.until("the unknown-focus notice", |u| u.reason.as_deref() == Some("focus-unknown"));
    assert_eq!(w.phase, "waiting");
    assert!(w.message.unwrap().starts_with("Typewriter can't tell which window is active"));
    d.set(|s| s.focused = Some(doc()));
    r.until("the countdown", |u| u.phase == "countdown" && u.countdown_ms < 400.0);
    // Back to Typewriter: the countdown is off.
    d.set(|s| s.focused = Some(win("1", OWN, "Typewriter", "Typewriter")));
    r.until("waiting again", |u| u.phase == "waiting");
    d.set(|s| s.focused = Some(doc()));
    r.until("the countdown again", |u| u.phase == "countdown");
    // A click into the document, then another window: each starts the countdown over.
    d.set(|s| s.mouse = true);
    thread::sleep(Duration::from_millis(50));
    d.set(|s| {
        s.mouse = false;
        s.focused = Some(win("20", 60, "Mail", "Inbox"));
    });
    let r = r.finish();
    assert_eq!(ended(&r), ("completed", "completed", None));
    assert_eq!(r.1.target.as_ref().map(|t| t.window_id.as_str()), Some("20"), "typed into the window chosen last");
    for line in ["focus: the focused window can't be read", "focus: Typewriter's own window", "countdown cancelled", "countdown restarted: a click", "countdown restarted: another window got focus"] {
        assert!(r.2.iter().any(|l| l.contains(line)), "{line}: {:?}", r.2);
    }
}

#[test]
fn focus_moving_to_a_titled_window_names_it_and_a_login_title_pauses_too() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| {
        s.hooks.push((0, Hook::Focus(Some(win("20", 60, "Mail", "Inbox")))));
        s.hooks.push((2, Hook::Focus(Some(win("10", 50, "Editor", "Sign in to Doc")))));
    });
    let mut r = Run::start(&d, &c, cfg(typed("abcdef", 5.0), 0, 0));
    let p = r.until("the focus-changed pause", |u| u.phase == "paused");
    assert_eq!(p.reason.as_deref(), Some("focus-changed"));
    assert!(p.message.unwrap().starts_with("Focus moved to \"Inbox\""));
    assert_eq!(d.sent().len(), 1);
    // The document is back: typing continues by itself.
    d.set(|s| s.focused = Some(doc()));
    let p = r.until("the login pause", |u| u.phase == "paused" && u.reason.as_deref() == Some("sensitive"));
    assert!(p.message.unwrap().contains("\"sign in\""));
    assert_eq!(d.sent().len(), 3);
    d.set(|s| s.focused = Some(doc()));
    let r = r.finish();
    assert_eq!(ended(&r), ("completed", "completed", None));
    assert_eq!(d.sent().len(), 6);
    assert!(r.2.iter().any(|l| l.contains("the target has focus again: continuing by itself")));
}

#[test]
fn stop_between_two_keys_ends_the_session() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.hooks.push((0, Hook::Stop)));
    let r = Run::start(&d, &c, cfg(typed("abc", 5.0), 0, 0)).finish();
    assert_eq!(ended(&r), ("stopped", "stopped", Some("user")));
    assert_eq!(d.sent().len(), 1);
}

#[test]
fn the_stopped_update_comes_after_the_last_key_and_counts_every_key_sent() {
    // The app treats the "stopped" update as the end of typing, so no key may be sent after it
    // and its progress must match what reached the document.
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.hooks.push((3, Hook::Stop)));
    let at_stop = Arc::new(Mutex::new(None::<(usize, usize)>));
    let (seen, probe) = (at_stop.clone(), d.clone());
    let r = Session::new(cfg(typed("abcdefgh", 5.0), 0, 0), d.clone(), c.clone(), Box::new(move |u: Update| {
        if u.phase == "stopped" {
            *seen.lock().unwrap() = Some((probe.sent().len(), u.index));
        }
    }))
    .run();
    assert_eq!(r, "stopped");
    let (sent_then, index) = at_stop.lock().unwrap().expect("a stopped update");
    assert_eq!(sent_then, 4, "every key before the stop was sent when \"stopped\" was published");
    assert_eq!(d.sent().len(), sent_then, "a key was sent after \"stopped\" was published");
    assert_eq!(index, 4, "the stopped update reports the keys that were sent");
}

#[test]
fn the_failsafe_stops_a_session_that_is_typing() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.hooks.push((1, Hook::Failsafe)));
    let r = Run::start(&d, &c, cfg(typed("abcdef", 5.0), 0, 0)).finish();
    assert_eq!(ended(&r), ("stopped", "stopped", Some("failsafe")));
    assert_eq!(d.sent().len(), 2);
}

#[test]
fn held_modifiers_are_named_and_typing_continues_once_they_are_released() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| {
        s.held = vec!["Shift", "Ctrl"];
        s.hooks.push((0, Hook::Modifiers(true)));
    });
    let mut r = Run::start(&d, &c, cfg(typed("abc", 5.0), 0, 0));
    let m = r.until("the modifiers notice", |u| u.reason.as_deref() == Some("modifiers-held"));
    assert_eq!(m.message.as_deref(), Some("Waiting for you to release Shift, Ctrl. If you aren't holding it, press and release it once."));
    assert_eq!(d.sent().len(), 1);
    d.set(|s| s.modifiers = false);
    let r = r.finish();
    assert_eq!(ended(&r), ("completed", "completed", None));
    assert_eq!(d.sent().len(), 3);
    assert!(r.2.iter().any(|l| l.contains("reported held: Shift, Ctrl")));
    assert!(r.2.iter().any(|l| l.contains("modifier keys released after")));
}

#[test]
fn pressing_pause_during_an_automatic_pause_waits_for_resume() {
    let c = Control::default();
    let d = Scripted::new(&c);
    d.set(|s| s.hooks.push((0, Hook::Focus(Some(win("20", 60, "Mail", "Inbox"))))));
    let mut r = Run::start(&d, &c, cfg(typed("abcd", 5.0), 0, 0));
    r.until("the automatic pause", |u| u.phase == "paused" && u.reason.as_deref() == Some("focus-changed"));
    c.send(Command::Pause);
    r.until("the user's pause", |u| u.phase == "paused" && u.reason.as_deref() == Some("user"));
    d.set(|s| s.focused = Some(doc()));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(d.sent().len(), 1, "the document being back doesn't end the user's pause");
    c.send(Command::Resume);
    let r = r.finish();
    assert_eq!(ended(&r), ("completed", "completed", None));
    assert_eq!(d.sent().len(), 4);
}

#[test]
fn resume_pressed_in_another_tab_types_on_in_that_tab() {
    let c = Control::default();
    let d = Scripted::new(&c);
    let tab = |t: &str| win("30", 70, "Firefox", t);
    d.set(|s| s.focused = Some(tab("Essay")));
    let mut r = Run::start(&d, &c, cfg(typed("abcdefghij", 40.0), 0, 0));
    r.until("typing", |u| u.phase == "typing");
    c.send(Command::Pause);
    r.until("the user's pause", |u| u.phase == "paused");
    d.set(|s| s.focused = Some(tab("Essay (renamed)")));
    c.send(Command::Resume);
    let r = r.finish();
    assert_eq!(ended(&r), ("completed", "completed", None));
    assert_eq!(r.1.target.as_ref().map(|t| t.title.as_str()), Some("Essay (renamed)"));
    assert!(r.2.iter().any(|l| l.contains("that tab is the target now")));
}

/// A backend with only the methods it must have: the trait's defaults (no mouse button,
/// nothing to prepare, modifiers it can't name, no focus detail) do the rest.
struct Minimal {
    modifier_checks: usize,
    sent: Arc<Mutex<Vec<KeyAction>>>,
}

impl Desktop for Minimal {
    fn focused_window(&mut self) -> Option<WindowInfo> {
        Some(doc())
    }
    fn sensitive_focus(&mut self) -> Option<String> {
        None
    }
    fn modifiers_held(&mut self) -> bool {
        // Held for the first two checks.
        self.modifier_checks += 1;
        self.modifier_checks <= 2
    }
    fn failsafe_triggered(&mut self) -> bool {
        false
    }
    fn send(&mut self, a: &KeyAction) -> Result<(), String> {
        self.sent.lock().unwrap().push(a.clone());
        Ok(())
    }
}

#[test]
fn a_backend_with_only_the_required_methods_runs_a_whole_session() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let updates = Arc::new(Mutex::new(Vec::<Update>::new()));
    let u = updates.clone();
    let d = Minimal { modifier_checks: 0, sent: sent.clone() };
    let r = Session::new(cfg(typed("hi", 1.0), 0, 0), d, Control::default(), Box::new(move |x| u.lock().unwrap().push(x))).run();
    assert_eq!(r, "completed");
    assert_eq!(*sent.lock().unwrap(), vec![KeyAction::Text("h".into()), KeyAction::Text("i".into())]);
    let updates = updates.lock().unwrap();
    assert!(updates.iter().any(|u| u.message.as_deref() == Some("Waiting for you to release Ctrl, Alt, Shift or Cmd.")));
    assert!(!updates.iter().any(|u| u.message.as_deref().is_some_and(|m| m.starts_with("Setting up"))), "nothing to prepare, so no progress");
}

#[test]
fn resume_pressed_while_the_focused_window_is_unknown_waits_for_the_document() {
    let c = Control::default();
    let d = Scripted::new(&c);
    let mut r = Run::start(&d, &c, cfg(typed("abcdefghij", 40.0), 0, 0));
    r.until("typing", |u| u.phase == "typing");
    c.send(Command::Pause);
    r.until("the user's pause", |u| u.phase == "paused");
    let n = d.sent().len();
    d.set(|s| s.focused = None);
    c.send(Command::Resume);
    r.until("waiting for the document", |u| u.reason.as_deref() == Some("waiting-for-target"));
    assert_eq!(d.sent().len(), n);
    d.set(|s| s.focused = Some(doc()));
    let r = r.finish();
    assert_eq!(ended(&r), ("completed", "completed", None));
    assert_eq!(r.1.target, Some(doc()), "the target stays the document");
    assert_eq!(d.sent().len(), 10);
}
