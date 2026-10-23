# SlopMonster in Typewriter

SlopMonster's writing checker is built into the Humanization Studio's style checklist. This page records:

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

### Compared with what Typewriter already had

Typewriter's checklist (`src/humanize/index.ts`) already looked for repetition, redundancy, stock transitions and openers, wordy phrasing, even sentence lengths and vague statements. SlopMonster adds what it lacked:

- marketing vocabulary;
- the contrast and opener constructions;
- dash and hyphen stacking;
- lists of three;
- unsupported numbers.

Three overlaps exist:

- "leverage" and "delve" are already counted under formal phrasing;
- "in today's" is already counted as a generic opener;
- "in conclusion / to sum up" is already counted as a generic conclusion.

These are not counted twice. The diff and the Studio (`diff.ts`, `HumanizeStudio.tsx`) have no equivalent in SlopMonster: it has no diff, highlights or per-change restore.

## 2. What was integrated

| Taken | How |
|---|---|
| The whole checker (catalogue, `normalise`, `audit`) | Ported rule for rule to TypeScript: `src/humanize/slopmonster/index.ts`, with the MIT notice (`LICENSE` next to it, and shown in the app under Preferences › About › Open-source notices). Python's Unicode-aware `\w`, `\s`, `\d` and `\b`, and its code-point string lengths, are reproduced exactly |
| Vocabulary, phrases, lists of three | Three new scored checks: "Overused buzzwords" (2 or more), "Stock phrases and constructions" (2 or more), "Tidy lists of three" (at least one per 150 words) |
| Punctuation, proof | Two notes, never scored: "Dash, hyphen and semicolon habits" and "Numbers to double-check" |
| Editing guidance (`prompts/cleanse.txt`) | Fixed local rules, only where the shorter wording means the same in any context: throat-clearing openers ("Here's the thing:", "The truth is,"), stacked hedges, padding ("very unique", "quite literally", "more than just"), "leverage" as a verb → "use", "harness the power of" → "use". Each Studio explanation names the rule and says "(SlopMonster)" |

| Not taken | Why |
|---|---|
| The AI rewrite (`cleanse.sh`) | It sends the text to an AI model over the network. Typewriter runs entirely on the device, with no AI and no network (CLAUDE.md rule 2) |
| Upstream's "any hit fails" scoring | It is made for short web pages; on essays and fiction it would fire constantly (see §3). Typewriter's checklist score and its 50% threshold are kept |
| HTML and Markdown readers, the CLI | Typewriter checks the plain text the user typed |
| Rewriting buzzwords that have a literal sense ("seamless pipe", "foster care", "embark on a ship"), contrast constructions, lists of three, "helps you to" ("helps you to your seat"), "Let's break it down." (a box can be broken down) | No fixed rule can do these without changing meaning. The checklist reports them for the writer to judge |

Nothing here tries to make text "undetectable". The checks look for wording that reads as padded or stock, and the score says nothing about who or what wrote the text.

## 3. Calibration (`src/humanize/calibration.test.ts`)

Limits were set against two sets of text:

- **40 public-domain passages, 145–450 words each.** They come from Walden (1854), The Federalist Papers (1788), Pride and Prejudice (1813) and Huckleberry Finn (1884): human writing from before text generators existed.
- **8 texts in the stock register.** We wrote these for the test; they are not collected data.

| | Human passages (40) | Stock-register texts (8) |
|---|---|---|
| Buzzwords: most in one text | 1 | 3–12 |
| Stock phrases: most in one text | 1 | 0–10 |
| Lists of three: highest rate | 1 per 228 words | 1 per 47–122 words |
| Dash, hyphen or semicolon finding | 13 of 40 | 1 of 8 |
| Rewritten at 50% (before / after this change) | 0 / 0 | 1 / 2 |
| Highest score | 20% | 60% |

The punctuation finding fires more often on 19th-century prose than on the stock texts, so it is a note rather than a scored check.

The 50% threshold is unchanged. On this data a 40% threshold would also rewrite 3 more of the stock texts (blog, report, e-mail) and still none of the human passages. That is a product decision for the owner, not something this data proves on its own: the stock texts are our own, and the human set is old fiction and essays.

## 4. Verification

- **Port = original:** `parity.test.ts` compares the port with `deslop.py`'s own output on 152 inputs, and every hit must match exactly. The inputs are:
  - every input of upstream's tests;
  - its README, examples and references;
  - the calibration texts;
  - Unicode and emoji edge cases (combining marks, RTL, Arabic-Indic and full-width digits, ſ and K, Turkish İ, Greek Σ);
  - CRLF line endings, tabs, non-breaking spaces and hyphens;
  - em-dashes on both sides of a 220-character window, including emoji windows.

  To regenerate the expected output: clone the upstream repository, then run `python3 -I scripts/slopmonster-parity.py <clone>`. Upstream's rule tests are also ported.
- **Integration:** `slopmonster.test.ts` covers:
  - each check, its limits and the double-count exclusions;
  - notes never affecting the score;
  - each rewrite rule, and the cases each must leave alone;
  - protected quotations, citations, brackets and code;
  - Studio explanations, with every change restoring on its own;
  - CRLF, emoji and tabs;
  - no network APIs touched.
- **Browser:** Playwright runs Smart Humanization on a stock-register essay in Chromium and checks:
  - the 13 checklist items and their SlopMonster marks;
  - the "leverage" → "use" explanation;
  - the typed text is exactly the prepared text.
- **Packaged desktop app:** `e2e-desktop/run.mjs` ("SlopMonster's checks in the packaged app") checks:
  - the installed app's checklist matches the engine, item by item;
  - one SlopMonster change kept as original;
  - the typed document equals exactly that mix.

  The Windows end-to-end check confirms the five marked checks in the installed Windows app.
- **Speed:** checking a 667,000-character book takes about 0.4 s, and a 500,000-character paragraph about 0.2 s. That is the same order as Typewriter's own checks.
