# CLAUDE.md — Typewriter

Typewriter is a client-side app that takes a block of text and types it out progressively,
like a real person would, over a duration the user chooses. Realism settings control the
rhythm, pauses, and temporary typos that get corrected.

- **Product spec (authoritative):** `docs/SPEC.md`
- **Visual reference:** `docs/design/reference-sheet.png`
- **Build board (live tracker):** https://claude.ai/artifact/6rEu1C45BZBPPsu2pPXV6p

This repository is its own project. It does **not** inherit rules from any other repository.

**Priority (2026-10-17):** the standalone desktop app is the primary product. The Chrome extension is
kept but deferred. Do not publish to the Chrome Web Store or pay its developer fee. Do not merge,
delete branches or rewrite history without the owner's approval.

---

## Rules

### 1. $0 budget
Nothing in this project may cost money:
- no paid services, paid tiers, or trials that need a card
- no paid fonts, icons, sounds, or other assets
- no domain purchases

Use only free, open-source tools and dependencies under permissive licenses (MIT, Apache-2.0,
BSD, ISC, OFL for fonts). If a requirement can't be met for $0, say so and leave it out.
Never quietly swap in something paid.

### 2. No external APIs
The app runs entirely on the user's device:
- No runtime network calls: no AI/LLM APIs, analytics, telemetry, or remote storage.
- Fonts, icons, and sounds ship inside the bundle. Fonts are self-hosted from npm, not
  fetched from a CDN at runtime. Sounds are synthesized with Web Audio.
- Preferences live in local browser storage only.
- The reference sheet shows a "Connect to Google Docs" destination. Typewriter never uses a
  Google (or any other) API for this. The Chrome extension types into a Chrome tab with trusted
  key input through `chrome.debugger` (see `docs/EXTENSION.md`). The desktop app types into any
  app by sending real key presses through the operating system (see `docs/DESKTOP.md`). Both are local.

### 3. The user's text is untouchable
The final output must equal the source text exactly, character for character (see SPEC §2).
Simulated typos may appear only temporarily during playback. Nothing may proofread,
rewrite, or "fix" what the user wrote.

---

## How work is run

- **The build board is the command channel.** Before starting each task, read the board:
  - the order of the **Up next** lane is the priority, top first
  - cards the user moved, added, or parked, and notes sent through **Tell Claude**, override
    the plan
  - mark each command `seen` when it is picked up, then `done` with a short reply

  After each task, update the board: move the card, then post the current task, the latest
  commit, and test results.
- **Work autonomously.** Don't stop to ask about anything the spec already decides. Ask only
  when something would break a rule above.
- **Verify by running.** A feature counts only after it has been exercised: unit tests for the
  engine, and Playwright in a real browser for the UI. Never report a test as passing unless
  it actually ran and passed.
- **Keep `docs/STATUS.md` current.** It records what works, what was tested, and known
  limitations.
- **Never commit secrets.** `.env*` is gitignored.

## Commands

```bash
npm install          # install dependencies
npm run dev          # start the web dev server
npm run build        # typecheck + production web build
npm test             # unit tests (Vitest)
npm run test:e2e     # browser tests (Playwright, uses the preinstalled Chromium)
npm run test:native  # native typing engine tests (Rust)
npm run test:desktop # desktop end-to-end: packaged app types into a real Chromium window
                     # (needs Xvfb, openbox, xdotool, tauri-driver; build first)
npm run test:desktop:wayland # packaged app on a real (headless Weston) Wayland session
npm run extension:build # Chrome extension: dist-extension/ + release/typewriter-extension-<v>.zip
npm run test:extension  # extension end-to-end in real Chromium (builds a test variant too)
npm run desktop:dev  # run the desktop app in development
npm run desktop:build # build desktop installers (src-tauri/target/release/bundle/)
npm run lint         # typecheck only
```

Desktop details, permissions and limitations: `docs/DESKTOP.md`. Chrome extension: `docs/EXTENSION.md`.
