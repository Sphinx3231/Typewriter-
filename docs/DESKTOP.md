# Typewriter desktop app

The desktop app is the full Typewriter. On top of the in-app preview, it can type into **another app**, such as Google Docs, Word or Notes, using real key presses.

It's built with [Tauri 2](https://tauri.app) (MIT/Apache-2.0). The window runs the same web app as the browser preview. Native keyboard output lives in `src-tauri/native` (Rust).

---

## Install

| System | File | Built where | Tested |
|---|---|---|---|
| Linux (Debian/Ubuntu) | `Typewriter_1.0.0_amd64.deb` | locally and in CI | yes (installed and run, see below) |
| Linux (Fedora/openSUSE) | `Typewriter-1.0.0-1.x86_64.rpm` | locally and in CI | built only |
| Linux (any) | `Typewriter_1.0.0_amd64.AppImage` | locally and in CI | built only |
| Windows 10/11 | `Typewriter_1.0.0_x64-setup.exe`, `.msi` | GitHub Actions (`Desktop builds`) | not tested |
| macOS 11+ | `Typewriter_1.0.0_*.dmg` | GitHub Actions (`Desktop builds`) | not tested |

### Get the installer

- **Linux:** build it yourself (below), or download the `typewriter-linux` artifact from the **Desktop builds** workflow run in the repository's Actions tab.
- **Windows and macOS:** open the repository on GitHub, go to **Actions › Desktop builds › Run workflow**, and download `typewriter-windows` or `typewriter-macos` when it finishes. GitHub's hosted runners are free within the monthly allowance.

### Install it

- **Debian/Ubuntu:** `sudo apt install ./Typewriter_1.0.0_amd64.deb`, then open **Typewriter** from the app menu, or run `typewriter`.
- **AppImage:** `chmod +x Typewriter_1.0.0_amd64.AppImage && ./Typewriter_1.0.0_amd64.AppImage`
- **Windows:** run the `-setup.exe`. The installers are **unsigned** (code signing costs money), so SmartScreen will warn. Choose **More info › Run anyway**.
- **macOS:** open the `.dmg` and drag Typewriter to Applications. It's **unsigned**, so the first time you open it, right-click the app › **Open** › **Open**.

### Build it yourself

You need Node 22, Rust (stable) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system. On Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev pkg-config patchelf
npm ci
npm run desktop:build      # installers in src-tauri/target/release/bundle/
```

---

## Type into Google Docs (or any app)

1. Open your document and put it where you can reach it.
2. In Typewriter, paste your text, then choose a duration or speed and the realism settings.
3. Under **Session settings › Output**, choose **Into another app**.
4. Press **Type into app**. Typewriter minimises itself and a small status window stays on top.
5. Click into your document **exactly where the text should start**.
6. A countdown runs (5 seconds by default; you can set 2–30). When it ends, Typewriter types into the window you clicked into.

**Emergency stop:**
- press **Ctrl + Shift + Space**, on any system;
- or move the mouse to the **top-left corner** of the screen;
- or press **Stop** in the status window or in Typewriter.

**Safety rules the app follows:**
- **Nothing types before the countdown ends.** The countdown starts only once Typewriter itself no longer has focus. If you come back to Typewriter, it starts over.
- **It never types into Typewriter itself.**
- **Clicking another window pauses typing.** Press **Resume**, then click back into your document. It waits until that same window has focus again before typing anything.
- **Password fields and login windows are refused.**
  - Windows: password boxes are detected through UI Automation.
  - macOS: secure input mode is detected.
  - All systems: window titles such as "Sign in" or "Password" are refused.
- **Shortcuts can't fire by accident.** If you hold Ctrl, Alt, Shift or Cmd, it waits until you let go, so typed letters never trigger shortcuts.
- **Your text is only ever typed as literal characters.** It is never run, and it is never sent anywhere.

### Checking the result

Typewriter can see which keys it sent, but it can't see inside other apps. So when it finishes, it says **"All keys sent · document not checked yet"**, not "matches". To check:

1. Select the typed text in your document and copy it (Ctrl+C / Cmd+C).
2. Press **Check copied text** in Typewriter.

It compares the copy with your original. Only line endings are normalised. It shows **Verified** only on an exact match. Otherwise it points to the first difference.

### Google Docs settings that change your text

Google Docs edits text as you type. For an exact copy, turn these off under **Tools › Preferences › General**:
- Automatically capitalize words
- Use smart quotes
- Automatically detect links
- Automatically detect lists
- Automatic substitutions

With them on, Docs may turn `"quotes"` into “curly quotes”, `--` into a dash, or `1.` at a line start into a numbered list. The copy-back check will show it.

---

## Permissions

| System | What's needed | Why |
|---|---|---|
| **macOS** | **Accessibility**: System Settings › Privacy & Security › Accessibility › turn on Typewriter, then restart Typewriter. **Grant access** in the app opens the system prompt. | macOS only lets apps with this permission send key presses to other apps. Without it, Typewriter explains the problem and types nothing. |
| **Windows** | Nothing. | Keys can't be sent to apps running as Administrator. Run the target normally. |
| **Linux** | An **X11 session** (Xorg). On Wayland, choose "Ubuntu on Xorg" (or similar) at the login screen. | Wayland doesn't allow one app to type into another. Typewriter detects this and explains it instead of typing. |

Typewriter asks for nothing else: no network access, no screen recording, no input monitoring.

---

## How it works

- **Planning stays in the web app.** It builds the same keystroke timeline the preview plays (typos, corrections, pauses, timing).
- **The native side does the typing.** The timeline goes to `typewriter-native`, which runs it on its own thread and clock, so a minimised window can't slow it down.
- **Edits become keys.** Each event becomes key presses:
  - characters → their key, or a Unicode key event;
  - line break → Enter;
  - tab → Tab;
  - backspace → Backspace;
  - caret moves → arrow keys;
  - autocorrect → arrows, Backspace, retype.
- **Each key is checked first.** Before every key, it checks the focused window, password fields, held modifier keys and the mouse corner.
- **Platform backends:**
  - On Linux, keys go through XTest directly, about 0.03 ms per character. Caps Lock is handled, and the keyboard map is restored afterwards.
  - On Windows and macOS, keys go through `enigo` (MIT).

---

## Known limitations

- **Google Docs end-to-end is not verified here.** The development environment has no Google account. The same flow has been tested end to end into a real Chromium window with real key events (`npm run test:desktop`), but typing into an actual Google Docs document has not been run. See "Checking the result" for how to confirm it yourself.
- **Windows and macOS builds are unverified.**
  - Their installers come from CI and haven't been launched or used.
  - The Windows code was type-checked locally.
  - The macOS code couldn't be checked locally (a dependency needs Apple's SDK). It compiles in CI only.
- **Restart isn't offered in "Into another app" mode.** The text already typed would be duplicated. Undo it in your document, then type again.
- **Resume relies on the window keeping its caret.** Switching windows normally does this. If you click somewhere else in the document before resuming, typing continues from wherever you clicked.
- **No password-field detection on Linux.** Only the window-title check applies there.
- **Arrow-key corrections assume plain text.** Fixes that move back with arrow keys assume each character is one arrow step. In apps that treat some sequences differently, such as ligatures or tables, the fix could land in the wrong place. The copy-back check catches it.
- **Installers are unsigned** (signing certificates cost money; $0 budget).
