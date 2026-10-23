# Typewriter desktop app

The desktop app is the main Typewriter product. On top of the in-app preview, it can type into **another app**, such as a text editor, a browser or Google Docs, using real key presses.

It's built with [Tauri 2](https://tauri.app) (MIT/Apache-2.0). The window runs the same interface as the web preview. Keyboard output lives in `src-tauri/native` (Rust).

---

## Install

| System | File | Built where | Tested |
|---|---|---|---|
| Linux (Debian/Ubuntu) | `Typewriter_1.2.0_amd64.deb` | locally and in CI | **yes** (2026-10-23): installed with dpkg as an upgrade from 1.1.0 (settings kept, `e2e-desktop/upgrade.mjs`); the full end-to-end suite (26 checks, including large documents) passed against `/usr/bin/typewriter` |
| Linux (any) | `Typewriter_1.2.0_amd64.AppImage` | locally and in CI | **yes**: launched; startup, exact typing, Smart Humanization, large documents and emergency stop checks passed |
| Linux (Fedora/openSUSE) | `Typewriter-1.2.0-1.x86_64.rpm` | locally and in CI | partly: package digests and files verified, installed into a scratch root, and its binary passed the launch and Smart Humanization checks on Debian. **Not installed on Fedora/openSUSE** |
| Windows 10/11 (x64) | `Typewriter_1.2.0_x64-setup.exe` (the only Windows installer since 1.2.0; there is no `.msi` any more) | GitHub Actions (`Desktop builds`) | installed silently, and the **installed** app passes the Windows end-to-end checks on a GitHub-hosted Windows Server 2022 runner (see Tests). Not run on a personal Windows PC |
| macOS 11+ (Apple Silicon) | `Typewriter_1.1.0_aarch64.dmg` | GitHub Actions (`Desktop builds`) | built, and session tests pass in CI; **never launched**. There's no Intel (x86-64) build: the CI runner is Apple Silicon. |

### Get the installer

- **Build it yourself (any system):** see below. On Linux the files appear in `src-tauri/target/release/bundle/{deb,rpm,appimage}/`.
- **From GitHub Actions (free hosted runners):**
  1. Open **Actions › Desktop builds** and click **Run workflow**. It also runs automatically on `main`, and on pull requests that change desktop code.
  2. Download `typewriter-linux`, `typewriter-windows` or `typewriter-macos` when it finishes.

### Install it

- **Debian/Ubuntu:** `sudo apt install ./Typewriter_1.2.0_amd64.deb`. Then open **Typewriter** from the app menu, or run `typewriter`. Installing over an older version upgrades it and keeps your settings (they live in your home folder, which the package never touches).
- **AppImage:** `chmod +x Typewriter_1.2.0_amd64.AppImage && ./Typewriter_1.2.0_amd64.AppImage`. If your system has no FUSE, add `APPIMAGE_EXTRACT_AND_RUN=1` before the command.
- **Fedora/openSUSE:** `sudo dnf install ./Typewriter-1.2.0-1.x86_64.rpm` (or `zypper install`).
- **Windows:** first uninstall **every** older Typewriter under **Settings › Apps** (up to 1.1.1 there were two installers, so there may be two entries: one from the `.msi` in `Program Files`, one from the `-setup.exe` in your user folder). Then run the `-setup.exe`. It is **unsigned** (code signing costs money), so SmartScreen will warn. Choose **More info › Run anyway**. If Typewriter is still running, the installer offers to close it.
  Check **Settings › About**: it shows the version, the build code, and **Running from** the folder this copy was started from. If another installed copy is found, a warning names its folder; uninstall that one, or the Start menu may keep opening it.
- **macOS:** open the `.dmg` and drag Typewriter to Applications. It's **unsigned**, so the first time, right-click the app › **Open** › **Open**.

### Build it yourself

You need Node 22, Rust (stable) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system. On Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config patchelf
npm ci
npm run desktop:build      # installers in src-tauri/target/release/bundle/
```

The build is reproducible from the lockfiles (`package-lock.json`, `src-tauri/Cargo.lock`). It downloads nothing at run time.

---

## Type into another app (Google Docs, an editor, a browser…)

1. Open your document and put it where you can reach it.
2. In Typewriter, paste your text, then choose a duration or speed and the realism settings.
3. Under **Session settings › Output**, choose **Into another app**. The panel says whether typing is available on this computer and, if not, why.
4. Press **Type into app**. Typewriter minimises itself (you can turn this off), and a small **status window** stays on top. It first says **Getting ready** while the keyboard is prepared (usually well under a second; a text with many symbols that aren't on your keyboard takes longer on Linux, and the window counts them).
5. Click into your document **exactly where the text should start**.
6. A countdown runs (5 seconds by default; you can set 2–30). It starts from your click: the window that gets focus by itself when Typewriter minimizes doesn't start it (the status window says "Click into your document"). It starts again whenever you click or switch to another window, so it always runs in full after your last click. When it ends, Typewriter types into the window you clicked into.

### If typing doesn't start

Every stage has a time limit and ends with an explanation. Nothing is typed in any of these cases:

| What you see | Why | What to do |
|---|---|---|
| "Typewriter couldn't get the keyboard ready within 15 seconds, so nothing was typed" | The keyboard didn't become available in time (for example, the previous session was still cleaning up). | Wait a few seconds and press **Type into app** again. If it keeps happening, restart Typewriter. |
| "Typewriter couldn't start typing: the typing engine didn't respond within 20 seconds" | The app's own safety net: the typing engine never answered. | Same as above. |
| "Typewriter can't tell which window is active, so it won't type yet" (while waiting) | The system won't say which window has focus. On Windows this happens with apps running as administrator. | Click into your document. If the message stays, that app can't receive typing from Typewriter: use a different app. |
| "Nothing was typed: no other window was chosen within 3 minutes" | You didn't click into another window after pressing Start. | Press **Type into app** again, then click into your document. |
| "No keys were sent, so nothing was typed" | No key could be sent. A finished session is never reported as done when nothing was sent. | Check the target app, then try again. |
| "Waiting for you to release Ctrl, Alt, Shift or Cmd." (after the countdown) | Windows reports one of those keys as held down. Typing waits so a held key doesn't turn letters into shortcuts. | Press and release Ctrl, Alt, Shift and the Windows key once each. |

### Typing diagnostics

When typing doesn't behave, **Settings › About › Copy typing diagnostics** copies the log of the last sessions to the clipboard. Paste it into a message. It records, with times in milliseconds: Start received, keyboard backend ready, each focus change, countdown start and end, the chosen window, typing started, the password-field check time, any wait for held keys, the first key sent and whether the system accepted it, pauses, send errors (with the Windows error code), and how the session ended. Windows are described by app name, process id, window handle, window class, the class of the control that has keyboard focus, whether it responds, and the privilege level of the target and of Typewriter.

It never contains the text being typed or window titles (only their length). The file is `typing-diagnostics.log` in the app's log folder (Windows: `%LOCALAPPDATA%\app.typewriter.desktop\logs`; Linux: `~/.local/share/app.typewriter.desktop/logs`; macOS: `~/Library/Logs/app.typewriter.desktop`). It is trimmed to the last 256 KB once it passes 512 KB. The header of each session names the app version and the build (git commit).

**Stop and Cancel work in every stage,** including **Getting ready**. Ctrl+Shift+Space works from the moment the status window appears.

### The status window

The status window shows:
- the session state (getting ready, waiting, countdown, typing, paused, resuming, done, stopped, failed);
- the target window, percent done and time left;
- **Pause**, **Resume** and **Stop** buttons.

Clicking it is always safe. The click moves focus away from your document, so typing waits first.

If the emergency shortcut couldn't be registered (another app may own it), the window says so instead of showing a shortcut that doesn't work.

### Emergency stop

- Press **Ctrl + Shift + Space**, on any system.
- Or move the mouse to the **top-left corner** of the screen.
- Or press **Stop** in the status window or in Typewriter.

### Safety rules

- **Nothing types before the countdown ends.** The countdown starts only once Typewriter itself no longer has focus, and starts over after every click and every switch to another window. (When Typewriter minimises itself, the system focuses whatever window was behind it. That doesn't start the countdown: your click into the document does, or a switch to another window. Clicks are counted as events, so a quick touchpad tap counts too.) If you come back to Typewriter, it waits again.
- **It never types into Typewriter itself.**
- **Switching windows or browser tabs makes typing wait.** Nothing goes into the other window or tab. When the window and tab you started in have focus again, a short countdown runs and typing continues by itself. Pressing **Pause** meanwhile makes it your pause: then only **Resume** continues. Pressing **Resume** while another tab of the same browser window shows continues in that tab. Browser tabs are told apart by the window title (unread counts like "(3)" are ignored).
- **Password fields and login windows are refused:**
  - Windows: password boxes are detected through UI Automation.
  - macOS: secure input mode is detected.
  - All systems: window titles such as "Sign in" or "Password" are refused.
- **Shortcuts can't fire by accident.** If you hold Ctrl, Alt, Shift or Cmd, it waits until you let go.
- **Your text is only ever typed as literal characters.** It is never run, and never sent anywhere.
- **Your text isn't lost when you quit.** If the text isn't saved ("Remember my text" is off), or a session is running, closing the window asks first. You can keep Typewriter open, save the text and quit, or quit anyway. Clicking Typewriter to close it already pauses typing (focus left your document); quitting then ends the session and removes Typewriter's temporary key bindings before the app exits.
- **Closing always works.** Closing Typewriter while it's minimised (for example from the taskbar) brings it back so you can see the question. If the window doesn't answer within 3 seconds (blank or frozen), it closes anyway, and the status window closes with it.

### Checking the result

Typewriter knows which keys it sent, but it can't see inside other apps. So when it finishes, it says **"All keys sent · document not checked yet"**, not "matches". To check:

1. Select the typed text in your document and copy it (Ctrl+C / Cmd+C).
2. Press **Check copied text** in Typewriter.

It compares the copy with your original; only line endings are normalised. It says **Verified** only on an exact match, and otherwise points to the first difference.

### Google Docs settings that change your text

Google Docs edits text as you type. For an exact copy, turn these off under **Tools › Preferences › General**:
- automatically capitalize words;
- use smart quotes;
- automatically detect links;
- automatically detect lists;
- automatic substitutions.

With these on, Docs may turn `"quotes"` into “curly quotes”, `--` into a dash, or `1.` at a line start into a numbered list. The copy-back check will show it.

---

## Permissions and system support

| System | What's needed | Why |
|---|---|---|
| **Linux** | An **X11 session** (Xorg). | Wayland doesn't let one app type into another. On a Wayland session (GNOME and KDE default to it), Typewriter says so and won't start typing into other apps. That holds even though those sessions also run XWayland. To use the feature, pick **"Ubuntu on Xorg"** (or similar) at the login screen. The preview works everywhere. Tested as a native Wayland client under Weston with XWayland; not yet on a full GNOME/KDE desktop. |
| **macOS** | **Accessibility**: System Settings › Privacy & Security › Accessibility › turn on Typewriter, then restart it. **Grant access** in the app opens the system prompt. | macOS only lets apps with this permission send key presses. Without it, Typewriter explains the problem and types nothing. |
| **Windows** | Nothing. | Keys can't be sent to apps running as Administrator. Run the target normally. |

Typewriter asks for nothing else: no network access, no screen recording, no input monitoring.

---

## How it works

1. **Planning stays in the app's interface.** It builds the same keystroke timeline the preview plays: typos, corrections, pauses and timing.
2. **The native side does the typing.** The timeline goes to `typewriter-native`, which runs it on its own thread and clock, so a minimised window can't slow it down.
3. **Edits become keys:**
   - characters → their key, or a key bound for that character;
   - line break → Enter;
   - tab → Tab;
   - backspace → Backspace;
   - caret moves → arrow keys;
   - autocorrect → arrows, Backspace, then retyping.
4. **Each key is checked first.** Before every key it checks the focused window, password fields, held modifier keys and the mouse corner.
5. **Platform backends:**
   - **Linux (X11):** keys go straight through XTest, about 0.03 ms per character.
     - Caps Lock is handled.
     - Characters that aren't on your keyboard layout (emoji, CJK, curly quotes…) are bound to unused key codes before the countdown starts. The app being typed into gets time to pick up each change. Pressing Stop cancels this preparation at once.
     - One session at a time may change the keymap, so a new session can never mistake a previous session's temporary binding for a real key.
     - Two unused key codes are left free for other programs (when the keyboard map has at least three).
     - When the session ends, every binding is removed again, including when you quit mid-session: the app waits (up to 10 s) for this before exiting.
   - **Windows and macOS:** keys go through `enigo` (MIT).

---

## How it's tested

- **Native (`npm run test:native`):** the session logic against a simulated desktop. Covers:
  - countdown and focus guard;
  - login/password refusal and modifier wait;
  - stop and failsafe, drift;
  - replay of 96 engine timelines with typos;
  - Wayland and no-display refusals.

  The session tests also run on Windows and macOS in CI.
- **Text integrity (`npm test`):** 14 tricky inputs × 4 realism settings × 5 seeds. Both the typed result and the keys sent must reproduce the source exactly.
- **Desktop end-to-end (`npm run test:desktop`):** the real packaged app, on a real X11 display (Xvfb + openbox), types into a real Chromium window. WebDriver drives Typewriter's UI; xdotool plays the user (clicks, window switches, shortcut presses); the document is read back over the DevTools protocol. Nothing in the input path is mocked. 22 checks:
- **Large documents in the packaged app** (part of the desktop end-to-end run): a 500,000-character paragraph and a 471,000-character, 800-paragraph essay are humanized automatically, the Studio shows every change, **Copy revised** (pressed with a real key press) gives exactly the expected text with one change restored and after undoing it, and a 10-paragraph humanized document with one change restored is typed into another app exactly. The expected texts come from the app's own humanizer, bundled from source by the harness.
- **Upgrade (`node e2e-desktop/upgrade.mjs before|after <app> <state.json>`):** changes and saves settings in the installed old version; after the new version is installed over it, every saved key and field must still be there and the UI must show the same choices.
  - startup and logo; theme switching, persistence and real repainting;
  - nothing typed while Typewriter has focus;
  - Cancel while the keyboard is still being prepared types nothing, removes the temporary key bindings, and the next session types exactly;
  - Cancel and Start again at once: the cancelled session can't take over the new one;
  - exact Unicode/typo text; punctuation and spacing edge cases;
  - more distinct symbols than free key codes; back-to-back sessions;
  - 1,500 characters in 12 s;
  - copy-back verification; Caps Lock;
  - pause on focus change; Ctrl+Shift+Space; mouse corner; login-window refusal;
  - status-window controls clicked with the mouse;
  - in-app preview;
  - quit protection (keep open; quitting mid-session removes every temporary key binding before the process exits);
  - Wayland refusal.

  After the emergency stop, the mouse-corner stop, Stop in the status window and "Keep Typewriter open", it checks that the source text is unchanged.
- **Windows end-to-end (`node e2e-desktop/windows.mjs`, in the Desktop builds workflow on `windows-2022`):** the real `typewriter.exe` on a real Windows desktop session, driven through tauri-driver; real `SendInput` clicks and Ctrl+Shift+Space; it tests the **installed** app from the very `setup.exe` the build job uploads (the downloadable file), installed silently as an upgrade over the published v1.2.0 pre-release after settings were saved in that version (`e2e-desktop/upgrade.mjs` checks they survive), and first checks that Settings shows the expected version and commit. Checks: launch; build identity; Type into app answers at once and the status window shows its controls; into a native WinForms text box, tricky Unicode text with typos arrives exactly, pause/resume from the status window, clicking another window pauses and nothing goes there, emergency stop; the same short text into Windows Notepad, a plain text field in Opera and a Docs-like page in Opera (each records when the first character arrived and prints the typing diagnostics); tricky text into a Docs-like page in Chrome, Edge and Opera; the Chrome extension's APIs in Opera. On a failure it prints the app's state, the status window's state and the focused window. (`windows-2022` because WebView2 on the newer image ignores the remote-debugging flag on the elevated runner.)
- **Real Wayland session (`npm run test:desktop:wayland`):** the packaged app runs as a native Wayland client under headless Weston with XWayland. It checks that typing into other apps is refused with the explanation, and that the preview reproduces Unicode text exactly. Needs `weston` and `Xwayland`.

---

## Known limitations

- **Google Docs end-to-end is not verified.** This environment has no Google account and no network access to Google. The same mechanism is verified into a real Chromium text area. To check it yourself, use **Check copied text**.
- **Windows is verified on a GitHub-hosted runner only, macOS not at all.** There is no Intel macOS build.
  - Windows: the end-to-end checks above pass on Windows Server 2022, against the installed `-setup.exe`. That runner is elevated (the app and the targets run with high privilege) and has no Google login, so real Google Docs is not tested; nothing has run on a personal Windows laptop.
  - macOS: compiles only in CI (a dependency needs Apple's SDK); the session logic tests run there. The app hasn't been launched.
- **Restart isn't offered in "Into another app" mode.** The text already typed would be duplicated. Undo it in your document, then type again.
- **Resume relies on the window keeping its caret.** Switching windows normally does this. If you click somewhere else in the document before resuming, typing continues from where you clicked.
- **No password-field detection on Linux.** Only the window-title check applies there.
- **Arrow-key corrections assume plain text.** Fixes that move back with arrow keys assume each character is one arrow step. In apps that treat some sequences differently, such as ligatures or tables, a fix could land in the wrong place. The copy-back check catches it.
- **Long texts with many distinct non-keyboard symbols type a little slower on Linux.** When a text uses more such symbols than there are free key codes, codes are reused mid-session, with a short pause (80 ms) each time so the target app sees the change.
- **Installers are unsigned.** Signing certificates cost money, and the budget is $0.
