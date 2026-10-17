//! Session behaviour against a simulated desktop. Keys only reach whichever
//! window has focus, exactly like a real desktop, so typing into the wrong
//! window would show up in these tests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use typewriter_native::*;

const OWN: u64 = 1;

fn win(id: &str, pid: u64, title: &str) -> WindowInfo {
    WindowInfo { window_id: id.into(), process_id: pid, app_name: "app".into(), title: title.into() }
}

#[derive(Default)]
struct State {
    focused: Option<WindowInfo>,
    sensitive: Option<String>,
    modifiers: bool,
    failsafe: bool,
    fields: HashMap<String, VirtualField>,
    keys_sent: usize,
    first_key_at: Option<Instant>,
    prepared: Option<(Vec<char>, usize)>,
    /// Simulates a slow backend: prepare() keeps working until it is cancelled (or 5 s pass).
    slow_prepare: bool,
}

#[derive(Clone, Default)]
struct Fake(Arc<Mutex<State>>);

impl Fake {
    fn focus(&self, w: WindowInfo) {
        self.0.lock().unwrap().focused = Some(w);
    }
    fn text(&self, id: &str) -> String {
        self.0.lock().unwrap().fields.get(id).map(|f| f.text()).unwrap_or_default()
    }
    fn keys(&self) -> usize {
        self.0.lock().unwrap().keys_sent
    }
}

impl Desktop for Fake {
    fn focused_window(&mut self) -> Option<WindowInfo> {
        self.0.lock().unwrap().focused.clone()
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
    fn prepare(&mut self, chars: &[char], cancelled: &dyn Fn() -> bool) {
        let slow = {
            let mut s = self.0.lock().unwrap();
            let sent = s.keys_sent;
            s.prepared = Some((chars.to_vec(), sent));
            s.slow_prepare
        };
        let t0 = Instant::now();
        while slow && !cancelled() && t0.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(5));
        }
    }
    fn send(&mut self, a: &KeyAction) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        let id = s.focused.as_ref().map(|w| w.window_id.clone()).unwrap_or_else(|| "nowhere".into());
        s.keys_sent += 1;
        s.first_key_at.get_or_insert(Instant::now());
        s.fields.entry(id).or_default().apply(a);
        Ok(())
    }
}

fn events_for(text: &str, step_ms: f64) -> Vec<Event> {
    text.chars().enumerate().map(|(i, c)| Event::Type { at: (i + 1) as f64 * step_ms, text: c.to_string() }).collect()
}

struct Run {
    control: Control,
    updates: Arc<Mutex<Vec<Update>>>,
    handle: thread::JoinHandle<String>,
}

fn start(fake: &Fake, events: Vec<Event>, countdown_ms: u64) -> Run {
    let updates = Arc::new(Mutex::new(Vec::new()));
    let u2 = updates.clone();
    let control = Control::default();
    let c2 = control.clone();
    let desk = fake.clone();
    let handle = thread::spawn(move || {
        let cfg = Config { events, countdown_ms, resume_countdown_ms: 100, own_pid: OWN };
        Session::new(cfg, desk, c2, Box::new(move |u| u2.lock().unwrap().push(u))).run()
    });
    Run { control, updates, handle }
}

fn phases(updates: &Arc<Mutex<Vec<Update>>>) -> Vec<String> {
    let mut v: Vec<String> = updates.lock().unwrap().iter().map(|u| u.phase.clone()).collect();
    v.dedup();
    v
}

fn wait_for_phase(r: &Run, phase: &str, timeout_ms: u64) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(timeout_ms) {
        if r.updates.lock().unwrap().iter().any(|u| u.phase == phase) {
            return true;
        }
        thread::sleep(Duration::from_millis(5));
    }
    false
}

#[test]
fn never_types_while_typewriter_has_focus() {
    let fake = Fake::default();
    fake.focus(win("tw", OWN, "Typewriter"));
    let r = start(&fake, events_for("hello", 5.0), 50);
    thread::sleep(Duration::from_millis(400));
    assert_eq!(fake.keys(), 0);
    assert!(phases(&r.updates).iter().all(|p| p == "waiting"));
    r.control.send(Command::Stop);
    assert_eq!(r.handle.join().unwrap(), "stopped");
    assert_eq!(fake.keys(), 0);
}

#[test]
fn the_backend_is_prepared_with_every_character_before_any_key() {
    let fake = Fake::default();
    fake.focus(win("doc", 42, "Doc"));
    let events = vec![
        Event::Type { at: 1.0, text: "a".into() },
        Event::Type { at: 2.0, text: "👍🏽".into() },
        Event::Replace { at: 3.0, start: 0, end: 1, replacement: vec!["“".into(), "a".into()] },
    ];
    let r = start(&fake, events, 30);
    assert_eq!(r.handle.join().unwrap(), "completed");
    let (chars, keys_before) = fake.0.lock().unwrap().prepared.clone().expect("prepare was called");
    assert_eq!(keys_before, 0, "keys were sent before preparing");
    assert_eq!(chars, vec!['a', '👍', '🏽', '“']);
}

#[test]
fn stop_during_a_slow_prepare_ends_the_session_promptly_without_typing() {
    let fake = Fake::default();
    fake.0.lock().unwrap().slow_prepare = true;
    fake.focus(win("doc", 42, "Doc"));
    let r = start(&fake, events_for("never typed", 5.0), 50);
    thread::sleep(Duration::from_millis(100));
    let stopped_at = Instant::now();
    r.control.send(Command::Stop);
    assert_eq!(r.handle.join().unwrap(), "stopped");
    assert!(stopped_at.elapsed() < Duration::from_millis(500), "Stop waited for prepare to finish");
    assert_eq!(fake.keys(), 0);
}

#[test]
fn counts_down_then_types_into_the_target_only() {
    let fake = Fake::default();
    fake.focus(win("tw", OWN, "Typewriter"));
    let text = "Hello,\tworld!\nSecond line 👍🏽 — ok";
    let r = start(&fake, events_for(text, 3.0), 200);
    thread::sleep(Duration::from_millis(80));
    let switched = Instant::now();
    fake.focus(win("doc", 42, "Untitled document - Google Docs"));
    let updates = r.updates.clone();
    assert_eq!(r.handle.join().unwrap(), "completed");
    let first = fake.0.lock().unwrap().first_key_at.unwrap();
    assert!(first.duration_since(switched) >= Duration::from_millis(190), "typed before the countdown ended");
    assert_eq!(fake.text("doc"), text.replace('\t', "\t"));
    assert_eq!(fake.text("tw"), "");
    let p = phases(&updates);
    assert!(p.contains(&"countdown".to_string()) && p.last().unwrap() == "completed", "{p:?}");
}

#[test]
fn returning_to_typewriter_during_countdown_restarts_it() {
    let fake = Fake::default();
    fake.focus(win("tw", OWN, "Typewriter"));
    // A long countdown so a slow CI runner can't let it run out before the test returns to Typewriter.
    let r = start(&fake, events_for("abc", 2.0), 1000);
    thread::sleep(Duration::from_millis(30));
    fake.focus(win("doc", 42, "Doc"));
    assert!(wait_for_phase(&r, "countdown", 900), "the countdown didn't start");
    fake.focus(win("tw", OWN, "Typewriter"));
    // Past the original countdown's end: nothing may have been typed.
    thread::sleep(Duration::from_millis(1100));
    assert_eq!(fake.keys(), 0);
    let back = Instant::now();
    fake.focus(win("doc", 42, "Doc"));
    assert_eq!(r.handle.join().unwrap(), "completed");
    let first = fake.0.lock().unwrap().first_key_at.unwrap();
    assert!(first.duration_since(back) >= Duration::from_millis(990), "the countdown didn't start over");
    assert_eq!(fake.text("doc"), "abc");
}

#[test]
fn focus_change_pauses_and_resume_continues_exactly() {
    let fake = Fake::default();
    fake.focus(win("doc", 42, "Doc"));
    let text: String = "pause and resume should not lose or repeat anything. ".repeat(3);
    let r = start(&fake, events_for(&text, 4.0), 20);
    thread::sleep(Duration::from_millis(250));
    fake.focus(win("chat", 77, "Chat app"));
    assert!(wait_for_phase(&r, "paused", 500));
    let reason = r.updates.lock().unwrap().iter().rev().find(|u| u.phase == "paused").unwrap().reason.clone();
    assert_eq!(reason.as_deref(), Some("focus-changed"));
    let keys_at_pause = fake.keys();
    thread::sleep(Duration::from_millis(300));
    assert_eq!(fake.keys(), keys_at_pause, "kept typing after focus left the target");
    assert_eq!(fake.text("chat"), "");
    // Resume while the wrong window still has focus: must wait, not type.
    r.control.send(Command::Resume);
    thread::sleep(Duration::from_millis(300));
    assert_eq!(fake.keys(), keys_at_pause);
    fake.focus(win("doc", 42, "Doc"));
    assert_eq!(r.handle.join().unwrap(), "completed");
    assert_eq!(fake.text("doc"), text);
    assert_eq!(fake.text("chat"), "");
}

#[test]
fn user_pause_and_resume() {
    let fake = Fake::default();
    fake.focus(win("doc", 42, "Doc"));
    let text = "user pause check, nothing lost";
    // 600 ms of typing, so the Pause at ~80 ms still lands mid-session on a slow CI runner.
    let r = start(&fake, events_for(text, 20.0), 10);
    thread::sleep(Duration::from_millis(80));
    r.control.send(Command::Pause);
    assert!(wait_for_phase(&r, "paused", 300));
    let k = fake.keys();
    thread::sleep(Duration::from_millis(200));
    assert_eq!(fake.keys(), k);
    r.control.send(Command::Resume);
    assert_eq!(r.handle.join().unwrap(), "completed");
    assert_eq!(fake.text("doc"), text);
}

#[test]
fn refuses_login_windows_and_password_fields() {
    for (title, sensitive) in [("Sign in - Google Accounts", None), ("Notes", Some("password field".to_string()))] {
        let fake = Fake::default();
        fake.focus(win("x", 9, title));
        fake.0.lock().unwrap().sensitive = sensitive;
        let r = start(&fake, events_for("secret", 2.0), 10);
        assert!(wait_for_phase(&r, "paused", 500), "{title}");
        let u = r.updates.lock().unwrap().iter().rev().find(|u| u.phase == "paused").cloned().unwrap();
        assert_eq!(u.reason.as_deref(), Some("sensitive"));
        thread::sleep(Duration::from_millis(100));
        assert_eq!(fake.keys(), 0, "typed into a sensitive field");
        r.control.send(Command::Stop);
        assert_eq!(r.handle.join().unwrap(), "stopped");
        assert_eq!(fake.keys(), 0);
    }
}

#[test]
fn waits_while_modifier_keys_are_held() {
    let fake = Fake::default();
    fake.focus(win("doc", 42, "Doc"));
    fake.0.lock().unwrap().modifiers = true;
    let r = start(&fake, events_for("shortcut safe", 2.0), 10);
    thread::sleep(Duration::from_millis(200));
    assert_eq!(fake.keys(), 0);
    fake.0.lock().unwrap().modifiers = false;
    assert_eq!(r.handle.join().unwrap(), "completed");
    assert_eq!(fake.text("doc"), "shortcut safe");
}

#[test]
fn emergency_stop_and_failsafe_stop_immediately() {
    // Stop command
    let fake = Fake::default();
    fake.focus(win("doc", 42, "Doc"));
    let r = start(&fake, events_for(&"x".repeat(500), 2.0), 10);
    thread::sleep(Duration::from_millis(100));
    r.control.send(Command::Stop);
    assert_eq!(r.handle.join().unwrap(), "stopped");
    let k = fake.keys();
    assert!(k > 0 && k < 500);
    thread::sleep(Duration::from_millis(50));
    assert_eq!(fake.keys(), k);

    // Mouse in the corner
    let fake = Fake::default();
    fake.focus(win("doc", 42, "Doc"));
    let r = start(&fake, events_for(&"y".repeat(500), 2.0), 10);
    thread::sleep(Duration::from_millis(100));
    fake.0.lock().unwrap().failsafe = true;
    let updates = r.updates.clone();
    assert_eq!(r.handle.join().unwrap(), "stopped");
    assert_eq!(updates.lock().unwrap().last().unwrap().reason.as_deref(), Some("failsafe"));
    assert!(fake.keys() < 500);
}

#[test]
fn timing_follows_the_plan_without_drift() {
    let fake = Fake::default();
    fake.focus(win("doc", 42, "Doc"));
    let text = "x".repeat(100);
    let t0 = Instant::now();
    let r = start(&fake, events_for(&text, 5.0), 0);
    assert_eq!(r.handle.join().unwrap(), "completed");
    let took = t0.elapsed().as_millis();
    assert!((480..=700).contains(&took), "took {took} ms for a 500 ms timeline");
}

#[derive(serde::Deserialize)]
struct Fixture {
    name: String,
    source: String,
    events: Vec<Event>,
}

fn fixtures() -> Vec<Fixture> {
    serde_json::from_str(include_str!("fixtures.json")).unwrap()
}

#[test]
fn engine_timelines_translate_to_keys_that_reproduce_the_source() {
    let cases = fixtures();
    assert!(cases.len() >= 90);
    let mut replaces = 0;
    let mut carets = 0;
    for c in &cases {
        let mut tr = Translator::new();
        let mut field = VirtualField::default();
        for e in &c.events {
            match e {
                Event::Replace { .. } => replaces += 1,
                Event::Caret { .. } => carets += 1,
                _ => {}
            }
            for a in tr.actions(e) {
                if let KeyAction::Text(t) = &a {
                    assert!(!t.is_empty());
                }
                field.apply(&a);
            }
        }
        // "\r\n" is one Enter in a text field; everything else is exact.
        assert_eq!(field.text(), c.source.replace("\r\n", "\n"), "{}", c.name);
    }
    assert!(replaces > 0 && carets > 0);
}

#[test]
fn full_sessions_reproduce_engine_timelines_with_typos() {
    // Compress each timeline to ~60 ms so the whole set runs quickly.
    for c in fixtures().into_iter().step_by(6) {
        let total = c.events.last().map(|e| e.at()).unwrap_or(1.0);
        let scale = 60.0 / total;
        let events: Vec<Event> = c
            .events
            .into_iter()
            .map(|e| {
                let mut v = serde_json::to_value(match &e {
                    Event::Type { at, text } => serde_json::json!({"kind":"type","at":at*scale,"text":text}),
                    Event::Backspace { at } => serde_json::json!({"kind":"backspace","at":at*scale}),
                    Event::Caret { at, to } => serde_json::json!({"kind":"caret","at":at*scale,"to":to}),
                    Event::Replace { at, start, end, replacement } => serde_json::json!({"kind":"replace","at":at*scale,"start":start,"end":end,"replacement":replacement}),
                    Event::Wait { at } => serde_json::json!({"kind":"wait","at":at*scale}),
                })
                .unwrap();
                serde_json::from_value(v.take()).unwrap()
            })
            .collect();
        let fake = Fake::default();
        fake.focus(win("doc", 42, "Doc"));
        let r = start(&fake, events, 0);
        assert_eq!(r.handle.join().unwrap(), "completed", "{}", c.name);
        assert_eq!(fake.text("doc"), c.source, "{}", c.name);
    }
}
