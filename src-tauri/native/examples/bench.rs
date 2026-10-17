//! Times the pieces of a typing session on the current X display.
use std::time::Instant;
use typewriter_native::{Desktop, KeyAction, RealDesktop};

fn main() {
    let mut d = RealDesktop::new(&|| false).expect("desktop");
    let text: String = "Long passages must arrive intact, even at a brisk pace. ".repeat(5);
    let n = text.chars().count();
    let t = Instant::now();
    for _ in 0..n {
        d.focused_window();
    }
    println!("focused_window: {:.3} ms/call", t.elapsed().as_secs_f64() * 1000.0 / n as f64);
    let t = Instant::now();
    for _ in 0..n {
        d.modifiers_held();
        d.failsafe_triggered();
    }
    println!("pointer checks: {:.3} ms/call", t.elapsed().as_secs_f64() * 1000.0 / n as f64);
    let t = Instant::now();
    for c in text.chars() {
        d.send(&KeyAction::Text(c.to_string())).unwrap();
    }
    println!("send text: {:.3} ms/char ({} chars)", t.elapsed().as_secs_f64() * 1000.0 / n as f64, n);
}
