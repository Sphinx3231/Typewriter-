# Status

_Last updated: 2026-10-17 (desktop-first release 1.1.0)_

- Live build board: https://claude.ai/artifact/6rEu1C45BZBPPsu2pPXV6p
- Desktop guide (install, workflow, permissions, limits): [`DESKTOP.md`](DESKTOP.md)
- Latest audit and gap analysis: [`DESKTOP-AUDIT.md`](DESKTOP-AUDIT.md)
- Chrome extension (**deferred**, not published): [`EXTENSION.md`](EXTENSION.md)

## Priority

The standalone desktop app is the primary product. The Chrome extension stays in the repository, built and tested, but is deferred. Chrome Web Store publication is not pursued, because the fee is not authorized.

## What works (verified by running it)

**Desktop app 1.1.0** (Tauri 2, Linux X11 verified):
- **Installers:** `.deb` installed and tested; `.AppImage` launched and tested; `.rpm` built and inspected.
- **Core workflow:** paste text, choose duration or speed and realism; then start, pause, resume and stop. Both in the app's own preview and typing into another app.
- **Exact text:** the final text equals the source, including punctuation, spacing, line breaks, accents, CJK, emoji and combining marks. Typos are temporary.
- **Typing into another app:**
  - Countdown after Typewriter loses focus.
  - Pauses when focus leaves the target, refuses login windows, waits for held modifiers.
  - Emergency stop: Ctrl+Shift+Space, the mouse corner, or Stop.
  - Status window with progress, time left and Pause/Resume/Stop.
  - "Sent, not checked" until **Check copied text** confirms the document.
- **Interruptions:** the source text is unchanged after stop, failsafe and failure. Quitting asks first when text would be lost or typing is running.
- **Wayland:** detected even under XWayland and explained; typing into other apps isn't offered there.
- **Themes:**
  - Light: white, blue and purple. Dark: black, red and orange.
  - Both use the original dragon logo, which switches with the theme.
  - Every text/background pair passes WCAG AA automatically.

## Fixed in this release (found by testing, not assumed)

| Problem | Effect | Fix |
|---|---|---|
| Two sessions overlapping on Linux | A new session could mistake the previous session's temporary key binding for a real key: wrong characters (`‘` for `文`). | A keymap lock: a session can't read the keymap until the previous one has restored it. A regression check fails without the lock (2/2) and passes with it (3/3). |
| Tab and newline pre-bound as symbols | Wasted key codes; a reused code typed a Tab. | Control characters are skipped. |
| Readiness check used enigo | While a Unicode-heavy session held every free key code, the next start said "Keyboard input isn't available". | Linux checks X11 + XTest directly; enigo is only a fallback. Two key codes are always left free. |
| No settle time after remapping a key code | Rarely, a character was read with the code's previous symbol. | 80 ms settle after each remap; symbols are bound before the countdown ends. |
| Wayland under XWayland reported "Ready" | Typing then waited forever or failed. | Detected and explained up front. |
| Quitting discarded unsaved text silently | Text lost. | Confirmation dialog: keep open / save text and quit / quit. |
| Status window | No Pause; a dead shortcut hint if registration failed; no time left. | Redesigned; it reflects the real shortcut state. |
| Contrast (found by the new automated check) | Light subtle text 4.3:1; success/warning text ~4.48:1; dark Stop button and primary hover with white text 3.3–3.8:1. | Token adjustments; all pairs ≥ 4.5:1. |

## Tests (run on 2026-10-17, all passing)

| Suite | Command | Result | What it covers |
|---|---|---|---|
| Typecheck | `npm run lint` | clean | the whole TypeScript codebase |
| Unit, fuzz, integrity, contrast | `npm test` | **214 passed** | Engine over thousands of seeds; the 14 × 4 × 5 exact-text matrix (typed buffer and sent keys); external adapter; quit-risk rules; 110 WCAG contrast pairs and palette checks; extension session logic |
| Web UI | `npm run build && npm run test:e2e` | **27 passed** | Every in-app control in Chromium, themes, persistence, layout at 6 widths, chaos clicking |
| Native | `npm run test:native` | **21 passed** | Session logic on a simulated desktop; key translation; 96 engine timelines; prepare-before-typing; Wayland/no-display refusal |
| Desktop end-to-end | `npx tauri build --no-bundle && npm run test:desktop` | **20 passed** | The real app on X11, typing into real Chromium (list in DESKTOP.md) |
| Desktop end-to-end, installed | `node e2e-desktop/run.mjs /usr/bin/typewriter` | **20 passed** | The same 20 checks against the installed `.deb` |
| AppImage | `APPIMAGE_EXTRACT_AND_RUN=1 ONLY="starts without\|types tricky text\|emergency stop" node e2e-desktop/run.mjs <AppImage>` | **3 passed** | Launch, exact typing, emergency stop |
| Packaging | `npm run desktop:build` | `.deb` 3.3 MB, `.rpm` 3.3 MB, `.AppImage` 79 MB | |
| Chrome extension (deferred) | `npm run test:extension` | **28 passed** | Unchanged behaviour; shared UI regression |

## Not verified

- **Google Docs itself.** No Google account here, and the network policy blocks Google. The input path is verified into a real Chromium text area. Use **Check copied text** the first time.
- **Other real third-party apps** (Word, LibreOffice, Notes…): not run here.
- **Windows and macOS.**
  - Installers are built by CI but haven't been launched.
  - The Windows code type-checks locally; the macOS code compiles only in CI.
  - Session-logic tests run on both in CI.
- **A real Wayland session.** Only the detection logic is tested (environment-based, plus the real app launched with `WAYLAND_DISPLAY` set).
- **The `.rpm` install.** Inspected, not installed (this is a Debian system).

## Known limitations

- Restart isn't offered in "Into another app" mode: the text would be duplicated.
- Linux:
  - It needs an X11 session.
  - There's no password-field detection, only the window-title check.
  - Texts with more distinct off-keyboard symbols than free key codes type slightly slower (80 ms per remap).
- Resume continues wherever the document's caret is.
- Installers are unsigned ($0 budget).
- Earlier limitations still apply:
  - no unfinished-session recovery after a crash;
  - adjacent-key typos assume a QWERTY layout.
