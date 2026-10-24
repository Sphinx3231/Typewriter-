# SlopMonster in Typewriter

SlopMonster's writing checker is Typewriter's writing analysis (SPEC §2a, §2b). It is the only engine: it reports findings and never changes the text. This page records:

- what SlopMonster is;
- what was taken from it, and what was not;
- how it was checked.

## 1. The project (audited 2026-10-23)

| | |
|---|---|
| Repository | https://github.com/ItsssssJack/SlopMonster (the project in the reference video: same name, same five monster mascots in `docs/img/hero.png`, same "What it checks" table) |
| Author, license | Jack Roberts, MIT (`LICENSE`, © 2026) |
| Audited commit | `3fc9787` (2026-09-26), the latest at the time; first commit 2026-08-29; 2 contributors |
| What it is | A Claude Code / Codex *skill* (`SKILL.md`) plus two command-line tools, not a library or a service |
| `tools/deslop.py` | The checker: Python standard library only (`re`, `html`, `sys`), no network, no telemetry. It reads text, HTML or Markdown and lists hits in five categories; the score is 5 minus the number of categories with a hit |
| `tools/cleanse.sh` + `prompts/cleanse.txt` | The rewriter: sends the whole draft to an AI model through the `codex` or `claude` command-line tool (a "rival model"), and returns the model's rewrite |
| Dependencies | None for the checker; the rewriter needs an installed AI CLI and an account with that provider |

The video's claims were checked against the code. The table of what it checks matches `deslop.py`, and upstream's own test suite (`tools/test_deslop.py`) passes. The video presents the cleanse step as part of the tool. In the code it is a call to an AI model.

### What the checker looks for (`deslop.py`)

| Category | Rule |
|---|---|
| Vocabulary | 39 words matched with their inflections ("leverage", "seamless", "elevate", "robust", "foster"…), and 21 matched exactly ("journey", "landscape", "in today's", "deep dive"…) |
| Phrases | 17 constructions: "not just X, but Y" and "not just X, it's Y" (contracted or not), "whether you're X or Y", "that's where X comes in", "more than just", "say goodbye to", "imagine a", "when it comes to", "at the end of the day", "the key is / the truth is", "helps you to", stacked hedges ("may potentially"), intensifiers ("very unique"), throat-clearing ("here's the thing"), "ready to get started", and questions it answers itself ("The result?") |
| Punctuation | Two or more em-dashes in one sentence, four or more hyphenated compounds in one sentence, and more than max(3, length ÷ 1200) semicolons |
| Rhythm | Two narrow shapes of a list of three ("faster, smarter, and better"; "trusted, reliable and built to last") |
| Proof | A number next to a noun such as customers, users, teams or students ("10,000+ happy homeowners") |

## 2. What is used

| Used | How |
|---|---|
| The whole checker (catalogue, `normalise`, `audit`, score) | Ported rule for rule to TypeScript in `src/analysis/slopmonster/index.ts`, with the MIT notice. The notice is in `LICENSE` next to it, and the app shows it under Preferences › About › Open-source notices. Python's Unicode-aware `\w`, `\s`, `\d` and `\b`, and its code-point string lengths, are reproduced exactly |
| Where each hit is | `locate()` reruns the same compiled patterns. Each hit is mapped back from the normalised text to the characters the user wrote: curly apostrophes, non-breaking hyphens, runs of spaces, tabs and line breaks, and CRLF. `hitsOf(locate(t))` must equal `audit(normalise(t))`; `analyze()` throws (an honest "Writing analysis failed") if it ever doesn't |
| `--allow-proof` | Settings › "My number claims are backed up": proof findings stay listed, but no longer lower the score |
| Explanations | From upstream's README ("What it checks") and `references/signs-of-ai-writing.md`, including its suggested fix for each construction (`src/analysis/index.ts`) |

| Not used | Why |
|---|---|
| The AI rewrite (`cleanse.sh`, `prompts/cleanse.txt`) | It sends the text to an AI model over the network. Typewriter runs entirely on the device, with no AI and no network (CLAUDE.md rule 2) |
| Any rewriting at all | Typewriter's earlier Smart Humanization rewrote text with fixed rules when its own checklist scored 50% or more. The checklist, the threshold and every rewrite rule were removed on 2026-10-24. What is typed is always the editor text |
| HTML and Markdown readers, the CLI | Typewriter checks the plain text the user typed |

Not supported, and not imitated:
- a revised text, side-by-side comparison or per-change restore (nothing is changed);
- languages other than English (the patterns are English words);
- any claim about who or what wrote a text. Nothing here tries to make text "undetectable".

## 3. Test corpus (`src/analysis/corpus.ts`)

The texts once used to calibrate the old checklist are kept as test inputs:
- 40 public-domain passages, 145–450 words each, from Walden, The Federalist Papers, Pride and Prejudice and Huckleberry Finn;
- 8 stock-register texts written for the tests.

The parity and analysis tests run on all of them. There is no threshold left to calibrate: SlopMonster's score is reported as is.

## 4. Verification

- **Port = original:** `src/analysis/slopmonster/parity.test.ts` compares the port with `deslop.py`'s own output on 152 inputs, and every hit must match exactly. The same test checks that the located findings rebuild exactly that report. The inputs are:
  - every input of upstream's tests;
  - its README, examples and references;
  - the corpus texts;
  - Unicode and emoji edge cases (combining marks, RTL, Arabic-Indic and full-width digits, ſ and K, Turkish İ, Greek Σ);
  - CRLF line endings, tabs, non-breaking spaces and hyphens;
  - em-dashes on both sides of a 220-character window, including emoji windows.

  To regenerate the expected output: clone the upstream repository, then run `python3 -I scripts/slopmonster-parity.py <clone>`. Upstream's rule tests are also ported.
- **Analysis:** `src/analysis/analysis.test.ts` covers:
  - findings equal to the checker's report;
  - each finding pointing at its words, through curly quotes, non-breaking characters, CRLF, tabs and emoji;
  - the punctuation rules;
  - empty and blank text;
  - explanations, the score and `--allow-proof`;
  - no network API touched;
  - overlapping highlights;
  - 500,000-character and 800-paragraph documents;
  - the worker service: a newer check ends the older one, and a crash or time-out fails honestly.
- **UI:** `AnalysisStudio.test.tsx`, `useSession.test.tsx`, `SettingsPanel.test.tsx`, `App.test.tsx`.
- **Browser:** Playwright (`e2e/app.spec.ts`, "Writing analysis (SlopMonster)") runs in Chromium and covers:
  - the real findings, explanations, navigation, reviewed marks, copy and check again;
  - exact typing with analysis on and off;
  - Unicode and CRLF;
  - toggling while typing;
  - no request leaving the page's origin;
  - both themes, and 11 window widths;
  - long documents with the theme switch answered while checking.
- **Packaged desktop app:** `e2e-desktop/run.mjs`, in the installed Linux app:
  - every finding highlighted exactly where the checker puts it, in two texts;
  - the panel's layout at two window sizes;
  - explanations and the nested pick;
  - exact typing into another app with typos on, analysis on and off;
  - 500,000-character and 800-paragraph documents checked without freezing the app;
  - a 10-paragraph document typed exactly.

  `e2e-desktop/windows.mjs` runs the same highlight, layout and exact-typing checks in the installed Windows app.
