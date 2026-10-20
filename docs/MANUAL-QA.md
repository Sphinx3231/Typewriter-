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
   - Windows: run the `*-setup.exe` (since 1.2.0 it is the only Windows installer). It's unsigned, so SmartScreen warns:
     **More info › Run anyway**.
   - macOS (Apple Silicon): open the `.dmg`, drag Typewriter to Applications, then
     right-click › **Open** the first time (unsigned).
   - Linux: install the `.deb`, or run the `.AppImage`.
3. **Remove the old version first.** Quit Typewriter (also from the tray icon), then uninstall it
   (Windows: Settings › Apps › Typewriter › Uninstall; macOS: drag it from Applications to the Trash).
   On Windows, search the list for "Typewriter" and uninstall **every** entry: older builds came
   with two installers, so there can be two copies. Then install the new one.
4. **Check you are running the fixed build:** open Typewriter › **Settings** › scroll to the bottom.
   It must say **Typewriter 1.2.0** and **Build** followed by a 7-character code, and on Windows
   **Running from** `…\AppData\Local\Typewriter\typewriter.exe`, with **no** "Another copy of
   Typewriter is installed" warning. If it says an older version, or shows that warning, the old
   app is still around: uninstall the copy it names, then check again before testing.

**Chrome extension** (unpacked, nothing is published):
1. Get it: **Actions** › **CI** › the latest run for branch `ccr-e747ce8b-l498oo` › download
   `typewriter-chrome-extension`, and unzip `typewriter-extension-1.2.0.zip` into a new folder.
   (Or build it yourself: `npm ci && npm run extension:build`; the folder is `dist-extension/`.)
2. `chrome://extensions` › turn on **Developer mode** › if an older Typewriter is listed,
   **Remove** it › **Load unpacked** › choose that folder.
3. Chrome shows that Typewriter can use the debugger. That's expected: it's how it sends
   real key presses.
4. **Check the version:** the Typewriter card in `chrome://extensions` must say **1.2.0**, and
   the panel's **Settings** tab must say **Typewriter 1.2.0** and a **Build** code.

Send back: your operating system and version, Chrome's version (`chrome://version`), and the
**Build** code from Settings (desktop app and extension).

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

## 1a. Windows: the same short text into three targets, with diagnostics

This is the check for "the countdown runs, then nothing appears". Use the 1.2.0 build from step 0 and confirm its **Build** code first.

1. Open Typewriter › **Settings** › **About**. Note the version and Build code.
2. Paste exactly: `Hello from Typewriter 123.`
3. Settings: **Into another app**, duration 6 s, Typing mistakes **Off**, countdown 3 s.
4. Run it three times, one per target:
   - **Windows Notepad** (opened normally, not as administrator);
   - **an ordinary text field in Opera** (for example a search box, or the box on a site's contact form; don't send it);
   - **a new private Google Doc in Opera**.

   Each time: press **Type into app**, click into the target, keep your hands off the keyboard, wait.
5. For each target, write down:
   - did the countdown appear and end?
   - did the first character appear, and about how long after the countdown ended?
   - what did the status window say at the end (or while it was stuck)?
6. Right after the three runs: Typewriter › **Settings** › **About** › **Copy typing diagnostics**, then paste it into your reply.
   It contains timings, window types and error codes, not your text or window titles. If the app can't be reached, the same log is the file `%LOCALAPPDATA%\app.typewriter.desktop\logs\typing-diagnostics.log`.
7. Optional: record the screen with the Snipping Tool (Win+Shift+R) for the Google Docs run, with nothing personal in view.

If it's stuck on "Waiting for you to release Ctrl, Alt, Shift or Cmd.", press and release each of those keys once and say whether typing then started.

Send back: the Build code, the three answers from step 5, and the pasted diagnostics.

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
| 2.12 | Start, then wait 2 s before clicking into the document. | The countdown starts again from your click (watch the status window): nothing is typed before a full countdown after the click, and the first letters aren't missing. |
| 2.13 | In Opera (or Chrome), type into a Google Doc; mid-session press **Ctrl+Tab** (or click another tab), wait 5 s, then go back to the Doc's tab. | The status window says "You switched tabs, so typing is waiting". Nothing appears in the other tab. Back in the Doc's tab, a 3-second countdown runs and typing continues by itself; the final text is exact. |
| 2.14 | Start a session (Typewriter minimizes itself). After it ends, right-click Typewriter in the taskbar › **Close window**. | Typewriter comes back to the front with "Quit Typewriter?". **Quit** closes it; nothing is left running (Task Manager shows no Typewriter). |
| 2.15 | Close Typewriter with its own **X** while the status window is showing. | The status window closes with it. |

Send back: pass/fail per row, and a screenshot of anything that didn't match.

## 2a. Smart Humanization (optional feature, off by default)

Use **Into another app** with Notepad (or a Google Doc), 20 s, typing mistakes Medium.

| # | Do this | Expected |
|---|---|---|
| 2a.1 | With Smart Humanization **off** (Settings), paste a formal essay (the sample below) and type it. | The document gets exactly what you pasted. No humanization line appears under the editor. |
| 2a.2 | Turn Smart Humanization **on**, paste the same essay again. | Within a moment the line under the editor says "Humanized automatically" with a score (for example 71%). No dialog, no button to approve. |
| 2a.3 | Press **Review the changes** under the status line (it scrolls to the **Humanization Studio** panel below); then open **Style checks**. | Changed words are highlighted in the text (underlined, struck through or boxed), with a summary like "9 changes · 26 words changed · 5 sentences adjusted". Every check is listed under Style checks, with a note that it is a style heuristic, not a detector. |
| 2a.4 | Press the down arrow (next change) a few times, then try **Side by side**, **Original**, **Highlights**, and **All text / Changes only**. | The selected change stays selected in every view, and each one shows a short reason. On a normal-size window Side by side shows original and revised next to each other, with no sideways scrolling. Turning highlights off shows the plain text. |
| 2a.5 | Select a change and press **Keep the original wording**. Type it, copy the document, press **Check copied text**. | Verified. The document equals the Final text view (highlights off) exactly, with that one change back to your wording. |
| 2a.6 | Press **Restore original**, type again. | The document equals your original exactly. |
| 2a.7 | Paste a short or casual paragraph (a few lines about your day). | "No changes needed" or "Too short to check"; it types exactly what you pasted. |
| 2a.8 | Start a session and try the switch, **Keep the original wording** and **Re-run** while typing. | They are disabled until the session ends; the arrows and Copy still work. |

Sample essay: *In today's fast-paced world, technology plays a crucial role in education. Moreover, students utilize various digital tools in order to learn more effectively. Furthermore, teachers leverage numerous platforms in order to facilitate learning for every student. Additionally, it is important to note that schools commence new programs every year (Smith, 2021). In conclusion, technology plays a crucial role in education.*

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
