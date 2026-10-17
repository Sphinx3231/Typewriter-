# Typewriter 1.1.0: desktop release record

Status: **release candidate, not published, not merged.** Development branch `ccr-e747ce8b-l498oo`; app source commit `ba653df`. Later commits change only tests and documentation, not the app (`git diff ba653df -- src src-tauri/src src-tauri/native/src src-tauri/tauri.conf.json` is empty).

## Artifacts

### Built locally (Linux x86-64), in `release/desktop/`

All three were built from a clean checkout of `ba653df` with `npm run desktop:build`.

| File | SHA-256 | How it was verified |
|---|---|---|
| `Typewriter_1.1.0_amd64.deb` | `21b7064a8310c10d6e791424353f80272bc5e7840634768d17a21836a56e8246` | Installed with `apt-get install`. The installed `/usr/bin/typewriter` is byte-identical to the package's binary. All 20 desktop end-to-end checks and the 4 Wayland checks passed against it. |
| `Typewriter_1.1.0_amd64.AppImage` | `cb95e4bda8ce170ab265d29bd09b2ca89f13a7b3f0f2d86e565282d3daa023f9` | Run directly (`APPIMAGE_EXTRACT_AND_RUN=1`). Passed: launch, exact typing with typos, emergency stop, back-to-back sessions, and quitting mid-session (keymap restored, process exits). |
| `Typewriter-1.1.0-1.x86_64.rpm` | `5d8dfae0263c5cc0b86369cc4426382ce0877423ade8e4a6803c4e1dc828bc4e` | `rpm -K`: digests OK. Installed with `rpm` into a scratch root (`--nodeps`; this is a Debian system), and `rpm -V` reports every file intact. Its own binary passed launch, exact typing, emergency stop and quitting mid-session. **Not installed on Fedora/openSUSE**, so dependency resolution there is unverified. |

`release/desktop/SHA256SUMS` holds the same checksums (`sha256sum -c SHA256SUMS` → all OK). `release/` is gitignored: the installers are build outputs, not committed.

**Provenance and reproducibility (checked, not assumed):**
- The `.rpm` binary differs from the `.deb` binary in exactly 3 bytes: Tauri's bundle-type marker (`__TAURI_BUNDLE_TYPE_VAR_DEB` vs `…_RPM`).
- Rebuilding from the same clean commit gave a byte-identical app binary and identical file contents in the `.deb` (checked on `743e599`).
- The package archives themselves are **not** bit-for-bit reproducible, because they embed build timestamps. Their SHA-256 changes with every build, so compare the binary or the file contents, not the archive hash.

### Built by GitHub Actions

Run [Desktop builds #8](https://github.com/Sphinx3231/Typewriter-/actions/runs/39021585270) (ID 39021585270), commit `81548d2` (app identical to `ba653df`), conclusion **success**:

| Job | Native session tests | Installers produced | Artifact (zip SHA-256) |
|---|---|---|---|
| `build (windows-latest, windows)` | passed | `Typewriter_1.1.0_x64_en-US.msi` (3.19 MiB), `Typewriter_1.1.0_x64-setup.exe` (2.68 MiB) | `typewriter-windows` `df91e331b254dfae1c796910c55b39dd13607be54c8a11ceed9a02100fee919b` |
| `build (macos-latest, macos)` | passed (13/13) | `Typewriter_1.1.0_aarch64.dmg` (4.66 MiB), **Apple Silicon only** (arm64 runner) | `typewriter-macos` `fd66d5b9671fcabdd987a86a371938e60196287e2fe9557c3da6a34906c15d61` |
| `build (ubuntu-22.04, linux)` | passed | `.deb`, `.rpm`, `.AppImage` (3 files) | `typewriter-linux` `213afe7aa962d76ad075145f1ba276ee6e9131fee1e6f5359f0d4a268c8245fb` |

The Windows and macOS installers were **compiled and packaged only. They have not been launched or used.** "Native session tests" means the session logic against a simulated desktop, not real key input on that system.

The previous run on `ba653df`, [Desktop builds #7](https://github.com/Sphinx3231/Typewriter-/actions/runs/39020623283), **failed on macOS**. Linux and Windows passed. On macOS, the native test `returning_to_typewriter_during_countdown_restarts_it` typed 3 keys. The cause was the test itself: it left only 80 ms of wall-clock margin, which a busy runner can exceed. The app logic was correct. Pausing the test process for 200–250 ms mid-countdown reproduced it locally: the old test failed or hung, and the fixed one passed 18/18. A mutant whose countdown doesn't restart still fails the fixed test. `user_pause_and_resume` had the same thin margin and was widened too.

CI (lint, unit tests, web build and 27 browser tests; native Rust tests; extension tests) on the branch:
- [CI #17](https://github.com/Sphinx3231/Typewriter-/actions/runs/39020463159) (ID 39020463159) for `ba653df`: **success**.
- [CI #18](https://github.com/Sphinx3231/Typewriter-/actions/runs/39021580578) (ID 39021580578) for `81548d2`: **success** (`test`, `native`, `extension`).

## Local test results for this release

All results below are on the `ba653df` app.

| Command | Result |
|---|---|
| `npm run lint` | clean |
| `npm test` | 214 passed |
| `npm run test:native` | 22 passed (3 runs in a row after the test-margin fix) |
| `cargo check -p typewriter --target x86_64-pc-windows-msvc` | clean |
| `node e2e-desktop/run.mjs /usr/bin/typewriter` (installed `.deb`) | 20 passed |
| `APPIMAGE_EXTRACT_AND_RUN=1 ONLY="starts without\|types tricky text\|emergency stop\|back-to-back\|quitting mid-session" node e2e-desktop/run.mjs release/desktop/Typewriter_1.1.0_amd64.AppImage` | 5 passed |
| `ONLY="starts without\|types tricky text\|emergency stop\|quitting mid-session" node e2e-desktop/run.mjs <rpm-root>/usr/bin/typewriter` | 4 passed |
| `node e2e-desktop/wayland.mjs /usr/bin/typewriter` (installed app under headless Weston 13 with XWayland, GDK Wayland backend) | 4 passed |

The web UI (`test:e2e`, 27) and extension (`test:extension`, 28) suites were not rerun locally after `654dbd8`. The review fixes don't touch that code. CI runs the web UI and extension suites on every push.

**The Wayland check** runs the app as a native Wayland client under Weston. It confirms:
- GTK really uses Wayland: no Typewriter window exists on XWayland, and the check fails when GTK is forced to X11;
- typing into other apps is refused in the UI with the Wayland/Xorg explanation, and Start stays disabled;
- a direct `external_start` call to the native side is refused with state `wayland`, so the UI can't be bypassed;
- the in-app preview reproduces Unicode text exactly.

It did not run on a full GNOME or KDE desktop.

## Not verified, and how to verify by hand

Each of these needs hardware, an account or an operating system that isn't available here. Use this test text in each:

```
Café naïve — 日本語 and emoji 👍🏽 🇯🇵.
I recieve teh mail evry day; their going tommorow!
	Tabbed line, (parentheses) "quotes" 'single' 100% $5 #tag @user.

Last line with trailing spaces.   
```

Settings for every run: Typing mistakes **Medium**, How typos get fixed **Mixed**, Total duration **0:30**.

### Windows 10/11 (x64)

1. Download `typewriter-windows` from Desktop builds run 39021585270. Run `Typewriter_1.1.0_x64-setup.exe`. SmartScreen warns because it's unsigned: choose **More info › Run anyway**.
2. Launch Typewriter from the Start menu.
   - Expected: no console window; the logo matches the theme; the theme toggle switches both.
3. Open **Notepad**. In Typewriter choose **Into another app**, paste the test text, press **Type into app**, then click into Notepad.
   - Expected: a 5 s countdown in the status window, then typing.
4. When it says **All keys sent**, press Ctrl+A, Ctrl+C in Notepad, then **Check copied text**.
   - Expected: **Verified**.
5. Interruptions, each in a fresh session:
   - click another window mid-typing → it pauses, and nothing arrives in the other window;
   - **Resume**, then click back into Notepad → it continues;
   - **Ctrl+Shift+Space** → it stops at once;
   - mouse to the top-left corner → it stops;
   - **Pause**/**Stop** in the status window work.
6. Open a browser login page, click into the password field, and start a session.
   - Expected: it pauses with "password field" (UI Automation detection).
7. Close Typewriter with unsaved text.
   - Expected: the quit dialog. **Quit** during typing stops typing at once.
8. Known OS limit to confirm: run Notepad **as Administrator**. Windows blocks input into elevated apps; note what Typewriter shows.

### macOS (Apple Silicon; there's no Intel build)

1. Download `typewriter-macos`, open the `.dmg` and drag Typewriter to Applications. It's unsigned: right-click › **Open** › **Open**.
2. Choose **Into another app**.
   - Expected: it asks for Accessibility permission. **Grant access** opens System Settings. Enable Typewriter, then restart it.
   - Expected: "Ready to type into other apps".
3. Open **TextEdit** (Format › Make Plain Text). Turn off Edit › Substitutions › Smart Quotes/Dashes/Text Replacement. Repeat Windows steps 3–5 (Cmd+A, Cmd+C to copy).
4. Click into a password field (for example Safari's login page) and start.
   - Expected: it pauses with "secure input is on".
5. Repeat Windows step 7.

### Google Docs and other real apps

- **Google Docs:**
  1. Use a **private** document you own.
  2. Turn off Tools › Preferences › automatic capitalisation, smart quotes, link and list detection, and substitutions.
  3. Type the test text with **Into another app** (desktop app, X11/Windows/macOS).
  4. Then select the typed text, copy it, and press **Check copied text**.
  - Expected: **Verified**. If Docs reformatted something, it shows the first difference.
- **LibreOffice Writer:** turn off Tools › AutoCorrect Options (While Typing, Localized Options quotes), then do the same.
- **A code editor** (VS Code, gedit): auto-indent and auto-closing brackets will change the text. Turn them off, or expect a reported mismatch.

### Real Wayland desktop (GNOME/KDE)

1. Log in to a Wayland session. Open Typewriter and choose **Into another app**.
   - Expected: the Wayland explanation; **Type into app** disabled.
2. Run a preview.
   - Expected: it works.
3. Log out, choose an Xorg session (for example "Ubuntu on Xorg"), and repeat.
   - Expected: "Ready to type into other apps", and the Windows steps 3–5 behaviour.

### RPM on Fedora/openSUSE

1. `sudo dnf install ./Typewriter-1.1.0-1.x86_64.rpm` (or `sudo zypper install …`).
   - Expected: it pulls in `webkit2gtk4.1` and `gtk3`, and installs cleanly.
2. Launch Typewriter from the menu.
   - Expected: the icon and window appear.
3. Recent Fedora Workstation releases are Wayland-only, so **Into another app** will show the Wayland explanation there. To test typing, use an X11 session (for example the Xfce or KDE X11 spin), then follow the Windows steps 3–5.
4. `sudo dnf remove typewriter` removes it cleanly.

## Review readiness

- CI: all jobs green for `81548d2`: CI #18 and Desktop builds #8 (Linux, Windows, macOS). The earlier macOS failure on `ba653df` is explained above.
- Local: all suites above pass against the exact-commit Linux artifacts.
- Code review: an independent reviewer (a fresh session with no build context) reviewed `main..743e599`. The fixes were made and verified by the original author, not by the reviewer; see the final review table in [`DESKTOP-AUDIT.md`](DESKTOP-AUDIT.md). One low-severity finding remains open: a failed keymap change on a broken X connection can leave one code bound.
- Open items: the manual platform checks above. None of them block code review. They do block calling Windows, macOS, Google Docs, a full Wayland desktop or RPM-on-Fedora "verified".
