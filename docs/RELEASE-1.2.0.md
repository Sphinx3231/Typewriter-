**Pre-release, for testing.** Built and tested automatically by GitHub Actions (Desktop builds). Not merged into `main`.

## Install

**Windows 10/11:** `Typewriter_1.2.0_x64-setup.exe`
1. First uninstall **every** older Typewriter: Windows Settings › Apps, search "Typewriter". Up to 1.1.1 there were two installers, so there may be two entries.
2. Run the setup.exe. It isn't signed (code signing costs money), so SmartScreen warns: **More info › Run anyway**.
3. Open Typewriter › **Settings**, scroll down. It must say **Typewriter 1.2.0**, a **Build** code, "Running from …\AppData\Local\Typewriter\typewriter.exe", and no "Another copy" warning.

**macOS 11+ (Apple Silicon):** `Typewriter_1.2.0_aarch64.dmg`. Drag Typewriter to Applications, then right-click › **Open** the first time (unsigned). Never launched by us; see below.

**Linux:** `Typewriter_1.2.0_amd64.deb` (`sudo apt install ./Typewriter_1.2.0_amd64.deb`), the `.AppImage`, or the `.rpm`. X11 sessions only.

`SHA256SUMS.txt` lists the checksum of every file.

## What changed since 1.1.1

- **Closing always works.** Closing from the taskbar while Typewriter is minimized brings the window back with the "Quit?" question. If the window doesn't answer within 3 seconds, it closes anyway.
- **Switching tabs or windows makes typing wait.** Nothing goes into the other tab, and typing continues by itself when you go back.
- **The countdown starts from your click.** When Typewriter minimizes, Windows focuses the window behind it. That no longer starts the countdown, so the first words can't be lost before you've clicked into your document. A click or a window switch during the countdown starts it again.
- **One Windows installer.** Settings shows where the app runs from and warns if another copy is installed.
- A held Ctrl/Alt/Shift/Windows key is named in the "waiting" message.
- **Typing diagnostics:** Settings › About › Copy typing diagnostics copies timings and window types, never your text.

## What was tested

- **Windows:** the installed app passed 17 end-to-end checks on a GitHub-hosted Windows Server 2022 machine. These include Notepad, Chrome, Edge and Opera, a tab switch, pause/resume, the emergency stop, closing while minimized, and a status-window screen capture in every phase.
- **Linux:** the desktop end-to-end suite passed 24/24 (X11).
- **Unit tests:** 695 (100% line coverage of the interface code).
- **Typing engine:** native tests at 97% line coverage.

**Not tested:**
- a personal Windows PC;
- real Google Docs (the tests use a stand-in page);
- launching the macOS app.

If something goes wrong, copy the typing diagnostics and send them.
