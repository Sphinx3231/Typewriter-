//! Operating-system facts the typing session needs, behind one trait so the
//! session logic can be tested without a desktop.

use crate::keys::KeyAction;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub window_id: String,
    pub process_id: u64,
    pub app_name: String,
    pub title: String,
}

impl WindowInfo {
    pub fn same_window(&self, other: &WindowInfo) -> bool {
        self.process_id == other.process_id && self.window_id == other.window_id
    }

    /// True for web browsers, whose one window holds many tabs.
    pub fn is_browser(&self) -> bool {
        let name = self.app_name.to_lowercase();
        const BROWSERS: [&str; 15] = ["chrome", "chromium", "microsoft edge", "microsoft-edge", "msedge", "opera", "firefox", "brave", "vivaldi", "safari", "browser", "yandex", "librewolf", "waterfox", "thorium"];
        name == "arc" || BROWSERS.iter().any(|b| name.contains(b))
    }

    /// Which tab of a browser window is showing, from the window title (a browser
    /// window's title is its active tab's title). Markers that a page adds or changes
    /// on its own (unread counts, unsaved/edited marks) are left out.
    pub fn tab_key(&self) -> String {
        tab_key(&self.title)
    }

    /// The same browser window, now showing another tab.
    pub fn other_tab_of(&self, target: &WindowInfo) -> bool {
        if !self.same_window(target) || !target.is_browser() {
            return false;
        }
        let (now, then) = (self.tab_key(), target.tab_key());
        !now.is_empty() && !then.is_empty() && now != then
    }
}

/// A window title without the markers pages and editors add on their own: a leading
/// "(3) " or "[2] " unread count, a leading or trailing "*", "●" or "•" (unsaved), and a
/// trailing "— Edited".
pub fn tab_key(title: &str) -> String {
    let mut t = title.trim();
    loop {
        let before = t;
        t = t.trim_start_matches(['*', '●', '•']).trim_end_matches(['*', '●', '•']).trim();
        for (open, close) in [('(', ')'), ('[', ']')] {
            if let Some(rest) = t.strip_prefix(open) {
                if let Some(end) = rest.find(close) {
                    let inner = &rest[..end];
                    if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit() || c == '+' || c == ',') {
                        t = rest[end + close.len_utf8()..].trim_start();
                    }
                }
            }
        }
        for suffix in [" — Edited", " - Edited"] {
            t = t.strip_suffix(suffix).unwrap_or(t).trim_end();
        }
        if t == before {
            return t.to_string();
        }
    }
}

/// Everything the session asks of the desktop.
pub trait Desktop {
    /// The window that currently has keyboard focus, if it can be determined.
    fn focused_window(&mut self) -> Option<WindowInfo>;
    /// A reason to refuse typing because the focused control is a password or
    /// secure-input field, when the platform can tell.
    fn sensitive_focus(&mut self) -> Option<String>;
    /// True while the user is physically holding Ctrl, Alt, Shift or the
    /// Windows/Command key. Typing then would trigger shortcuts.
    fn modifiers_held(&mut self) -> bool;
    /// True when the mouse is in the top-left corner (emergency stop).
    fn failsafe_triggered(&mut self) -> bool;
    /// True while a mouse button (left or right) is held down. A click during the countdown
    /// restarts it, so typing begins a full countdown after the user clicks into the document.
    fn mouse_down(&mut self) -> bool {
        false
    }
    /// True when clicks can be seen (`clicks` or `mouse_down`). Then a window that takes focus by
    /// itself right after Start doesn't start the countdown; the user's click does.
    fn sees_clicks(&mut self) -> bool {
        false
    }
    /// How many left or right button presses there have been since this desktop was created
    /// (the session's start). Counted as events, so a click too short for `mouse_down` to
    /// catch still counts.
    fn clicks(&mut self) -> u64 {
        0
    }
    /// Send one key action to the focused window.
    fn send(&mut self, action: &KeyAction) -> Result<(), String>;
    /// Called once with every character the session will type, before the
    /// countdown, so the backend can set up whatever those characters need.
    /// It should return early once `cancelled()` is true (Stop was requested or the
    /// preparation time ran out), and report `progress(done, total)` as it goes.
    fn prepare(&mut self, _chars: &[char], _cancelled: &dyn Fn() -> bool, _progress: &mut dyn FnMut(usize, usize)) {}
    /// Diagnostics only: the modifier keys the platform reports as held.
    fn held_modifiers(&mut self) -> Vec<&'static str> {
        Vec::new()
    }
    /// Diagnostics only: where keyboard focus is inside the focused window and whether keys
    /// can reach it (control class, responsiveness, privilege levels). Never titles or text.
    fn focus_detail(&mut self) -> Option<String> {
        None
    }
}

/// Locks `m`, waiting while another holder has it, unless `cancelled()` turns true
/// first. A poisoned lock is still taken (the data is a unit marker).
pub fn lock_unless<T>(m: &'static std::sync::Mutex<T>, cancelled: &dyn Fn() -> bool) -> Option<std::sync::MutexGuard<'static, T>> {
    loop {
        match m.try_lock() {
            Ok(g) => return Some(g),
            Err(std::sync::TryLockError::Poisoned(e)) => return Some(e.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                if cancelled() {
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
}

/// Window titles that suggest a login or password manager. Typing is refused there.
pub fn sensitive_title(title: &str) -> Option<String> {
    let t = title.to_lowercase();
    const WORDS: [&str; 12] = [
        "password", "passwort", "mot de passe", "contraseña", "sign in", "sign-in", "log in", "login", "1password", "bitwarden", "keepass", "keychain",
    ];
    WORDS.iter().find(|w| t.contains(*w)).map(|w| format!("The window title mentions \"{w}\", which looks like a login or password screen."))
}

// ---------------------------------------------------------------------------
// Real desktop implementation
// ---------------------------------------------------------------------------

use enigo::{Direction, Enigo, Key, Keyboard, Mouse, Settings};

/// Why external typing can't run on this machine right now.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    pub available: bool,
    /// "ok", "permission-denied", "no-display", "wayland" or "unsupported"
    pub state: String,
    pub platform: String,
    pub message: String,
}

pub fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn settings(prompt: bool) -> Settings {
    Settings { open_prompt_to_get_permissions: prompt, linux_delay: 4, ..Settings::default() }
}

/// Why a Linux desktop session can't take simulated typing, from its environment.
///
/// On Wayland the compositor doesn't let one app send keys to another, or tell it
/// which window has focus. XWayland sets `DISPLAY` too, but keys sent there only
/// reach older X11 apps, and focus can't be tracked across the two. So any Wayland
/// session is refused with an explanation instead of half-working.
pub fn linux_session_problem(display: Option<&str>, wayland_display: Option<&str>, session_type: Option<&str>) -> Option<(&'static str, String)> {
    let wayland = wayland_display.is_some() || session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland"));
    if wayland {
        return Some((
            "wayland",
            "This is a Wayland session. Wayland doesn't let one app type into another, so Typewriter can't type into your document here. \
             Log out and pick an \"Xorg\" or \"X11\" session at the login screen (for example \"Ubuntu on Xorg\"), then try again. \
             The preview in Typewriter still works."
                .into(),
        ));
    }
    if display.is_none() {
        return Some(("no-display", "Typing into other apps needs an X11 desktop session, and none was found (DISPLAY is not set).".into()));
    }
    None
}

/// Checks whether keyboard input can be simulated, without typing anything.
/// On macOS, `prompt` opens the system dialog that asks for Accessibility access.
pub fn check_support(prompt: bool) -> Support {
    let platform = platform_name().to_string();
    if cfg!(target_os = "linux") {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        if let Some((state, message)) = linux_session_problem(var("DISPLAY").as_deref(), var("WAYLAND_DISPLAY").as_deref(), var("XDG_SESSION_TYPE").as_deref()) {
            return Support { available: false, state: state.into(), platform, message };
        }
    }
    // On X11, ask for exactly what the typer uses (a display with XTest). Creating an
    // enigo instance here would fail whenever another session has every spare key
    // code bound, and wrongly report typing as unavailable.
    #[cfg(target_os = "linux")]
    {
        let _ = prompt;
        match crate::xtyper::probe() {
            Ok(()) => Support { available: true, state: "ok".into(), platform, message: "Ready to type into other apps.".into() },
            Err(e) => Support { available: false, state: "unsupported".into(), platform, message: format!("Keyboard input isn't available: {e}") },
        }
    }
    #[cfg(not(target_os = "linux"))]
    match Enigo::new(&settings(prompt)) {
        Ok(_) => Support { available: true, state: "ok".into(), platform, message: "Ready to type into other apps.".into() },
        Err(enigo::NewConError::NoPermission) => Support {
            available: false,
            state: "permission-denied".into(),
            platform,
            message: "Typewriter needs Accessibility permission to type into other apps. Open System Settings › Privacy & Security › Accessibility, turn on Typewriter, then restart it.".into(),
        },
        Err(e) => Support { available: false, state: "unsupported".into(), platform, message: format!("Keyboard input isn't available: {e}.") },
    }
}

pub struct RealDesktop {
    /// Windows/macOS key output, and the Linux fallback if XTest can't be used.
    enigo: Option<Enigo>,
    #[cfg(target_os = "linux")]
    x11: Option<linux::X11>,
    #[cfg(target_os = "linux")]
    typer: Option<crate::xtyper::XTyper>,
    /// Windows/macOS: the system's click count when this desktop was created.
    #[cfg(not(target_os = "linux"))]
    clicks_base: u64,
}

impl RealDesktop {
    /// `cancelled` lets a Stop (or the preparation time limit) end the wait for a
    /// previous session to release the keymap; the result is then a Support with
    /// state "cancelled".
    pub fn new(cancelled: &dyn Fn() -> bool) -> Result<Self, Support> {
        // Clicks count from here, before any wait below: a click into the document while the
        // previous session cleans up must still count.
        #[cfg(not(target_os = "linux"))]
        let clicks_base = os::clicks();
        #[cfg(target_os = "linux")]
        let x11 = linux::X11::connect();
        let support = check_support(false);
        if !support.available {
            return Err(support);
        }
        let new_enigo = || {
            Enigo::new(&settings(false)).map_err(|e| Support {
                available: false,
                state: "unsupported".into(),
                platform: platform_name().into(),
                message: format!("Keyboard input isn't available: {e}."),
            })
        };
        #[cfg(target_os = "linux")]
        {
            // Waits for a previous session to finish restoring the keymap (see xtyper).
            let typer = match crate::xtyper::XTyper::connect(cancelled) {
                Ok(t) => Some(t),
                Err(e) if e == crate::xtyper::CANCELLED => {
                    return Err(Support { available: false, state: "cancelled".into(), platform: platform_name().into(), message: e });
                }
                Err(_) => None,
            };
            let enigo = if typer.is_some() { None } else { Some(new_enigo()?) };
            Ok(Self { enigo, x11, typer })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = cancelled;
            Ok(Self { enigo: Some(new_enigo()?), clicks_base })
        }
    }
}

impl Desktop for RealDesktop {
    fn focused_window(&mut self) -> Option<WindowInfo> {
        // On X11, ask over the session's own connection: active-win-pos-rs opens a
        // new connection per call, which is far too slow to do before every key.
        #[cfg(target_os = "linux")]
        if let Some(x) = &self.x11 {
            return x.active_window();
        }
        let w = active_win_pos_rs::get_active_window().ok()?;
        Some(WindowInfo { window_id: w.window_id, process_id: w.process_id, app_name: w.app_name, title: w.title })
    }

    fn sensitive_focus(&mut self) -> Option<String> {
        os::sensitive_focus()
    }

    fn modifiers_held(&mut self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.x11.as_ref().and_then(|x| x.pointer()).map(|p| p.modifiers).unwrap_or(false)
        }
        #[cfg(not(target_os = "linux"))]
        {
            os::modifiers_held()
        }
    }

    fn failsafe_triggered(&mut self) -> bool {
        #[cfg(target_os = "linux")]
        if let Some(p) = self.x11.as_ref().and_then(|x| x.pointer()) {
            return p.x <= 1 && p.y <= 1;
        }
        matches!(self.enigo.as_ref().map(|e| e.location()), Some(Ok((x, y))) if x <= 1 && y <= 1)
    }

    fn sees_clicks(&mut self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.x11.as_ref().and_then(|x| x.pointer()).is_some()
        }
        #[cfg(not(target_os = "linux"))]
        {
            true
        }
    }

    fn clicks(&mut self) -> u64 {
        #[cfg(target_os = "linux")]
        {
            self.x11.as_ref().map(|x| x.clicks()).unwrap_or(0)
        }
        #[cfg(not(target_os = "linux"))]
        {
            os::clicks().saturating_sub(self.clicks_base)
        }
    }

    fn mouse_down(&mut self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.x11.as_ref().and_then(|x| x.pointer()).map(|p| p.button).unwrap_or(false)
        }
        #[cfg(not(target_os = "linux"))]
        {
            os::mouse_down()
        }
    }

    fn prepare(&mut self, chars: &[char], cancelled: &dyn Fn() -> bool, progress: &mut dyn FnMut(usize, usize)) {
        #[cfg(target_os = "linux")]
        if let Some(t) = self.typer.as_mut() {
            t.prebind(chars, cancelled, progress);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (chars, cancelled, progress);
    }

    fn held_modifiers(&mut self) -> Vec<&'static str> {
        #[cfg(target_os = "windows")]
        {
            os::held_modifiers()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Vec::new()
        }
    }

    fn focus_detail(&mut self) -> Option<String> {
        #[cfg(target_os = "windows")]
        {
            os::focus_detail()
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }

    fn send(&mut self, action: &KeyAction) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        if let Some(t) = self.typer.as_mut() {
            return t.send(action);
        }
        let enigo = self.enigo.as_mut().ok_or("no keyboard output is available")?;
        let r = match action {
            KeyAction::Text(t) => enigo.text(t),
            KeyAction::Enter => enigo.key(Key::Return, Direction::Click),
            KeyAction::Tab => enigo.key(Key::Tab, Direction::Click),
            KeyAction::Backspace => enigo.key(Key::Backspace, Direction::Click),
            KeyAction::Left => enigo.key(Key::LeftArrow, Direction::Click),
            KeyAction::Right => enigo.key(Key::RightArrow, Direction::Click),
        };
        // On Windows, add the system's error code (for example 5, access denied, when a window
        // of a more privileged app has focus).
        #[cfg(target_os = "windows")]
        let r = r.map_err(|e| format!("{e} [{}]", std::io::Error::last_os_error()));
        r.map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
mod os {
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LBUTTON, VK_LWIN, VK_MENU, VK_RBUTTON, VK_RWIN, VK_SHIFT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetMessageW, GetWindowThreadProcessId, IsHungAppWindow, SetWindowsHookExW, GUITHREADINFO, MSG, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_RBUTTONDOWN,
    };

    /// Uses UI Automation to ask whether the focused control is a password box.
    pub fn sensitive_focus() -> Option<String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let el = uia.GetFocusedElement().ok()?;
            if el.CurrentIsPassword().ok()?.as_bool() {
                return Some("The focused field is a password field.".into());
            }
        }
        None
    }

    pub fn modifiers_held() -> bool {
        unsafe { [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN].iter().any(|k| (GetAsyncKeyState(k.0 as i32) as u16 & 0x8000) != 0) }
    }

    static CLICKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static HOOK: std::sync::Once = std::sync::Once::new();

    unsafe extern "system" fn on_mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 && (w.0 as u32 == WM_LBUTTONDOWN || w.0 as u32 == WM_RBUTTONDOWN) {
            CLICKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        unsafe { CallNextHookEx(None, code, w, l) }
    }

    /// Left and right button presses since the first call. A low-level mouse hook on its own
    /// thread counts them as they happen; polling the button state misses very short clicks
    /// (touchpad taps, automation tools).
    pub fn clicks() -> u64 {
        HOOK.call_once(|| {
            std::thread::spawn(|| unsafe {
                if SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), None, 0).is_ok() {
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
                }
            });
        });
        CLICKS.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The physical left or right mouse button is down.
    pub fn mouse_down() -> bool {
        unsafe { [VK_LBUTTON, VK_RBUTTON].iter().any(|k| (GetAsyncKeyState(k.0 as i32) as u16 & 0x8000) != 0) }
    }

    pub fn held_modifiers() -> Vec<&'static str> {
        [(VK_SHIFT, "Shift"), (VK_CONTROL, "Ctrl"), (VK_MENU, "Alt"), (VK_LWIN, "left Windows key"), (VK_RWIN, "right Windows key")]
            .iter()
            .filter(|(k, _)| unsafe { (GetAsyncKeyState(k.0 as i32) as u16 & 0x8000) != 0 })
            .map(|(_, n)| *n)
            .collect()
    }

    fn class_name(h: HWND) -> String {
        let mut b = [0u16; 256];
        let n = unsafe { GetClassNameW(h, &mut b) };
        String::from_utf16_lossy(&b[..n.max(0) as usize])
    }

    /// The process's integrity level (Windows blocks input into windows of a higher level).
    fn integrity(pid: u32) -> &'static str {
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return "unknown (can't open process)";
            };
            let mut token = HANDLE::default();
            let level = if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok() {
                let mut len = 0u32;
                let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
                let mut buf = vec![0u8; len as usize];
                let level = if len > 0 && GetTokenInformation(token, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut _), len, &mut len).is_ok() {
                    let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
                    let count = *GetSidSubAuthorityCount(label.Label.Sid);
                    match *GetSidSubAuthority(label.Label.Sid, count.saturating_sub(1) as u32) {
                        r if r < 0x2000 => "low",
                        r if r < 0x3000 => "medium",
                        r if r < 0x4000 => "high",
                        _ => "system",
                    }
                } else {
                    "unknown"
                };
                let _ = CloseHandle(token);
                level
            } else {
                "unknown (no token access)"
            };
            let _ = CloseHandle(process);
            level
        }
    }

    pub fn focus_detail() -> Option<String> {
        unsafe {
            let fg = GetForegroundWindow();
            if fg.is_invalid() {
                return Some("no foreground window".into());
            }
            let mut pid = 0u32;
            let thread = GetWindowThreadProcessId(fg, Some(&mut pid));
            let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
            let focus = if GetGUIThreadInfo(thread, &mut info).is_ok() && !info.hwndFocus.is_invalid() {
                class_name(info.hwndFocus)
            } else {
                "none".into()
            };
            Some(format!(
                "window class {}, keyboard focus in {}, responding {}, privilege: target {} / Typewriter {}",
                class_name(fg),
                focus,
                !IsHungAppWindow(fg).as_bool(),
                integrity(pid),
                integrity(GetCurrentProcessId()),
            ))
        }
    }
}

#[cfg(target_os = "macos")]
mod os {
    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn IsSecureEventInputEnabled() -> u8;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state_id: i32) -> u64;
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
        fn CGEventSourceCounterForEventType(state_id: i32, event_type: u32) -> u32;
    }

    /// Left and right mouse-down events so far (kCGEventLeftMouseDown = 1, RightMouseDown = 3).
    pub fn clicks() -> u64 {
        unsafe { CGEventSourceCounterForEventType(0, 1) as u64 + CGEventSourceCounterForEventType(0, 3) as u64 }
    }

    /// The left or right mouse button is down (combined session state).
    pub fn mouse_down() -> bool {
        unsafe { CGEventSourceButtonState(0, 0) || CGEventSourceButtonState(0, 1) }
    }

    /// macOS turns on Secure Event Input while a password field has focus.
    pub fn sensitive_focus() -> Option<String> {
        if unsafe { IsSecureEventInputEnabled() } != 0 {
            Some("macOS reports secure input is on, which means a password field has focus.".into())
        } else {
            None
        }
    }

    pub fn modifiers_held() -> bool {
        const SHIFT: u64 = 0x0002_0000;
        const CONTROL: u64 = 0x0004_0000;
        const ALT: u64 = 0x0008_0000;
        const COMMAND: u64 = 0x0010_0000;
        let flags = unsafe { CGEventSourceFlagsState(0) };
        flags & (SHIFT | CONTROL | ALT | COMMAND) != 0
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::WindowInfo;
    use std::cell::Cell;
    use std::time::{Duration, Instant};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt, KeyButMask, Window};
    use x11rb::rust_connection::RustConnection;

    /// Subscribes a new connection to raw button presses on all master devices (XInput 2.0).
    fn raw_buttons(root: Window) -> Option<RustConnection> {
        use x11rb::protocol::xinput::{self, ConnectionExt as _};
        let (conn, _) = x11rb::connect(None).ok()?;
        conn.xinput_xi_query_version(2, 0).ok()?.reply().ok()?;
        let mask = xinput::EventMask { deviceid: 1, mask: vec![xinput::XIEventMask::RAW_BUTTON_PRESS] };
        conn.xinput_xi_select_events(root, &[mask]).ok()?.check().ok()?;
        Some(conn)
    }

    #[derive(Clone, Copy)]
    pub struct Pointer {
        pub x: i16,
        pub y: i16,
        pub modifiers: bool,
        pub button: bool,
    }

    /// One persistent X11 connection for focus, pointer and modifier queries.
    pub struct X11 {
        conn: RustConnection,
        root: Window,
        active: Atom,
        pid: Atom,
        name: Atom,
        utf8: Atom,
        // Pointer and modifiers come from one query; reuse it briefly.
        pointer: Cell<Option<(Instant, Pointer)>>,
        // A second connection that receives XInput2 raw button presses from every device, so a
        // click shorter than a polling interval still counts.
        raw: Option<RustConnection>,
        clicks: Cell<u64>,
    }

    impl X11 {
        pub fn connect() -> Option<Self> {
            let (conn, screen) = x11rb::connect(None).ok()?;
            let root = conn.setup().roots[screen].root;
            let atom = |n: &str| conn.intern_atom(false, n.as_bytes()).ok()?.reply().ok().map(|r| r.atom);
            Some(Self {
                active: atom("_NET_ACTIVE_WINDOW")?,
                pid: atom("_NET_WM_PID")?,
                name: atom("_NET_WM_NAME")?,
                utf8: atom("UTF8_STRING")?,
                raw: raw_buttons(root),
                conn,
                root,
                pointer: Cell::new(None),
                clicks: Cell::new(0),
            })
        }

        /// Left and right button presses seen so far (the wheel and middle button aren't clicks).
        pub fn clicks(&self) -> u64 {
            if let Some(raw) = &self.raw {
                while let Ok(Some(ev)) = raw.poll_for_event() {
                    if let x11rb::protocol::Event::XinputRawButtonPress(e) = ev {
                        if e.detail == 1 || e.detail == 3 {
                            self.clicks.set(self.clicks.get() + 1);
                        }
                    }
                }
            }
            self.clicks.get()
        }

        fn window_prop(&self, w: Window, prop: Atom, ty: Atom, len: u32) -> Option<x11rb::protocol::xproto::GetPropertyReply> {
            self.conn.get_property(false, w, prop, ty, 0, len).ok()?.reply().ok()
        }

        pub fn active_window(&self) -> Option<WindowInfo> {
            let r = self.window_prop(self.root, self.active, AtomEnum::WINDOW.into(), 1)?;
            let w = r.value32()?.next()?;
            if w == 0 {
                return None;
            }
            let pid = self.window_prop(w, self.pid, AtomEnum::CARDINAL.into(), 1).and_then(|r| r.value32().and_then(|mut v| v.next())).unwrap_or(0);
            let title = self
                .window_prop(w, self.name, self.utf8, 1024)
                .map(|r| String::from_utf8_lossy(&r.value).into_owned())
                .filter(|t| !t.is_empty())
                .or_else(|| self.window_prop(w, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into(), 1024).map(|r| String::from_utf8_lossy(&r.value).into_owned()))
                .unwrap_or_default();
            // WM_CLASS is "instance\0class\0"; the class names the app (e.g. "Google-chrome", "firefox").
            let app_name = self
                .window_prop(w, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into(), 256)
                .map(|r| r.value.split(|b| *b == 0).filter(|p| !p.is_empty()).last().map(|c| String::from_utf8_lossy(c).into_owned()).unwrap_or_default())
                .unwrap_or_default();
            Some(WindowInfo { window_id: w.to_string(), process_id: pid as u64, app_name, title })
        }

        pub fn pointer(&self) -> Option<Pointer> {
            if let Some((t, p)) = self.pointer.get() {
                if t.elapsed() < Duration::from_millis(5) {
                    return Some(p);
                }
            }
            let r = self.conn.query_pointer(self.root).ok()?.reply().ok()?;
            let m = r.mask;
            let p = Pointer {
                x: r.root_x,
                y: r.root_y,
                modifiers: m.contains(KeyButMask::SHIFT) || m.contains(KeyButMask::CONTROL) || m.contains(KeyButMask::MOD1) || m.contains(KeyButMask::MOD4),
                button: m.contains(KeyButMask::BUTTON1) || m.contains(KeyButMask::BUTTON3),
            };
            self.pointer.set(Some((Instant::now(), p)));
            Some(p)
        }
    }
}

#[cfg(target_os = "linux")]
mod os {
    /// X11 has no standard way to ask another app whether its focused field is a
    /// password field. The window-title check in the session still applies.
    pub fn sensitive_focus() -> Option<String> {
        None
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;

    fn w(app: &str, title: &str) -> WindowInfo {
        WindowInfo { window_id: "1".into(), process_id: 2, app_name: app.into(), title: title.into() }
    }

    #[test]
    fn browsers_are_recognised_by_name() {
        for app in ["Opera Internet Browser", "Google Chrome", "Microsoft Edge", "Firefox", "Brave Browser", "Vivaldi", "Safari", "Arc", "Chromium", "msedge"] {
            assert!(w(app, "").is_browser(), "{app}");
        }
        for app in ["Notepad", "Microsoft Word", "Knowledge Edge Base", "Archive Utility", ""] {
            assert!(!w(app, "").is_browser(), "{app}");
        }
    }

    #[test]
    fn tab_keys_ignore_marks_a_page_or_editor_adds_itself() {
        assert_eq!(tab_key("  (3) Inbox - Gmail - Opera "), "Inbox - Gmail - Opera");
        assert_eq!(tab_key("[12] Chat"), "Chat");
        assert_eq!(tab_key("(1,204) Mail"), "Mail");
        assert_eq!(tab_key("*Untitled - Notepad"), "Untitled - Notepad");
        assert_eq!(tab_key("● main.rs - VS Code"), "main.rs - VS Code");
        assert_eq!(tab_key("Notes.txt — Edited"), "Notes.txt");
        assert_eq!(tab_key("Report - Edited"), "Report");
        assert_eq!(tab_key("(draft) Essay"), "(draft) Essay");
        assert_eq!(tab_key("()"), "()");
        assert_eq!(tab_key("(5"), "(5");
        assert_eq!(tab_key(""), "");
    }

    #[test]
    fn another_tab_means_the_same_browser_window_with_a_different_page() {
        let docs = w("Google Chrome", "Essay - Google Docs - Google Chrome");
        assert!(w("Google Chrome", "YouTube - Google Chrome").other_tab_of(&docs));
        assert!(!w("Google Chrome", "(2) Essay - Google Docs - Google Chrome").other_tab_of(&docs));
        assert!(!w("Google Chrome", "").other_tab_of(&docs), "an untitled moment isn't a tab change");
        let mut elsewhere = w("Google Chrome", "YouTube - Google Chrome");
        elsewhere.window_id = "9".into();
        assert!(!elsewhere.other_tab_of(&docs), "another window is a focus change, not a tab change");
        let notepad = w("Notepad", "Untitled - Notepad");
        assert!(!w("Notepad", "Other - Notepad").other_tab_of(&notepad), "only browsers have tabs here");
    }
}
