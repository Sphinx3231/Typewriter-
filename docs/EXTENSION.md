# Typewriter for Chrome (deferred)

> **Status: deferred.** The desktop app is the primary product (see [`DESKTOP.md`](DESKTOP.md)). The extension stays in the repository, built and tested, for possible later use. It is **not published** to the Chrome Web Store, and publishing is not planned: the developer fee is not authorized.

The Chrome extension is Typewriter in Chrome's side panel. Paste your text, choose the duration and realism, click into a web page such as a Google Docs document, and Typewriter types the text there with real key presses.

It is the same app as the browser and desktop versions, with the same engine and the same screens. Only the output is different: the extension types into **the Chrome tab you choose**. It can't type into other desktop apps; the [desktop app](DESKTOP.md) does that.

---

## Install (Load unpacked)

The extension isn't on the Chrome Web Store (see [Publishing](#publishing-and-updates)). Install it yourself:

1. Get the extension:
   - **Download:** from the repository's **Actions › CI** run, download the `typewriter-chrome-extension` artifact. Unzip it, then unzip `typewriter-extension-<version>.zip` inside it into a folder.
   - **Or build it:** `npm ci && npm run extension:build`. The folder is `dist-extension/` and the ZIP is `release/typewriter-extension-<version>.zip`.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder with `manifest.json` in it.
5. Pin Typewriter from the puzzle-piece menu. Clicking its icon opens the side panel.

Requirements: desktop Chrome 116 or newer on Windows, macOS, Linux or ChromeOS. Other Chromium browsers (Edge, Brave) may work but haven't been tested.

## Use it

1. Open your document in a tab, for example Google Docs.
2. Click the Typewriter icon to open the side panel next to it.
3. Paste your text and choose the duration or speed, mistakes and correction style.
4. In **Session settings › Output**, choose **Into a web page**.
5. Press **Type into page**.
   - The first time, Chrome asks to allow the **debugger** permission. Choose **Allow**.
   - If you refuse, nothing is typed and Typewriter explains why.
6. Click in the document **exactly where the text should start**.
7. A countdown runs (5 s by default; 2–30 s can be set). Then the text is typed there.

While it types, Chrome shows a bar saying **"Typewriter started debugging this browser"**. That bar is how Chrome tells you an extension is sending input. Closing it stops typing.

**Stop at any time** with any of these:
- the **Stop** button;
- the keyboard shortcut **Alt+Shift+.** (change it at `chrome://extensions/shortcuts`);
- closing the side panel;
- closing Chrome's debugging bar.

## How it types, and why it needs "debugger"

Google Docs doesn't use a normal text box. It takes key presses in a hidden frame, keeps the document in its own memory, and draws the page itself. It ignores key events made by scripts, because those are marked untrusted. So setting a field's value, or dispatching `KeyboardEvent`s from a content script, does **not** work in Google Docs.

The only way an extension can send *trusted* input, the same kind a keyboard produces, is through the [`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger) API, using the DevTools Protocol's `Input.dispatchKeyEvent` and `Input.insertText`. Typewriter uses it like this:

- **One tab only:** the tab that's active when the countdown ends. It attaches only after you press the button, and detaches when typing ends, stops or fails.
- **Key by key, on the planned timeline:** letters, Enter, Backspace, arrow keys for corrections. Accented letters, CJK and emoji are inserted as text the way an on-screen keyboard does it. Tab inserts a tab character.
- **A fixed inspection script, and nothing else:** before typing and every ~120 ms, it runs one built-in script that reports the focused element: what kind of field it is, whether it's a password or hidden field, and its text when that can be read. Your text is only ever sent as key input data. It is never run as code.

No content scripts are injected, and Typewriter asks for **no website access** (no host permissions).

### Permissions in plain language

| Permission | When | Why |
|---|---|---|
| `sidePanel` | at install | Show Typewriter in Chrome's side panel. |
| `debugger` (optional) | the first time you press **Type into page** | Send real key presses to the one tab you're typing into. Chrome's prompt describes this permission broadly (it can read and change data on websites), because the debugger is powerful. Typewriter only uses it as described above. You can remove it any time from the extension's details page. |
| `clipboardRead` (optional) | the first time you press **Check copied text** | Read the text you copied from your document, to compare it with your original. |

## Safety rules

- **Nothing types until you press Type into page and the countdown ends.** Cancel during the countdown and nothing is typed.
- **It types only into the tab that was active when the countdown ended,** into the field that had focus then.
- **Switching tabs pauses typing.** After Resume, it waits until that same tab is active again.
- **Moving focus to another field pauses it.** Nothing goes into the other field. Click back where you were, then Resume.
- **A reload or navigation stops it,** and so does a URL change in the same tab, or closing the tab.
- **Password, one-time-code, payment and hidden fields are refused.** If one gets focus during typing, it pauses.
- **Multi-line text isn't typed into single-line fields,** because Enter could submit a form.
- **Protected pages are refused:** Chrome pages, the Chrome Web Store, and others where Chrome blocks extensions.
- **It waits while no text field has focus,** instead of pressing keys into the page.

## Checking the result

When typing finishes, Typewriter reads the field back if it can:

- **Text boxes and inputs:** compared exactly with what the field should contain, including the text that was already around the insertion point. It shows **Verified** only on an exact match.
- **Rich editors that keep their text on the page:** it checks that your text now appears exactly.
- **Google Docs**, and any editor that keeps its text off the page: they **can't be read back**. Typewriter says "the document hasn't been checked", never "matches". To check, select the typed text in the document, copy it, and press **Check copied text**.

Google Docs can change text as you type. For an exact copy, turn these off in **Tools › Preferences**: automatic capitalisation, smart quotes, link detection, list detection and automatic substitutions.

## Privacy

- **Everything runs in your browser.** Everything the extension uses ships inside it. Its pages are blocked from fetch, XHR and WebSocket connections to any server (`connect-src 'self'`).
- **No analytics, telemetry, accounts or AI.**
- **Your text is not stored** unless you turn on "Remember my text" in Preferences. History keeps statistics only (length, duration, speed), never the text. Preferences live in the extension's local storage, on this device.
- **The inspection script reads only the focused field,** only during a session. What it reads stays in memory to check the result. It is never stored or sent anywhere.
- **No browsing history is collected.** Typewriter doesn't have the `tabs` permission, so outside a typing session it can't see your tabs' addresses. During a session it checks only the typed-into tab's address, to notice navigation.

## Phones and tablets

- **Chrome on Android and iOS doesn't support extensions,** so this extension can't be installed there.
- On a phone, use the browser version to watch the typing playback. It can't type into other apps.
- The extension is for desktop Chrome only.

## Testing

```bash
npm run test:extension   # builds both variants, then 27 Playwright tests in real Chromium
```

The tests load the unpacked extension into real Chromium and type into real pages. Typing is never simulated. They cover:
- a textarea, a single-line input, a contenteditable editor;
- a strict **Docs-like stand-in**: hidden input frame, text kept off the page and drawn on a canvas, script-made events ignored. The test proves that script-made events are rejected there, and that Typewriter's input arrives exactly.

They also cover every safety rule above, pause/resume/stop, the stop shortcut, long text, Unicode, the theme and logo in a narrow panel, and the release build and ZIP.

Automated browsers can't click Chrome's permission prompt, so these tests use a **test build** (`dist-extension-test/`) where `debugger` and `clipboardRead` are granted at install. The release build is tested separately to load correctly, with `debugger` *not* granted. The refused-permission path is covered by unit tests.

## Not verified

- **Typing into an actual Google Docs document has not been tested.** This environment has no Google account. The mechanism is the one Google Docs accepts from a keyboard, trusted input events, and it works in the strict stand-in, but that's not the same as running it in Docs. Please check with **Check copied text** the first time.
- **The real toolbar click and side panel.** Automation can't click Chrome's toolbar. The tests confirm the panel is set to open on the icon click, then open the same page in a window of side-panel width.
- **Windows, macOS and ChromeOS.** Tested on Linux only.

## Known limitations

- **Chrome tabs only.** It can't type into desktop apps, and it doesn't claim to.
- **Editors inside frames from another site** (some embedded editors) can't be inspected, so Typewriter waits instead of typing.
- **Keeping the side panel open.** If the side panel or Chrome window is closed, typing stops. Typing continues while you use another window, because it only ever goes to the chosen tab.
- **Restart isn't offered.** The text already typed would be duplicated. Undo it in your document, then press **Type into page** again.
- **Corrections use arrow keys.** Fixes that move back assume one arrow step per character. Editors that treat some characters differently, such as ligatures or tables, could misplace a fix. The copy-back check catches it.

## Publishing and updates

**The extension has not been published to the Chrome Web Store.**

Publishing would need:
- **A Chrome Web Store developer account.** It has a **one-time US$5 registration fee**, which conflicts with this project's $0 budget, so the owner has to decide on it.
- **A privacy-practices form and a privacy policy URL** (the Privacy section above can be the basis).
- **A justification for the `debugger` permission,** which gets extra review and may be questioned or rejected.

**Updates:**
- **Unpacked installs don't update themselves.** Replace the folder with the new build, then click the reload icon on Typewriter's card in `chrome://extensions`.
- **Web Store installs update automatically** once a new version (a higher `version` in the manifest) is published.
- Chrome on Windows and macOS doesn't allow self-hosted updates for extensions outside the Web Store, except through enterprise policy.
