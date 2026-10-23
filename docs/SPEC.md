# TYPEWRITER — COMPLETE MASTER BUILD PROMPT
## Premium Design, Realistic Typing Simulation, Dual Themes, and Full Functional QA

> Saved verbatim from the founder's brief (2026-10-16). This is the authoritative product spec.
> Project rules that sit on top of it (the $0 budget and no external APIs) live in `CLAUDE.md`.

You are continuing the development of Typewriter, an application already established through our previous design discussions.

Your task is to inspect the existing project, preserve successful work, and complete the application as a polished, reliable, fully functional product.

Do not restart the project unnecessarily. Do not replace working functionality with mockups, placeholders, or superficial animations. Inspect the existing repository, identify the current framework and architecture, understand what has already been implemented, and build on that foundation.

The following requirements define the intended final product.

---

# 1. CORE PRODUCT CONCEPT

Typewriter is a text playback application that accepts a complete block of user-provided text and types it progressively into a dedicated typing area over a configurable duration.

The user should be able to:

1. Paste or enter an entire text into an input editor.
2. Choose how long the typing process should take.
3. Configure typing speed and realism settings.
4. Start the playback.
5. Watch the text appear progressively, as though someone is actually typing it.
6. Observe occasional temporary typing errors and their corrections when realism mode is enabled.
7. Pause, resume, restart, or stop the playback.
8. See accurate progress, elapsed time, and estimated remaining time.
9. Copy or otherwise retrieve the final text.

The defining feature is realistic typing behavior. This must be a genuine playback engine, not a static block of text with a decorative cursor.

The application must feel like a premium desktop utility with a distinctive identity, carefully designed controls, smooth interactions, and reliable functionality.

# 2. NON-NEGOTIABLE TEXT INTEGRITY

The original text supplied by the user is authoritative.

The application must never rewrite, paraphrase, summarize, polish, or otherwise alter the supplied wording.

Strictly preserve:
- Every original word.
- Sentence structure.
- Grammar and spelling as originally supplied.
- Capitalization.
- Punctuation.
- Paragraph boundaries.
- Line breaks and whitespace, to the extent supported by the input format.

Do not use an AI model to rewrite or improve the source text.

Temporary mistakes during playback are permitted only as part of the typing simulation. They must not modify the authoritative source.

For example, if the source contains a correctly spelled word, the playback may briefly display a simulated typo before correcting it. If the source contains an intentional misspelling or grammatical error, preserve that original error in the completed output.

The final output must match the original input exactly at the character level, including whitespace and punctuation.

Never treat the realism engine as a text-editing or proofreading engine.

# 2a. SMART HUMANIZATION (OPT-IN EXCEPTION TO §2, approved by the owner 2026-10-19)

§2 applies whenever Smart Humanization is off, which is the default.

When the user turns Smart Humanization on:
- Every time the text changes, it is checked automatically against a local writing-style checklist. The checks look for:
  - repetitive wording;
  - redundant sentences;
  - formulaic transitions;
  - generic introductions or conclusions;
  - overly formal or wordy phrasing;
  - repetitive sentence structure;
  - vague statements;
  - a mismatch with the chosen tone;
  - from SlopMonster's checker (added 2026-10-23, see `docs/SLOPMONSTER.md`): overused buzzwords (2 or more), stock phrases and constructions such as "not just X, but Y" (2 or more), and tidy lists of three (at least one per 150 words). Words and phrases one of the checks above already counts are not counted again.
- Two more SlopMonster findings are shown as notes and never scored: dash, hyphen and semicolon habits, and numbers next to a claim ("10,000+ happy customers") to double-check.
- Score = flagged applicable checks ÷ applicable checks × 100. Only applicable checks count; notes never do. Text too short to judge, or with no applicable check, has no score and is left unchanged.
- At 50% or more (exactly 50% included), a minimal rule-based rewrite prepares a lightly edited copy. Below 50%, the text is left unchanged. No confirmation is asked.
- The rewrite must preserve:
  - meaning, facts, names and numbers;
  - quotations, citations, URLs and anything in brackets;
  - line breaks and paragraphs.
- The rewrite never invents content and never adds mistakes. A safety check compares the protected parts; if they differ, or the engine fails, the original text is typed and the status says so.
- The score is a writing-style heuristic. It is never presented as detecting AI authorship.
- The original is immutable. The rewrite is always derived from the original, never from a previous rewrite. The user can inspect both and type the original instead.
- The final output must equal the prepared text exactly, character for character. Text is never changed during a running session.
- It runs entirely on the device: no model, no network (CLAUDE.md rule 2).
- SlopMonster's own rewriting step sends text to an AI model, so it is not used. Its editing guidance is applied only as fixed local rules where the shorter wording means the same in any context: throat-clearing openers ("Here's the thing:", "The truth is,"), stacked hedges ("may potentially"), padding ("very unique", "more than just"), "leverage" used as a verb and "harness the power of". Everything else it finds is reported in the checklist for the writer to judge.

## 2b. Humanization Studio (added 2026-10-20)

After an automatic rewrite, the Studio shows what changed. It is a presentation layer: it never edits the text it shows.
- Changes come from a word-level diff of the original and the revised text (Myers, run line by line and then word by word), not from the rewrite marking its own edits.
- When a block of text is too large or too different for the word-level diff (more than 1,500 word edits, or more than 50,000 characters in one block, such as a long one-paragraph document), it is split into sentences and diffed sentence by sentence: sentence i pairs with sentence i when the counts match, otherwise the sentences are aligned first. Only if that also fails does the block show as one coarser change. Every path is exact: joining the pieces gives back both texts character for character.
- Three synchronized views: **Final text** (the text that will be typed, changes highlighted inline), **Side by side** (original and revised), and **Original**.
- The Studio is its own panel below the editor and playback (in windows from 1025 to 1260 px wide, below Settings, so it has the full width). The status line under the editor keeps the score and has **Review the changes**, which scrolls to the Studio. Side by side shows the two texts next to each other when the window is wider than 640 px and stacks them below that, with no horizontal scrolling.
- Added or reworded text is underlined, removed text is struck through, punctuation and spacing changes are boxed, and kept-original changes have a dashed line. Colors come from the theme (light: blue and purple; dark: orange and red), and every highlight also has a text label for screen readers.
- The summary (changes, words changed, sentences adjusted, words removed and added) is counted from the diff.
- Selecting a change explains it. An explanation names a rule only when one of the rewrite's recorded edits really occurs over that spot in the original; rules taken from SlopMonster say so. Otherwise it says "Wording adjusted for flow", "Punctuation adjusted", "Spacing or line breaks adjusted" or "Capitalization adjusted".
- Controls:
  - highlights on/off;
  - all text / changes only;
  - previous / next change (also Alt+↑ / Alt+↓);
  - copy original or revised;
  - restore original;
  - re-run on the original;
  - per change, keep the original wording.
- With changes kept as original, the prepared text is the revised text with exactly those slices of the original put back. It is still what is typed, exactly. Kept choices are cleared when the text, the tone or the result changes, and by a re-run.
- There is no approval step. While a session runs, nothing that changes the typed text can be used; looking around and copying still work.

# 3. BRAND IDENTITY AND VISUAL DIRECTION

Create a recognizable, professional identity for Typewriter.

The application must have its own custom logo, consistent typography, coherent iconography, polished controls, and a unified design language.

The logo should be original and relevant to the product. Explore a distinctive combination of a typewriter-inspired symbol, a typing cursor, or a carefully designed letterform. Avoid generic logos and excessive decorative detail.

Use a consistent spacing scale, border-radius system, typography hierarchy, and component library.

Every component must appear deliberately designed. Avoid generic dashboard layouts, unnecessary cards, excessive gradients, oversized headings, random icon styles, and inconsistent spacing.

Prioritize usability, clarity, and visual polish equally.

# 4. COMPLETE LIGHT MODE

The light theme must use the following primary palette:

- Purple: primary brand identity and important interactive elements.
- White: main backgrounds and clean surfaces.
- Cyan: secondary highlights, focus indicators, and progress accents.

The light theme should feel modern, bright, precise, and visually balanced.

Design requirements:
- A clean white or subtly tinted background.
- Carefully differentiated editor and playback surfaces.
- Purple primary buttons and active states.
- Cyan progress indicators and selected details.
- Clear, readable text with accessible contrast.
- Subtle borders and restrained shadows.
- Consistent hover, focus, pressed, disabled, and loading states.
- Elegant typography and comfortable spacing.
- Minimal, purposeful transitions.

Do not saturate the entire interface with purple or cyan. Use color intentionally to establish hierarchy.

The text editor must remain easy to read, and the playback area must provide enough contrast to distinguish typed text, the caret, and temporary corrections.

# 5. COMPLETE DARK MODE

The dark theme must use an intentionally different palette:

- Near-black: primary background.
- Dark charcoal: editor surfaces and secondary panels.
- Red: primary brand and active interaction accents.
- Orange: secondary highlights, progress, and supporting accents.

The dark theme should feel refined, focused, and sophisticated.

Design requirements:
- Deep near-black backgrounds rather than flat gray everywhere.
- Carefully differentiated surface elevations.
- Red primary buttons and active controls.
- Orange highlights and progress indicators.
- Readable text with accessible contrast.
- Restrained glow effects where appropriate.
- Subtle borders and consistent component styling.
- Distinct active, hover, focus, and disabled states.
- Smooth transitions between visual states.

Dark mode must not be a simple CSS inversion of light mode. Design its palette, surfaces, borders, shadows, and accents deliberately.

Avoid excessive red glow, oversaturated orange, and visually exhausting contrast.

# 6. LIGHT/DARK MODE SWITCH

Implement a fully functional theme switch that is visible and easy to access from the application header.

The switch must:
- Clearly indicate the current theme.
- Support switching between Light and Dark modes.
- Update the entire interface immediately.
- Preserve the selected theme across application restarts.
- Work consistently on every screen and component.
- Update text colors, backgrounds, borders, icons, controls, tooltips, and progress indicators.
- Respect system theme preferences on first launch if no explicit user preference exists.
- Allow an explicit user selection to override the system preference.
- Remain accessible through keyboard navigation and screen readers.

Use a polished toggle, segmented switch, or compact sun/moon control that fits the visual identity.

Do not use a decorative switch that fails to change the actual application theme.

Centralize theme tokens using CSS variables, design tokens, or the existing framework's appropriate theme architecture.

All components must use the shared theme system rather than scattered, hardcoded colors.

Verify that switching themes during playback does not interrupt, reset, or alter the typing session.

# 7. APPLICATION LAYOUT

Design the complete interface with a clear hierarchy.

## A. Application header

Include:
- Custom Typewriter logo.
- Application name.
- Theme switch.
- Settings access.
- Any essential secondary actions.

Keep the header compact and polished.

## B. Text input editor

Provide a spacious, comfortable editor for entering or pasting the complete text.

Include:
- A clear input label.
- A helpful empty-state placeholder.
- Character count.
- Word count.
- Optional line and paragraph counts.
- A clear-text action with confirmation when appropriate.
- A way to inspect and edit the original input before playback.

The editor must handle long texts without freezing the interface.

## C. Playback surface

Provide a dedicated area in which the text progressively appears.

Include:
- A readable text surface.
- A visible typing caret.
- Natural scrolling when the text exceeds the available space.
- Appropriate paragraph spacing.
- A clear visual distinction between the input editor and the playback output.
- An optional indicator showing whether playback is active, paused, or complete.

The playback surface must display the actual simulated typing sequence, not reveal the full text immediately.

## D. Playback configuration

Provide an organized configuration area with:
- Total duration.
- Typing speed.
- Characters per second or words per minute.
- Realism settings.
- Optional pauses.
- Optional typing sounds.

Display estimated completion time and explain any conflicts between the selected duration and realism settings.

## E. Playback controls

Provide:
- Start.
- Pause.
- Resume.
- Restart.
- Stop.
- Copy final output.

Each control must perform its advertised action.

Use clear disabled states when an action is unavailable.

## F. Progress and timing

Show:
- Completion percentage.
- Progress indicator.
- Elapsed time.
- Estimated remaining time.
- Current typing rate.
- Current playback status.

Update the interface without unnecessary rendering overhead.

# 8. REALISTIC TYPING ENGINE

The central playback engine must simulate the experience of a person entering the supplied text.

Typing must not progress at perfectly uniform intervals unless the user explicitly disables realistic rhythm.

## A. Natural typing rhythm

Support configurable variations such as:
- Small variations in the time between keystrokes.
- Slight pauses between words.
- Longer pauses after punctuation.
- Brief pauses between paragraphs.
- Occasional hesitation before longer words.
- Short bursts of faster typing after a pause.

Keep these variations subtle and believable.

Avoid exaggerated pauses, erratic speed changes, and unnecessary delays.

The average typing rate must remain consistent with the configured playback duration.

## B. Character-by-character rendering

The engine must progressively reveal text through ordered typing events.

Each event should represent an action such as:
- Typing a character.
- Waiting briefly.
- Moving the caret.
- Deleting a character.
- Replacing a temporary typo.
- Completing a word.
- Pausing at punctuation.

The playback renderer must respond to these events and update the visible text accordingly.

Do not implement a fake typing animation that displays the entire source immediately and merely moves a cursor across it.

## C. Realistic caret behavior

Implement a visible caret that:
- Appears at the current insertion point.
- Blinks naturally while typing or waiting.
- Moves appropriately during corrections.
- Remains at the correct position after pause and resume.
- Disappears or changes appearance appropriately when playback completes.

Caret animation must not interfere with text rendering or timing.

# 9. TYPING MISTAKES AND CORRECTIONS

Provide an optional realism mode that simulates occasional, plausible typing mistakes.

The goal is to reproduce the visible sequence of typing, noticing an error, correcting it, and continuing.

## A. Supported temporary mistakes

Examples include:
- Typing an adjacent keyboard character.
- Accidentally duplicating a character.
- Omitting a character temporarily.
- Transposing two neighboring characters.
- Briefly misspelling a word.
- Making a temporary punctuation or capitalization error.

Mistakes should be infrequent and configurable.

Do not inject mistakes into every sentence or make the simulation look careless.

## B. Visible correction sequences

A correction should follow a believable sequence:

1. Type the temporary error.
2. Allow a brief delay.
3. Move the caret to the incorrect position if necessary.
4. Use backspace or selection to remove the incorrect characters.
5. Type the correct characters.
6. Resume normal typing.

Not every mistake should follow exactly the same sequence.

The engine may simulate a mixture of immediate correction, delayed correction, and backspace-and-retype behavior.

## C. Autocorrect simulation

Provide an optional autocorrect style.

For eligible temporary spelling mistakes:
- The incorrect word may briefly appear.
- A short correction delay occurs.
- The incorrect word is replaced by the intended original word.
- Typing continues.

The correction must be visibly represented in the playback sequence.

Do not silently correct text before playback starts.

Do not depend on an operating system's actual autocorrect behavior, since that would make results unpredictable. Implement the simulation within the application.

## D. Manual correction simulation

When this style is selected:
- The caret returns to the relevant position.
- Backspaces visibly remove the temporary error.
- Correct characters are typed into the same position.
- The remainder of the text is preserved.

The implementation must correctly handle corrections in the middle of a sentence without duplicating or deleting surrounding text.

## E. Preserve the original wording

Temporary corrections must always converge toward the supplied source text.

Do not correct original grammatical mistakes or spelling mistakes that were already present in the input.

The simulation may correct an error it generated, but it must not reinterpret the user's writing.

# 10. REALISM SETTINGS

Create a clearly organized settings panel with the following options.

### Realistic typing rhythm
- Off.
- On.

### Typing speed variation
- Low.
- Medium.
- High.

### Simulated typing mistakes
- Off.
- Low.
- Medium.

### Correction behavior
- Autocorrect simulation.
- Backspace and retype.
- Mixed behavior.

### Correction delay
Provide an adjustable delay range with a sensible default.

### Natural pauses
- Off.
- On.

### Typing sounds
- Off.
- On.

If sounds are enabled, use subtle, optional effects that can be disabled instantly. Avoid repetitive or excessively loud audio.

### Duration and speed

Allow the user to choose either:
- A target duration for the complete text.
- A target typing speed.

When one setting changes, calculate the corresponding estimate for the other.

Clearly communicate that realism, corrections, and pauses affect the total duration.

The user should be able to disable every optional realism effect and use clean, predictable typing.

Persist configuration preferences across sessions.

# 11. PLAYBACK STATE MANAGEMENT

Implement playback as a proper state machine.

Support these states:
- Empty.
- Ready.
- Playing.
- Paused.
- Completed.
- Stopped.
- Error.

Define the permitted transitions clearly.

Examples:
- Ready → Playing.
- Playing → Paused.
- Paused → Playing.
- Playing → Completed.
- Playing → Stopped.
- Paused → Stopped.
- Completed → Playing after a restart or new session.

Prevent invalid transitions and duplicated playback loops.

## Pause and resume

Pausing must stop playback advancement without losing:
- The current text.
- The caret position.
- The event index.
- The remaining event delays.
- The elapsed-time state.
- The correction state.

Resuming must continue from the correct point.

## Restart

Restarting must:
- Cancel the existing playback sequence.
- Reset the playback position.
- Clear temporary output.
- Reset progress and elapsed time.
- Reinitialize the event sequence according to the configured behavior.
- Start cleanly without duplicate timers or event handlers.

## Stop

Stopping must terminate active playback safely.

Define and implement a consistent stopped-state behavior. Do not confuse stopping with pausing or completing.

## Completion

When playback finishes:
- Verify the final output.
- Mark the session complete.
- Update progress to 100%.
- Stop all active playback timers.
- Keep the final text available.
- Allow the user to copy the completed output or start again.

# 12. TIMING ACCURACY AND PERFORMANCE

Timing must be handled independently of visual rendering frequency.

Do not rely on repeatedly adding a fixed delay and assuming every callback executes on time.

Use a reliable event scheduler based on elapsed time and planned event timing.

Account for:
- Variable character delays.
- Correction events.
- Pauses.
- Rendering delays.
- Browser scheduling variability.
- Pause and resume.
- Restart and cancellation.

Calculate progress using the actual playback timeline rather than simply dividing the current character index by the total number of characters.

Where appropriate, precompute the event sequence and its expected cumulative timing before playback begins.

If the user specifies a total duration, distribute the typing events across that duration while preserving realistic rhythm as much as possible.

Explain when the selected duration is incompatible with the requested pauses or corrections, and offer a sensible adjustment.

Ensure the interface remains responsive during long playback sessions.

# 13. SOURCE TEXT, EVENT SEQUENCE, AND FINAL OUTPUT

Keep these concepts separate in the architecture:

1. Immutable source text.
2. Generated playback-event sequence.
3. Current visible text.
4. Current caret position.
5. Playback event index.
6. Playback timing state.
7. Final completed output.

The event sequence should describe how the text is typed, including temporary mistakes and corrections.

The renderer should apply those events to the visible output.

The final completed output must be compared with the original source text.

If a mismatch is detected, do not silently claim success. Identify the issue, correct the playback implementation, and retest it.

Where practical, make playback deterministic so restarting the same session reproduces the same event sequence. If randomized behavior is supported, use a configurable random seed or clearly defined regeneration behavior.

# 14. TEXT STATISTICS AND INPUT HANDLING

Display accurate:
- Character count.
- Word count.
- Line count.
- Paragraph count.
- Estimated typing duration.
- Estimated completion time.

Update the statistics when the source text changes.

Handle:
- Empty input.
- Whitespace-only input.
- Very long text.
- Multiple paragraphs.
- Unicode characters.
- Emoji.
- Punctuation.
- Tabs and line breaks.
- Different keyboard layouts where relevant.

Use appropriate text indexing so Unicode characters and surrogate pairs are not corrupted.

Do not truncate the source text without informing the user.

If a setting is invalid, provide clear feedback rather than allowing the playback engine to fail.

# 15. PERSISTENCE AND SESSION MANAGEMENT

Persist appropriate preferences, including:
- Selected theme.
- Preferred typing speed.
- Default duration behavior.
- Realism settings.
- Sound preferences.

Use the project's existing persistence architecture where available.

If session recovery is implemented, distinguish between restoring settings and restoring an unfinished playback session.

Never imply that a session was recovered successfully unless the restored state has actually been verified.

Do not store unnecessary copies of sensitive text. Make any text-persistence behavior clear and predictable.

# 16. ACCESSIBILITY AND USABILITY

Ensure:
- Keyboard-accessible controls.
- Visible focus indicators.
- Accessible labels.
- Readable contrast in both themes.
- Sensible keyboard shortcuts where appropriate.
- Clear validation messages.
- Consistent button behavior.
- Appropriate reduced-motion behavior.
- No essential information conveyed by color alone.

Provide a comfortable editing experience and ensure the playback output is readable on smaller screens.

# 17. RESPONSIVE DESIGN

The interface should work well across supported desktop, tablet, and mobile viewport sizes.

On larger screens, use a balanced editor and playback layout with sufficient space for configuration.

On smaller screens:
- Stack panels logically.
- Keep primary playback controls accessible.
- Avoid horizontal overflow.
- Maintain readable typography.
- Keep the theme switch available.
- Ensure the editor and playback area remain usable.

Do not shrink the entire desktop interface indiscriminately to fit mobile.

# 18. IMPLEMENTATION REQUIREMENTS

Before coding:

1. Inspect the repository.
2. Identify the framework and entry points.
3. Review existing components, theme logic, and playback implementation.
4. Identify missing or broken features.
5. Establish a concise implementation plan.
6. Preserve working code and established visual decisions.

During development:
- Use the existing architecture where practical.
- Reuse components and design tokens.
- Keep the playback engine separate from presentation.
- Avoid unnecessary dependencies.
- Remove obsolete or duplicate logic safely.
- Implement real behavior behind every interactive control.
- Handle errors gracefully.
- Maintain clean, understandable code.
- Avoid regressions in existing functionality.

Do not substitute screenshots, mock data, hardcoded progress, or simulated success messages for actual working features.

# 19. REQUIRED TESTING

Run the available automated tests and perform real interaction tests.

At minimum, verify the following.

### Theme testing
- Light mode uses purple, white, and cyan.
- Dark mode uses near-black, red, and orange.
- Switching themes updates every relevant component.
- Theme selection persists across restarts.
- Theme changes do not interrupt playback.

### Text integrity testing
- Simple sentences.
- Multiple paragraphs.
- Punctuation and capitalization.
- Original misspellings and grammatical errors.
- Unicode and emoji.
- Long input.
- Leading and trailing whitespace.
- Exact final-output comparison.

### Playback testing
- Start.
- Pause.
- Resume.
- Restart.
- Stop.
- Completion.
- Repeated sessions.
- Empty input.
- Very short duration.
- Long duration.
- Speed changes.

### Realism testing
- Rhythm variation enabled and disabled.
- Typing mistakes enabled and disabled.
- Autocorrect simulation.
- Backspace-and-retype simulation.
- Correction delays.
- Natural pauses.
- Typing sounds.
- Exact preservation of final wording.

### Reliability testing
- No duplicate timers.
- No duplicated characters.
- No lost text after pause/resume.
- No corrupted output after restart.
- No unexpected state transitions.
- No timing drift that materially violates the configured duration.
- No major performance degradation on long text.

### Visual testing
Inspect the actual running application in both themes.

Test multiple viewport sizes and verify:
- Spacing.
- Typography.
- Contrast.
- Alignment.
- Button states.
- Caret visibility.
- Progress display.
- Editor scrolling.
- Playback scrolling.
- Empty, active, paused, completed, and error states.

If browser automation or screenshot verification is available, use it. Inspect the screenshots and correct visible defects rather than merely generating screenshots and declaring success.

# 20. DEFINITION OF DONE

Typewriter is complete only when all of the following are true:

- It has a distinctive, finished visual identity and custom logo.
- Light and dark modes are fully functional.
- Light mode uses purple, white, and cyan.
- Dark mode uses near-black, red, and orange.
- Theme switching is persistent and does not interrupt playback.
- Users can paste an entire text into the editor.
- Users can configure typing speed or total duration.
- Text is progressively typed into the playback area.
- Optional realism settings affect actual playback behavior.
- Temporary typing mistakes and corrections are visibly simulated.
- The final text matches the original source exactly.
- The original wording is never rewritten or silently corrected.
- Playback controls work reliably.
- Timing and progress are meaningful and accurate.
- Long texts are handled without unacceptable performance problems.
- Existing functionality has not been unnecessarily broken.
- Automated tests and real interaction checks have been performed.
- Remaining limitations are explicitly documented.

# 21. EXECUTION INSTRUCTIONS

Work directly in the existing project.

Do not stop after writing a plan or presenting a design concept. Implement the features, run the application, test the actual behavior, inspect the interface, and fix the problems you discover.

Prioritize functional correctness and visual quality equally.

Do not claim that a feature is complete merely because its interface exists.

Do not claim that tests passed unless they were actually run and passed.

If a requirement cannot be completed because of a genuine technical limitation, explain the limitation and its impact, then complete the remaining work.

At the end, provide a concise report covering:
- Features implemented.
- Important files or components changed.
- Theme and playback behavior verified.
- Tests actually executed and their results.
- Any remaining defects or incomplete requirements.

The final result should be a cohesive, production-quality Typewriter application: visually distinctive, fully functional, reliable, and capable of reproducing a natural typing process while preserving the user's supplied text exactly.

---

# AMENDMENTS

## 2026-10-17 — Desktop-first, light palette

These amendments come from the product owner and override the sections above where they conflict.

- **Priority:** the standalone desktop app is the primary product. The Chrome extension is kept but deferred. Chrome Web Store publication is not pursued, and its fee is not authorized.
- **Light theme palette:** white, blue and purple. Blue replaces cyan as the secondary color (progress, focus, highlights, caret). Purple stays the primary brand color. The dark theme is unchanged: black, red and orange.
- **Contrast:** every text/background token pair is checked automatically against WCAG AA (`src/theme/contrast.test.ts`).
