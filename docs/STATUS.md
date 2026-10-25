# Status

_Last updated: 2026-10-25 (1.2.0 + writing analysis with SlopMonster's checker on branch `ccr-e747ce8b-l498oo`, not merged)_

- Live build board: https://claude.ai/artifact/6rEu1C45BZBPPsu2pPXV6p
- Desktop guide (install, workflow, permissions, limits): [`DESKTOP.md`](DESKTOP.md)
- Latest audit and gap analysis: [`DESKTOP-AUDIT.md`](DESKTOP-AUDIT.md)
- Chrome extension (**deferred**, not published): [`EXTENSION.md`](EXTENSION.md)

## Writing analysis replaces Smart Humanization (2026-10-24, local commit, not pushed, not merged, not released)

SlopMonster's offline checker is now the only engine, and it never changes the text. See SPEC §2a/§2b and [`SLOPMONSTER.md`](SLOPMONSTER.md). The sections below this one, about Smart Humanization, the Humanization Studio and the checklist, describe features that no longer exist and are kept as history.

- **Removed:**
  - the checklist and its 50% threshold;
  - every rewrite rule;
  - the word diff, side by side and per-change restore;
  - the tone setting;
  - `src/humanize/`, `HumanizeStudio.tsx` and `HumanizeStatus.tsx`.

  What is typed is always exactly the editor text, with the analysis on or off.
- **Added:**
  - `src/analysis/`: the ported checker, plus `locate()`, which puts each hit at the characters the user wrote;
  - a Web Worker service, with a main-thread fallback, a 30 s limit and honest errors;
  - `AnalysisStatus.tsx` and `AnalysisStudio.tsx` (highlights, findings list, explanations, reviewed marks, Copy text, Check again);
  - Settings › Writing analysis ("Check writing style", "My number claims are backed up" = `--allow-proof`).

  An older version's Smart Humanization choice carries over as writing analysis on.
- **Large documents:** the old stack overflow (`push(...spread)` in the diff) and the diff's slow cases went away with the diff itself. Highlights are cut in one linear sweep (`segments()`), with no recursion and no spreads. The check runs off the main thread, and a newer text ends the older check's worker.
- **Not supported (documented, not imitated):**
  - rewriting of any kind, and SlopMonster's AI rewrite (`cleanse.sh`);
  - languages other than English;
  - any claim about authorship or detectors.
- **Not changed:** CLAUDE.md rule 3 still describes the Smart Humanization exception. Nothing uses it any more. Removing it is the owner's call.

### Windows run 43 and the cause of the "settings lost on close" failures (2026-10-24)

**Run 43** (`540cbe9`, release off):
- Builds: Linux, macOS and Windows passed. CI run 67 passed.
- Installer: `Typewriter_1.2.0_x64-setup.exe`, 2,845,698 bytes, SHA-256 `03D6C86DD36F9B8BE2A6595CE9EFFB2E5AE8CA6AD06471335AD5702A015DAC8C`.
- It installed silently over v1.2.0, and "UPGRADE PRESERVED SETTINGS" printed PASS (vacuous, see below).
- "Settings changed just before closing are kept" failed again. The Windows end-to-end suite, including the writing-analysis check, was skipped after it, so **writing analysis has not run on Windows yet**.

**Cause: the test harness, not the app (proven by run 43's driver-free step).**
- msedgedriver gives every WebDriver session a temporary WebView2 profile unless the browser arguments name one. tauri-driver passes `tauri:options.args` as those arguments, and the harness passed none.
- Started without WebDriver, the installed app wrote `settings`, `prefs` and `history` to its real profile (`EBWebView\Default\Local Storage`, 14:06:29).
- The WebDriver session that then changed settings (14:06:42) never touched that file.
- After v1.2.0's WebDriver session, the real profile had no Local Storage at all.

So in runs 36–43:
- every key the check changed (`settings`, `theme`) was "lost";
- the keys it didn't change (`prefs`, `history`) only looked kept, because every launch rewrites them with the same default values.

The "Windows bug already in v1.2.0" reported for run 37 was not shown by those runs, and the upgrade check's PASS in runs 41 and 43 proves nothing.

**Run 44** (`dda76fd`): the first fix didn't work, and the new guard caught it:
- v1.2.0's session, given `--user-data-dir=<the app's profile>`, still never wrote that profile ("last written never").
- The check stopped with "NOT THE APP'S PROFILE" instead of passing on nothing.
- So msedgedriver doesn't take the profile from browser arguments for WebView2.

**Fix, second attempt (local):** on Windows, `upgrade.mjs` no longer uses WebDriver.
- It starts the installed app like a user, adding only a remote-debugging port through `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, the attach method in Microsoft's WebView2 testing docs.
- Playwright attaches to the main window over CDP.
- The "profile written" guard stays.
- Tested here against a stand-in: Chromium serving the built app with its exact CSP. It attached, picked the main page, changed "Typing mistakes" and the theme, and read storage back. The Linux path still passes.

**First fix attempt (`dda76fd`, `e2e-desktop/upgrade.mjs`, `desktop.yml`):**
- On Windows each session passes `--user-data-dir=<LOCALAPPDATA>\app.typewriter.desktop\EBWebView` (the app's own profile).
- The check now fails ("NOT THE APP'S PROFILE") if the session never wrote that profile. Every launch saves its preferences, so a session in the real profile always does.
- v1.2.0 is now closed at once, like the new version, instead of after 70 s. The control step then shows whether it really loses anything.

Verified here: the Linux path passes (closed at once, 4/4 keys kept), and the guard's file check works on a fake profile. The Windows path needs the next CI run.

**Run 45** (`0d31ea0`, release off): **everything passed.** CI run 69 is green.
- **Builds:** Linux, macOS and Windows all passed.
- **Installer:** `Typewriter_1.2.0_x64-setup.exe`, 2,845,861 bytes, SHA-256 `D6D167C5193286EB7CB888FA8559A3435B48D473AC2C5B2891293556793BB885`.
- **Profile:** every attached session wrote the app's real profile; each "last written" time is after its session started.
- **v1.2.0, settings changed and the app closed at once:** kept 4 of 4 keys, with their changed values. **v1.2.0 never had a "settings lost on close" bug.**
- **Upgrade:** kept 4 of 4, with real values.
- **New app, closed at once right after a change:** kept 4 of 4.
- **Windows end-to-end suite: 18/18 passed** on the installed app. That includes writing analysis: the 5 findings highlighted where the checker puts them, the panel 729 px wide in a 1,028 px window with no overflow, and the text typed exactly with the analysis on and off.

**Storage flush removed (local commit after `0d31ea0`).**
- The Windows flush (`storage_flush`, added in `1694f72`, with its exit log from `a737472`) was built for a loss that came from the harness.
- It never did anything useful. It ran after the window was already destroyed and found "0 of 0 webviews". In 3 of 4 logged exits it waited its full 6 s limit; once, the browser process exited after 3 s.
- v1.2.0, which has no flush, keeps settings on an immediate close. So the flush, its exit log line and the two Windows-only dependencies (`webview2-com`, `windows-core`) are removed.
- Closing on Windows is no longer up to 6 s slower.
- Kept from `1694f72`: the guard that stops a second exit request from starting a second cleanup.
- The driver-free diagnostic step is also removed from `desktop.yml`; the corrected upgrade checks cover what it showed.
- Verified locally after the removal: `cargo check` is clean for Linux and the Windows target, native tests pass 97/97, and the rebuilt, installed `.deb` passes the desktop suite 27/27. Settings changed and the app closed at once are kept (PASS). Windows needs the next CI run.

**Run 46** (`c03923d`, flush removed, release off): CI run 70 green; builds passed on all three platforms.
- **Installer:** `Typewriter_1.2.0_x64-setup.exe`, 2,844,173 bytes, SHA-256 `0D146C9373DB0C0F188A086BC43B8B69F85A12C0D90D72878948E5AF5E4DC8C7`.
- **Without the flush, every settings check passed on the real profile:** v1.2.0 control 4/4, upgrade 4/4, new app closed at once 4/4.
- **Windows end-to-end: 16 of 18 passed.** Writing analysis passed: 5 findings, the panel 729 px wide, no overflow. Neither failure involves the code the commit removed, which only ran at exit. Both are test-harness fixes, committed locally:
  1. **Emergency stop: "text kept arriving after the emergency stop".** The app and the status window both said "Stopped" at 5%, and the final document ("Emergency stop check. ", 22 characters) matches that. The check read the target's text the moment the status said "stopped", but the target saves its text only every 150 ms, and a key sent just before the stop can still be in Windows' input queue. The pause check already waits 500 ms for this, and now this check does the same. It stays strict: at this test's pace (about 22 characters a second), a typer that kept going would add about 33 characters in the next 1.5 s.
  2. **The Chrome extension in Opera: "DevTools didn't answer"** (also in runs 32 and 34). The first DevTools call into the freshly loaded service worker was a single 5 s attempt. It now retries for up to 20 s, as the panel-page call right after it already did.

**Independent verification of `44551d3` (2026-10-25, local; Windows and Opera not run here).**
- **Emergency stop: no race in the app.**
  - `session.rs` checks for Stop before each event wait, during the modifier wait, and before each key of a burst.
  - `stop()` publishes "stopped" only after the last key was sent, then returns. So the 500 ms settle in the harness delays only the reading of the document, never the stop.
  - New native test `the_stopped_update_comes_after_the_last_key_and_counts_every_key_sent`: when "stopped" is published, 4 of 4 keys have been sent, none is sent afterwards, and its progress says 4.
  - Mutation check: a Stop that publishes "stopped" but keeps typing makes it fail. `session.rs` was restored unchanged.
  - The stop tests (17) passed 10 times in a row.
  - The Windows check is now stricter as well. After the stop, the document must be a shorter prefix of the text (mistakes are off), not only unchanged for 1.5 s.
- **Opera retry: bounded, but it wasn't before this fix.**
  - `until` retries every 150 ms and fails at its deadline with the last error ("Timed out after 20000 ms … (last error: DevTools didn't answer)"). The assertions after it are unchanged, and `finally` still kills Opera.
  - `cdpEval` had no timeout on opening the DevTools WebSocket, so one hung handshake could block the retry forever. Opening now fails after 5 s ("DevTools connection didn't open"), and a close before opening fails too.
  - Checked by running the real `until` + `cdpEval` code from `windows.mjs` (scratch probe):

    | Case | Result |
    |---|---|
    | Real Chromium | answered |
    | Missing worker | failed at 3 s, last error kept |
    | Hung handshake | failed at 5.2 s; `44551d3`'s version hung until killed |
    | Opens but never answers | failed at 5.2 s |
    | Silent twice, then answers | succeeded on the 3rd attempt |
  - The worst case is the deadline plus one attempt (about 30 s).
  - Opera isn't available here, so the Opera check itself has **not** run on this code. Opera is installed best effort in CI. If it's missing, the check prints "skipped", never a pass.
- **Local results on this code** (nothing needed a retry):

  | Suite | Command | Exit | Result |
  |---|---|---|---|
  | Native | `npm run test:native` | 0 | 98/98, including the new test |
  | Unit | `npx vitest run` | 0 | 770/770, 48 files |
  | Typecheck | `npm run lint` | 0 | clean |
  | Web build | `npm run build` | 0 | built |
  | Browser | `npx playwright test` | 0 | 45/45 |
  | Extension | `npm run test:extension` | 0 | 30/30 |
  | Package | `npx tauri build --bundles deb` | 0 | `.deb` 3,533,044 B; installed with dpkg |
  | Packaged desktop | `node e2e-desktop/run.mjs /usr/bin/typewriter` | 0 | 27/27, including quitting mid-session |
  | Close at once | `upgrade.mjs before`, then `check` | 0, 0 | 4/4 keys kept, PASS; the app exited by itself both times |
- **Not verified here:**
  - the Windows end-to-end suite;
  - the Windows upgrade checks;
  - the Opera check.

  They run only in the Desktop workflow on GitHub. CI run 70 tested `c03923d`, not `44551d3` or this fix.

### Tests (2026-10-24)

- **Unit** (Vitest): **770/770**; lint (tsc) clean. The 500,000-character paragraph is checked and cut for highlighting in about 0.65 s in Node, and the 800-paragraph document (333,541 characters, CRLF) in about 0.36 s. The parity test is unchanged: identical to `deslop.py` on 152 inputs, and the located findings rebuild that report exactly.
- **Browser** (Playwright, Chromium): **45/45** on the final code. The first run had 2 failures, both fixed in the UI rather than the tests:
  - "Check again" lost its confirmation because the panel is hidden while re-checking. The panel now confirms when the new result arrives.
  - The finding position wasn't formatted like the headline ("1335" vs "1,335").

  Long documents in the browser:

  | Document | Findings | Theme switch answered while checking | Panel shown after |
  |---|---|---|---|
  | 800 paragraphs (157,261 characters) | 1,335 | 169 ms | 7.0 s |
  | 500,000-character paragraph | 4,270 | 125 ms | 2.4 s |

- **Chrome extension** (`npm run test:extension`): first run 29/30. "text is progressive, not pasted at once" failed in the test fixture's `chrome.windows.create` call, before Typewriter's page opened, while a Rust release build was using the CPU. The rerun passed **30/30**. That test doesn't turn on writing analysis.
- **Native** (`npm run test:native`): **97/97**.
- **Packaged Linux app** (`.deb` built locally, installed with dpkg, `e2e-desktop/run.mjs` under Xvfb): **27/27** on the final harness.
  - The earlier run of the same build was 25/27. Both failures were harness bugs, not app faults:
    - WebDriver returns `null`, not `undefined`, for a missing element.
    - The old 500k sample has no SlopMonster findings: the app correctly said "Nothing to review", but the harness waited for "0 findings".
  - In the installed app:
    - every finding is highlighted exactly where the checker puts it (5 in the sample, 22 in an essay with curly quotes and accents);
    - the panel fits at 1360 and 1050 px with no overflow;
    - explanations and the nested pick work;
    - with typos on, the text is typed into another app exactly, with the analysis on and off;
    - a 498,000-character paragraph (6,000 findings, shown after 9.7 s; UI round trip 191 ms while checking) and an 800-paragraph essay (471,200 characters, 4,000 findings, 9.9 s; 48 ms) can be navigated, and **Copy text** gives exactly the text;
    - a 10-paragraph document is typed exactly.
- **Windows (CI run 45):** see the section above: builds, install and upgrade passed, settings are kept on an immediate close, and the Windows end-to-end suite passed 18/18, including writing analysis.
- **Windows installer (cross-built on Linux from this code):** `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Typewriter_1.2.0_x64-setup.exe`.
  - Version 1.2.0, 3,075,408 bytes, SHA-256 `a19c6b7ce99b7557ba9016f4c569e0198fa6e21c476240724db229760a43cec2`.
  - Unsigned, GNU target, built with `npx tauri build --target x86_64-pc-windows-gnu --bundles nsis`. It ships `WebView2Loader.dll`.
  - **Checked:** extracted with 7-Zip, it contains this build's `typewriter.exe`, the same size and differing only in Tauri's 3-byte bundle-type marker.
  - **Not checked:**
    - a Wine launch of the extracted exe showed no window within 50 s, in two tries (WebView2 isn't available under Wine);
    - it has not been installed or run on Windows.

    So install, launch, writing analysis and typing on Windows are unverified for this file. `e2e-desktop/windows.mjs` was updated for writing analysis, but it runs only in CI after a push, which hasn't been approved. The MSVC installer that CI builds is the one the Windows end-to-end job verifies.

## SlopMonster's checks in the Humanization Studio (2026-10-23, not merged, not released)

SlopMonster (github.com/ItsssssJack/SlopMonster, MIT, Jack Roberts) is the project in the reference video. Audit, what was integrated and why, calibration and verification: [`SLOPMONSTER.md`](SLOPMONSTER.md).

- **Integrated:** its checker (`deslop.py`), ported rule for rule to TypeScript (`src/humanize/slopmonster/`). In the checklist it adds three scored checks (overused buzzwords, stock phrases and constructions, tidy lists of three) and two notes that are never scored (dash, hyphen and semicolon habits; numbers to double-check). Each is marked "SlopMonster" in Style checks. Its MIT notice is in Preferences › About › Open-source notices.
- **Rewrite rules from its editing guidance** (local, fixed): "Here's the thing:" and "The truth is," openers, stacked hedges, "very unique", "quite literally", "more than just", "leverage" as a verb → "use", "harness the power of" → "use". The Studio explains each one as SlopMonster's.
- **Not integrated:** its rewriter (`cleanse.sh`) sends the text to an AI model. Typewriter has no AI and no network, so it is left out. The video presents it as part of the tool.
- **Unchanged:** the 50% threshold, the score formula, exact typing of the prepared text, the original never changing, per-change restore, themes and layout.
- **Diff fix found on the way:** three changes in a row ("Furthermore, teachers leverage numerous" → "Teachers use many") were split at the wrong spaces, so restoring one gave "Teachers teachers many". The re-split pass now also tries the last two changes together.
- **Rules dropped after review:** "help you to" → "help you" ("helps you to your seat"), "Let's break it down." and "Here's the thing." / "Here's the thing," (literal or continuing uses). These are now reported only.
- **Playwright helper race:** `setDuration` sometimes left 14 s instead of 4 s (3 times in 600 runs). The duration assertion caught it. Fixed by setting seconds before minutes (details in `e2e/app.spec.ts`).
- **The Studio's "Copied" note could vanish early (app bug):** a second copy within 4 s of the first got no fresh confirmation (same text, so React skipped the update, and the first copy's timer cleared it). This is what made the packaged-app large-document check's **Copy revised** time out now and then (25/26 earlier, 26/27 today). Each note now restarts its own 4 s; a unit test fails without the fix and passes with it.

Tests run (2026-10-23, this change):
- Lint/typecheck clean. Unit + integration (Vitest, coverage): **848 passed**, 0 failed (99.7% statements, 98.66% branches, 99.85% functions, 100% lines). New tests include:
  - parity with SlopMonster's own Python on 152 inputs, plus its ported rule tests;
  - calibration;
  - integration (checks, rules, explanations, per-change restore, CRLF/emoji/tabs, no network APIs);
  - the three-change diff split.
- Upstream's own suite (`python3 tools/test_deslop.py`) passes on the audited commit.
- Playwright: **44 passed**, 0 failed, in each of the last 3 full runs. The two affected Studio tests also passed 60 of 60 repeats.
- Installed `.deb` (binary identical to the packaged one), full desktop suite: **27 passed, 0 failed, twice in a row**, including "SlopMonster's checks in the packaged app". The run before the note fix had 26/27, failing on the copy note above.
- AppImage (launch, tricky text, Smart Humanization, SlopMonster, large documents, emergency stop): **6 passed**, 0 failed.

Local installers with SlopMonster's checks (`src-tauri/target/release/bundle/`, version 1.2.0):

| File | Bytes | SHA-256 |
|---|---|---|
| `deb/Typewriter_1.2.0_amd64.deb` | 3,536,128 | `f3f0026380991ed0e56396ef9b385370caec7a5c5521aecc7d0c58e3b447fd5c` |
| `rpm/Typewriter-1.2.0-1.x86_64.rpm` | 3,542,083 | `99baf3107496bba51e1b60ad72db5d2f3f67683d67222e0540b30d3c8272f5e9` |
| `appimage/Typewriter_1.2.0_amd64.AppImage` | 82,385,400 | `6ceb32f552d777c0e4311e628c4325458e3f77acd102496487fc8bef2de57511` |
- **Windows run 39** (`732dfa6`): **the Windows and macOS builds failed** (`vite build`: "PARSE_ERROR … src/humanize/slopmonster/license:1:4"). The license module `license.ts` sat next to upstream's `LICENSE` file. On the case-insensitive Windows and macOS file systems, `import "…/slopmonster/license"` loaded the text file. Linux is case-sensitive, so every local build passed. No Windows installer was produced, and nothing was installed or run on Windows. **Fix:** the module is now `notice.ts`, and `src/paths.test.ts` fails if two paths under `src/` differ only by case (checked: it reports the old pair).
- **Windows run 40** (`735a1f0`, release off; CI run 64 green): **all three builds passed**, so the case fix works on Windows and macOS. The Windows installer artifact `typewriter-windows` is 2,829,749 bytes zipped, SHA-256 of the zip `157dd757b0d7379239dc71f5e8fd3459eed9266145a8795306223e0805644c65`. **The Windows end-to-end job stopped at its first step, before the new installer was installed:** the published v1.2.0 lost `typewriter:settings` and `typewriter:theme` again, even 70 s after the change; `prefs` and `history` were kept. This is v1.2.0's own bug (run 38 lost them after 10 s too), and no wait makes the control pass. **Change (local, not yet run on Windows):** the control (`upgrade.mjs control`) now records which keys the old version really kept and drops the ones it lost by itself. The upgrade check then requires every kept key with unchanged values and the same UI, and fails if none were kept. The new app's settings-on-close check is unchanged and still requires every key. Checked on the installed Linux app: before → control → after PASS; a key that was never stored is dropped and the rest still checked; a state with no kept key FAILS.
- **Windows run 41** (`16cb034`, release off): all three builds passed. The new `Typewriter_1.2.0_x64-setup.exe` is 2,848,148 bytes, SHA-256 `B0B30653AD8E4463010536AD200773CC3729377D27E9431C13B7F94397F0B99B`. **Passed on Windows:** v1.2.0 installed and kept `prefs` and `history` (it lost `settings` and `theme` by itself, as before). The new setup.exe installed silently over it. The upgrade kept both of those keys unchanged, and the UI was the same (**UPGRADE PRESERVED SETTINGS: PASS**). **Failed: the settings-on-close fix does not work on Windows.** The new app, closed with the title bar's X at once, also lost `settings` and `theme`. The app exited about 6.5 s after the close was sent. That is the fix's 6 s limit: WebView2's browser process did not exit in time. A likely cause, not proven, is that the test's WebDriver connection (msedgedriver) keeps the browser process alive, so the harness may be what blocks the fix. Users without a driver attached may behave differently. The full Windows end-to-end suite (including the SlopMonster checks) did not run after this failure.
- **CI run 65** (`16cb034`) failed in one Playwright test: `setDuration` read "59" in Seconds where "1" was set; the same code passed CI run 64. Most likely "1" was typed after a "13" that came back (2:13 → "131", clamped to 59, then minutes 0 → 0:59). It did not happen in 330 local runs (180 under full CPU load). Under artificial stress (the text changed every 2 ms), real key presses failed once in 40, and once the fields read "2:60", which whole-second durations cannot produce. Root cause not found; the test was not changed.
- **Windows setup.exe cross-built on Linux** (2026-10-24, from this fix, not from CI): `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Typewriter_1.2.0_x64-setup.exe`, version 1.2.0, 3,077,331 bytes, SHA-256 `04251a096398508ef66ef68fb44136cf6bcf222acefc18ba39941e667395201e`. Built with `npx tauri build --target x86_64-pc-windows-gnu --bundles nsis` (MinGW-w64 and NSIS 3.09), because the Microsoft toolchain behind the MSVC build in `desktop.yml` cannot be downloaded here. It is unsigned, and it ships `WebView2Loader.dll` next to `typewriter.exe` (the GNU build loads it at run time; the MSVC build links it in). The installed `typewriter.exe` differs from the plain build only in Tauri's 3-byte bundle-type marker. **Checked:** under Wine, the extracted `typewriter.exe` loads `WebView2Loader.dll` and opens its window. **Not checked:** the Wine install itself stops with exit code 2, because the WebView2 runtime is missing and its bootstrapper cannot be downloaded here. It has not been installed or run on real Windows, so install, launch, the Studio, typing, the settings-on-close fix and the upgrade are all unverified for this file. The CI-built MSVC installer remains the one the Windows end-to-end job verifies.

## Installers with the Humanization Studio (2026-10-23, local build, not merged, not released)

Built with the project's own process (`npx tauri build`, as in `.github/workflows/desktop.yml`), from `4d5e742` plus the changes below. Version 1.2.0, identifier `app.typewriter.desktop`.

Fixed while packaging:
- **The sidebar said "v1.1" in the 1.2.0 app** (hard-coded in `App.tsx`). It now shows the version from `package.json`, like Settings › About; a unit test checks it.
- **Windows harness race (run 35, 17/18):** the Smart Humanization check read the document before typing, because the status window still showed the previous session's "completed". It now waits for the new session, then for typing, then for completion. The Linux harness had the same pattern (a stale "Sent"); fixed the same way.
- **A rare Playwright failure** (1 of 344 runs: "the switch is locked while typing" saw "Typing" for 15 s on a 6 s session). Not reproduced in 80 more runs (40 under full CPU load) or in 40,000 seeds of the playback engine; the likeliest cause is a duration that didn't take effect. `setDuration` now checks that the mode, minutes and seconds really took effect, so a repeat fails there with a clear message instead of a timeout.

New checks:
- **Packaged-app large documents** (`e2e-desktop/run.mjs`): a 500,004-character single paragraph and a 471,200-character, 800-paragraph essay in the installed app. Each is humanized automatically and the Studio shows every change. **Copy revised** (pressed with a real key press, since the webview only lets a user gesture write to the clipboard) gives exactly the engine's humanized text. Restoring the 3rd change gives exactly that mix, and undoing the restore gives the humanized text back. Then a 10-paragraph humanized document with one change restored is typed into another app, exactly. The expected texts come from the app's own humanizer, bundled from source by the harness; every observed text comes from the packaged app.
- **Upgrade keeps settings** (`e2e-desktop/upgrade.mjs`): settings are changed and saved in the installed old version, the new version is installed over it, and every saved key and field must survive, with the UI showing the same choices.
- **Windows CI** (`desktop.yml`, not yet run, needs a push): the Windows end-to-end job now installs the exact `setup.exe` the build job uploads (before, it rebuilt its own copy, so the downloadable file itself was never installed). It first installs the published v1.2.0 pre-release and saves settings in it, then upgrades and checks them. The build job prints each installer's SHA-256.

Local installers (Linux container; `src-tauri/target/release/bundle/`; rebuilt with the Windows storage fix, whose exit change also runs on Linux):

| File | Bytes | SHA-256 |
|---|---|---|
| `deb/Typewriter_1.2.0_amd64.deb` | 3,531,602 | `71a8af170ff3e3c0f838eba6fb82b3fb71405885c5a5571e5e961e1a4a09d764` |
| `rpm/Typewriter-1.2.0-1.x86_64.rpm` | 3,538,102 | `ed30f6798f98a0b52f85c809193e760f0374fc7d41191258005c18bb57d51b32` |
| `appimage/Typewriter_1.2.0_amd64.AppImage` | 82,381,304 | `9849c725cd139d11e1ed9931b2276b563469fcfbe2ccdd4a96d28d91924fdbb0` |

Tests run (2026-10-23):
- Lint/typecheck clean. Unit + integration (Vitest, coverage): **816 passed**, 0 failed (99.68% statements, 98.63% branches, 99.85% functions, 100% lines). Playwright: **43 passed**, 0 failed (in 7 full runs before the duration assertion only that one rare failure; 43/43 after it).
- `.deb`: v1.1.0 installed, settings changed and saved in it, then the 1.2.0 `.deb` installed over it with dpkg: all 4 stored keys and every field kept, same choices shown (**PASS**, run twice). The installed `/usr/bin/typewriter` is byte-identical to the packaged one. Full desktop suite against it: **26 passed, 0 failed** (an earlier full run had 25/26: the large-document check's second **Copy revised** got no answer within 20 s; it then passed 6 of 6 times, alone, after the check before it, and in the final full run. The harness now prints where the key press went if it happens again).
- Large documents in the installed app: 500,004-character paragraph, Studio shows 34,883 changes after 2–4 s, then the page is busy for up to about 4 s while it lays out every highlight; restoring one change 0.5–1.1 s. 471,200-character essay: 7,999 changes after 4–5 s; restoring one change about 0.4 s. All texts exact.
- AppImage: launch, tricky text, Smart Humanization, large documents and emergency stop: **5 passed**. `.rpm`: digests OK, files verified in a scratch root, its binary passed launch and Smart Humanization: **2 passed**. Not installed on Fedora/openSUSE.
- **Windows: not built or installed here.** NSIS installers are built on Windows; the established process is the `Desktop builds` workflow. This container has no Windows and can't download CI artifacts.
- **Windows run 36** (`d9d8eb7`, build only, no release): all three builds passed. The installer is `Typewriter_1.2.0_x64-setup.exe`, 2,842,695 bytes, SHA-256 `7249b1f1687dcb0ce692ad3be2af1aeb124d364b4a89e2ba08f1b5a7476d334b`, artifact `typewriter-windows`. The Windows job installed the published v1.2.0 and saved settings in it, then installed this file over it silently. **The upgrade check failed**: `typewriter:prefs` and `typewriter:history` were kept, but `typewriter:settings` and `typewriter:theme` were missing (the UI showed defaults). The rest of the Windows end-to-end run was skipped. The lost keys are exactly the two written about 1 s before the harness ended its WebDriver session, which kills the app process; WebView2 writes localStorage to disk lazily. So this is probably a write that was never flushed, not the installer deleting data, but that was not proven. The check now closes the app like a user (the title bar's X) and waits for it to exit, and first reopens the old version as a control. Linux passes all three stages (1.1.0 → 1.2.0).
- **Windows run 37** (`faf7a1a`; **its conclusion was wrong**: the loss came from the test harness, and run 45 showed that v1.2.0 keeps settings on an immediate close; see "Windows run 43" above): builds passed; the setup.exe is 2,842,290 bytes, SHA-256 `1d90ec371240074cb4192ed614904000f569995310e600c50ad0c3ed195644a5`. **The control failed, before any upgrade:** the published v1.2.0 was closed with the title bar's X (it exited by itself), then reopened. `typewriter:settings` and `typewriter:theme` were gone again; `prefs` and `history` were kept. So the loss is not the installer's. **It is a Windows bug in the app, already in the released v1.2.0:** settings changed shortly before closing the app are lost. The lost keys were written 1–2 s before closing; the kept ones about 10 s before. The likely cause (not yet proven) is that WebView2 commits localStorage to disk after a delay of a few seconds, and the app exits before that happens. Linux (WebKitGTK) is not affected. The Windows end-to-end suite never closed and reopened the app with fresh settings, so this was not caught before. **Fix (not yet verified on Windows):** before exiting, Typewriter now closes its webviews and waits for WebView2's `BrowserProcessExited` event, at most 6 s, so its browser process can finish writing storage (`storage_flush` in `src-tauri/src/lib.rs`; Windows only, same `webview2-com` version as Tauri's webview layer). The Windows job now gives v1.2.0 10 s before closing, which tests the timing cause, and then checks that the new app keeps settings changed just before an immediate close. On Linux, the rebuilt `.deb` keeps settings changed just before an immediate close (PASS), and the full desktop suite passed **26/26** (a first run had 23/26: the status window's Pause click timed out, and the next two checks failed after it; all three passed when re-run alone, and then the whole suite passed). The new setup.exe was not installed in run 37; in run 36 it installed silently and the installed app launched and showed its UI, but the end-to-end checks did not run.
- **Windows run 38** (`1694f72`, the fix): all three builds and the native tests passed. **The control failed again, even with 10 s between the change and closing:** the published v1.2.0 kept `prefs` and `history` (written as it started) and lost `settings` and `theme` (written about 25 s after it started, 10 s before closing). So it is not a delay of a few seconds. This fits Chromium's page-storage rate limit: after one write to disk, the next one is held for up to about a minute, and it is written out only when the browser process shuts down cleanly, which v1.2.0 never waited for. The fix in `1694f72` waits for exactly that shutdown, but run 38 stopped before reaching it. **The new app's immediate-close check, the upgrade check and the Windows end-to-end suite did not run in run 38, so the fix is still unverified on Windows.** The control now gives v1.2.0 70 s before closing (`desktop.yml`), long enough for the held write, so the run can reach the new app's checks.

## Humanization Studio (2026-10-20, not merged, not in the v1.2.0 release)

Extends Smart Humanization (below). Automatic humanization is unchanged: no approval step, 50% threshold, the original typed exactly when off. See SPEC §2b.

- **Diff** (`src/humanize/diff.ts`):
  - a Myers word-level diff, run line by line and then word by word inside changed lines (Unicode word segmentation, so emoji, combining marks and CJK are never split);
  - small, exact clean-ups so changes read as whole words: removals slide to start at a word, a lone shared space can't split one edit, and adjacent replacements are split where they share words;
  - a per-call limit; a block over it (or any block over 50,000 characters) is split into sentences and diffed sentence by sentence (so a long one-paragraph text still gets word-level changes), and only if that also fails does it become one coarser but still exact change.
  - Every segment is an exact slice of the original and of the revised text, so both rebuild character for character (tested, including 300 random cases).
- **Explanations** are matched to the rewrite's recorded edits only when the edit's text really occurs over that spot, covers the removed text, and accounts for the added words. Otherwise they say "Wording adjusted for flow".
- **Session** (`src/state/useSession.ts`):
  - the original stays immutable, and the prepared text = the revised text with any kept-original changes put back;
  - that prepared text is the only thing loaded into the player or sent to the desktop engine;
  - kept choices are tied to one result: they are dropped on any edit, tone change or re-run;
  - re-run always checks the original;
  - nothing changes while typing.
- **UI** (`src/ui/HumanizeStudio.tsx`, styles in `app.css`, colors in `tokens.css`):
  - the Studio is its own panel: under the editor and playback panels in windows wider than 1260 px, and below Settings across the full width from 1025 to 1260 px (where the main column is too narrow for two texts); the status line under the editor keeps the score and offers **Review the changes**, which scrolls to the Studio and focuses it;
  - Side by side puts the two texts next to each other above 640 px of window width and stacks them below that;
  - three views, highlights on/off, changes only (in pages of 200), previous/next with Alt+↑/↓, an explanation card, keep original wording / use revised wording, copy revised/original, restore original, re-run on original;
  - the failure status is now "Humanization unavailable … Your original text will be typed, exactly as written."
  - Highlight text and lines pass WCAG contrast checks in both themes (`contrast.test.ts`).
  - Unchanged text renders as plain text nodes, and the selection is moved in the DOM without re-rendering the text.

**Tests (run 2026-10-20 in this container):**
- Lint/typecheck: clean. Production build: OK.
- Unit + integration (Vitest): **802 passed**; coverage 99.68% statements, 98.6% branches, 99.84% functions, 100% lines.
  - New: diff (no change, empty, additions/removals/replacements, punctuation/spacing/case, line breaks and CRLF, repeated phrases, Unicode, the real essay, 1,440 changes in 0.1 s, fallbacks, random property test, reverts, explanations including the fallback); session (diff, revert, typed payload equals the reverted mix, revert-all types the original, reverts dropped on edit/tone, locked while typing, re-run on the original, no diff when unchanged); Studio UI (16 tests: views and sync, navigation and keyboard, explanations, revert, highlights never change the prepared text, changes only, copy and its failure, restore, re-run, locked session, long document with paging, punctuation/spacing/addition rendering); contrast for the new colors.
- Browser (Playwright, real Chromium): **32 passed**. New: full Studio flow, ending with a per-change revert typed exactly with no markup, copy both versions, re-run, restore; both themes with real computed colors and decoration (underline vs line-through), plus screenshots; a 94,000-character document (Studio shown ≈2.3 s after the text was set, 20 steps + 2 view switches ≈1.5–1.9 s).
- Native (Rust): all suites pass (no Rust changes).
- Linux desktop E2E (packaged app, Xvfb): **25/25**, including: humanized copy exact (typos on); one change kept as original → exactly that mix in a real window, with no markup; off → exact original.
- Windows desktop E2E (GitHub `windows-2022`, the installed app), run 32 (`f987d7a0`):
  - The Studio check passed in both attempts: humanized copy exact; one change kept as original, exactly that mix; off, exact original.
  - Attempt 1 failed one unrelated check: "the Chrome extension in Opera", where Opera's DevTools didn't answer while starting.
  - Attempt 2, a single re-run of that job, passed **every check**, the Opera ones included.
  - The macOS and Linux builds succeeded. No release was published.

**Limitations:**
- Explanations exist only for the rewrite's own rules.
- The checks and rules are English-only.
- A diff limit means a huge difference shows as one large but exact change: when the sentence counts differ and more than 1,500 sentences changed (for example every sentence edited and one removed). Humanization doesn't add or remove sentences, so it doesn't produce this.
- Very long texts are slow but complete: diffing a 500,000-character single paragraph takes about 2.5 s in Node, and the browser shows the Studio about 6 s after the text is set (humanizing it is part of that). Splitting text into words (`Intl.Segmenter`) is most of the time.

### Merge-readiness pass (2026-10-20)

Issues found and fixed:
1. **Side by side stacked in the narrow editor column.** Measured in Chromium (production build): at 1440 and 1280 px the two texts stacked, and at 1280 px the columns overflowed the panel. The Studio is now its own panel; status line → **Review the changes**.
2. **A long single-paragraph text showed as one whole-text change.** The word-level diff gave up past its limit (e.g. "Moreover, we utilize it in order to learn. " × 3000, 129,000 characters, 1 change). It now falls back to a sentence-by-sentence diff first: 8,999 word-level changes, both texts rebuilt exactly.
3. **Columns too narrow in 1025–1260 px windows** (found by Windows run 33 on `44cf88f`, whose window was 1028 px: columns 161 + 161 px). The sidebar and the Settings column leave the main column about 400 px there. Fix: in that range the Studio goes below Settings across the full width, and Settings is not sticky there (it slid over the Studio and blocked clicks, caught by a new "nothing covers the Studio" check).
   - Measured after, Chromium, column widths in px: 1920 → 588+588, 1440 → 382+382, 1280 → 302+302, 1260 → 466+466, 1100 → 386+386, 1028 → 350+350, 1025 → 349+349, 1024 → 466+466, 900 → 404+404, 700 → 316+316 (all side by side); 390 → stacked. No horizontal overflow and nothing on top of the Studio at any width.
   - Packaged Linux app (WebKitGTK): 1360 px window → 342+342; resized to 1050 px → 361+361.

Audited with new tests (no defect found): exactly 50% on the **real** checklist (casual tone, 4 of 8 checks) is rewritten and typed, 3 of 8 is not; off, and on with nothing to change, types Unicode, emoji, combining marks, CRLF, tabs, no-break spaces and repeated blank lines exactly; empty and blank input produce no Studio and nothing to revert; a change put back in the Studio reaches the desktop engine as exactly that plain text (source and replayed key events), with no markup; a checklist failure types the original (existing test). There is no model, network call or timeout in this feature (local rules only), so "model error / timeout" reduces to the checklist-failure path.

Tests run in this container for this pass:
- Lint/typecheck: clean. Production build: OK.
- Unit + integration (Vitest): **811 passed**, 0 failed (48 files); coverage 99.68% statements, 98.58% branches, 99.85% functions, 100% lines.
- Browser (Playwright, real Chromium, production build): **43 passed**, 0 failed (11 new layout tests, 390–1920 px).
- Native (Rust): 9 + 38 + 32 + 3 + 15 passed, 0 failed.
- Linux desktop E2E (packaged app, Xvfb): **25 passed**, 0 failed; the Studio check now also measures the side-by-side layout in the real webview, at 1360 px and at 1050 px.
- Windows desktop E2E (GitHub `windows-2022`, the installed app, 1028 px window):
  - Run 33 on `44cf88f`: **17 of 18 passed**. Failed: the Smart Humanization check at its new layout assertion (issue 3 above, columns 161 + 161 px), before it reached typing.
  - Run 34 on `4d5e2ed` (the fix), attempt 1: 17 of 18. The Studio check passed (side by side, columns 343 + 343 px, no overflow; humanized copy, kept-original mix and original all typed exactly). Failed: "the Chrome extension in Opera" (Opera's DevTools didn't answer), the same failure as run 32 attempt 1. The merge-readiness commits do not change the extension (the branch as a whole does, compared with main: earlier commits changed `src/extension/` and its tests).
  - Run 34 attempt 2, a single re-run of that job: **18 of 18 passed**, including Notepad, a plain text field in Opera and a Google-Docs-like page in Opera, Chrome and Edge (stand-ins, not Google Docs), each exact. The macOS, Linux and Windows builds succeeded. No release was published.
- Not verified: real Google Docs, and the owner's own PC.

### Merge-blocker fixes (2026-10-20, after the final audit)

The final read-only audit found blockers in the sentence-level fallback added by `44cf88f`. Fixed:
1. **Crash on very large humanized texts.** `diffTokens` appended pieces with `out.push(...p)`, which overflows the call stack past about 120,000 pieces. Before: a 471,000-character, 800-paragraph essay made the whole app go blank in Chromium ("Maximum call stack size exceeded"); a 500,000-character single paragraph threw in Node. Now appended one at a time. The four clean-up passes after grouping also used `splice` inside loops (quadratic in the number of changes); each now rebuilds the list in one sweep.
2. **Near-freeze in the re-split pass.** It tried every pair of spaces in two neighbouring replacements and recounted the words for each pair: a 5,857-character input (two 751-word rewritten sentences) did not finish in 45 s, against 88 ms before `44cf88f`. Now each split point's words are counted once, and edits with more than 16 spaces a side keep Myers' split (the rewrite rules never make edits that long): 140–150 ms.
3. **Wasted work on large blocks.** A block over 50,000 characters was split into words and diffed whole (which fails past 1,500 edits, after seconds), then split into words again sentence by sentence. It now goes sentence by sentence first.
4. **Flaky unit test.** The long-document Studio test checks an 8 s render budget but ran under the default 5 s timeout; with coverage it took 5.1–6.1 s and failed, and once a click still pending after the timeout landed in the next test. It now has an explicit 30 s timeout (about 5× the measured time) and queries only its own render.
5. The Studio heading is an `h2` (a top-level panel, like Your text, Playback and Settings). SPEC §2b now describes the sentence-level fallback. The run 34 note no longer says the branch doesn't touch the extension (the merge-readiness commits don't; earlier commits on the branch do).

Tests run in this container (2026-10-20), on the working tree:
- New regression tests: 500,000-character single paragraph and 800-paragraph essay (no crash, exact rebuild, expected change counts), the re-split freeze input (under 5 s, exact), and large inputs with different sentence counts, repeated phrases and completely different text (exact, no change with before = after). On the `75920d6` code the two crash tests fail with "Maximum call stack size exceeded" and the freeze test does not finish in 40 s.
- Lint/typecheck: clean. Production build: OK.
- Unit + integration (Vitest, with coverage): **815 passed**, 0 failed, in each of 3 full runs; coverage 99.68% statements, 98.63% branches, 99.85% functions, 100% lines. The long-document Studio test passed 7 of 7 runs with coverage (4.7–6.0 s in the 4 runs that printed its time).
- Browser (Playwright, real Chromium, production build): **43 passed**, 0 failed.
- Benchmarks (Node, 3 runs each, all exact): 500,000-character paragraph 2.4–2.6 s (34,883 changes); 471,000-character essay 0.9–1.0 s; 589,000-character essay 1.0–1.2 s; 498,000 characters on one line 0.55–0.67 s; the freeze input 0.14–0.15 s; 100,000 characters of completely different text 0.74–0.89 s; 800 shuffled sentences 0.66–0.74 s; "a. " × 66,000 → "a! " 3.2–3.6 s (66,000 changes; every sentence differs).
- In the browser (Chromium, production build): the 471,000-character essay and the 500,000-character paragraph both show the Studio (7,999 and 34,883 changes), with no errors.
- Not run for these changes: the Linux packaged-app and Windows desktop suites. Only `src/humanize/diff.ts`, one Studio heading and tests changed.

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
