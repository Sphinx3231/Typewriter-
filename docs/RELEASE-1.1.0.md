# Typewriter 1.1.0: desktop release record

Status: **release candidate, not published, not merged.** Development branch `ccr-e747ce8b-l498oo`; source commit `654dbd8`. Later commits on the branch change only documentation and test scripts, not the app.

## Artifacts

### Built locally (Linux x86-64), in `release/desktop/`

All three were built from commit `654dbd8` with `npm run desktop:build`.

| File | SHA-256 | How it was verified |
|---|---|---|
| `Typewriter_1.1.0_amd64.deb` | `5a1473d913a05967a0c37bd1abe7d72798ec87de9c14b1db0b80624296390d5b` | Installed with `apt-get install --reinstall`. The installed `/usr/bin/typewriter` is byte-identical to the package's binary, and all 20 desktop end-to-end checks passed against it. |
| `Typewriter_1.1.0_amd64.AppImage` | `db9b33abf52b76fef5e3668072b0f53a5e3ece7cd44d4eb41ac6b48395549502` | Run directly (`APPIMAGE_EXTRACT_AND_RUN=1`): launch, exact typing with typos, emergency stop and back-to-back sessions all passed. |
| `Typewriter-1.1.0-1.x86_64.rpm` | `cb1e855a8c3c3ae0611783bd10b71c7f4de2864bef84ff0a80b98f2f01ec8217` | `rpm -K`: digests OK. Installed with `rpm` into a scratch root (`--nodeps`; this is a Debian system), and `rpm -V` reports every file intact. Its own binary passed launch, exact typing and emergency stop. **Not installed on Fedora/openSUSE**, so dependency resolution there is unverified. |

`release/desktop/SHA256SUMS` holds the same checksums (`sha256sum -c SHA256SUMS` → all OK). `release/` is gitignored: the installers are build outputs, not committed.

### Built by GitHub Actions

Run [Desktop builds #6](https://github.com/Sphinx3231/Typewriter-/actions/runs/38996967288) (ID 38996967288), commit `654dbd8`, conclusion **success**:

| Job | Native session tests | Installers produced | Artifact (zip SHA-256) |
|---|---|---|---|
| `build (windows-latest, windows)` | passed | `Typewriter_1.1.0_x64_en-US.msi` (3.19 MiB), `Typewriter_1.1.0_x64-setup.exe` (2.68 MiB) | `typewriter-windows` `3d747c5ee50f1a028e9a360d34c6a7dedb69106d9c4341a38c28b19b1e32b294` |
| `build (macos-latest, macos)` | passed | `Typewriter_1.1.0_aarch64.dmg` (4.66 MiB), **Apple Silicon only** | `typewriter-macos` `d176685edf32e568465145838b28b5cc32a945cfd3fa4bb6daf868d228d583ae` |
| `build (ubuntu-22.04, linux)` | passed | `.deb`, `.rpm`, `.AppImage` (3 files) | `typewriter-linux` `4d9b933177851ecb9c5c872651a07f1a50944394cb7d6189762f797b30f7c53b` |

The Windows and macOS installers were **compiled and packaged only. They have not been launched or used.**

Run [CI #15](https://github.com/Sphinx3231/Typewriter-/actions/runs/38996960262) (ID 38996960262), commit `654dbd8`, conclusion **success**:
- `test`: lint, unit tests, web build and 27 browser tests.
- `native`: Rust tests.
- `extension`: 28 tests, plus the extension ZIP artifact.

## Local test results for this release

| Command | Result |
|---|---|
| `npm run lint` | clean |
| `npm test` | 214 passed |
| `npm run build && npm run test:e2e` | 27 passed |
| `npm run test:native` | 21 passed |
| `node e2e-desktop/run.mjs /usr/bin/typewriter` (installed `.deb` from `654dbd8`) | 20 passed |
| `APPIMAGE_EXTRACT_AND_RUN=1 ONLY="starts without\|types tricky text\|emergency stop\|back-to-back" node e2e-desktop/run.mjs release/desktop/Typewriter_1.1.0_amd64.AppImage` | 4 passed |
| `ONLY="starts without\|types tricky text\|emergency stop" node e2e-desktop/run.mjs <rpm-root>/usr/bin/typewriter` | 3 passed |
| `npm run test:desktop:wayland` (installed app under headless Weston 13 with XWayland, GDK Wayland backend) | 3 passed |
| `npm run test:extension` (deferred extension; shared UI regression) | 28 passed |

**The Wayland check** runs the app as a native Wayland client: a negative control (no compositor) makes GTK refuse to start. It confirms:
- the app renders;
- typing into other apps is refused with the Wayland/Xorg explanation, and Start stays disabled;
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

1. Download `typewriter-windows` from Desktop builds run 38996967288. Run `Typewriter_1.1.0_x64-setup.exe`. SmartScreen warns because it's unsigned: choose **More info › Run anyway**.
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

- CI: all jobs green for `654dbd8` (both runs above).
- Local: all suites above pass against the exact-commit Linux artifacts.
- Open items: the manual platform checks above. None of them block code review. They do block calling Windows, macOS, Google Docs or RPM-on-Fedora "verified".
