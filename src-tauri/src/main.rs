// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // With some GPU drivers, virtual machines and software-rendered X servers,
        // WebKitGTK's DMA-BUF renderer leaves the window blank or stops repainting
        // (e.g. the theme switch wouldn't show). The fallback renderer always repaints.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    typewriter_lib::run()
}
