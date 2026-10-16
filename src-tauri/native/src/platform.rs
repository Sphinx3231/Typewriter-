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
    /// Send one key action to the focused window.
    fn send(&mut self, action: &KeyAction) -> Result<(), String>;
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
    /// "ok", "permission-denied", "no-display" or "unsupported"
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

/// Checks whether keyboard input can be simulated, without typing anything.
/// On macOS, `prompt` opens the system dialog that asks for Accessibility access.
pub fn check_support(prompt: bool) -> Support {
    let platform = platform_name().to_string();
    if cfg!(target_os = "linux") && std::env::var_os("DISPLAY").is_none() {
        return Support {
            available: false,
            state: "no-display".into(),
            platform,
            message: "Typing into other apps needs an X11 session (DISPLAY is not set). On Wayland, log in with an \"Xorg\"/\"X11\" session.".into(),
        };
    }
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
    enigo: Enigo,
    #[cfg(target_os = "linux")]
    x11: Option<(x11rb::rust_connection::RustConnection, u32)>,
}

impl RealDesktop {
    pub fn new() -> Result<Self, Support> {
        let support = check_support(false);
        if !support.available {
            return Err(support);
        }
        let enigo = Enigo::new(&settings(false)).map_err(|e| Support {
            available: false,
            state: "unsupported".into(),
            platform: platform_name().into(),
            message: format!("Keyboard input isn't available: {e}."),
        })?;
        Ok(Self {
            enigo,
            #[cfg(target_os = "linux")]
            x11: x11rb::connect(None).ok().map(|(c, screen)| {
                use x11rb::connection::Connection;
                let root = c.setup().roots[screen].root;
                (c, root)
            }),
        })
    }
}

impl Desktop for RealDesktop {
    fn focused_window(&mut self) -> Option<WindowInfo> {
        let w = active_win_pos_rs::get_active_window().ok()?;
        Some(WindowInfo { window_id: w.window_id, process_id: w.process_id, app_name: w.app_name, title: w.title })
    }

    fn sensitive_focus(&mut self) -> Option<String> {
        os::sensitive_focus()
    }

    fn modifiers_held(&mut self) -> bool {
        #[cfg(target_os = "linux")]
        {
            use x11rb::protocol::xproto::{ConnectionExt, KeyButMask};
            if let Some((c, root)) = &self.x11 {
                if let Ok(Ok(reply)) = c.query_pointer(*root).map(|r| r.reply()) {
                    let m = reply.mask;
                    return m.contains(KeyButMask::SHIFT) || m.contains(KeyButMask::CONTROL) || m.contains(KeyButMask::MOD1) || m.contains(KeyButMask::MOD4);
                }
            }
            false
        }
        #[cfg(not(target_os = "linux"))]
        {
            os::modifiers_held()
        }
    }

    fn failsafe_triggered(&mut self) -> bool {
        matches!(self.enigo.location(), Ok((x, y)) if x <= 1 && y <= 1)
    }

    fn send(&mut self, action: &KeyAction) -> Result<(), String> {
        let r = match action {
            KeyAction::Text(t) => self.enigo.text(t),
            KeyAction::Enter => self.enigo.key(Key::Return, Direction::Click),
            KeyAction::Tab => self.enigo.key(Key::Tab, Direction::Click),
            KeyAction::Backspace => self.enigo.key(Key::Backspace, Direction::Click),
            KeyAction::Left => self.enigo.key(Key::LeftArrow, Direction::Click),
            KeyAction::Right => self.enigo.key(Key::RightArrow, Direction::Click),
        };
        r.map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
mod os {
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};

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
mod os {
    /// X11 has no standard way to ask another app whether its focused field is a
    /// password field. The window-title check in the session still applies.
    pub fn sensitive_focus() -> Option<String> {
        None
    }
}
