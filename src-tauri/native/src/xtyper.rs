//! Fast, exact key output for X11 (Linux) using the XTest extension.
//!
//! enigo asks the X server to delay every press and release, which costs about
//! 20 ms per character on common servers. Here events are sent without delays:
//! - characters on the current layout use their own key (with Shift if needed),
//!   unless Caps Lock is on, which would flip the case of letters;
//! - anything else (emoji, CJK, symbols not on the layout) is bound to a spare
//!   key code, both levels set to the same symbol so Shift/Caps can't change it.
//!   A spare code is only rebound after it has been idle long enough that the
//!   target app has surely processed the previous key, and every binding is
//!   removed again when the typer is dropped.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, KeyButMask, Window, KEY_PRESS_EVENT, KEY_RELEASE_EVENT};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use crate::keys::KeyAction;

const XK_RETURN: u32 = 0xff0d;
const XK_TAB: u32 = 0xff09;
const XK_BACKSPACE: u32 = 0xff08;
const XK_LEFT: u32 = 0xff51;
const XK_RIGHT: u32 = 0xff53;
const XK_SHIFT_L: u32 = 0xffe1;
const XK_CAPS_LOCK: u32 = 0xffe5;
/// Spare key codes left alone for other programs that use the same technique.
const LEAVE_FREE: usize = 2;
/// A spare code is reused only after this long, so the target has seen the old binding's keys.
const REBIND_AFTER: Duration = Duration::from_millis(250);
/// After changing a binding, wait this long before pressing the key. Apps (Chromium,
/// for one) reload their copy of the keymap asynchronously after the change notice,
/// so a key pressed at once can still be read with the old symbol.
const SETTLE_AFTER_REMAP: Duration = Duration::from_millis(80);

/// Only one typer may change the keymap at a time. A new session must not even read
/// the keymap while the previous one is still removing its bindings, or it would
/// mistake those temporary bindings for real keys on the layout.
static KEYMAP: Mutex<()> = Mutex::new(());

pub struct XTyper {
    conn: RustConnection,
    root: Window,
    min_kc: u8,
    per: usize,
    syms: Vec<u32>,
    shift_kc: u8,
    spare: VecDeque<(u8, Option<Instant>)>,
    bound: HashMap<u32, u8>,
    last_used: HashMap<u8, Instant>,
    // Declared last: released only after Drop has restored the keymap.
    _keymap: MutexGuard<'static, ()>,
}

/// Keysym for a character: Latin-1 maps directly, everything else uses the Unicode keysym range.
pub fn keysym_for(c: char) -> u32 {
    let u = c as u32;
    if (0x20..=0x7e).contains(&u) || (0xa0..=0xff).contains(&u) {
        u
    } else {
        0x0100_0000 | u
    }
}

/// Whether keys can be sent on this display: an X11 connection with XTest.
pub fn probe() -> Result<(), String> {
    let (conn, _) = x11rb::connect(None).map_err(|e| format!("can't connect to the X11 display ({e})."))?;
    // x11rb refuses the request itself when the server lacks XTest, so both steps mean the same.
    conn.xtest_get_version(2, 2).ok().and_then(|c| c.reply().ok()).ok_or_else(|| "the X server has no XTest extension.".to_string())?;
    Ok(())
}

/// What `connect` returns when it gave up waiting for the keymap (Stop or the preparation time limit).
pub const CANCELLED: &str = "cancelled";

impl XTyper {
    /// Waits for any previous session to finish restoring the keymap, unless `cancelled()`
    /// turns true first (then fails with `CANCELLED`).
    pub fn connect(cancelled: &dyn Fn() -> bool) -> Result<Self, String> {
        let keymap = crate::platform::lock_unless(&KEYMAP, cancelled).ok_or(CANCELLED)?;
        let (conn, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
        conn.xtest_get_version(2, 2).ok().and_then(|c| c.reply().ok()).ok_or_else(|| "The X server has no XTest extension.".to_string())?;
        let root = conn.setup().roots[screen].root;
        let (min_kc, max_kc) = (conn.setup().min_keycode, conn.setup().max_keycode);
        let map = conn.get_keyboard_mapping(min_kc, max_kc - min_kc + 1).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
        let per = map.keysyms_per_keycode as usize;
        let syms = map.keysyms;
        let mut spare = VecDeque::new();
        let mut shift_kc = 0;
        for i in 0..=(max_kc - min_kc) as usize {
            let row = &syms[i * per..(i + 1) * per];
            let kc = min_kc + i as u8;
            if row.iter().all(|&s| s == 0) {
                spare.push_back((kc, None));
            }
            if shift_kc == 0 && row.first() == Some(&XK_SHIFT_L) {
                shift_kc = kc;
            }
        }
        // Leave a couple of codes for other tools; keep at least one for ourselves.
        // With none at all, keys on the layout still work; others fail with a message.
        let keep = spare.len().saturating_sub(LEAVE_FREE).max(spare.len().min(1));
        spare.truncate(keep);
        Ok(Self { conn, root, min_kc, per, syms, shift_kc, spare, bound: HashMap::new(), last_used: HashMap::new(), _keymap: keymap })
    }

    /// A full-width keymap row: `ks` on the first two levels, nothing elsewhere.
    /// Always the server's own width: some clients mis-merge narrower updates.
    fn row(&self, ks: u32) -> Vec<u32> {
        let mut r = vec![0; self.per.max(2)];
        r[0] = ks;
        r[1] = ks;
        r
    }

    /// (key code, needs shift) for a keysym already on the layout.
    fn lookup(&self, ks: u32) -> Option<(u8, bool)> {
        for level in 0..2.min(self.per) {
            for (i, row) in self.syms.chunks(self.per).enumerate() {
                if row[level] == ks {
                    return Some((self.min_kc + i as u8, level == 1));
                }
            }
        }
        None
    }

    fn caps_lock_on(&self) -> bool {
        self.conn.query_pointer(self.root).ok().and_then(|c| c.reply().ok()).map(|r| r.mask.contains(KeyButMask::LOCK)).unwrap_or(false)
    }

    fn fake(&self, kind: u8, kc: u8) -> Result<(), String> {
        self.conn.xtest_fake_input(kind, kc, 0, self.root, 0, 0, 0).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn tap(&mut self, kc: u8, shift: bool) -> Result<(), String> {
        if shift {
            self.fake(KEY_PRESS_EVENT, self.shift_kc)?;
        }
        self.fake(KEY_PRESS_EVENT, kc)?;
        self.fake(KEY_RELEASE_EVENT, kc)?;
        if shift {
            self.fake(KEY_RELEASE_EVENT, self.shift_kc)?;
        }
        self.conn.flush().map_err(|e| e.to_string())?;
        self.last_used.insert(kc, Instant::now());
        Ok(())
    }

    /// Binds up front the characters a session will need that aren't on the layout,
    /// as many as there are spare codes, so typing normally never remaps mid-session.
    /// One change at a time, each given time to settle: apps that see a burst of
    /// keymap changes can miss some of them.
    /// `progress(done, total)` is called after each binding.
    pub fn prebind(&mut self, chars: &[char], cancelled: &dyn Fn() -> bool, progress: &mut dyn FnMut(usize, usize)) {
        // Line breaks and tabs are sent as their own keys, never as symbols.
        let mut todo: Vec<u32> = Vec::new();
        for &c in chars {
            let ks = keysym_for(c);
            if !c.is_control() && self.lookup(ks).is_none() && !todo.contains(&ks) {
                todo.push(ks);
            }
        }
        todo.truncate(self.spare.len());
        for (i, &ks) in todo.iter().enumerate() {
            if cancelled() || self.bind(ks).is_err() {
                break;
            }
            progress(i + 1, todo.len());
        }
    }

    /// Binds `ks` to a spare key code (both levels), reusing the least recently used
    /// one, and waits for apps to pick up the change before the key is used.
    fn bind(&mut self, ks: u32) -> Result<u8, String> {
        if let Some(&kc) = self.bound.get(&ks) {
            return Ok(kc);
        }
        let kc = self.remap(ks)?;
        std::thread::sleep(SETTLE_AFTER_REMAP);
        Ok(kc)
    }

    fn remap(&mut self, ks: u32) -> Result<u8, String> {
        let (kc, _) = self.spare.pop_front().ok_or("there's no free key code for a character that isn't on the keyboard layout")?;
        if let Some(t) = self.last_used.get(&kc) {
            let idle = t.elapsed();
            if idle < REBIND_AFTER {
                std::thread::sleep(REBIND_AFTER - idle);
            }
        }
        self.bound.retain(|_, v| *v != kc);
        self.conn.change_keyboard_mapping(1, kc, self.per as u8, &self.row(ks)).map_err(|e| e.to_string())?;
        self.conn.sync().map_err(|e| e.to_string())?;
        self.bound.insert(ks, kc);
        self.spare.push_back((kc, None));
        Ok(kc)
    }

    fn type_keysym(&mut self, ks: u32, letter: bool) -> Result<(), String> {
        // Caps Lock would change the case of letters (X applies it even to spare
        // bindings), so switch it off around the letter and back on right after.
        let caps_kc = if letter && self.caps_lock_on() { self.lookup(XK_CAPS_LOCK).map(|(kc, _)| kc) } else { None };
        if let Some(c) = caps_kc {
            self.tap(c, false)?;
        }
        let r = match self.lookup(ks) {
            Some((kc, shift)) if !shift || self.shift_kc != 0 => self.tap(kc, shift),
            _ => self.bind(ks).and_then(|kc| self.tap(kc, false)),
        };
        if let Some(c) = caps_kc {
            self.tap(c, false)?;
        }
        r
    }

    pub fn send(&mut self, a: &KeyAction) -> Result<(), String> {
        let named = |ks| -> u32 { ks };
        match a {
            KeyAction::Text(t) => {
                for c in t.chars() {
                    self.type_keysym(keysym_for(c), c.is_alphabetic())?;
                }
                Ok(())
            }
            KeyAction::Enter => self.type_keysym(named(XK_RETURN), false),
            KeyAction::Tab => self.type_keysym(named(XK_TAB), false),
            KeyAction::Backspace => self.type_keysym(named(XK_BACKSPACE), false),
            KeyAction::Left => self.type_keysym(named(XK_LEFT), false),
            KeyAction::Right => self.type_keysym(named(XK_RIGHT), false),
        }
    }
}

impl Drop for XTyper {
    fn drop(&mut self) {
        // Leave the user's keymap exactly as it was.
        let codes: Vec<u8> = self.bound.values().copied().collect();
        if let Some(&last) = self.last_used.values().max() {
            let idle = last.elapsed();
            if idle < REBIND_AFTER {
                std::thread::sleep(REBIND_AFTER - idle);
            }
        }
        // One at a time, like every other change (see SETTLE_AFTER_REMAP).
        for kc in codes {
            let _ = self.conn.change_keyboard_mapping(1, kc, self.per as u8, &self.row(0));
            let _ = self.conn.sync();
            std::thread::sleep(SETTLE_AFTER_REMAP);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::keysym_for;

    #[test]
    fn keysyms_for_latin1_and_unicode() {
        assert_eq!(keysym_for('a'), 0x61);
        assert_eq!(keysym_for('é'), 0xe9);
        assert_eq!(keysym_for('—'), 0x0100_2014);
        assert_eq!(keysym_for('日'), 0x0100_65e5);
        assert_eq!(keysym_for('🎉'), 0x0101_f389);
    }
}
