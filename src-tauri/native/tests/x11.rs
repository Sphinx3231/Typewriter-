//! The X11 backend against a real X server: an Xvfb started for this test binary, real
//! windows that receive the key events, and the server's real keymap.
//!
//! Every test checks what a window actually received (the key events, decoded with the
//! keymap the server had when they arrived), never what the code says it sent.
//! Where Xvfb isn't installed, the tests print why and pass without checking anything.
//! The tests never use the desktop the developer is logged into: they always start their own
//! Xvfb and point `DISPLAY` at it for this process.
#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, InputFocus, KeyButMask, PropMode, Window, WindowClass, BUTTON_PRESS_EVENT,
    BUTTON_RELEASE_EVENT, KEY_PRESS_EVENT, KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::protocol::Event as XEvent;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use typewriter_native::xtyper::{self, XTyper};
use typewriter_native::{check_support, spawn_session, Command as SessionCommand, Config, Desktop, Event, KeyAction, RealDesktop, Translator, Update, VirtualField};

const XK_SHIFT_L: u32 = 0xffe1;
const XK_CAPS_LOCK: u32 = 0xffe5;
const XK_RETURN: u32 = 0xff0d;
const XK_TAB: u32 = 0xff09;
const XK_BACKSPACE: u32 = 0xff08;
const XK_LEFT: u32 = 0xff51;
const XK_RIGHT: u32 = 0xff53;
/// A keysym nothing in these tests types (XF86Launch0), used to occupy spare key codes.
const XK_FILLER: u32 = 0x1008_ff40;
/// Long enough for any key event to reach the window on a local Xvfb.
const ARRIVE: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// The X server
// ---------------------------------------------------------------------------

/// An Xvfb of our own. `-terminate` ends it when its last client disconnects; `keeper` is a
/// client that lives as long as this value (for the shared server: as long as the test
/// process), so the server can't exit between tests and never outlives the tests.
struct Xvfb {
    display: String,
    child: Child,
    _keeper: RustConnection,
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_xvfb(extra: &[&str]) -> Result<Xvfb, String> {
    // -displayfd: the server picks a free display number itself and writes it to our pipe.
    let mut child = Command::new("Xvfb")
        .args(["-displayfd", "1", "-nolisten", "tcp", "-terminate", "-screen", "0", "1280x800x24"])
        .args(extra)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Xvfb can't be started ({e})"))?;
    let out = child.stdout.take().expect("Xvfb stdout");
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(out).read_line(&mut line);
        let _ = tx.send(line);
    });
    let n = match rx.recv_timeout(Duration::from_secs(15)).ok().and_then(|l| l.trim().parse::<u32>().ok()) {
        Some(n) => n,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Xvfb didn't report a display number".into());
        }
    };
    let display = format!(":{n}");
    let t0 = Instant::now();
    loop {
        match x11rb::connect(Some(&display)) {
            Ok((keeper, _)) => return Ok(Xvfb { display, child, _keeper: keeper }),
            Err(e) if t0.elapsed() > Duration::from_secs(10) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("can't connect to Xvfb on {display} ({e})"));
            }
            Err(_) => thread::sleep(Duration::from_millis(20)),
        }
    }
}

static SERVER: OnceLock<Option<Xvfb>> = OnceLock::new();
/// The tests share one display, keyboard and keymap, so they run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

/// The shared Xvfb (started on first use, with `DISPLAY` pointing at it), or None (after
/// printing why) when it can't run here. Hold the returned guard for the whole test.
fn x11(test: &str) -> Option<(MutexGuard<'static, ()>, &'static str)> {
    let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let server = SERVER.get_or_init(|| match start_xvfb(&[]) {
        Ok(s) => {
            // Everything in the crate connects to `DISPLAY`; make sure it's ours, and that
            // nothing in the environment makes the session look like Wayland.
            std::env::set_var("DISPLAY", &s.display);
            std::env::remove_var("WAYLAND_DISPLAY");
            std::env::set_var("XDG_SESSION_TYPE", "x11");
            Some(s)
        }
        Err(e) => {
            eprintln!("note: {e}");
            None
        }
    });
    match server {
        Some(s) => {
            let ctl = Ctl::new(&s.display);
            ctl.reset();
            Some((guard, s.display.as_str()))
        }
        None => {
            eprintln!("skipping {test}: needs Xvfb (a real X server), which isn't available here");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Driving the server from the test (the "user" and the window manager)
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Eq)]
struct Keymap {
    min: u8,
    per: usize,
    syms: Vec<u32>,
}

impl Keymap {
    fn read(conn: &RustConnection) -> Keymap {
        let (min, max) = (conn.setup().min_keycode, conn.setup().max_keycode);
        let r = conn.get_keyboard_mapping(min, max - min + 1).unwrap().reply().unwrap();
        Keymap { min, per: r.keysyms_per_keycode as usize, syms: r.keysyms }
    }
    fn row(&self, kc: u8) -> &[u32] {
        let i = (kc - self.min) as usize * self.per;
        self.syms.get(i..i + self.per).unwrap_or(&[])
    }
    fn rows(&self) -> impl Iterator<Item = (u8, &[u32])> {
        self.syms.chunks(self.per).enumerate().map(|(i, r)| (self.min + i as u8, r))
    }
    /// The key code with `ks` on its first or second level (where the typer looks).
    fn code_for(&self, ks: u32) -> Option<u8> {
        self.rows().find(|(_, r)| r.iter().take(2).any(|&s| s == ks)).map(|(kc, _)| kc)
    }
    fn on_layout(&self, c: char) -> bool {
        self.code_for(xtyper::keysym_for(c)).is_some()
    }
    fn spare(&self) -> Vec<u8> {
        self.rows().filter(|(_, r)| r.iter().all(|&s| s == 0)).map(|(kc, _)| kc).collect()
    }
}

/// The test's own connection, for what a user or window manager would do.
struct Ctl {
    conn: RustConnection,
    root: Window,
}

impl Ctl {
    fn new(display: &str) -> Ctl {
        let (conn, screen) = x11rb::connect(Some(display)).expect("connect to Xvfb");
        let root = conn.setup().roots[screen].root;
        Ctl { conn, root }
    }
    fn atom(&self, name: &str) -> Atom {
        self.conn.intern_atom(false, name.as_bytes()).unwrap().reply().unwrap().atom
    }
    fn keymap(&self) -> Keymap {
        Keymap::read(&self.conn)
    }
    fn set_row(&self, kc: u8, per: usize, ks: &[u32]) {
        let mut row = vec![0; per];
        row[..ks.len()].copy_from_slice(ks);
        self.conn.change_keyboard_mapping(1, kc, per as u8, &row).unwrap();
        self.conn.sync().unwrap();
    }
    /// Sets the EWMH "active window" (what a window manager does on focus) and gives the
    /// window the X input focus, where key events go.
    fn activate(&self, w: Window) {
        let active = self.atom("_NET_ACTIVE_WINDOW");
        self.conn.change_property32(PropMode::REPLACE, self.root, active, AtomEnum::WINDOW, &[w]).unwrap();
        if w != 0 {
            self.conn.set_input_focus(InputFocus::PARENT, w, x11rb::CURRENT_TIME).unwrap();
        }
        self.conn.sync().unwrap();
    }
    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) {
        self.conn.xtest_fake_input(kind, detail, x11rb::CURRENT_TIME, self.root, x, y, 0).unwrap();
        self.conn.sync().unwrap();
        // The desktop caches pointer queries for 5 ms.
        thread::sleep(Duration::from_millis(15));
    }
    fn key(&self, kind: u8, ks: u32) {
        let kc = self.keymap().code_for(ks).expect("key on the layout");
        self.fake(kind, kc, 0, 0);
    }
    fn tap(&self, ks: u32) {
        self.key(KEY_PRESS_EVENT, ks);
        self.key(KEY_RELEASE_EVENT, ks);
    }
    fn mask(&self) -> KeyButMask {
        self.conn.query_pointer(self.root).unwrap().reply().unwrap().mask
    }
    fn caps_lock_on(&self) -> bool {
        self.mask().contains(KeyButMask::LOCK)
    }
    fn move_pointer(&self, x: i16, y: i16) {
        self.fake(MOTION_NOTIFY_EVENT, 0, x, y);
    }
    /// A neutral starting point for each test: no lock, keys and buttons up, pointer centred.
    fn reset(&self) {
        if self.caps_lock_on() {
            self.tap(XK_CAPS_LOCK);
        }
        self.move_pointer(640, 400);
        self.activate(0);
    }
}

// ---------------------------------------------------------------------------
// A window that records what it receives
// ---------------------------------------------------------------------------

/// What the window received, applied like a text field applies keys.
#[derive(Default)]
struct Field {
    text: Vec<char>,
    caret: usize,
    /// Keysyms that are neither text nor one of the editing keys.
    unknown: Vec<u32>,
    presses: usize,
}

impl Field {
    fn apply(&mut self, ks: u32) {
        let insert = |f: &mut Field, c: char| {
            f.text.insert(f.caret, c);
            f.caret += 1;
        };
        match ks {
            XK_RETURN => insert(self, '\n'),
            XK_TAB => insert(self, '\t'),
            XK_BACKSPACE => {
                if self.caret > 0 {
                    self.caret -= 1;
                    self.text.remove(self.caret);
                }
            }
            XK_LEFT => self.caret = self.caret.saturating_sub(1),
            XK_RIGHT => self.caret = (self.caret + 1).min(self.text.len()),
            0xffe1..=0xffee => {} // Shift, Control, Caps Lock, Alt, Super: no text.
            0x20..=0x7e | 0xa0..=0xff => insert(self, char::from_u32(ks).unwrap()),
            k if k & 0xff00_0000 == 0x0100_0000 => match char::from_u32(k & 0x00ff_ffff) {
                Some(c) => insert(self, c),
                None => self.unknown.push(k),
            },
            k => self.unknown.push(k),
        }
    }
}

/// The symbol a key press produces under X's core rules: Shift picks the second level,
/// Caps Lock turns a lowercase letter into a capital.
fn keysym(map: &Keymap, kc: u8, state: KeyButMask) -> u32 {
    let row = map.row(kc);
    let first = row.first().copied().unwrap_or(0);
    let mut ks = if state.contains(KeyButMask::SHIFT) && row.len() > 1 && row[1] != 0 { row[1] } else { first };
    if state.contains(KeyButMask::LOCK) {
        if let Some(c) = char::from_u32(ks).filter(|c| c.is_ascii_lowercase()) {
            ks = c.to_ascii_uppercase() as u32;
        }
    }
    ks
}

struct Target {
    win: Window,
    field: Arc<Mutex<Field>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Target {
    /// Opens a mapped window with EWMH/ICCCM properties like a real app's. `pid` and `class`
    /// may be left out, to look like windows that don't set them.
    fn open(display: &str, pid: Option<u32>, class: Option<&str>, title: &str) -> Target {
        let (conn, screen) = x11rb::connect(Some(display)).expect("connect to Xvfb");
        let s = &conn.setup().roots[screen];
        let win = conn.generate_id().unwrap();
        let aux = CreateWindowAux::new()
            .background_pixel(s.white_pixel)
            .event_mask(EventMask::KEY_PRESS | EventMask::KEY_RELEASE | EventMask::STRUCTURE_NOTIFY);
        conn.create_window(s.root_depth, win, s.root, 100, 100, 400, 300, 0, WindowClass::INPUT_OUTPUT, s.root_visual, &aux).unwrap();
        let atom = |n: &str| conn.intern_atom(false, n.as_bytes()).unwrap().reply().unwrap().atom;
        if let Some(pid) = pid {
            conn.change_property32(PropMode::REPLACE, win, atom("_NET_WM_PID"), AtomEnum::CARDINAL, &[pid]).unwrap();
        }
        if let Some(class) = class {
            let v = format!("{}\0{class}\0", class.to_lowercase());
            conn.change_property8(PropMode::REPLACE, win, AtomEnum::WM_CLASS, AtomEnum::STRING, v.as_bytes()).unwrap();
        }
        conn.change_property8(PropMode::REPLACE, win, atom("_NET_WM_NAME"), atom("UTF8_STRING"), title.as_bytes()).unwrap();
        conn.map_window(win).unwrap();
        conn.flush().unwrap();
        // Wait until it's viewable (only then can it take the input focus).
        loop {
            if let XEvent::MapNotify(_) = conn.wait_for_event().unwrap() {
                break;
            }
        }
        let field = Arc::new(Mutex::new(Field::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (f, st) = (field.clone(), stop.clone());
        let thread = thread::spawn(move || {
            let mut map = Keymap::read(&conn);
            while !st.load(Ordering::SeqCst) {
                match conn.poll_for_event() {
                    Ok(Some(XEvent::KeyPress(e))) => {
                        let ks = keysym(&map, e.detail, e.state);
                        let mut f = f.lock().unwrap();
                        f.presses += 1;
                        f.apply(ks);
                    }
                    // Sent to every client when the keymap changes; the events after it use the new one.
                    Ok(Some(XEvent::MappingNotify(_))) => map = Keymap::read(&conn),
                    Ok(Some(_)) => {}
                    Ok(None) => thread::sleep(Duration::from_millis(1)),
                    Err(_) => break,
                }
            }
        });
        Target { win, field, stop, thread: Some(thread) }
    }

    fn text(&self) -> String {
        self.field.lock().unwrap().text.iter().collect()
    }

    /// Waits until the window holds `expected` (or the time runs out), then returns what it holds.
    fn wait_for(&self, expected: &str) -> String {
        let t0 = Instant::now();
        while self.text() != expected && t0.elapsed() < ARRIVE {
            thread::sleep(Duration::from_millis(5));
        }
        // Nothing more may arrive after it.
        thread::sleep(Duration::from_millis(50));
        self.text()
    }

    fn unknown(&self) -> Vec<u32> {
        self.field.lock().unwrap().unknown.clone()
    }

    fn presses(&self) -> usize {
        self.field.lock().unwrap().presses
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn type_str(t: &mut XTyper, s: &str) {
    for c in s.chars() {
        t.send(&KeyAction::Text(c.to_string())).expect("send");
    }
}

/// Fills spare key codes with a filler symbol until only `leave` are spare; returns the codes filled.
fn fill_spare(ctl: &Ctl, leave: usize) -> Vec<u8> {
    let map = ctl.keymap();
    let spare = map.spare();
    assert!(spare.len() >= leave + 2, "the default keymap has spare key codes");
    let filled: Vec<u8> = spare[..spare.len() - leave].to_vec();
    for &kc in &filled {
        ctl.set_row(kc, map.per, &[XK_FILLER, XK_FILLER]);
    }
    filled
}

fn unfill(ctl: &Ctl, filled: &[u8]) {
    let per = ctl.keymap().per;
    for &kc in filled {
        ctl.set_row(kc, per, &[]);
    }
}

// ---------------------------------------------------------------------------
// xtyper: the XTest key sender
// ---------------------------------------------------------------------------

#[test]
fn xtyper_types_layout_characters_and_editing_keys_exactly() {
    let Some((_x, display)) = x11("xtyper_types_layout_characters_and_editing_keys_exactly") else { return };
    let ctl = Ctl::new(display);
    let target = Target::open(display, Some(4242), Some("Editor"), "Notes");
    ctl.activate(target.win);
    let before = ctl.keymap();

    let mut t = XTyper::connect(&|| false).expect("connect");
    let text = "Hello, World! ~{}|<>?:\"_+ 0123456789 `-=[]\\;',./";
    type_str(&mut t, text);
    t.send(&KeyAction::Enter).unwrap();
    t.send(&KeyAction::Tab).unwrap();
    // "ac", back over "c", insert "b", forward past "c", then "d" and a typo removed.
    type_str(&mut t, "ac");
    t.send(&KeyAction::Left).unwrap();
    type_str(&mut t, "b");
    t.send(&KeyAction::Right).unwrap();
    type_str(&mut t, "dx");
    t.send(&KeyAction::Backspace).unwrap();

    let expected = format!("{text}\n\tabcd");
    assert_eq!(target.wait_for(&expected), expected);
    assert!(target.unknown().is_empty(), "only text and editing keys arrive: {:x?}", target.unknown());
    // Characters on the layout use their own keys: the keymap was never touched.
    assert!(ctl.keymap() == before, "typing layout characters must not change the keymap");
    drop(t);
    assert!(ctl.keymap() == before);
}

#[test]
fn xtyper_binds_characters_missing_from_the_layout_up_front_and_restores_the_keymap() {
    let Some((_x, display)) = x11("xtyper_binds_characters_missing_from_the_layout_up_front_and_restores_the_keymap") else { return };
    let ctl = Ctl::new(display);
    let target = Target::open(display, Some(4242), Some("Editor"), "Notes");
    ctl.activate(target.win);
    let before = ctl.keymap();
    let chars = ['a', 'é', '日', '\n', 'é', '🎉', '—', '\t', 'Z', 'ß'];
    let missing: Vec<char> = {
        let mut m = Vec::new();
        for &c in &chars {
            if !c.is_control() && !before.on_layout(c) && !m.contains(&c) {
                m.push(c);
            }
        }
        m
    };
    assert!(missing.len() >= 3, "日, 🎉 and — are never on the default layout");

    let mut t = XTyper::connect(&|| false).expect("connect");
    // Cancelled before it starts: nothing is bound.
    let mut calls = 0;
    t.prebind(&chars, &|| true, &mut |_, _| calls += 1);
    assert_eq!(calls, 0);
    assert!(ctl.keymap() == before);

    let mut progress = Vec::new();
    t.prebind(&chars, &|| false, &mut |done, of| progress.push((done, of)));
    let n = missing.len();
    assert_eq!(progress, (1..=n).map(|i| (i, n)).collect::<Vec<_>>(), "one step per character missing from the layout");
    let bound = ctl.keymap();
    for &c in &missing {
        let ks = xtyper::keysym_for(c);
        let kc = bound.code_for(ks).unwrap_or_else(|| panic!("{c:?} is bound after preparing"));
        assert_eq!(&bound.row(kc)[..2], &[ks, ks], "both levels hold the symbol, so Shift can't change it");
        assert!(before.row(kc).iter().all(|&s| s == 0), "only a spare key code is used");
    }
    // Line breaks and tabs are keys of their own, never bound as symbols.
    assert!(bound.code_for(xtyper::keysym_for('\n')).is_none() || before.code_for(xtyper::keysym_for('\n')).is_some());

    let text: String = chars.iter().collect();
    for c in chars {
        match c {
            '\n' => t.send(&KeyAction::Enter).unwrap(),
            '\t' => t.send(&KeyAction::Tab).unwrap(),
            c => t.send(&KeyAction::Text(c.to_string())).unwrap(),
        }
    }
    assert_eq!(target.wait_for(&text), text);
    assert!(ctl.keymap() == bound, "everything was bound up front: typing didn't remap anything");
    // A grapheme made of several characters goes out as one action, character by character.
    t.send(&KeyAction::Text("e\u{301}".into())).unwrap();
    let text = format!("{text}e\u{301}");
    assert_eq!(target.wait_for(&text), text);
    drop(t);
    assert!(ctl.keymap() == before, "the keymap is exactly as it was once the typer is gone");
}

#[test]
fn xtyper_reuses_its_only_spare_key_code_and_reports_when_there_is_none() {
    let Some((_x, display)) = x11("xtyper_reuses_its_only_spare_key_code_and_reports_when_there_is_none") else { return };
    let ctl = Ctl::new(display);
    let original = ctl.keymap();
    let target = Target::open(display, Some(4242), Some("Editor"), "Notes");
    ctl.activate(target.win);

    // Three spare codes: two are left for other programs, one is ours.
    let filled = fill_spare(&ctl, 3);
    let tight = ctl.keymap();
    let mut t = XTyper::connect(&|| false).expect("connect");
    let mut progress = Vec::new();
    t.prebind(&['日', '本', '語'], &|| false, &mut |d, o| progress.push((d, o)));
    assert_eq!(progress, vec![(1, 1)], "only as many as there are spare codes are bound up front");
    let t0 = Instant::now();
    // 日 is bound already; 本 and 語 each take over the same code once the previous key had time to arrive.
    type_str(&mut t, "日本語日");
    assert!(t0.elapsed() >= Duration::from_millis(500), "a code is rebound only after it has been idle a while");
    assert_eq!(target.wait_for("日本語日"), "日本語日");
    let after = ctl.keymap();
    assert_eq!(after.rows().filter(|(kc, r)| *r != tight.row(*kc)).count(), 1, "one key code was used for all of them");
    drop(t);
    assert!(ctl.keymap() == tight);

    // No spare code at all: layout characters still work, others fail with a reason.
    let rest = fill_spare(&ctl, 0);
    let full = ctl.keymap();
    let mut t = XTyper::connect(&|| false).expect("connect");
    let mut calls = 0;
    t.prebind(&['日'], &|| false, &mut |_, _| calls += 1);
    assert_eq!(calls, 0);
    type_str(&mut t, "ok");
    let err = t.send(&KeyAction::Text("日".into())).unwrap_err();
    assert!(err.contains("no free key code"), "{err}");
    assert_eq!(target.wait_for("日本語日ok"), "日本語日ok");
    drop(t);
    assert!(ctl.keymap() == full);

    unfill(&ctl, &rest);
    unfill(&ctl, &filled);
    assert!(ctl.keymap() == original, "the test left the keymap as it found it");
}

#[test]
fn caps_lock_does_not_change_the_case_of_typed_letters() {
    let Some((_x, display)) = x11("caps_lock_does_not_change_the_case_of_typed_letters") else { return };
    let ctl = Ctl::new(display);
    let target = Target::open(display, Some(4242), Some("Editor"), "Notes");
    ctl.activate(target.win);
    ctl.tap(XK_CAPS_LOCK);
    assert!(ctl.caps_lock_on());

    let mut t = XTyper::connect(&|| false).expect("connect");
    type_str(&mut t, "aB1 é日z");
    assert_eq!(target.wait_for("aB1 é日z"), "aB1 é日z");
    assert!(ctl.caps_lock_on(), "Caps Lock is back on after each letter");
    drop(t);
    ctl.tap(XK_CAPS_LOCK);
    assert!(!ctl.caps_lock_on());
}

#[test]
fn without_a_shift_key_capitals_are_bound_to_a_spare_code() {
    let Some((_x, display)) = x11("without_a_shift_key_capitals_are_bound_to_a_spare_code") else { return };
    let ctl = Ctl::new(display);
    let original = ctl.keymap();
    let target = Target::open(display, Some(4242), Some("Editor"), "Notes");
    ctl.activate(target.win);
    let shift: Vec<(u8, Vec<u32>)> = original.rows().filter(|(_, r)| r.first() == Some(&XK_SHIFT_L)).map(|(kc, r)| (kc, r.to_vec())).collect();
    assert!(!shift.is_empty());
    for (kc, _) in &shift {
        ctl.set_row(*kc, original.per, &[XK_FILLER]);
    }

    let mut t = XTyper::connect(&|| false).expect("connect");
    type_str(&mut t, "aA!");
    assert_eq!(target.wait_for("aA!"), "aA!");
    let a = xtyper::keysym_for('A');
    let bound = ctl.keymap();
    let kc = bound.rows().find(|(kc, r)| r.first() == Some(&a) && original.row(*kc).iter().all(|&s| s == 0)).map(|(kc, _)| kc);
    assert!(kc.is_some(), "the capital got a spare key code of its own");
    drop(t);

    for (kc, row) in &shift {
        ctl.conn.change_keyboard_mapping(1, *kc, original.per as u8, row).unwrap();
        ctl.conn.sync().unwrap();
    }
    assert!(ctl.keymap() == original, "the test left the keymap as it found it");
}

#[test]
fn a_second_typer_waits_for_the_first_and_can_give_up() {
    let Some((_x, _display)) = x11("a_second_typer_waits_for_the_first_and_can_give_up") else { return };
    let first = XTyper::connect(&|| false).expect("connect");
    match XTyper::connect(&|| true) {
        Err(e) => assert_eq!(e, xtyper::CANCELLED),
        Ok(_) => panic!("a second typer must wait for the first"),
    }
    let t0 = Instant::now();
    let deadline = t0 + Duration::from_millis(150);
    assert!(XTyper::connect(&|| Instant::now() >= deadline).is_err());
    assert!(t0.elapsed() >= Duration::from_millis(150), "it waited until told to give up");
    drop(first);
    assert!(XTyper::connect(&|| true).is_ok(), "free again once the first typer is gone");
}

#[test]
fn a_display_that_is_missing_or_has_no_xtest_is_reported() {
    let Some((_x, display)) = x11("a_display_that_is_missing_or_has_no_xtest_is_reported") else { return };
    let saved = display.to_string();
    let restore = |d: &str| std::env::set_var("DISPLAY", d);

    // A display nobody serves.
    let free = (5000..6000).find(|n| !std::path::Path::new(&format!("/tmp/.X11-unix/X{n}")).exists()).unwrap();
    std::env::set_var("DISPLAY", format!(":{free}"));
    let probe = xtyper::probe();
    let connect = XTyper::connect(&|| false).err();
    let support = check_support(false);
    let desktop = RealDesktop::new(&|| false).err();
    restore(&saved);
    assert!(probe.unwrap_err().contains("can't connect to the X11 display"));
    assert!(connect.is_some());
    assert!(!support.available);
    assert_eq!(support.state, "unsupported");
    assert_eq!(support.platform, "linux");
    assert!(support.message.starts_with("Keyboard input isn't available"), "{}", support.message);
    assert_eq!(desktop.map(|s| s.state), Some("unsupported".into()));

    // An X server without the XTest extension.
    let bare = match start_xvfb(&["-extension", "XTEST"]) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("skipping the no-XTest part: {e}");
            return;
        }
    };
    std::env::set_var("DISPLAY", &bare.display);
    let probe = xtyper::probe();
    let connect = XTyper::connect(&|| false).err();
    let support = check_support(false);
    let spawned = spawn_session(Config { events: vec![], countdown_ms: 0, resume_countdown_ms: 0, own_pid: 0, prepare_timeout_ms: 100, wait_timeout_ms: 100 }, emitter(mpsc::channel().0), Box::new(|_: &str| {})).err();
    restore(&saved);
    drop(bare);
    // x11rb fails the request itself ("Unsupported extension"); the user gets the plain reason.
    assert_eq!(probe.unwrap_err(), "the X server has no XTest extension.");
    assert_eq!(connect.as_deref(), Some("The X server has no XTest extension."));
    assert!(!support.available);
    assert_eq!(support.state, "unsupported");
    assert!(support.message.starts_with("Keyboard input isn't available"), "{}", support.message);
    assert!(support.message.contains("no XTest extension"), "{}", support.message);
    assert_eq!(spawned.map(|s| s.state), Some("unsupported".into()));
    // And the shared display works as before.
    assert!(check_support(false).available);
}

// ---------------------------------------------------------------------------
// RealDesktop
// ---------------------------------------------------------------------------

#[test]
fn the_focused_window_is_read_from_the_window_managers_properties() {
    let Some((_x, display)) = x11("the_focused_window_is_read_from_the_window_managers_properties") else { return };
    let ctl = Ctl::new(display);
    assert!(check_support(false).available);
    let mut d = RealDesktop::new(&|| false).expect("desktop");

    // No active window (as before a window manager has picked one).
    ctl.activate(0);
    assert_eq!(d.focused_window(), None);
    let active = ctl.atom("_NET_ACTIVE_WINDOW");
    ctl.conn.delete_property(ctl.root, active).unwrap();
    ctl.conn.sync().unwrap();
    assert_eq!(d.focused_window(), None, "no window manager at all");

    let app = Target::open(display, Some(4242), Some("Google-chrome"), "Essay – Docs");
    ctl.activate(app.win);
    let w = d.focused_window().expect("focused window");
    assert_eq!(w.window_id, app.win.to_string());
    assert_eq!(w.process_id, 4242);
    assert_eq!(w.app_name, "Google-chrome", "the class part of WM_CLASS names the app");
    assert_eq!(w.title, "Essay – Docs");
    assert!(w.is_browser());

    // A window without a pid, a class or an EWMH title, but with the old WM_NAME.
    let bare = Target::open(display, None, None, "");
    ctl.conn.change_property8(PropMode::REPLACE, bare.win, AtomEnum::WM_NAME, AtomEnum::STRING, b"xterm").unwrap();
    ctl.activate(bare.win);
    let w = d.focused_window().expect("focused window");
    assert_eq!((w.process_id, w.app_name.as_str(), w.title.as_str()), (0, "", "xterm"));
    // Nothing at all to go by.
    ctl.conn.delete_property(bare.win, AtomEnum::WM_NAME.into()).unwrap();
    ctl.conn.sync().unwrap();
    let w = d.focused_window().expect("focused window");
    assert_eq!((w.window_id, w.title), (bare.win.to_string(), String::new()));

    // X11 can't tell password fields or describe focus further; nothing is reported.
    assert_eq!(d.sensitive_focus(), None);
    assert_eq!(d.focus_detail(), None);
    assert!(d.held_modifiers().is_empty());
}

#[test]
fn held_modifiers_mouse_buttons_and_the_failsafe_corner_are_seen() {
    let Some((_x, display)) = x11("held_modifiers_mouse_buttons_and_the_failsafe_corner_are_seen") else { return };
    let ctl = Ctl::new(display);
    let mut d = RealDesktop::new(&|| false).expect("desktop");
    assert!(!d.modifiers_held());
    assert!(!d.mouse_down());
    assert!(!d.failsafe_triggered());

    for ks in [XK_SHIFT_L, 0xffe3 /* Control_L */, 0xffe9 /* Alt_L */, 0xffeb /* Super_L */] {
        ctl.key(KEY_PRESS_EVENT, ks);
        assert!(d.modifiers_held(), "{ks:#x} held");
        ctl.key(KEY_RELEASE_EVENT, ks);
        assert!(!d.modifiers_held(), "{ks:#x} released");
    }
    // Caps Lock is a lock, not a held modifier.
    ctl.tap(XK_CAPS_LOCK);
    assert!(!d.modifiers_held());
    ctl.tap(XK_CAPS_LOCK);

    for button in [1, 3] {
        ctl.fake(BUTTON_PRESS_EVENT, button, 0, 0);
        assert!(d.mouse_down(), "button {button} down");
        ctl.fake(BUTTON_RELEASE_EVENT, button, 0, 0);
        assert!(!d.mouse_down(), "button {button} up");
    }
    // The middle button isn't a click into the document.
    ctl.fake(BUTTON_PRESS_EVENT, 2, 0, 0);
    assert!(!d.mouse_down());
    ctl.fake(BUTTON_RELEASE_EVENT, 2, 0, 0);

    ctl.move_pointer(0, 0);
    assert!(d.failsafe_triggered());
    ctl.move_pointer(1, 1);
    assert!(d.failsafe_triggered());
    ctl.move_pointer(2, 0);
    assert!(!d.failsafe_triggered());
    ctl.move_pointer(640, 400);
    assert!(!d.failsafe_triggered());
    // Back-to-back checks share one pointer query.
    assert_eq!((d.modifiers_held(), d.mouse_down(), d.failsafe_triggered()), (false, false, false));
}

#[test]
fn the_real_desktop_prepares_and_types_into_the_focused_window() {
    let Some((_x, display)) = x11("the_real_desktop_prepares_and_types_into_the_focused_window") else { return };
    let ctl = Ctl::new(display);
    let target = Target::open(display, Some(4242), Some("Editor"), "Notes");
    ctl.activate(target.win);
    let before = ctl.keymap();
    let mut d = RealDesktop::new(&|| false).expect("desktop");
    let chars = ['H', 'i', '✓', '\n', 'ø'];
    let mut progress = Vec::new();
    d.prepare(&chars, &|| false, &mut |done, of| progress.push((done, of)));
    let missing = chars.iter().filter(|c| !c.is_control() && !before.on_layout(**c)).count();
    assert_eq!(progress.last(), Some(&(missing, missing)));
    for a in [KeyAction::Text("H".into()), KeyAction::Text("i".into()), KeyAction::Text("✓".into()), KeyAction::Enter, KeyAction::Text("ø".into()), KeyAction::Tab, KeyAction::Text("x".into()), KeyAction::Left, KeyAction::Backspace, KeyAction::Right] {
        d.send(&a).expect("send");
    }
    assert_eq!(target.wait_for("Hi✓\nøx"), "Hi✓\nøx");
    assert!(target.unknown().is_empty());
    drop(d);
    assert!(ctl.keymap() == before);
}

// ---------------------------------------------------------------------------
// spawn_session: a whole session into a real window
// ---------------------------------------------------------------------------

/// The status sink every session here uses (one closure type, so one instantiation of `spawn_session`).
fn emitter(tx: mpsc::Sender<Update>) -> impl FnMut(Update) + Send + 'static {
    move |u| drop(tx.send(u))
}

fn timeline() -> Vec<Event> {
    let mut at = 0.0;
    let mut next = || {
        at += 4.0;
        at
    };
    let mut ev = Vec::new();
    let ty = |at: f64, s: &str| Event::Type { at, text: s.into() };
    for s in ["t", "e", "h"] {
        ev.push(ty(next(), s));
    }
    ev.push(Event::Replace { at: next(), start: 0, end: 3, replacement: vec!["t".into(), "h".into(), "e".into()] });
    for s in [" ", "é", "日", "🎉", "\n", "\t", "A", "x"] {
        ev.push(ty(next(), s));
    }
    ev.push(Event::Backspace { at: next() });
    ev.push(Event::Caret { at: next(), to: 0 });
    ev.push(ty(next(), "¡"));
    ev.push(Event::Caret { at: next(), to: 99 });
    ev.push(ty(next(), "!"));
    ev.push(Event::Wait { at: next() });
    ev
}

#[test]
fn a_session_types_a_timeline_into_a_real_window_exactly() {
    let Some((_x, display)) = x11("a_session_types_a_timeline_into_a_real_window_exactly") else { return };
    let ctl = Ctl::new(display);
    let own_pid = std::process::id();
    let own = Target::open(display, Some(own_pid), Some("Typewriter"), "Typewriter");
    let target = Target::open(display, Some(4242), Some("Editor"), "Draft");
    ctl.activate(own.win);
    let before = ctl.keymap();

    let events = timeline();
    let expected = {
        let (mut tr, mut f) = (Translator::new(), VirtualField::default());
        events.iter().flat_map(|e| tr.actions(e)).for_each(|a| f.apply(&a));
        f.text()
    };
    assert_eq!(expected, "¡the é日🎉\n\tA!");

    let (tx, rx) = mpsc::channel::<Update>();
    let diag = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = diag.clone();
    let cfg = Config { events, countdown_ms: 100, resume_countdown_ms: 100, own_pid: own_pid as u64, prepare_timeout_ms: 5000, wait_timeout_ms: 10_000 };
    let (_control, handle) = spawn_session(cfg, emitter(tx), Box::new(move |l: &str| sink.lock().unwrap().push(l.to_string()))).expect("session starts");

    // Typewriter has focus: the session waits. Then the user clicks into the document.
    let mut updates = Vec::new();
    loop {
        let u = rx.recv_timeout(Duration::from_secs(10)).expect("an update while waiting");
        let waiting = u.phase == "waiting";
        updates.push(u);
        if waiting {
            break;
        }
    }
    assert_eq!(own.presses(), 0, "nothing is typed while Typewriter has focus");
    // Focus moving to the document at once, without a click, is the system handing it over when
    // Typewriter minimizes: the countdown waits for the click.
    ctl.activate(target.win);
    loop {
        let u = rx.recv_timeout(Duration::from_secs(10)).expect("an update after focus moved");
        let asks = u.reason.as_deref() == Some("click-to-start");
        updates.push(u);
        if asks {
            break;
        }
    }
    thread::sleep(Duration::from_millis(300));
    assert!(target.presses() == 0 && !updates.iter().any(|u| u.phase == "countdown"), "no countdown or key before the click");
    ctl.move_pointer(200, 200);
    ctl.fake(BUTTON_PRESS_EVENT, 1, 0, 0);
    ctl.fake(BUTTON_RELEASE_EVENT, 1, 0, 0);
    let result = handle.join().expect("session thread");
    updates.extend(rx.try_iter());

    assert_eq!(result, "completed");
    assert_eq!(target.wait_for(&expected), expected);
    assert!(target.unknown().is_empty());
    assert_eq!(own.presses(), 0, "Typewriter's own window never gets a key");
    let phases: Vec<&str> = updates.iter().map(|u| u.phase.as_str()).collect();
    assert_eq!(phases.first(), Some(&"preparing"));
    for p in ["waiting", "countdown", "typing"] {
        assert!(phases.contains(&p), "{p} in {phases:?}");
    }
    let last = updates.last().unwrap();
    assert_eq!(last.phase, "completed");
    let t = last.target.as_ref().expect("target");
    assert_eq!((t.window_id.clone(), t.process_id, t.app_name.as_str()), (target.win.to_string(), 4242, "Editor"));
    assert!(updates.iter().any(|u| u.phase == "preparing" && u.message.as_deref().is_some_and(|m| m.starts_with("Setting up"))), "it reported binding progress");
    // The keymap is restored by the time the session has ended.
    assert!(ctl.keymap() == before);
    let diag = diag.lock().unwrap();
    assert!(diag.iter().any(|l| l.contains("keyboard backend ready")));
    assert!(diag.iter().any(|l| l.contains("completed")));
    assert!(!diag.iter().any(|l| l.contains("Draft") || l.contains("日")), "the trail never has titles or text");
}

#[test]
fn a_session_fails_when_the_keyboard_is_not_ready_in_time() {
    let Some((_x, _display)) = x11("a_session_fails_when_the_keyboard_is_not_ready_in_time") else { return };
    // A previous session still holds the keymap.
    let previous = XTyper::connect(&|| false).expect("connect");
    let (tx, rx) = mpsc::channel::<Update>();
    let diag = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = diag.clone();
    let cfg = Config { events: timeline(), countdown_ms: 0, resume_countdown_ms: 0, own_pid: 1, prepare_timeout_ms: 300, wait_timeout_ms: 1000 };
    let t0 = Instant::now();
    let (_control, handle) = spawn_session(cfg, emitter(tx), Box::new(move |l: &str| sink.lock().unwrap().push(l.to_string()))).expect("session starts");
    assert_eq!(handle.join().unwrap(), "failed");
    assert!(t0.elapsed() >= Duration::from_millis(300));
    let updates: Vec<Update> = rx.try_iter().collect();
    assert_eq!(updates.first().map(|u| u.phase.as_str()), Some("preparing"));
    let last = updates.last().unwrap();
    assert_eq!((last.phase.as_str(), last.reason.as_deref()), ("failed", Some("prepare-timeout")));
    assert_eq!(last.message.as_deref(), Some(typewriter_native::prepare_timeout_message(300).as_str()));
    assert!(diag.lock().unwrap().iter().any(|l| l.contains("wasn't ready in time")));
    drop(previous);
}

#[test]
fn stop_ends_a_session_that_is_waiting_for_the_keyboard() {
    let Some((_x, _display)) = x11("stop_ends_a_session_that_is_waiting_for_the_keyboard") else { return };
    let previous = XTyper::connect(&|| false).expect("connect");
    let (tx, rx) = mpsc::channel::<Update>();
    let cfg = Config { events: timeline(), countdown_ms: 0, resume_countdown_ms: 0, own_pid: 1, prepare_timeout_ms: 10_000, wait_timeout_ms: 10_000 };
    let (control, handle) = spawn_session(cfg, emitter(tx), Box::new(|_: &str| {})).expect("session starts");
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap().phase, "preparing");
    thread::sleep(Duration::from_millis(100));
    let t0 = Instant::now();
    control.send(SessionCommand::Stop);
    assert_eq!(handle.join().unwrap(), "stopped");
    assert!(t0.elapsed() < Duration::from_secs(2), "Stop ends the wait at once");
    let last = rx.try_iter().last().expect("a final update");
    assert_eq!((last.phase.as_str(), last.reason.as_deref()), ("stopped", Some("user")));
    drop(previous);
}

/// Starts an Xvfb of its own, opens `open` on it, then kills the server.
fn opened_then_killed<T>(open: impl FnOnce() -> T) -> Option<T> {
    let mut doomed = match start_xvfb(&[]) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("skipping: {e}");
            return None;
        }
    };
    let saved = std::env::var("DISPLAY").expect("DISPLAY");
    std::env::set_var("DISPLAY", &doomed.display);
    let opened = open();
    std::env::set_var("DISPLAY", &saved);
    let _ = doomed.child.kill();
    let _ = doomed.child.wait();
    Some(opened)
}

#[test]
fn a_display_that_goes_away_gives_errors_instead_of_hanging() {
    let Some((_x, _display)) = x11("a_display_that_goes_away_gives_errors_instead_of_hanging") else { return };
    let t0 = Instant::now();
    let Some(typer) = opened_then_killed(|| XTyper::connect(&|| false)) else { return };
    let mut typer = typer.expect("connect");
    // Sends fail once the connection notices; none hangs or panics.
    let mut results = Vec::new();
    for a in [KeyAction::Text("a".into()), KeyAction::Text("b".into()), KeyAction::Text("c".into()), KeyAction::Text("日".into()), KeyAction::Enter] {
        results.push(typer.send(&a));
    }
    assert!(results.iter().filter(|r| r.is_err()).count() >= 4, "{results:?}");
    drop(typer);

    let Some(desktop) = opened_then_killed(|| RealDesktop::new(&|| false)) else { return };
    let mut desktop = desktop.expect("desktop");
    assert!(desktop.send(&KeyAction::Text("日".into())).is_err());
    assert_eq!(desktop.focused_window(), None);
    assert!(!desktop.modifiers_held());
    assert!(!desktop.mouse_down());
    assert!(!desktop.failsafe_triggered());
    drop(desktop);
    assert!(t0.elapsed() < Duration::from_secs(10), "giving up on a dead display is quick");
}

#[test]
fn a_display_lost_while_waiting_for_the_keyboard_fails_the_session_with_the_reason() {
    let Some((_x, display)) = x11("a_display_lost_while_waiting_for_the_keyboard_fails_the_session_with_the_reason") else { return };
    let saved = display.to_string();
    // A previous session still holds the keymap, so the new one waits for it...
    let previous = XTyper::connect(&|| false).expect("connect");
    let mut doomed = match start_xvfb(&[]) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("skipping: {e}");
            return;
        }
    };
    std::env::set_var("DISPLAY", &doomed.display);
    let (tx, rx) = mpsc::channel::<Update>();
    let diag = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = diag.clone();
    let cfg = Config { events: timeline(), countdown_ms: 0, resume_countdown_ms: 0, own_pid: 1, prepare_timeout_ms: 10_000, wait_timeout_ms: 1000 };
    let started = spawn_session(cfg, emitter(tx), Box::new(move |l: &str| sink.lock().unwrap().push(l.to_string())));
    let (_control, handle) = match started {
        Ok(s) => s,
        Err(s) => {
            std::env::set_var("DISPLAY", &saved);
            panic!("the session should start: {}", s.message);
        }
    };
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).map(|u| u.phase).ok().as_deref(), Some("preparing"));
    thread::sleep(Duration::from_millis(300));
    // ...and while it waits, the display goes away.
    let _ = doomed.child.kill();
    let _ = doomed.child.wait();
    drop(previous);
    let result = handle.join();
    std::env::set_var("DISPLAY", &saved);
    assert_eq!(result.expect("session thread"), "failed");
    let last = rx.try_iter().last().expect("a final update");
    eprintln!("final update: {:?} {:?} {:?}", last.phase, last.reason, last.message);
    assert_eq!((last.phase.as_str(), last.reason.as_deref()), ("failed", Some("unsupported")));
    assert!(last.message.unwrap().starts_with("Keyboard input isn't available"));
    assert!(diag.lock().unwrap().iter().any(|l| l.contains("failed to open the keyboard backend: unsupported")));
}
