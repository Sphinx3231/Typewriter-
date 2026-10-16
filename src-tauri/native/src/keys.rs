//! Translation from Typewriter timeline events to concrete key presses.
//!
//! The web engine describes typing as edits on a buffer of graphemes (type at the
//! caret, backspace, move the caret to an index, replace a range). A real text
//! field only understands keys, so this module tracks the caret and turns every
//! edit into the keys a person would press. It is pure and fully unit-tested.

use serde::Deserialize;

/// One timeline event, as produced by `buildTimeline()` in `src/engine/schedule.ts`.
/// Unknown fields (timing breakdown, notes, flags) are ignored.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event {
    Type { at: f64, text: String },
    Backspace { at: f64 },
    Caret { at: f64, to: usize },
    Replace { at: f64, start: usize, end: usize, replacement: Vec<String> },
    Wait { at: f64 },
}

impl Event {
    pub fn at(&self) -> f64 {
        match self {
            Event::Type { at, .. } | Event::Backspace { at } | Event::Caret { at, .. } | Event::Replace { at, .. } | Event::Wait { at } => *at,
        }
    }
}

/// A single physical action sent to the operating system.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    /// Literal text (always exactly one grapheme). Never interpreted as a command.
    Text(String),
    Enter,
    Tab,
    Backspace,
    Left,
    Right,
}

/// The key that produces a grapheme in a text field.
pub fn key_for(grapheme: &str) -> KeyAction {
    match grapheme {
        "\n" | "\r\n" | "\r" => KeyAction::Enter,
        "\t" => KeyAction::Tab,
        g => KeyAction::Text(g.to_string()),
    }
}

/// Tracks the caret and buffer length while converting events to keys.
#[derive(Debug, Default, Clone)]
pub struct Translator {
    pub caret: usize,
    pub len: usize,
}

impl Translator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn actions(&mut self, ev: &Event) -> Vec<KeyAction> {
        let mut out = Vec::new();
        match ev {
            Event::Type { text, .. } => {
                out.push(key_for(text));
                self.caret += 1;
                self.len += 1;
            }
            Event::Backspace { .. } => {
                if self.caret > 0 {
                    out.push(KeyAction::Backspace);
                    self.caret -= 1;
                    self.len -= 1;
                }
            }
            Event::Caret { to, .. } => {
                let to = (*to).min(self.len);
                if to < self.caret {
                    out.extend(std::iter::repeat_n(KeyAction::Left, self.caret - to));
                } else {
                    out.extend(std::iter::repeat_n(KeyAction::Right, to - self.caret));
                }
                self.caret = to;
            }
            Event::Replace { start, end, replacement, .. } => {
                let (start, end) = ((*start).min(self.len), (*end).min(self.len));
                let removed = end.saturating_sub(start);
                let c = self.caret;
                // Put the caret just after the range, delete it, type the replacement.
                if c >= end {
                    out.extend(std::iter::repeat_n(KeyAction::Left, c - end));
                } else {
                    out.extend(std::iter::repeat_n(KeyAction::Right, end - c));
                }
                out.extend(std::iter::repeat_n(KeyAction::Backspace, removed));
                out.extend(replacement.iter().map(|g| key_for(g)));
                let after = start + replacement.len();
                // Restore the caret to where the typist had it.
                let target = if c >= end {
                    c - removed + replacement.len()
                } else if c <= start {
                    c
                } else {
                    after
                };
                if target > after {
                    out.extend(std::iter::repeat_n(KeyAction::Right, target - after));
                } else {
                    out.extend(std::iter::repeat_n(KeyAction::Left, after - target));
                }
                self.caret = target;
                self.len = self.len - removed + replacement.len();
            }
            Event::Wait { .. } => {}
        }
        out
    }
}

/// A minimal text field that applies key actions, used to prove the translation
/// reproduces the source exactly. Counts graphemes the same way the engine does.
#[derive(Debug, Default, Clone)]
pub struct VirtualField {
    pub cells: Vec<String>,
    pub caret: usize,
}

impl VirtualField {
    pub fn apply(&mut self, a: &KeyAction) {
        match a {
            KeyAction::Text(g) => {
                self.cells.insert(self.caret, g.clone());
                self.caret += 1;
            }
            KeyAction::Enter => {
                self.cells.insert(self.caret, "\n".into());
                self.caret += 1;
            }
            KeyAction::Tab => {
                self.cells.insert(self.caret, "\t".into());
                self.caret += 1;
            }
            KeyAction::Backspace => {
                if self.caret > 0 {
                    self.caret -= 1;
                    self.cells.remove(self.caret);
                }
            }
            KeyAction::Left => self.caret = self.caret.saturating_sub(1),
            KeyAction::Right => self.caret = (self.caret + 1).min(self.cells.len()),
        }
    }

    pub fn text(&self) -> String {
        self.cells.concat()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ty(t: &str) -> Event {
        Event::Type { at: 0.0, text: t.into() }
    }

    fn run(events: &[Event]) -> (VirtualField, Vec<KeyAction>) {
        let mut tr = Translator::new();
        let mut f = VirtualField::default();
        let mut all = vec![];
        for e in events {
            for a in tr.actions(e) {
                f.apply(&a);
                all.push(a);
            }
            assert_eq!(tr.caret, f.caret, "caret tracking diverged after {e:?}");
            assert_eq!(tr.len, f.cells.len());
        }
        (f, all)
    }

    #[test]
    fn newlines_and_tabs_become_keys_and_text_stays_literal() {
        let (f, keys) = run(&[ty("a"), ty("\n"), ty("\t"), ty("\r\n"), ty("👨‍👩‍👧‍👦"), ty("$(rm -rf /)")]);
        assert_eq!(keys[1], KeyAction::Enter);
        assert_eq!(keys[2], KeyAction::Tab);
        assert_eq!(keys[3], KeyAction::Enter);
        assert_eq!(keys[4], KeyAction::Text("👨‍👩‍👧‍👦".into()));
        assert_eq!(keys[5], KeyAction::Text("$(rm -rf /)".into()));
        assert_eq!(f.text(), "a\n\t\n👨‍👩‍👧‍👦$(rm -rf /)");
    }

    #[test]
    fn caret_moves_become_arrow_keys() {
        let evs = [ty("a"), ty("c"), Event::Caret { at: 0.0, to: 1 }, ty("b"), Event::Caret { at: 0.0, to: 3 }, ty("d")];
        let (f, keys) = run(&evs);
        assert_eq!(f.text(), "abcd");
        assert_eq!(keys.iter().filter(|k| **k == KeyAction::Left).count(), 1);
        assert_eq!(keys.iter().filter(|k| **k == KeyAction::Right).count(), 1);
    }

    #[test]
    fn autocorrect_replace_with_caret_after_range() {
        // typed "teh " then autocorrect replaces [0,3) with "the"
        let evs = [ty("t"), ty("e"), ty("h"), ty(" "), Event::Replace { at: 0.0, start: 0, end: 3, replacement: vec!["t".into(), "h".into(), "e".into()] }, ty("x")];
        let (f, _) = run(&evs);
        assert_eq!(f.text(), "the x");
    }

    #[test]
    fn replace_with_different_lengths_and_caret_positions() {
        let base = [ty("a"), ty("b"), ty("c"), ty("d"), ty("e")];
        for caret in 0..=5 {
            for (start, end) in [(0, 0), (1, 3), (0, 5), (2, 2), (4, 5)] {
                for rep in [vec![], vec!["X".to_string()], vec!["X".into(), "Y".into(), "Z".into()]] {
                    let mut evs = base.to_vec();
                    evs.push(Event::Caret { at: 0.0, to: caret });
                    evs.push(Event::Replace { at: 0.0, start, end, replacement: rep.clone() });
                    let (f, _) = run(&evs);
                    let mut expect: Vec<String> = "abcde".chars().map(|c| c.to_string()).collect();
                    expect.splice(start..end, rep.clone());
                    assert_eq!(f.text(), expect.concat(), "caret {caret} range {start}..{end}");
                }
            }
        }
    }

    #[test]
    fn backspace_at_start_is_ignored() {
        let (f, keys) = run(&[Event::Backspace { at: 0.0 }, ty("a")]);
        assert_eq!(f.text(), "a");
        assert_eq!(keys, vec![KeyAction::Text("a".into())]);
    }
}
