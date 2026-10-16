# Typewriter

**Type naturally. Write effortlessly.**

Typewriter takes a block of text and types it out keystroke by keystroke, like a real person would, over the time you choose. Pauses, small rhythm changes and the odd typo come with it. Every typo is corrected on screen, and the finished text always matches what you pasted, character for character.

It runs entirely in your browser: no account, no server, no AI, no tracking.

## Features

- **Real typing playback.** A seeded engine plans every key press, pause, typo and correction, then plays it on a drift-free timeline.
- **Your words stay yours.** The output is checked against your original at the end. Your own spelling and grammar are never "fixed".
- **Timing by duration or speed.** Set "finish in 3 minutes" or "type at 70 WPM". The other value is worked out for you, with a breakdown of typing, pauses and corrections.
- **Realism controls.**
  - realistic rhythm and speed variation
  - natural pauses
  - typing mistakes (off, low, medium)
  - three correction styles: autocorrect, backspace-and-retype, mixed
  - correction delay
  - synthesized typing sounds
- **Full playback control.** Start, pause, resume, restart, stop and copy, with progress, elapsed and remaining time, live WPM and an estimated finish time.
- **Two designed themes.**
  - Light: purple, white and cyan.
  - Dark: near-black, red and orange.
  - Follows your system until you choose, then remembers your choice.
- **Local-only history** of finished sessions. It keeps statistics only, never your text.
- **Keyboard shortcuts:**
  - `Ctrl/⌘ + Enter` starts
  - `Space` pauses or resumes
  - `Esc` stops
  - `Ctrl/⌘ + Shift + C` copies
- **Accessibility and layout.** Works on phone, tablet and desktop, with AA contrast, screen-reader announcements and reduced-motion support.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Typecheck and production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Unit and fuzz tests (Vitest) |
| `npm run test:e2e` | Browser tests (Playwright; build first) |
| `npm run lint` | Typecheck only |

## How it works

```
source text ──► buildScript() ──► keystroke script (timing-free, seeded)
                                    │
               buildTimeline() ◄────┘  duration or WPM → event times
                     │
            PlaybackController  (state machine + scheduler)
                     │ applies events
                TypedBuffer  ──► PlaybackSurface (incremental DOM)
```

- `src/engine/` is plain TypeScript with no UI:
  - `script.ts`: keystrokes, pauses, typos, corrections
  - `schedule.ts`: timing and conflict detection
  - `player.ts`: states and drift-free scheduling
  - `buffer.ts`: the visible text and caret
- `src/ui/` holds the React components. `src/theme/tokens.css` holds every colour for both themes.
- Product spec: [`docs/SPEC.md`](docs/SPEC.md). Current state and known limitations: [`docs/STATUS.md`](docs/STATUS.md).

## Project rules

- $0 budget and no external APIs. See [`CLAUDE.md`](CLAUDE.md).
- Fonts (Inter, JetBrains Mono, OFL) and icons (Lucide, ISC) are bundled.
- Sounds are generated with Web Audio.
