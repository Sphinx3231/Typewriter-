//! Support checks run before anything is typed. Kept in its own test binary
//! because it changes process environment variables.

/// Tests that change environment variables must not run at the same time.
static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(target_os = "linux")]
#[test]
fn without_an_x11_display_typing_is_refused_with_an_explanation() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let saved = std::env::var_os("DISPLAY");
    std::env::remove_var("DISPLAY");
    let s = typewriter_native::check_support(false);
    if let Some(d) = &saved {
        std::env::set_var("DISPLAY", d);
    }
    assert!(!s.available);
    assert_eq!(s.state, "no-display");
    assert!(s.message.contains("X11"));
    // And a session can't be started at all.
    std::env::remove_var("DISPLAY");
    let r = typewriter_native::spawn_session(
        typewriter_native::Config { events: vec![], countdown_ms: 0, resume_countdown_ms: 0, own_pid: 0, prepare_timeout_ms: 1000, wait_timeout_ms: 1000 },
        |_| {},
        Box::new(|_: &str| {}),
    );
    if let Some(d) = saved {
        std::env::set_var("DISPLAY", d);
    }
    assert!(r.is_err());
}

#[test]
fn wayland_sessions_are_refused_even_when_xwayland_sets_display() {
    use typewriter_native::linux_session_problem as check;
    // Plain X11 session: fine.
    assert!(check(Some(":0"), None, Some("x11")).is_none());
    assert!(check(Some(":0"), None, None).is_none());
    // GNOME/KDE on Wayland: XWayland sets DISPLAY as well.
    let (state, msg) = check(Some(":0"), Some("wayland-0"), Some("wayland")).unwrap();
    assert_eq!(state, "wayland");
    assert!(msg.contains("Xorg"));
    assert_eq!(check(Some(":0"), None, Some("Wayland")).unwrap().0, "wayland");
    assert_eq!(check(Some(":0"), Some("wayland-1"), None).unwrap().0, "wayland");
    // No display at all.
    assert_eq!(check(None, None, Some("tty")).unwrap().0, "no-display");
}

#[cfg(target_os = "linux")]
#[test]
fn a_wayland_session_refuses_before_any_session_starts() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let saved = std::env::var_os("WAYLAND_DISPLAY");
    std::env::set_var("WAYLAND_DISPLAY", "wayland-0");
    let s = typewriter_native::check_support(false);
    match saved {
        Some(v) => std::env::set_var("WAYLAND_DISPLAY", v),
        None => std::env::remove_var("WAYLAND_DISPLAY"),
    }
    assert!(!s.available);
    assert_eq!(s.state, "wayland");
}
