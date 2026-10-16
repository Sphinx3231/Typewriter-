//! Support checks run before anything is typed. Kept in its own test binary
//! because it changes process environment variables.

#[cfg(target_os = "linux")]
#[test]
fn without_an_x11_display_typing_is_refused_with_an_explanation() {
    let saved = std::env::var_os("DISPLAY");
    std::env::remove_var("DISPLAY");
    let s = typewriter_native::check_support(false);
    if let Some(d) = saved {
        std::env::set_var("DISPLAY", d);
    }
    assert!(!s.available);
    assert_eq!(s.state, "no-display");
    assert!(s.message.contains("X11"));
    // And a session can't be started at all.
    std::env::remove_var("DISPLAY");
    let r = typewriter_native::spawn_session(
        typewriter_native::Config { events: vec![], countdown_ms: 0, resume_countdown_ms: 0, own_pid: 0 },
        |_| {},
    );
    assert!(r.is_err());
}
