use std::process::Command;

fn main() {
    // The commit this build was made from, written into the typing diagnostics.
    let git = |args: &[&str]| Command::new("git").args(args).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let mut commit = git(&["rev-parse", "--short=7", "HEAD"]).unwrap_or_else(|| "unknown".into());
    if git(&["status", "--porcelain", "--untracked-files=no", "--", "../src", "src", "native/src", "../extension"]).is_some_and(|s| !s.is_empty()) {
        commit.push_str("+local");
    }
    println!("cargo:rustc-env=TYPEWRITER_COMMIT={commit}");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/index");
    tauri_build::build()
}
