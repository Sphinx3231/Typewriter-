# Manual QA on your own computer

These are the checks that can't be done from the build environment: your laptop, your
Chrome, your apps, your Google account. Each step says what to do, what should happen,
and what to send back. Screenshots: crop to the Typewriter window, the status window and
the document, so nothing personal is in them.

Use a **private test document** with nothing important in it.

## 0. Get the builds

**Desktop app** (the main product):
1. Open the repository's **Actions** tab › **Desktop builds** › the latest run for branch
   `ccr-e747ce8b-l498oo` (you need to be signed in to GitHub to download).
2. Download `typewriter-windows`, `typewriter-macos` or `typewriter-linux`, and unzip it.
   - Windows: run the `*-setup.exe` (or the `.msi`). It's unsigned, so SmartScreen warns:
     **More info › Run anyway**.
   - macOS (Apple Silicon): open the `.dmg`, drag Typewriter to Applications, then
     right-click › **Open** the first time (unsigned).
   - Linux: install the `.deb`, or run the `.AppImage`.
3. If an older Typewriter is installed, quit it first (also from the tray), then install over it.

**Chrome extension** (unpacked, nothing is published):
1. Build it: `npm ci && npm run extension:build` (the folder is `dist-extension/`), or unzip
   `release/typewriter-extension-1.1.0.zip` from that build.
2. `chrome://extensions` › turn on **Developer mode** › if an older Typewriter is listed,
   **Remove** it › **Load unpacked** › choose `dist-extension`.
3. Chrome shows that Typewriter can use the debugger. That's expected: it's how it sends
   real key presses.

Send back: your operating system and version, and Chrome's version (`chrome://version`).

## 1. Desktop: typing starts and delivers characters (Bug 1)

Target: Notepad (Windows), TextEdit in plain-text mode (macOS), or gedit/Kate (Linux).

1. Start Typewriter from a fresh launch.
2. Paste this text:
   ```
   Café naïve — "quotes", 'single', 100% $5 #tag @user (parens) [brackets] {braces}
   	Tabbed line with 日本語 and emoji 👍🏽 🎉.
   Last line.
   ```
3. Settings: **Into another app**, duration 20 s, Typing mistakes **Medium**, countdown 5 s.
4. Press **Type into app**.
   - Expected: within about a second the status window appears with its text and buttons,
     never blank. It may briefly say **Getting ready**, then **Waiting**.
5. Click into the text editor.
   - Expected: countdown 5…1, then typing starts.
6. Screenshot the status window and the editor **while typing**.
7. Let it finish.
   - Expected: the status window says the keys were sent. The editor's text equals the
     source exactly (typos only appear briefly and are corrected).
8. Select all in the editor, copy, and press **Check copied text** in Typewriter.
   - Expected: **Verified**. Screenshot it.

Send back: the screenshots, and whether the status window was ever blank.

## 2. Desktop: controls in every phase

Use the same text with a 60 s duration.

| # | Do this | Expected |
|---|---|---|
| 2.1 | Press **Type into app**, then **Cancel** at once (while it says Getting ready or Waiting). | "Stopped… Nothing was typed." Nothing appears in the editor, even after 10 s. |
| 2.2 | Start, click into the editor, press **Stop** in the status window during the countdown. | Stops. Nothing typed. |
| 2.3 | Start; while typing, press **Pause** in the status window, wait 5 s, press **Resume**, then click back into the editor. | Nothing typed while paused. It continues where it stopped; the final text is exact. |
| 2.4 | While typing, click on another window (e.g. the desktop). | Typing pauses with "Focus moved…". Nothing goes into the other window. Resume continues exactly. |
| 2.5 | While typing, press **Ctrl+Shift+Space**. | Stops at once. |
| 2.6 | While typing, move the mouse to the **top-left corner** of the screen. | Stops at once. |
| 2.7 | Run another session right after one ends. | Works the same; no stray characters. |
| 2.8 | Press **Type into app** and don't click anywhere for 3 minutes. | Fails with "Nothing was typed: no other window was chosen within 3 minutes". |
| 2.9 | Windows only: open Notepad **as administrator**, start a session and click into it. | It doesn't type; the status window explains it can't type into that window, or that focus can't be read. It never says "done". |
| 2.10 | macOS only: turn Typewriter's Accessibility permission **off** (System Settings › Privacy & Security › Accessibility), then press Type into app. | It explains the permission and types nothing. |
| 2.11 | A long text: paste ~2,000 characters, 60 s. | Arrives exactly (check with **Check copied text**). |

Send back: pass/fail per row, and a screenshot of anything that didn't match.

## 3. Extension: side panel (Bug 2)

1. After loading the unpacked extension, open any normal web page (not `chrome://`).
2. Click the puzzle-piece icon › **Typewriter**. The side panel opens.
   - Expected: the full UI (logo, theme switch, status card, Start, your text, settings),
     not a blank panel. Screenshot it.
3. Right-click inside the panel › **Inspect** › **Console**.
   - Expected: no red errors. Screenshot the console.
4. Quit Chrome completely (all windows), start it again, and open the panel again.
   - Expected: same full UI. Screenshot.

If the panel is blank: screenshot it, the Console of the panel, and the extension's card
in `chrome://extensions` (including any **Errors** button).

## 4. Extension: typing into a page

1. Open a page with a text box (for example, a new email draft or a plain textarea).
2. In the panel: **Into a web page**, 15 s, Typing mistakes **Medium**, paste the text
   from step 1.2. Press **Type into page**.
   - Expected: no permission prompt. A countdown asks you to click into the page.
3. Click into the text box.
   - Expected: Chrome shows "Typewriter started debugging this browser"; typing starts.
4. Try **Pause**/**Resume**, **Stop**, and **Alt+Shift+.** in separate runs.
5. At the end: the panel says **Verified** when it can read the field.

Send back: screenshots while typing and at the end.

## 5. Google Docs (optional, private document)

1. Create a new, private Google Doc. Turn off Docs' automatic substitutions first if you
   want an exact comparison (Tools › Preferences: smart quotes, automatic substitution).
2. Desktop app: **Into another app**, click into the Doc, let it finish.
3. Extension: **Into a web page**, click into the Doc, let it finish.
4. Both: select all in the Doc, copy, **Check copied text**.

Send back: whether each run was **Verified**, and screenshots with nothing personal in view.
