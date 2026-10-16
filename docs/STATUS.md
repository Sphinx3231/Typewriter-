# Status

_Last updated: 2026-10-16 (phase 2: logo, desktop app, typing into other apps)_

- Live build board: https://claude.ai/artifact/6rEu1C45BZBPPsu2pPXV6p
- Browser preview: https://claude.ai/artifact/9pi8hGpiZY1TfVYpYNkZ65
- Desktop guide (install, permissions, Google Docs workflow): [`DESKTOP.md`](DESKTOP.md)

## What's built

**Browser and desktop:** everything in `docs/SPEC.md`. That's realistic typing playback with exact text integrity, both themes, history, sounds, accessibility and responsive layouts.

**Logo.** The supplied artwork is used unmodified. CSS shows its light half in the light theme and its dark half in the dark theme. It appears in the sidebar, the phone header, the launch splash, the desktop status window and the About section. App icons and the favicon are the dark half, padded to a square with its own background, never cropped.

**Desktop app** (Tauri 2). Linux `.deb`, `.rpm` and `.AppImage` were built here. Windows and macOS installers are built by the **Desktop builds** GitHub Actions workflow.

**Typing into other apps.**
- **Safety:**
  - a countdown before any key;
  - an emergency stop (Ctrl+Shift+Space or the mouse corner);
  - pause when focus leaves the target;
  - never typing into Typewriter itself;
  - refusing password and login fields;
  - waiting while modifier keys are held.
- **Honest results:** finished sessions say "sent" until a copy-back check verifies the document.

## Tests (all run, all passing)

| Suite | Command | Count | What it covers |
|---|---|---|---|
| Unit and fuzz (Vitest) | `npm test` | **54** | Engine integrity over thousands of seeds, timing, the state machine; the external output adapter (arming, mirroring, pause/resume, stop, no restart, permission denied, stale updates); copy-back verification; native fixture export |
| Browser (Playwright, Chromium) | `npm run test:e2e` | **27** | Every in-app control, themes and persistence, the logo half switching with the theme (and after reload), the image loading at full size, the splash clearing, the browser-only output note, accessibility, no overflow at 6 widths, chaos clicking |
| Native (Rust) | `npm run test:native` | **18** | Event-to-key translation; full sessions on a simulated desktop (countdown, focus guard, login and password refusal, modifier wait, stop, failsafe, drift); replay of 96 engine timelines with typos; the no-display refusal; keysyms |
| Desktop end-to-end | `npm run test:desktop` | **13** | Real packaged app, real X11 display, real key events into a real Chromium window (details below) |
| Typecheck and build | `npm run lint`, `npm run build` | — | clean |

**Total: 112 automated tests passing.** The desktop suite passed against both the freshly built binary and the **installed `.deb`** (`/usr/bin/typewriter`). The AppImage launched and passed the startup check.

### Desktop end-to-end, in detail

Xvfb + openbox run the session. WebDriver (tauri-driver) operates Typewriter's UI. `xdotool` does the user's clicks, window switches and key presses. The text that arrives in Chromium is read back over CDP. Typewriter's input path is not mocked.

1. The app starts without a dev server, shows its window, clears the splash, and shows the right logo half.
2. The theme toggle switches the UI and the logo together six times, and persists across an app restart.
3. Pixels on screen change with the theme. This catches a WebKitGTK repaint bug, found and fixed: the window stopped repainting with the DMA-BUF renderer.
4. Nothing is typed after arming while Typewriter still has focus.
5. **Tricky text arrives exactly in Chromium:** accents, CJK, emoji including family and flag sequences, tabs, blank lines, trailing spaces, the user's own misspellings, and medium typos with mixed corrections. Nothing is typed during the countdown, the text arrives progressively, and it finishes within the planned time. Typewriter reports "not checked yet".
6. 1,500 characters in 12 s arrive exactly and on time.
7. The copy-back check marks the document Verified.
8. Caps Lock left on doesn't change the case of what's typed.
9. Switching to another app pauses typing, and the other app gets no keys. Resume waits for the document window, then finishes exactly.
10. Ctrl+Shift+Space stops typing immediately.
11. Moving the mouse to the top-left corner stops typing.
12. A window titled "Sign in" is refused before any key is sent.
13. The in-app preview still works in the desktop app.

### Manual checks

- Screenshots of the packaged app in both themes, the arming state, typing with the status window, and the finished/verified state.
- The real theme switch clicked with the mouse in a hand-launched app.

## Not verified

- **Typing into an actual Google Docs document.** This environment has no Google account, so the Google Docs acceptance test could not be run. The same mechanism is verified end to end into a real Chromium text area, as above. To check it yourself, follow the steps in `DESKTOP.md` and use **Check copied text**. Google Docs' own autocorrect options can change text (see `DESKTOP.md`).
- **Windows and macOS.** Not launched or used here.
  - The Windows-specific code (UI Automation password detection, modifier state) type-checks for the Windows target.
  - The macOS-specific code (secure input, modifier state) can only be compiled on a Mac. The **Desktop builds** workflow compiles and packages both.
- **Permission prompts** (macOS Accessibility). The denied path is covered by unit tests (structured error, explanation shown, nothing typed), but not by a real macOS run.
- **Sound in external mode.** Clicks play from the progress mirror; this hasn't been listened to.

## Known limitations

- **Restart is disabled in "Into another app" mode**, because the text already typed would be duplicated.
- **Linux:**
  - It needs an X11 session; on Wayland, Typewriter explains this and types nothing.
  - There's no password-field detection, only the window-title check.
- **Resume relies on the caret.** It continues wherever the document's caret is. Switching windows keeps the caret; clicking elsewhere in the document moves it.
- **Installers are unsigned** ($0 budget), so expect a SmartScreen or Gatekeeper warning.
- **Phase 1 limitations still apply:**
  - no unfinished-session recovery after a reload;
  - adjacent-key typos assume a QWERTY layout.
