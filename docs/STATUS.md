# Status

_Last updated: 2026-10-17 (desktop-first release 1.1.0)_

- Live build board: https://claude.ai/artifact/6rEu1C45BZBPPsu2pPXV6p
- Desktop guide (install, workflow, permissions, limits): [`DESKTOP.md`](DESKTOP.md)
- Latest audit and gap analysis: [`DESKTOP-AUDIT.md`](DESKTOP-AUDIT.md)
- Chrome extension (**deferred**, not published): [`EXTENSION.md`](EXTENSION.md)

## Critical fixes after 1.1.0 (2026-10-17, branch `ccr-e747ce8b-l498oo`, not merged)

Two bugs reported from real use. Both had a root cause in the code; neither was a cosmetic or timing problem.

| Bug | Root cause | Fix | Evidence |
|---|---|---|---|
| **"Type into app" spends its time preparing and often never types** (desktop) | On Windows, `external_start` was a *synchronous* Tauri command that created the status window. Tauri documents that creating a window in a synchronous command deadlocks on Windows: the status window stayed blank and Start never returned. It only happened when the status window didn't already exist (it closes 6 s after a session), so it was "frequent", not constant. Around it: the UI showed "waiting" before the engine was ready, a Stop pressed during that time was lost, and the keyboard preparation had no time limit, no progress and couldn't be cancelled while waiting for the previous session's cleanup. | `external_start` is async. New **preparing** phase ("Getting ready", with progress) shown in the app and the status window. Limits: 15 s for the keyboard to become available (after that, preparing symbols up front is cut short and the rest are bound as they're typed), 20 s for the typing engine to answer at all (UI safety net), 3 min to pick a target window; each failure explains itself and types nothing. Stop/Cancel works in every phase, including before Start has returned. Each session carries an id end to end, and starts run one at a time, so a session stopped just before a new Start can't take over the new one (found by an independent review of this fix, with regression tests). A session that sent no keys is reported as failed, never as done. When the focused window can't be read (Windows: admin apps), the wait says so instead of waiting silently. | Unit and native regression tests fail on the old code and pass now. Linux desktop E2E 22/22 (new checks: Cancel while getting ready; Cancel and Start again at once). **Real Windows desktop** (GitHub `windows-2022` runner): the old build reproduced the bug: the status window never showed its controls and the app stopped responding (Desktop builds run 12). The fixed build passed all 6 Windows checks (run 16), including exact typing into a native Windows text box. |
| **The extension could never type** | `"debugger"` was an *optional* permission. Chrome doesn't allow it to be optional: `chrome.permissions.request` fails with "Only permissions specified in the manifest may be requested", with no prompt. The automated tests used a build that pre-granted it, which hid this. | `debugger` is a required permission (Chrome shows it once when the extension is loaded). A manifest test fails if any never-optional permission is listed as optional; a new test types with the release build (nothing pre-granted). The "Type into page" label was also cut off in a narrow side panel; fixed with a test at 320/360/400 px. | Release-build typing test: fails on the old build, passes now. Real Chromium 141 window, real clicks through the toolbar: the side panel shows the full UI on a fresh load and after a full browser restart, with no console errors; it typed exactly into a page; Pause, Resume, Stop and Alt+Shift+. worked. |

**The "blank pop-up":** the extension's side panel rendered correctly in every real-UI check (fresh load, restart, the old main-branch build too). The blank window that matches the report is the desktop **status window** on Windows, caused by the deadlock above. Which one you saw still needs confirming on your machine.

**Not verified here:** your laptop (a GitHub-hosted Windows runner is not your machine), real Google Docs, macOS. See [`MANUAL-QA.md`](MANUAL-QA.md).

### Test runs for these fixes (2026-10-17)

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run lint` | clean |
| Unit | `npm test` | **223 passed** |
| Native | `npm run test:native` | **all passed** (21 session tests, incl. preparation cut short, Stop before any key) |
| Desktop end-to-end (X11) | `npx tauri build --no-bundle && npm run test:desktop` | **22 passed** |
| Real Wayland | `npm run test:desktop:wayland` | **4 passed** |
| Extension | `npm run test:extension` | **30 passed** (incl. the release build typing with nothing pre-granted) |
| Extension, real browser UI | Chromium 141 on Xvfb, real toolbar clicks (xdotool), shipped `dist-extension` | side panel full UI on a fresh load and after a full restart; typed exactly into a page; Verified |
| Windows end-to-end | `node e2e-desktop/windows.mjs` on GitHub `windows-2022` (Desktop builds workflow) | old app (run 12): **frozen**; fixed app (run 16, `bd403ed`): **6 passed** |
| Builds | Desktop builds run 16 | Linux, Windows, macOS installers and native tests: **success** |

The Windows harness runs the real `typewriter.exe` through tauri-driver and plays the user with real `SendInput` clicks and shortcut presses; the target is a native WinForms text box. Screenshots are in the run's `windows-e2e-screenshots` artifact.

## Priority

The standalone desktop app is the primary product. The Chrome extension stays in the repository, built and tested, but is deferred. Chrome Web Store publication is not pursued, because the fee is not authorized.

## What works (verified by running it)

**Desktop app 1.1.0** (Tauri 2, Linux X11 verified):
- **Installers** (built from `ba653df`; checksums in [`RELEASE-1.1.0.md`](RELEASE-1.1.0.md)):
  - `.deb`: installed and tested;
  - `.AppImage`: launched and tested;
  - `.rpm`: verified and its binary tested on Debian, but not installed on an RPM system;
  - Windows `.msi`/`.exe` and macOS (Apple Silicon) `.dmg`: built by CI, not launched.
- **Core workflow:** paste text, choose duration or speed and realism; then start, pause, resume and stop. Both in the app's own preview and typing into another app.
- **Exact text:** the final text equals the source, including punctuation, spacing, line breaks, accents, CJK, emoji and combining marks. Typos are temporary.
- **Typing into another app:**
  - Countdown after Typewriter loses focus.
  - Pauses when focus leaves the target, refuses login windows, waits for held modifiers.
  - Emergency stop: Ctrl+Shift+Space, the mouse corner, or Stop.
  - Status window with progress, time left and Pause/Resume/Stop.
  - "Sent, not checked" until **Check copied text** confirms the document.
- **Interruptions:** the end-to-end checks confirm the source text is unchanged after the emergency stop, the mouse-corner stop and Stop in the status window, and after choosing "Keep Typewriter open". Quitting asks first when text would be lost or typing is running, and quitting mid-session removes every temporary key binding before the app exits.
- **Wayland:** detected even under XWayland and explained; typing into other apps isn't offered there. Tested with the real app as a Wayland client under Weston + XWayland.
- **Themes:**
  - Light: white, blue and purple. Dark: black, red and orange.
  - Both use the original dragon logo, which switches with the theme.
  - Every text/background pair passes WCAG AA automatically.

## Fixed in this release (found by testing, not assumed)

| Problem | Effect | Fix |
|---|---|---|
| No settle time after remapping a key code (**present in 1.0.0**) | Rarely, a character arrived as the code's previous symbol (`”` for `👍`), seen once with 1.0.0's typing code. | 80 ms settle after each remap; off-layout symbols are bound before the countdown starts. |
| Two sessions overlapping on Linux (*made reachable during this release*) | Once cleanup got slower in this release, a new session could mistake the previous session's temporary binding for a real key (`‘` for `文`). The real 1.0.0 build passes the same test 3/3: its window for this race was about 250 ms. | A keymap lock: a session can't read the keymap until the previous one has restored it. The regression check fails without the lock (2/2) and passes with it. |
| Tab and newline pre-bound as symbols (*introduced and fixed in this release*) | Wasted key codes; a reused code typed a Tab. | Control characters are skipped. |
| Readiness check used enigo (*made reachable during this release*) | While a Unicode-heavy session held the free key codes, the next start said "Keyboard input isn't available". | Linux checks X11 + XTest directly; enigo is only a fallback. Two codes are left free when the pool has at least 3. |
| Quitting left temporary key bindings behind (*found in the final code review*) | Quitting mid-session killed the typing thread before it removed its bindings (e.g. 日 語 中 文 stayed in the X keymap until the X server restarted). | The app postpones its exit until typing threads have stopped and restored the keymap (up to 10 s). Preparing a session also stops as soon as Stop is pressed. The quit check fails on the previous build and passes on this one (3/3). |
| Wayland under XWayland reported "Ready" | Typing then waited forever or failed. | Detected and explained up front. |
| Quitting discarded unsaved text silently | Text lost. | Confirmation dialog: keep open / save text and quit / quit. |
| Status window | No Pause; a dead shortcut hint if registration failed; no time left. | Redesigned; it reflects the real shortcut state. |
| Contrast (found by the new automated check) | Light subtle text 4.3:1; success/warning text ~4.48:1; dark Stop button and primary hover with white text 3.3–3.8:1. | Token adjustments; all pairs ≥ 4.5:1. |

## Tests (run on 2026-10-17, all passing)

| Suite | Command | Result | What it covers |
|---|---|---|---|
| Typecheck | `npm run lint` | clean | the whole TypeScript codebase |
| Unit, fuzz, integrity, contrast | `npm test` | **214 passed** | Engine over thousands of seeds; the 14 × 4 × 5 exact-text matrix (typed buffer and sent keys); external adapter; quit-risk rules; 110 WCAG contrast pairs and palette checks; extension session logic |
| Web UI | `npm run build && npm run test:e2e` | **27 passed** (locally on `654dbd8`; CI on every push) | Every in-app control in Chromium, themes, persistence, layout at 6 widths, chaos clicking |
| Native | `npm run test:native` | **22 passed** | Session logic on a simulated desktop; key translation; 96 engine timelines; prepare-before-typing, and Stop during preparation; Wayland/no-display refusal |
| Desktop end-to-end | `npx tauri build --no-bundle && npm run test:desktop` | **20 passed** | The real app on X11, typing into real Chromium (list in DESKTOP.md) |
| Desktop end-to-end, installed | `node e2e-desktop/run.mjs /usr/bin/typewriter` | **20 passed** | The same 20 checks against the installed `.deb`, including quitting mid-session: the process exits and no temporary key binding is left |
| AppImage | `APPIMAGE_EXTRACT_AND_RUN=1 ONLY="starts without\|types tricky text\|emergency stop\|back-to-back\|quitting mid-session" node e2e-desktop/run.mjs <AppImage>` | **5 passed** | Launch, exact typing, emergency stop, back-to-back sessions, quitting mid-session |
| RPM | `rpm -K`, `rpm -i --nodeps` into a scratch root, `rpm -V`, then 4 desktop checks on its binary | **OK, 4 passed** | Package integrity and binary; not dependency resolution on Fedora |
| Real Wayland | `npm run test:desktop:wayland` | **4 passed** | Installed app under Weston 13 + XWayland: GTK on Wayland (no X11 window), refusal message, Start disabled, native refusal of a direct start call, exact preview |
| GitHub CI | runs 39021580578 (CI) and 39021585270 (Desktop builds) for `81548d2` (app = `ba653df`) | **all jobs success** | Lint, unit, web, native, extension; Linux, Windows and macOS installers and session tests. The earlier macOS failure on `ba653df` was a test-timing defect, now fixed (see RELEASE-1.1.0.md) |
| Packaging | `npm run desktop:build` | `.deb` 3.3 MB, `.rpm` 3.3 MB, `.AppImage` 79 MB | |
| Chrome extension (deferred) | `npm run test:extension` | **28 passed** (locally on `654dbd8`; CI on every push) | Unchanged behaviour; shared UI regression |

## Not verified

- **Google Docs itself.** No Google account here, and the network policy blocks Google. The input path is verified into a real Chromium text area. Use **Check copied text** the first time.
- **Other real third-party apps** (Word, LibreOffice, Notes…): not run here.
- **Windows and macOS.**
  - Windows: the real app runs end to end on a GitHub-hosted Windows Server 2022 runner (6 checks, see above). The installers (`.msi`, `.exe`) are built by CI but haven't been installed and launched.
  - macOS: compiles and runs the session-logic tests in CI only; the app hasn't been launched.
- **A full GNOME/KDE Wayland desktop.** Tested under headless Weston with XWayland, not on a full desktop session.
- **The `.rpm` on Fedora/openSUSE.** The package and its binary are verified here, but `dnf`/`zypper` dependency resolution and the menu entry there are not.
- **Intel Macs.** There's no x86-64 macOS build.
- Step-by-step manual checks for all of these: [`RELEASE-1.1.0.md`](RELEASE-1.1.0.md).

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
