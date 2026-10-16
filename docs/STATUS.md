# Status

_Last updated: 2026-10-16_

## Summary

All required features in `docs/SPEC.md` are built and verified in a real browser, apart from the limitations listed below.

- Branch: `ccr-e747ce8b-l498oo`
- Live build board: https://claude.ai/artifact/6rEu1C45BZBPPsu2pPXV6p
- Live preview: https://claude.ai/artifact/9pi8hGpiZY1TfVYpYNkZ65

## Tests (all passing at the last run)

### Unit and fuzz tests (`npm test`): 46

- **Text integrity.** Exact output for 11 tricky texts × 5 realism modes × 300 seeds, covering:
  - unicode, emoji (ZWJ, flags, skin tones, keycaps) and combining marks
  - CRLF, tabs, and leading/trailing whitespace
  - the user's own misspellings
  - 100k characters
- **Realism.**
  - deterministic seeds
  - clean mode gives even intervals
  - variation levels change the spread
  - pauses only when enabled
  - mistake levels
  - autocorrect vs. backspace vs. caret-move fixes
  - correction delay range
- **Timing.**
  - duration mode lands exactly on the requested length
  - speed mode adds time for pauses and corrections
  - duration and WPM convert both ways
  - too-short and superhuman-speed detection
- **Controller.**
  - completion and verification
  - pause/resume, including 200 rapid cycles
  - restart
  - stop vs. pause
  - invalid transitions rejected
  - late timers cause no drift
  - a mismatch is reported as an error, never as success
- **Fuzz.**
  - 1,500 random texts × random settings, with invariants checked after every keystroke
  - surrounding text is never disturbed
  - typos are always visibly marked
  - 300 random command sequences: no timer leaks, exact output afterwards

### Browser tests (`npm run test:e2e`, Chromium): 25

- exact output after typos and corrections
- typos visible, and autocorrect and backspace both observed
- pause/resume exactness
- stop vs. restart
- finishes within ±1 s of the requested duration
- theme switch mid-playback doesn't interrupt typing
- palette tokens per theme
- theme persists across reloads
- system theme on first launch
- settings persist
- empty and whitespace-only input blocked with a message
- too-short duration conflict and adjustment
- copy returns the exact text
- keyboard shortcuts
- history never stores text
- switching views doesn't interrupt playback
- 105k-character text stays responsive
- no horizontal overflow at 360 / 390 / 768 / 1024 / 1280 / 1920 px in both themes and all views
- keyboard-only use with visible focus
- reduced motion
- sounds only when enabled and stop instantly
- chaos test: 120 random rapid clicks, then an exact finish

### Visual checks

- Screenshots inspected in both themes at phone, tablet and desktop sizes, in these states: empty, ready, typing, typo, paused, completed, history and settings.
- Issues found and fixed:
  - see-through phone header
  - badge covering text
  - cramped presets and filters
  - misleading speed cap

## Known limitations

- **No Google Docs destination.** The reference sheet shows "Connect to Google Docs". That needs an external API, which the project rules forbid. Text is typed in Typewriter's own playback area and copied out from there.
- **Web app, not a native desktop app.** It runs in any modern browser and could be wrapped (e.g. Tauri) later. Packaging is not done.
- **No unfinished-session recovery.** Settings and theme are restored. The text is restored only if "Remember my text on this device" is on, which is off by default. An unfinished playback is not resumed after a reload.
- **QWERTY neighbours only.** Adjacent-key typos use a QWERTY layout. Letters outside a–z (e.g. Greek, Cyrillic) still get doubled, dropped, swapped or case typos, but not neighbour-key ones.
- **Background tabs.** Browsers throttle timers in background tabs. Playback stays on schedule: missed keystrokes are applied in a batch when the tab wakes, silently.
- **Sound not judged by ear.** Tests confirm sounds play only when enabled; nobody has listened to them in this environment.
- **Preview theme may follow the claude.ai viewer.** The preview runs inside the claude.ai viewer, which sets its own light/dark attribute on load, so the preview may start in the viewer's theme.
