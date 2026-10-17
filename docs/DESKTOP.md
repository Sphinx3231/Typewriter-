# Typewriter desktop app

The desktop app is the main Typewriter product. On top of the in-app preview, it can type into **another app**, such as a text editor, a browser or Google Docs, using real key presses.

It's built with [Tauri 2](https://tauri.app) (MIT/Apache-2.0). The window runs the same interface as the web preview. Keyboard output lives in `src-tauri/native` (Rust).

---

## Install

| System | File | Built where | Tested |
|---|---|---|---|
| Linux (Debian/Ubuntu) | `Typewriter_1.1.0_amd64.deb` | locally and in CI | **yes**: installed with apt (upgrade from 1.0.0); the full end-to-end suite passed against `/usr/bin/typewriter` |
| Linux (any) | `Typewriter_1.1.0_amd64.AppImage` | locally and in CI | **yes**: launched; startup, exact typing, emergency stop and back-to-back session checks passed |
| Linux (Fedora/openSUSE) | `Typewriter-1.1.0-1.x86_64.rpm` | locally and in CI | partly: package digests and files verified, installed into a scratch root, and its binary passed launch/typing/stop checks on Debian. **Not installed on Fedora/openSUSE** |
| Windows 10/11 (x64) | `Typewriter_1.1.0_x64-setup.exe`, `Typewriter_1.1.0_x64_en-US.msi` | GitHub Actions (`Desktop builds`) | built, and session tests pass in CI; **never launched** |
| macOS 11+ (Apple Silicon) | `Typewriter_1.1.0_aarch64.dmg` | GitHub Actions (`Desktop builds`) | built, and session tests pass in CI; **never launched**. There's no Intel (x86-64) build: the CI runner is Apple Silicon. |

### Get the installer

- **Build it yourself (any system):** see below. On Linux the files appear in `src-tauri/target/release/bundle/{deb,rpm,appimage}/`.
- **From GitHub Actions (free hosted runners):**
  1. Open **Actions › Desktop builds** and click **Run workflow**. It also runs automatically on `main`, and on pull requests that change desktop code.
  2. Download `typewriter-linux`, `typewriter-windows` or `typewriter-macos` when it finishes.

### Install it

- **Debian/Ubuntu:** `sudo apt install ./Typewriter_1.1.0_amd64.deb`. Then open **Typewriter** from the app menu, or run `typewriter`. Installing over an older version upgrades it.
- **AppImage:** `chmod +x Typewriter_1.1.0_amd64.AppImage && ./Typewriter_1.1.0_amd64.AppImage`. If your system has no FUSE, add `APPIMAGE_EXTRACT_AND_RUN=1` before the command.
- **Fedora/openSUSE:** `sudo dnf install ./Typewriter-1.1.0-1.x86_64.rpm` (or `zypper install`).
- **Windows:** run the `-setup.exe`. The installers are **unsigned** (code signing costs money), so SmartScreen will warn. Choose **More info › Run anyway**.
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
6. A countdown runs (5 seconds by default; you can set 2–30). When it ends, Typewriter types into the window you clicked into.

### If typing doesn't start

Every stage has a time limit and ends with an explanation. Nothing is typed in any of these cases:

| What you see | Why | What to do |
|---|---|---|
| "Typewriter couldn't get the keyboard ready within 15 seconds, so nothing was typed" | The keyboard didn't become available in time (for example, the previous session was still cleaning up). | Wait a few seconds and press **Type into app** again. If it keeps happening, restart Typewriter. |
| "Typewriter couldn't start typing: the typing engine didn't respond within 20 seconds" | The app's own safety net: the typing engine never answered. | Same as above. |
| "Typewriter can't tell which window is active, so it won't type yet" (while waiting) | The system won't say which window has focus. On Windows this happens with apps running as administrator. | Click into your document. If the message stays, that app can't receive typing from Typewriter: use a different app. |
| "Nothing was typed: no other window was chosen within 3 minutes" | You didn't click into another window after pressing Start. | Press **Type into app** again, then click into your document. |
| "No keys were sent, so nothing was typed" | No key could be sent. A finished session is never reported as done when nothing was sent. | Check the target app, then try again. |

**Stop and Cancel work in every stage,** including **Getting ready**. Ctrl+Shift+Space works from the moment the status window appears.

### The status window

The status window shows:
- the session state (getting ready, waiting, countdown, typing, paused, resuming, done, stopped, failed);
- the target window, percent done and time left;
- **Pause**, **Resume** and **Stop** buttons.

Clicking it is always safe. The click moves focus away from your document, so typing pauses first.

If the emergency shortcut couldn't be registered (another app may own it), the window says so instead of showing a shortcut that doesn't work.

### Emergency stop

- Press **Ctrl + Shift + Space**, on any system.
- Or move the mouse to the **top-left corner** of the screen.
- Or press **Stop** in the status window or in Typewriter.

### Safety rules

- **Nothing types before the countdown ends.** The countdown starts only once Typewriter itself no longer has focus. If you come back to Typewriter, it starts over.
- **It never types into Typewriter itself.**
- **Clicking another window pauses typing.** After **Resume**, it waits until that same window has focus again before typing anything.
- **Password fields and login windows are refused:**
  - Windows: password boxes are detected through UI Automation.
  - macOS: secure input mode is detected.
  - All systems: window titles such as "Sign in" or "Password" are refused.
- **Shortcuts can't fire by accident.** If you hold Ctrl, Alt, Shift or Cmd, it waits until you let go.
- **Your text is only ever typed as literal characters.** It is never run, and never sent anywhere.
- **Your text isn't lost when you quit.** If the text isn't saved ("Remember my text" is off), or a session is running, closing the window asks first. You can keep Typewriter open, save the text and quit, or quit anyway. Clicking Typewriter to close it already pauses typing (focus left your document); quitting then ends the session and removes Typewriter's temporary key bindings before the app exits.

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
- **Desktop end-to-end (`npm run test:desktop`):** the real packaged app, on a real X11 display (Xvfb + openbox), types into a real Chromium window. WebDriver drives Typewriter's UI; xdotool plays the user (clicks, window switches, shortcut presses); the document is read back over the DevTools protocol. Nothing in the input path is mocked. 21 checks:
  - startup and logo; theme switching, persistence and real repainting;
  - nothing typed while Typewriter has focus;
  - Cancel while the keyboard is still being prepared types nothing, removes the temporary key bindings, and the next session types exactly;
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
- **Real Wayland session (`npm run test:desktop:wayland`):** the packaged app runs as a native Wayland client under headless Weston with XWayland. It checks that typing into other apps is refused with the explanation, and that the preview reproduces Unicode text exactly. Needs `weston` and `Xwayland`.

---

## Known limitations

- **Google Docs end-to-end is not verified.** This environment has no Google account and no network access to Google. The same mechanism is verified into a real Chromium text area. To check it yourself, use **Check copied text**.
- **Windows and macOS are unverified.** There is no Intel macOS build.
  - Their installers come from CI and haven't been launched.
  - The Windows code type-checks locally.
  - The macOS code compiles only in CI (a dependency needs Apple's SDK).
  - The session logic tests do run on both in CI.
- **Restart isn't offered in "Into another app" mode.** The text already typed would be duplicated. Undo it in your document, then type again.
- **Resume relies on the window keeping its caret.** Switching windows normally does this. If you click somewhere else in the document before resuming, typing continues from where you clicked.
- **No password-field detection on Linux.** Only the window-title check applies there.
- **Arrow-key corrections assume plain text.** Fixes that move back with arrow keys assume each character is one arrow step. In apps that treat some sequences differently, such as ligatures or tables, a fix could land in the wrong place. The copy-back check catches it.
- **Long texts with many distinct non-keyboard symbols type a little slower on Linux.** When a text uses more such symbols than there are free key codes, codes are reused mid-session, with a short pause (80 ms) each time so the target app sees the change.
- **Installers are unsigned.** Signing certificates cost money, and the budget is $0.
