# Status

_Last updated: 2026-10-19 (1.2.0 + Smart Humanization on branch `ccr-e747ce8b-l498oo`, not merged)_

- Live build board: https://claude.ai/artifact/6rEu1C45BZBPPsu2pPXV6p
- Desktop guide (install, workflow, permissions, limits): [`DESKTOP.md`](DESKTOP.md)
- Latest audit and gap analysis: [`DESKTOP-AUDIT.md`](DESKTOP-AUDIT.md)
- Chrome extension (**deferred**, not published): [`EXTENSION.md`](EXTENSION.md)

## Smart Humanization (2026-10-19, not merged, not in the v1.2.0 release)

An opt-in exception to "the text is untouchable", approved by the owner (CLAUDE.md rule 3, SPEC §2a). Off by default. Owner decisions: opt-in only; local rules, no AI.

- **What it does.** When it's on, text you type or paste is checked against 8 style checks as soon as the editor settles (the same moment the estimate updates). Score = flagged applicable checks ÷ applicable checks × 100. At ≥ 50% (50% included), a rule-based rewrite prepares a copy and that copy is typed, with no approval step. Below 50%, too short (< 40 words or < 2 sentences), no applicable checks, or no safe edit: your text is typed as written.
- **Integrity.** The editor text is the original and is never changed. The copy is always derived from the original, never from an earlier copy. Quotations, citations, brackets, links, code, numbers, line breaks and edge whitespace are protected, and a safety check compares them; any difference, or any error, types the original and shows "Couldn't humanize" with the reason. The switch, tone and version choice are locked during a session. Any edit re-checks the text and clears a "type my original" choice.
- **Honesty.** The UI and docs call the score a writing-style heuristic. It does not detect AI authorship.
- **Code.** `src/humanize/` (checks, score, rewrite, safety check), `src/state/useSession.ts` (what gets typed), `src/ui/HumanizeStatus.tsx`, the switch in `src/ui/SettingsPanel.tsx`.

**Tests (run 2026-10-19 in this container):**
- Lint/typecheck: clean. Unit + integration (Vitest): **748 passed**, coverage 99.73% statements, 98.78% branches, 99.82% functions, 100% lines.
  - Engine: threshold below, exactly 50% (4/8 and 1/2) and above; no applicable checks; empty/short text; no safe edit; the real essay with its exact output and edit list; protected spans; Unicode/CRLF/edge whitespace; case; safety-check fallback; checklist-crash fallback.
  - Session hook: off types the original exactly; on, pasted text is humanized with no approval and the preview output equals the copy exactly; below 50% and short text unchanged; on → off restores exact-source typing; type original / type humanized; re-checks always run on the original (never on a copy); tone change; very long text and a start before the check settled; no change mid-session (playing and paused); stop then toggle; checklist failure types the original; corrupt saved settings repaired; desktop bridge receives the copy and its key events replay to exactly the copy.
  - UI: every status (checking, humanized, using original, no changes needed, no changes made, too short, failed), details, buttons and the locked state; the settings switch and tone; the editor subtitle.
- Browser (Playwright, real Chromium): **29 passed**, including a real Ctrl+V paste → "Humanized automatically" → output equals the copy exactly; type original; natural text unchanged; setting survives reload; off → exact original; switch locked while typing. This test found a bug (fixed): after "Type my original", editing and then pasting the same text again revived the old choice.
- Native (Rust): all suites pass (no changes there).
- Linux desktop E2E (packaged app, Xvfb + openbox, real Chromium window): **25/25**, including the new check: on, with typos Medium, the document gets the humanized copy exactly; off, the exact original.
- Windows desktop E2E (GitHub `windows-2022`, the installed NSIS app), run 31 (`61b9dde`): **15/15 run checks passed**, including the new one: humanize on with typos Medium types the humanized copy exactly into a real window; off types the exact original. Run 30 failed that check only because the harness read the fixtures from a CRLF checkout; the document text was already correct, and the harness now normalizes line endings. In both runs Opera's best-effort install failed, so the three Opera checks were **skipped** (Notepad-only in the three-target test). macOS and Linux builds: success. No release was published.

**Not verified:** your PC; how well the edits read to a human (that's a judgement, not a test); languages other than English (the checks and rules are English-only; other text will usually score low and be left alone).

## 1.2.0: closing, tab switching, the countdown, packaging (2026-10-18, not merged)

Three reports from real use on Windows: the app can't be closed (only Task Manager works), typing goes wrong when you switch tabs, and the status window is a blank small screen.

| Report | Root cause | Fix | Evidence |
|---|---|---|---|
| **Closing is impossible** | Typewriter minimizes itself while typing. Closing it from the taskbar asked "Quit Typewriter?" *inside the minimized window*, so nothing visible happened. A blank or hung page never answered the close request at all. | A close request first restores and focuses the window. If the page hasn't answered within 3 s, the window closes anyway. The status window is destroyed with the main window. | Linux desktop E2E: "closing while minimized" and "a page that doesn't answer" (both fail on the old build). Windows runner (run 23): closing the installed app from the minimized state, and with a hung page; it exited 3.9 s after the close request. |
| **Switching tabs** | A browser window has one handle for all its tabs. Switching tabs mid-session looked like the same window, so keys went into the other tab. | The active tab is told apart by the window title (unread counts and unsaved marks ignored). A tab or window switch makes typing **wait**, and it **continues by itself** when the original tab has focus again. Pause meanwhile makes it a normal pause; Resume in another tab continues there. | Native session tests (fail without the fix). Windows runner, real Chrome (run 23): Ctrl+Tab mid-session; it waited, nothing reached the other tab, and the original tab got the exact text. |
| **First characters missing** (found while testing the tab fix) | On Start, Typewriter minimizes and Windows focuses the window behind it. The countdown started *then*, before your click, so typing could begin during the click. A status-window capture right after Start already said "Starting in 3". | A click (left or right) or a switch to another window during the countdown starts it again, so it always runs in full after your last click. | Native tests (fail without the fix). Run 22 lost "Ty" in Chrome; run 23, with the fix, typed it exactly. |
| **First word lost when the click comes late** (found in Windows run 25) | The click/window-switch restart above only helps while the countdown is running. When Typewriter minimized, the browser behind it got focus *by itself*, the countdown started at that moment and ran out before the click into the page; "Hello" went nowhere. | A window that gets focus within 1.5 s of Start without a click is treated as the system's hand-over: the status window says "Click into your document" and the countdown starts from the click (or a switch to another window). Clicks are counted as events (Windows: a low-level mouse hook; X11: XInput2 raw presses; macOS: the system's event counter) from the moment Start is pressed, because polling the button missed short clicks (touchpad taps, automation). | Native tests (the hand-over test fails without the change). Linux desktop E2E 24/24 on the new build. Windows run 26 (`b07c2e3`): in both Opera checks the log shows "that window got focus by itself (Typewriter minimized): the countdown starts after a click", and the countdown started at the click; text exact. |
| **Blank status window** | **Not reproduced.** Real screen captures of the status window on the Windows runner (run 23) show it fully painted in every phase: waiting, typing, paused, completed, including while the main window is minimized. The check fails if a capture has fewer than 12 colours or one colour covers 97% of it. | The likeliest explanation is an old build still installed (see packaging). Up to 1.1.1 there were two Windows installers. | Captures in the run 23 log. Not checked on your PC. |
| **Packaging** | Every build was 1.1.1, and Windows got both an `.msi` (Program Files) and a `-setup.exe` (your user folder). Both could be installed side by side, and the Start menu could open the old copy. | Version **1.2.0**. Windows ships only the `-setup.exe`. **Settings › About** shows "Running from <path>" and warns when another installed copy exists; the diagnostics header records both. | Unit tests; the Windows E2E checks the path and that no second copy is reported. |

**Windows run 26 (Desktop builds, `b07c2e3`, GitHub `windows-2022`, the installed 1.2.0 app): all 17 checks passed.** That covers: Settings shows 1.2.0, the build and "Running from …\AppData\Local\Typewriter\typewriter.exe" with no second copy; the status window painted in every phase (≈120–136 colours); tricky text, pause/resume, focus pause, emergency stop; the same text into Notepad, an Opera text field and a Docs-like page in Opera, all exact; Docs-like pages in Chrome, Edge and Opera; the extension's APIs in Opera; Ctrl+Tab mid-session in Chrome (waited, nothing in the other tab, continued by itself, exact); closing while minimized and with a hung page (exited 3.8 s after the close request). macOS and Linux builds and the CI workflow: success.

Runs 24 and 25 failed in 3 and then 2 checks. In run 24 a "System Properties / Performance Options" dialog that the runner itself opened at boot (`SystemPropertiesPerformance.exe`, started 1 s after the desktop) covered the targets; the test now closes it and logs it. Run 25 found the late-click bug above.

**Coverage (2026-10-18):**
- Frontend (Vitest, enforced in CI at 95%): **100% lines, 99.74% statements, 98.94% branches, 99.8% functions**, 695 tests.
- Rust, typing engine (`cd src-tauri && cargo llvm-cov --release -p typewriter-native --summary-only`): **97.0% lines** (95.4% regions). Per file: session 98.5%, X11 key sender 97.7%, keys 97.2%, platform 93.9%, lib 100%. New real-X11 tests (`tests/x11.rs`, their own Xvfb; they skip where there's no Xvfb) cover the key sender, the real desktop and whole sessions. What's left is mostly error paths that need the X server to fail between two requests. Windows- and macOS-only code isn't compiled on Linux, so it isn't counted; it runs in the Windows E2E and the macOS session tests.
- Rust, app shell (`src-tauri/src/lib.rs`, Tauri commands and windows): not at 95%. It is exercised by the desktop E2E on Linux and Windows (`scripts/native-coverage.sh` merges that run), not by unit tests.

**Not verified:** your PC, real Google Docs (no Google login on the runner), macOS (built and session-tested in CI, never launched).

## Windows desktop: "countdown, then nothing appears in Google Docs in Opera" (investigation, 2026-10-17)

Reported from a real Windows PC with an unknown installed version: the status window counted down, then no text appeared in Google Docs in Opera. **Root cause: not found yet. Not reproduced.** Nothing below says it is fixed.

**What the Windows code actually does** (read, not assumed):
- Preparing is a no-op on Windows. The X11 keymap code is Linux-only (`cfg(target_os = "linux")`) and isn't compiled for Windows.
- Keys go through enigo 0.6.1 `SendInput` with `KEYEVENTF_UNICODE` (Enter and Tab as real keys). When Windows accepts fewer events than sent (for example, UIPI blocking an elevated target), enigo returns an error. The session stops and reports it; nothing is swallowed. On Windows the error now includes the OS error code.
- The target is whichever window has focus when the countdown ends (`GetForegroundWindow`). Before each key: a UI Automation password-field check, then the focused window is read again; a different window pauses typing.
- One wait has no time limit: after the countdown, typing waits while Windows reports Ctrl, Alt, Shift or the Windows key as held (`GetAsyncKeyState`). It shows "Waiting for you to release Ctrl, Alt, Shift or Cmd." This is a candidate, not a proven cause.

**Added to find it:** a typing-diagnostics log (Settings › About › **Copy typing diagnostics**; details in [`DESKTOP.md`](DESKTOP.md#typing-diagnostics)). It records each step with timings and error codes: Start, keyboard ready, focus changes, countdown, target, password-check time, held-key waits, first key sent and accepted, pauses, send errors, end. It also records the target's window class, keyboard-focus control, responsiveness and privilege level. It never records the text or window titles; a native test checks that. Settings › About also shows the version and the build (git commit), so a report can name the binary it came from.

**Real Windows run (GitHub `windows-2022` runner, Desktop builds run 21, `b548244`):** the NSIS installer was built and installed silently. The **installed** app showed "Typewriter 1.1.1, Build b548244" in Settings. The same short text (`Hello from Typewriter 123.`, 6 s, mistakes off, 3 s countdown) was then typed into three targets:

| Target | First key sent, after the target got focus (from the diagnostics) | Result | Notes from the diagnostics |
|---|---|---|---|
| Windows Notepad | 3.2 s (3 s countdown + 0.16 s) | completed, text exact | focus in `Edit`; password check 5 ms; first key accepted at once |
| A plain text field in Opera 137 | 3.2 s | completed, text exact | focus in `Chrome_WidgetWin_1`; password check 48 ms |
| A Docs-like page in Opera 137 (a local stand-in, **not Google Docs**) | 3.3 s | completed, text exact | password check 153 ms |

The harness's own "first character after the click" figures (3 s, 1.1 s, 0 s) start their timer after it has checked the click, so they understate the delay; the diagnostics times above are the accurate ones. In all three, the countdown ended, a target was chosen and the first key was accepted by Windows. The same run also typed the tricky Unicode text exactly into a Docs-like page in Chrome, Edge and Opera.

**What this does not cover:** real Google Docs (no Google login on the runner), your PC, and a non-elevated session. The runner runs everything with high privilege, so an elevation mismatch can't happen there. Next step: install the 1.1.1 build on the affected PC, reproduce, and send the copied diagnostics ([`MANUAL-QA.md`](MANUAL-QA.md) §1a).

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
| Unit | `npm test` | **224 passed** |
| Native | `npm run test:native` | **all passed** (24 session tests, incl. preparation cut short, Stop before any key, focus moving during the password check, the diagnostics never containing the text) |
| Desktop end-to-end (X11) | `npx tauri build --no-bundle && npm run test:desktop` | **22 passed** |
| Real Wayland | `npm run test:desktop:wayland` | **4 passed** |
| Extension | `npm run test:extension` | **30 passed** (incl. the release build typing with nothing pre-granted) |
| Extension, real browser UI | Chromium 141 on Xvfb, real toolbar clicks (xdotool), shipped `dist-extension` | side panel full UI on a fresh load and after a full restart; typed exactly into a page; Verified |
| Windows end-to-end | `node e2e-desktop/windows.mjs` on GitHub `windows-2022` (Desktop builds workflow) | old app (run 12): **frozen**; fixed app (run 16, `bd403ed`): **6 passed**; installed 1.1.1 app (run 21, `b548244`): **all 14 passed**, including the three-target check above and Chrome/Edge/Opera |
| Builds | Desktop builds run 17 (`25ae580`, version 1.1.1) | Linux, Windows, macOS installers and native tests: **success**. (Run 16's macOS job failed: a native test caught a key sent to a window that took focus during the password-field check; fixed by reading focus last, with a regression test.) |

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
