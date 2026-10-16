# CLAUDE.md — Typewriter

Typewriter is a client-side app that takes a block of text and types it out progressively,
like a real person would, over a duration the user chooses. Realism settings control the
rhythm, pauses, and temporary typos that get corrected.

- **Product spec (authoritative):** `docs/SPEC.md`
- **Visual reference:** `docs/design/reference-sheet.png`
- **Build board (live tracker):** https://claude.ai/artifact/6rEu1C45BZBPPsu2pPXV6p

This repository is its own project. It does **not** inherit rules from any other repository.

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
  Google (or any other) API for this. The desktop app types into Google Docs, or any other app,
  by sending real key presses through the operating system, locally (see `docs/DESKTOP.md`).

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
npm run desktop:dev  # run the desktop app in development
npm run desktop:build # build desktop installers (src-tauri/target/release/bundle/)
npm run lint         # typecheck only
```

Desktop details, permissions and limitations: `docs/DESKTOP.md`.
