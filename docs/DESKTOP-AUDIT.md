# Desktop audit and gap analysis (2026-10-17)

Priority change: the standalone desktop app is the primary product. The Chrome extension (merged in `548966c`) is kept intact but deferred. Web Store publication is not pursued: the US$5 fee is not authorized.

## What exists, and what was observed working

Everything below was checked by running it, not only by reading test names.

| Area | Implementation | Evidence |
|---|---|---|
| Desktop shell | Tauri 2 (`src-tauri/`). The same React UI as the web app, plus a Rust crate `typewriter-native` behind a `Desktop` trait (focus, password checks, modifier keys, mouse failsafe, key sending). | The packaged release binary was launched on Xvfb + openbox; screenshots reviewed. |
| Typing engine | `src/engine/`: a seeded keystroke script and a drift-free timeline. Typos are always corrected; the final buffer is checked against the source. | 84 unit/fuzz tests (thousands of seeds, Unicode). |
| Typing into other apps | Linux: XTest (fast, Caps Lock handled). Windows/macOS: `enigo`. Countdown starts only after Typewriter loses focus. | 13 desktop end-to-end checks: the real packaged app types into a real Chromium window. Exact Unicode, multiline, typos, 1,500 chars in 12 s on time, pause on focus change, Ctrl+Shift+Space stop, mouse-corner stop, login-window refusal. All 13 passed today. |
| Logo and themes | Original dragon artwork, unmodified; CSS shows the light or dark half. | Desktop pixel check: the window repaints on a theme switch. |
| Packaging | `.deb`, `.rpm` and `.AppImage` built locally; `.msi`/`.exe`/`.dmg` built by CI (`desktop.yml`). | The `.deb` was installed and passed the suite on 2026-10-16. The bundles on disk predate later UI changes, so they must be rebuilt. |
| Chrome extension | MV3 side panel, `chrome.debugger` trusted input. | 28 end-to-end tests in Chromium. **Deferred**; left untouched. |

## Gaps found

| # | Gap | Severity | Plan |
|---|---|---|---|
| G1 | **Wayland detection is incomplete.** The code refuses only when `DISPLAY` is unset. On GNOME/KDE Wayland, XWayland sets `DISPLAY`, so it reports "Ready", then waits forever or fails with "no target". DESKTOP.md claims it "detects this and explains it", which is only partly true. | High (honesty and UX) | Detect `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE=wayland` and explain before arming. Unit-test the decision. |
| G2 | **Source text can be lost on quit.** "Remember my text" is off by default. Closing the window, even mid-typing, discards the text without warning. | High (req. 6) | Ask before quitting when unsaved text would be lost or typing is running, with an in-app dialog. Move "stop typing on close" to window destruction so a cancelled close keeps the session. |
| G3 | **Status window (HUD) controls.** No Pause button (only Resume/Stop). It always shows the Ctrl+Shift+Space hint, even if registration failed. No time remaining. Dead space at the bottom, and the completion text is cut off. | Medium (req. 1, 4) | Redesign the HUD: Pause/Resume/Stop, accurate shortcut state, percent and time remaining, a clear "not checked yet" completion, a layout that fills the window. |
| G4 | **Light theme palette.** It is purple/white/**cyan**; the new direction is white/blue/purple. | Medium (req. 3) | Cyan accent → blue in tokens; spec amendment recorded. |
| G5 | **No automated contrast check.** The earlier "AA" claim came from a manual pass. | Medium | A unit test computes WCAG ratios for every text/background token pair in both themes. |
| G6 | **Text-preservation coverage** for punctuation/whitespace edge cases (runs of spaces, NBSP, backslashes, quotes, braces, RTL, combining marks) isn't explicit. | Medium | Integrity matrix unit test (engine + key translation), plus one more desktop end-to-end check with such text. |
| G7 | **The source text isn't asserted after interruptions** (stop, failsafe, failure) in the desktop tests. | Low | Assert the editor still holds the exact source after each interruption. |
| G8 | **Windows/macOS real input is unverified.** Only the logic runs there (CI, fake desktop) and installers are built. | Known limit | Can't run here; documented as the remaining verification. |
| G9 | **Google Docs / real third-party apps are unverified.** Chromium textarea only. | Known limit | Documented; the copy-back check remains the user-side verification. |
| G10 | **Docs are extension-first** in places. | Low | README/DESKTOP/STATUS desktop-first; the extension and Web Store marked deferred. |

## Decision

Keep Tauri 2 and the existing architecture. It is small (about 6 MB binary, 3.4 MB `.deb`), already works end to end, and keeps OS input behind the `Desktop` trait. No rewrite and no new runtime dependencies. Fix G1–G7 incrementally, rebuild and reinstall the packages, rerun every suite against the installed app, and document G8–G9.

## Outcome (same day)

| Gap | Result |
|---|---|
| G1 Wayland | Fixed: detected via `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE` and explained; native unit tests plus an end-to-end check with the real app. |
| G2 Text on quit | Fixed: confirmation dialog; the session stops only when the window is really destroyed. End-to-end: keep open, and quit mid-session (see the final review below for a cleanup defect found afterwards). |
| G3 Status window | Fixed: Pause/Resume/Stop, real shortcut state, percent and time left, full-height layout. End-to-end with real mouse clicks. |
| G4 Palette | Done: light theme is white/blue/purple; spec amendment recorded. |
| G5 Contrast | Done: automated WCAG test. It found and fixed 5 failing pairs, including the dark Stop button. |
| G6 Integrity | Done: 14 × 4 × 5 matrix, plus two new end-to-end checks with punctuation and many off-keyboard symbols. |
| G7 Source after interruptions | Done: asserted after stop, failsafe, Stop in the status window and quitting. |
| New: Linux keymap races | Found while testing G6: overlapping sessions mixed up characters; pre-binding control characters typed Tabs; the readiness check failed while key codes were in use. All fixed with regression checks (one proven by a mutant that reintroduces the bug). |
| G8, G9 | Still open, and documented: Windows/macOS real input, Google Docs and other real apps. |

## Final review (independent reviewer + verification)

A reviewer with no build context read `origin/main..743e599`. Each finding below was then checked by running the code.

| Finding | Severity | Verified how | Outcome |
|---|---|---|---|
| Quitting mid-session killed the typing thread before it removed its temporary key bindings (`src-tauri/src/lib.rs` exit path, `xtyper.rs` `Drop`) | Medium | The strengthened quit check found 日 語 中 文 한 국 어 → ∞ left in the X keymap after quitting the 743e599 build. | **Fixed:** exit is postponed (not blocked: a first attempt that blocked the event loop deadlocked) until typing threads finish, up to 10 s. The check passes 3/3 on the fix and fails on 743e599. |
| The quit end-to-end check couldn't detect a session that kept running (focusing Typewriter pauses typing anyway) | Medium | Reading the check | **Fixed:** it now waits for the process to exit and asserts every temporary key binding is gone. |
| Stop and failsafe ignored while a session prepares (pre-binding up to ~3 s) | Low | Reading the code | **Fixed:** preparation stops as soon as Stop is requested; a native test fails if Stop waits for it. A new session can still wait up to ~3 s on the keymap lock while the previous one restores. |
| A failed keymap change can leave one code bound (`xtyper.rs` `remap`) | Low | Reading the code; only reachable when the X connection is already broken | Not fixed (theoretical). |
| Docs overclaimed: "unchanged after every interruption", "two codes always left free", "bound before the countdown ends" | Low | Compared with the tests and code | Corrected. |
| The back-to-back regression was described as a 1.0.0 bug | Low | The real 1.0.0 build (548966c) passes that check 3/3 | Corrected: the race became reachable through this release's slower cleanup; the check guards the current design. |
| The Wayland test didn't prove GTK used Wayland, or that the native side refuses | Low | Reading the test | **Fixed:** it asserts Typewriter has no X11 window (fails when GTK is forced to X11) and that a direct `external_start` call is refused with state `wayland`. |

