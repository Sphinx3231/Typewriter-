import { Eraser, FileText, Lock } from "lucide-react";
import type { Session } from "../state/useSession";
import { LARGE_TEXT_CHARS } from "../state/useSession";
import { ConfirmButton, Button } from "./controls";
import { nf } from "./format";

const SAMPLE = `The quick brown fox jumps over the lazy dog. It's a sentence that uses every letter of the alphabet, which is why typists have practiced with it for more than a century.

Typewriter keeps your words exactly as you wrote them. Watch closely and you might catch a small slip, a pause after a full stop, or a word fixed on the fly. The finished text will still match yours character for character.`;

export function Editor({ session }: { session: Session }) {
  const { text, setText, stats, snapshot } = session;
  const locked = snapshot.status === "playing" || snapshot.status === "paused";
  const whitespaceOnly = text.length > 0 && session.blank;

  return (
    <section className="panel editor" aria-labelledby="editor-title">
      <header className="panel__head">
        <div className="panel__title-group">
          <h2 className="panel__title" id="editor-title">
            <label htmlFor="source-text">Your text</label>
          </h2>
          <p className="panel__sub">This is the original. Typewriter never changes it.</p>
        </div>
        <div className="panel__actions">
          {text.length === 0 ? (
            <Button size="sm" variant="ghost" icon={<FileText size={15} />} onClick={() => setText(SAMPLE)} disabled={locked}>
              Use sample
            </Button>
          ) : (
            <ConfirmButton icon={<Eraser size={15} />} confirmLabel="Clear all text?" onConfirm={() => setText("")} disabled={locked}>
              Clear
            </ConfirmButton>
          )}
        </div>
      </header>

      <div className={`editor__box ${locked ? "is-locked" : ""}`}>
        <textarea
          id="source-text"
          className="editor__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={locked}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-describedby="editor-stats editor-note"
          placeholder={"Paste or type the text you want typed out.\n\nLine breaks, tabs, emoji and your own spelling are all kept exactly."}
          data-testid="editor"
        />
      </div>

      <footer className="editor__foot">
        <dl className="stat-chips" id="editor-stats" aria-live="polite">
          <div className="stat-chip">
            <dt>Characters</dt>
            <dd data-testid="stat-chars">{nf.format(stats.characters)}</dd>
          </div>
          <div className="stat-chip">
            <dt>Words</dt>
            <dd data-testid="stat-words">{nf.format(stats.words)}</dd>
          </div>
          <div className="stat-chip">
            <dt>Lines</dt>
            <dd>{nf.format(stats.lines)}</dd>
          </div>
          <div className="stat-chip">
            <dt>Paragraphs</dt>
            <dd>{nf.format(stats.paragraphs)}</dd>
          </div>
        </dl>
        {locked ? (
          <p className="editor__lock" id="editor-note">
            <Lock size={13} aria-hidden="true" /> Locked while typing. Stop playback to edit.
          </p>
        ) : (
          <p className="editor__note" id="editor-note" role={whitespaceOnly ? "alert" : undefined}>
            {whitespaceOnly
              ? "Only spaces or line breaks so far. Add some text to start."
              : stats.characters > LARGE_TEXT_CHARS
                ? `Long text (${nf.format(stats.characters)} characters). Nothing is cut off; planning may take a moment.`
                : session.planning
                  ? "Updating estimate…"
                  : null}
          </p>
        )}
      </footer>
    </section>
  );
}
