# Typewriter

**Type naturally. Write effortlessly.**

Typewriter is a desktop app. Paste a block of text, choose how long it should take, and Typewriter types it out keystroke by keystroke, like a real person would. It can type in its own window, or into the app you click into (a text editor, a browser, Google Docs) with real key presses.

Pauses, small rhythm changes and the odd typo come with it. Every typo is corrected before the end, and the finished text always matches what you pasted, character for character.

Everything runs on your computer: no account, no server, no AI, no tracking.

## Install the desktop app

**Download:** the repository's **Releases** page (right-hand side on GitHub) › the newest **Typewriter** entry (marked *Pre-release*) › *Assets*. No GitHub sign-in needed.

| System | File | Status |
|---|---|---|
| Windows 10/11 (x64) | `Typewriter_1.2.0_x64-setup.exe` (the only Windows installer) | Installed and tested end to end on a GitHub-hosted Windows machine; **not yet run on a personal PC** |
| macOS 11+ (Apple Silicon only) | `Typewriter_1.2.0_aarch64.dmg` | Built by CI, session tests pass; **not launched yet**; no Intel build |
| Linux (Debian/Ubuntu) | `Typewriter_1.2.0_amd64.deb` | Built; the app passes the Linux desktop end-to-end suite (X11) |
| Linux (any) | `Typewriter_1.2.0_amd64.AppImage` | Built by CI |
| Linux (Fedora/openSUSE) | `Typewriter-1.2.0-1.x86_64.rpm` | Built by CI; **not installed on Fedora/openSUSE** |

**Windows: uninstall every older Typewriter first** (Settings › Apps, search "Typewriter"; versions up to 1.1.1 could be installed twice). After installing, Typewriter › Settings shows the version, the build and where it runs from.

What changed and what was tested: [`docs/RELEASE-1.2.0.md`](docs/RELEASE-1.2.0.md). Step-by-step install, permissions and the typing workflow: [`docs/DESKTOP.md`](docs/DESKTOP.md).

**Publishing a release** (maintainer): Actions › Desktop builds › Run workflow, tick **release**. It publishes a pre-release only if every build and the Windows end-to-end test pass on that commit. To build the installers yourself:

```bash
npm ci
npm run desktop:build   # installers in src-tauri/target/release/bundle/
```

## What it does

- **Types into another app.** Press **Type into app**, click where the text should go, and after a countdown Typewriter types there.
  - **Emergency stop:** Ctrl+Shift+Space, the mouse in the top-left corner, or **Stop** in the small status window.
  - **Status window:** stays on top with progress, time left, and Pause/Resume/Stop.
  - **Safety:** it pauses if you click another window, never types into itself, and refuses login and password windows.
  - **Results:** it reports "sent" until you check the document with **Check copied text**.
- **Your text stays exact.** Every input is checked by automated tests against the final result: punctuation, spacing, line breaks, accents, CJK, emoji, combining marks, and your own spelling.
- **Your text isn't lost by accident.** Quitting with unsaved text, or in the middle of typing, asks first.
- **Timing by duration or speed.** Set "finish in 3 minutes" or "type at 70 WPM"; the other value is worked out for you.
- **Realism controls:**
  - rhythm and speed variation;
  - natural pauses;
  - typing mistakes (off, low, medium);
  - three correction styles;
  - correction delay;
  - synthesized typing sounds.
- **Full control.** Start, pause, resume, stop, plus progress, elapsed and remaining time, live WPM and an estimated finish time.
- **Two themes, both using the original dragon logo:**
  - Light: white, blue and purple.
  - Dark: black, red and orange.
  - Text contrast in both is checked automatically against WCAG AA.
- **Local-only history** (statistics only, never your text), keyboard shortcuts, and screen-reader and reduced-motion support.

## Deferred

- **Chrome extension.** It is built and tested (`docs/EXTENSION.md`) and kept in the repository, but it isn't the priority.
- **Chrome Web Store.** Not published, and not planned: the developer fee is not authorized.

## Development

```bash
npm install
npm run dev            # web preview at http://localhost:5173
npm run desktop:dev    # the desktop app, with hot reload
```

| Command | What it does |
| --- | --- |
| `npm run lint` | Typecheck |
| `npm test` | Unit, fuzz, text-integrity and contrast tests (Vitest) |
| `npm run build` | Production web build into `dist/` (the desktop app's UI) |
| `npm run test:e2e` | UI tests in Chromium (Playwright; build first) |
| `npm run test:native` | Native typing engine and safety tests (Rust) |
| `npx tauri build --no-bundle` | Release desktop binary only (what `test:desktop` runs) |
| `npm run test:desktop` | The packaged app types into a real Chromium window (Linux, X11; needs Xvfb, openbox, xdotool, tauri-driver) |
| `npm run test:desktop:wayland` | The packaged app as a native Wayland client under headless Weston (needs weston, Xwayland, tauri-driver) |
| `npm run desktop:build` | Desktop installers |
| `npm run extension:build` / `test:extension` | Deferred Chrome extension: build / tests |

## How it works

```
source text ──► buildScript() ──► keystroke script (seeded typos and corrections)
                                    │
               buildTimeline() ◄────┘  duration or WPM → event times
                     │
         ┌───────────┴────────────┐
   in-app preview            another app (desktop)
   PlaybackController        typewriter-native (Rust): events → keys,
   + TypedBuffer             focus guard, failsafes, X11/Windows/macOS output
```

- `src/engine/`: plain TypeScript, no UI. It covers the script, timing, the playback state machine and the exact-text buffer.
- `src-tauri/native/`: the desktop typing engine. Operating-system access sits behind one `Desktop` trait, so the session logic is tested without a desktop.
- `src/ui/`: React components. `src/theme/tokens.css` holds every colour for both themes.
- Docs:
  - spec: [`docs/SPEC.md`](docs/SPEC.md)
  - current state and limitations: [`docs/STATUS.md`](docs/STATUS.md)
  - latest audit: [`docs/DESKTOP-AUDIT.md`](docs/DESKTOP-AUDIT.md)

## Project rules

- $0 budget and no external APIs. See [`CLAUDE.md`](CLAUDE.md).
- Fonts (Inter, JetBrains Mono, OFL) and icons (Lucide, ISC) are bundled.
- Sounds are generated with Web Audio.
