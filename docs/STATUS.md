# Status

_Last updated: 2026-10-16 (phase 3: Chrome extension)_

- Live build board: https://claude.ai/artifact/6rEu1C45BZBPPsu2pPXV6p
- Browser preview: https://claude.ai/artifact/9pi8hGpiZY1TfVYpYNkZ65
- Chrome extension guide (install, permissions, privacy, limits): [`EXTENSION.md`](EXTENSION.md)
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

**Chrome extension** (Manifest V3). The same app runs in Chrome's side panel and types into the Chrome tab you choose.
- **How it types:** trusted key input through `chrome.debugger`. Script-made events are ignored by Google Docs, so they aren't used, and there's no fake fallback.
- **Permissions:** only `sidePanel` up front. `debugger` is requested when you first press **Type into page**, and `clipboardRead` when you first press **Check copied text**. No host permissions, no content scripts.
- **Safety:**
  - nothing types before you press the button and the countdown ends;
  - it types into one tab, into the field focused when the countdown ended;
  - switching tabs or fields pauses it; navigation, reload, a closed tab or a closed panel stops it;
  - password, one-time-code, payment and hidden fields are refused;
  - multi-line text is refused for single-line fields;
  - protected Chrome pages are refused;
  - stop with the button, Alt+Shift+., or by closing Chrome's debugging bar.
- **Honest results:** fields that can be read back are verified exactly. Google Docs and other editors that keep their text off the page say "not checked" and offer the copy-back check.
- **Build:** `npm run extension:build` produces `dist-extension/` and `release/typewriter-extension-1.0.0.zip`. CI uploads the ZIP as an artifact.
- **Not published** to the Chrome Web Store (a one-time US$5 developer fee conflicts with the $0 rule; owner decision).

## Tests (all run, all passing)

| Suite | Command | Count | What it covers |
|---|---|---|---|
| Unit and fuzz (Vitest) | `npm test` | **84** | Engine integrity over thousands of seeds, timing, the state machine; the external output adapter; copy-back verification; native fixture export; the TS key translator against all native fixtures; the Chrome typing session on a simulated browser (countdown, every guard, stop/pause/resume, verification outcomes, long text); the extension's permission flow (refused = nothing typed) |
| Browser (Playwright, Chromium) | `npm run test:e2e` | **27** | Every in-app control, themes and persistence, the logo half switching with the theme (and after reload), the image loading at full size, the splash clearing, the browser-only output note, accessibility, no overflow at 6 widths, chaos clicking |
| Native (Rust) | `npm run test:native` | **18** | Event-to-key translation; full sessions on a simulated desktop (countdown, focus guard, login and password refusal, modifier wait, stop, failsafe, drift); replay of 96 engine timelines with typos; the no-display refusal; keysyms |
| Desktop end-to-end | `npm run test:desktop` | **13** | Real packaged app, real X11 display, real key events into a real Chromium window (details below) |
| Chrome extension end-to-end | `npm run test:extension` | **28** | The unpacked extension in real Chromium typing into real pages (details below) |
| Typecheck and build | `npm run lint`, `npm run build` | — | clean |

**Total: 170 automated tests passing.** The desktop suite passed against both the freshly built binary and the **installed `.deb`** (`/usr/bin/typewriter`). The AppImage launched and passed the startup check.

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

### Chrome extension end-to-end, in detail

The tests load the unpacked extension into real Chromium. Typewriter's page is opened in a window of side-panel width beside a real web page served over HTTP. Typing goes through the real `chrome.debugger` path; nothing is mocked. Results are read from the page.

1. **Install checks:**
   - Manifest V3; only `sidePanel` required; no host permissions or content scripts.
   - The panel opens on the toolbar click; the stop shortcut is registered.
   - The panel page runs without errors or network requests.
2. **Logo and theme** at 320, 420 and 600 px wide: the right half per theme, persisted after reload, no sideways scroll.
3. **Panel UI:** offers "Into a web page", explains the permission, labels the button "Type into page".
4. **Exact typing:**
   - Unicode, multiline and literal text (HTML and shell syntax stay text) into a textarea, with medium typos and corrections.
   - Nothing during the countdown. Trusted input only.
5. **Progressive,** not pasted at once.
6. **Inserts at the caret,** leaving the surrounding text untouched.
7. **Single-line input:** single-line text typed; multi-line refused.
8. **A contenteditable editor:** exact, verified.
9. **The Docs-like stand-in:**
   - Script-made events are proven to be ignored there.
   - Typewriter's text arrives exactly.
   - The result is reported as "not checked"; the copy-back check then verifies it.
10. **Long text** (40 lines) with a short duration.
11. **Type again** types a second time only when pressed.
12. **Nothing typed** without pressing the button, or in preview mode.
13. **Password and one-time-code fields** refused.
14. **Waits** while no text field has focus, then types once one does.
15. **Cancel** during the countdown types nothing.
16. **Pause, resume and stop** from the panel, with nothing lost or repeated.
17. **The stop-typing command** stops at once.
18. **Switching tabs** pauses; nothing goes to the other tab; it resumes only in the original tab.
19. **Moving focus** to another field pauses; nothing goes into it.
20. **Reload** stops typing.
21. **Closing the panel** stops typing and releases the tab. This found a bug, now fixed: the tab stayed attached.
22. **Closing the tab** stops typing.
23. **Protected Chrome pages** are refused.
24. **The release build and its ZIP:**
    - The build loads with `debugger` *not* granted.
    - The ZIP has the manifest at its root and matches the build.

Automation can't click Chrome's permission prompt, so tests 1–23 use a test build where the optional permissions are granted at install. The refused-permission path is covered by unit tests.

### Manual checks

- Screenshots of the packaged app in both themes, the arming state, typing with the status window, and the finished/verified state.
- The real theme switch clicked with the mouse in a hand-launched app.

## Not verified

- **The Chrome extension in an actual Google Docs document.** There's no Google account here. The extension uses the input path Docs accepts from a keyboard, and it works in a strict stand-in, but real Docs is untested. Use **Check copied text** the first time.
- **The extension on Windows, macOS and ChromeOS**, and the real toolbar-click/side-panel opening. Automation opens the same page in a window of side-panel width instead.

- **Typing into an actual Google Docs document.** This environment has no Google account, so the Google Docs acceptance test could not be run. The same mechanism is verified end to end into a real Chromium text area, as above. To check it yourself, follow the steps in `DESKTOP.md` and use **Check copied text**. Google Docs' own autocorrect options can change text (see `DESKTOP.md`).
- **Windows and macOS.** Not launched or used here.
  - The Windows-specific code (UI Automation password detection, modifier state) type-checks for the Windows target.
  - The macOS-specific code (secure input, modifier state) can only be compiled on a Mac. The **Desktop builds** workflow compiles and packages both.
- **Permission prompts** (macOS Accessibility). The denied path is covered by unit tests (structured error, explanation shown, nothing typed), but not by a real macOS run.
- **Sound in external mode.** Clicks play from the progress mirror; this hasn't been listened to.

## Known limitations

- **Chrome extension:**
  - Chrome tabs only. It doesn't type into desktop apps (that's the desktop app's job).
  - Chrome on Android and iOS doesn't support extensions.
  - Editors in frames from another site can't be inspected, so it waits instead of typing.

- **Restart is disabled in "Into another app" mode**, because the text already typed would be duplicated.
- **Linux:**
  - It needs an X11 session; on Wayland, Typewriter explains this and types nothing.
  - There's no password-field detection, only the window-title check.
- **Resume relies on the caret.** It continues wherever the document's caret is. Switching windows keeps the caret; clicking elsewhere in the document moves it.
- **Installers are unsigned** ($0 budget), so expect a SmartScreen or Gatekeeper warning.
- **Phase 1 limitations still apply:**
  - no unfinished-session recovery after a reload;
  - adjacent-key typos assume a QWERTY layout.
