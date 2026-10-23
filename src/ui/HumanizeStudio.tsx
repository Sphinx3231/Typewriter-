import { ChevronDown, ChevronUp, Columns2, Copy, FileText, Highlighter, ListFilter, RefreshCw, ScanText, Sparkles, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { applyReverts, explainer, type Change, type ChangeType, type TextDiff } from "../humanize/diff";
import type { Session } from "../state/useSession";
import { Button, IconButton, Segmented } from "./controls";
import { copyText } from "./SessionBar";

type View = "final" | "split" | "original";

const TYPE_NAME: Record<ChangeType, string> = {
  added: "Added",
  removed: "Removed",
  replaced: "Reworded",
  punctuation: "Punctuation",
  formatting: "Spacing",
  case: "Capitalization",
};
/** How a change looks: reworded/added text is underlined, removed text struck through, punctuation and spacing boxed. */
const LOOK: Record<ChangeType, string> = {
  added: "add",
  removed: "del",
  replaced: "add",
  case: "add",
  punctuation: "fmt",
  formatting: "fmt",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** A change's text for labels: line breaks and spaces made visible, long text shortened. */
function shown(t: string): string {
  const v = t.replace(/\r?\n/g, "↵").replace(/^ +| +$/g, (m) => "␣".repeat(m.length));
  return v.length > 80 ? `${v.slice(0, 77)}…` : v;
}
function describe(c: Change, kept: boolean): string {
  const k = kept ? " Kept as the original wording." : "";
  if (c.type === "formatting") return `Spacing changed.${k}`;
  if (!c.after) return `Removed “${shown(c.before)}”.${k}`;
  if (!c.before) return `Added “${shown(c.after)}”.${k}`;
  return `${TYPE_NAME[c.type]}: “${shown(c.before)}” to “${shown(c.after)}”.${k}`;
}

/** The revised text (what is typed), with each change as a selectable highlight. */
function finalNodes(d: TextDiff, kept: ReadonlySet<number>): ReactNode[] {
  return d.segments.map((s, i) => {
    if (s.kind === "same") return s.text;
    const isKept = kept.has(s.id);
    const label = describe(s, isKept);
    if (isKept)
      return (
        <button key={i} type="button" className="chg chg--kept" data-change={s.id} aria-label={label} title={label}>
          {s.before || <span className="chg__mark" aria-hidden="true">↺</span>}
        </button>
      );
    if (!s.after)
      return (
        <button key={i} type="button" className="chg chg--gone" data-change={s.id} aria-label={label} title={label}>
          <span className="chg__mark" aria-hidden="true">−</span>
        </button>
      );
    return (
      <button key={i} type="button" className={`chg chg--${LOOK[s.type]}`} data-change={s.id} aria-label={label} title={label}>
        <ins>{s.after}</ins>
      </button>
    );
  });
}

/** The original, with what changed struck through and where words were added marked. */
function originalNodes(d: TextDiff, kept: ReadonlySet<number>): ReactNode[] {
  return d.segments.map((s, i) => {
    if (s.kind === "same") return s.text;
    const label = describe(s, kept.has(s.id));
    const cls = `chg chg--${s.type === "punctuation" || s.type === "formatting" ? "fmt" : "del"}${kept.has(s.id) ? " is-kept" : ""}`;
    if (!s.before)
      return (
        <button key={i} type="button" className="chg chg--gone" data-change={s.id} aria-label={label} title={label}>
          <span className="chg__mark" aria-hidden="true">+</span>
        </button>
      );
    return (
      <button key={i} type="button" className={cls} data-change={s.id} aria-label={label} title={label}>
        <del>{s.before}</del>
      </button>
    );
  });
}

const CONTEXT = 36;
const LIST_PAGE = 200;

/** Words around a change, cut at a word boundary. */
function context(text: string, from: number, to: number): [string, string] {
  let left = text.slice(Math.max(0, from - CONTEXT), from);
  let right = text.slice(to, to + CONTEXT);
  if (from > CONTEXT) left = `…${left.replace(/^\S*\s/, "")}`;
  if (to + CONTEXT < text.length) right = `${right.replace(/\s\S*$/, "")}…`;
  return [left.replace(/\s+/g, " "), right.replace(/\s+/g, " ")];
}

/** The Studio is shown once the latest text was checked and humanized. */
export function studioVisible(session: Session): boolean {
  const h = session.humanize;
  return h.enabled && !session.blank && !h.checking && h.result?.status === "humanized" && !!h.diff;
}

/** The Studio as its own workspace panel (spanning both text columns), or nothing. */
export function StudioPanel({ session }: { session: Session }) {
  return studioVisible(session) ? <HumanizeStudio session={session} /> : null;
}

export function HumanizeStudio({ session }: { session: Session }) {
  const h = session.humanize;
  const d = h.diff!;
  const r = h.result!;
  const kept = h.reverted;
  const total = d.changes.length;

  const [view, setView] = useState<View>("final");
  const [highlight, setHighlight] = useState(true);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [listed, setListed] = useState(LIST_PAGE);
  // A new object each time, so the same message twice in a row (two copies within 4 s) restarts
  // the 4-second display instead of being cleared by the first one's timer.
  const [note, setNoteState] = useState<{ text: string } | null>(null);
  const setNote = (text: string) => setNoteState({ text });
  const body = useRef<HTMLDivElement>(null);

  // A new result means new changes: start over.
  useEffect(() => {
    setSelected(null);
    setListed(LIST_PAGE);
  }, [d]);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNoteState(null), 4000);
    return () => clearTimeout(id);
  }, [note]);

  const why = useMemo(() => explainer(d.original, r.edits), [d, r.edits]);
  const revised = useMemo(() => applyReverts(d, kept), [d, kept]);
  const markup = useMemo(() => {
    if (!highlight) return null;
    return { final: finalNodes(d, kept), original: originalNodes(d, kept) };
  }, [d, kept, highlight]);

  // Mark the selected change in every view without re-rendering the whole text.
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    for (const el of root.querySelectorAll(".is-selected")) {
      el.classList.remove("is-selected");
      el.setAttribute("aria-pressed", "false");
    }
    if (selected === null) return;
    const els = root.querySelectorAll<HTMLElement>(`[data-change="${selected}"]`);
    els.forEach((el) => {
      el.classList.add("is-selected");
      el.setAttribute("aria-pressed", "true");
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  }, [selected, view, onlyChanges, highlight, markup, listed]);

  const go = useCallback(
    (step: 1 | -1) => {
      if (!total) return;
      setSelected((s) => {
        const next = s === null ? (step === 1 ? 0 : total - 1) : s + step;
        if (next >= listed && onlyChanges) setListed((n) => n + LIST_PAGE);
        return Math.min(total - 1, Math.max(0, next));
      });
    },
    [total, listed, onlyChanges],
  );
  const pick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-change]");
    if (el) setSelected(Number(el.dataset.change));
  };
  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    go(e.key === "ArrowDown" ? 1 : -1);
  };
  const copy = async (which: "revised" | "original") => {
    const ok = await copyText(which === "revised" ? revised : d.original);
    setNote(ok ? `Copied the ${which} text.` : "Couldn't copy: the clipboard isn't available here.");
  };

  const sel = selected === null ? null : d.changes[selected];
  const s = d.stats;
  const canNavigate = highlight && total > 0;
  const allKept = kept.size === total && total > 0;

  const views = (
    <>
      {view === "split" ? (
        <div className="studio__split">
          <div className="studio__col">
            <p className="studio__col-title">Original</p>
            <div className="studio__text" data-testid="studio-original-text">
              {markup ? markup.original : d.original}
            </div>
          </div>
          <div className="studio__col">
            <p className="studio__col-title">Revised (typed)</p>
            <div className="studio__text" data-testid="studio-revised-text">
              {markup ? markup.final : revised}
            </div>
          </div>
        </div>
      ) : (
        <div className="studio__text" data-testid={view === "final" ? "studio-revised-text" : "studio-original-text"}>
          {markup ? markup[view] : view === "final" ? revised : d.original}
        </div>
      )}
    </>
  );

  const list = (
    <ol className="studio__list" data-testid="studio-list">
      {d.changes.slice(0, listed).map((c) => {
        const [left, right] = context(d.original, c.origStart, c.origEnd);
        const isKept = kept.has(c.id);
        return (
          <li key={c.id}>
            <button type="button" className={`studio-item${isKept ? " is-kept" : ""}`} data-change={c.id} aria-label={`Change ${c.id + 1}: ${describe(c, isKept)}`}>
              <span className="studio-item__head">
                <span className="studio-item__n">{c.id + 1}</span>
                <span className={`studio-item__type studio-item__type--${LOOK[c.type]}`}>{TYPE_NAME[c.type]}</span>
                {isKept ? <span className="studio-item__kept">kept original</span> : null}
              </span>
              <span className="studio-item__ctx">
                {left}
                {c.before ? <del>{c.before}</del> : null}
                {view !== "original" && c.after ? <ins>{c.after}</ins> : null}
                {right}
              </span>
              <span className="studio-item__why">{why(c).reason}</span>
            </button>
          </li>
        );
      })}
      {total > listed ? (
        <li>
          <Button size="sm" variant="ghost" onClick={() => setListed((n) => n + LIST_PAGE)}>
            Show {Math.min(LIST_PAGE, total - listed)} more of {(total - listed).toLocaleString()} remaining
          </Button>
        </li>
      ) : null}
    </ol>
  );

  return (
    <section className="panel studio" id="studio" tabIndex={-1} aria-labelledby="studio-title" data-testid="studio" onKeyDown={onKey}>
      <header className="studio__head">
        <h2 className="studio__title" id="studio-title">
          <ScanText size={15} aria-hidden="true" /> Humanization Studio
        </h2>
        <p className="studio__summary" data-testid="studio-summary" title="Counted from a word-by-word comparison of your original and the revised text. Words changed: for each change, the larger of the words removed and the words added.">
          {plural(s.changes, "change")} · {plural(s.wordsChanged, "word")} changed · {plural(s.sentencesAdjusted, "sentence")} adjusted
          <span className="studio__sub">
            {" "}
            ({s.wordsRemoved.toLocaleString()} removed, {s.wordsAdded.toLocaleString()} added{kept.size ? `; ${kept.size} kept as original` : ""})
          </span>
        </p>
      </header>

      {h.usingOriginal ? (
        <p className="studio__banner" role="status" data-testid="studio-banner">
          Your original will be typed. The highlights show the revised text, which won't be typed.{" "}
          <Button size="sm" variant="secondary" icon={<Sparkles size={14} />} onClick={h.typeHumanized} disabled={h.locked} data-testid="humanize-use">
            Type the revised text
          </Button>
        </p>
      ) : allKept ? (
        <p className="studio__banner" role="status" data-testid="studio-banner">
          Every change is set back to your original wording, so your original will be typed.
        </p>
      ) : null}
      {h.locked ? (
        <p className="studio__banner studio__banner--lock" role="status">
          Typing is in progress. The text being typed can't change until it ends; you can still look through the changes.
        </p>
      ) : null}

      <div className="studio__toolbar" role="toolbar" aria-label="Studio view">
        <Segmented<View>
          label="View"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "final", label: "Final text", icon: <FileText size={13} /> },
            { value: "split", label: "Side by side", icon: <Columns2 size={13} /> },
            { value: "original", label: "Original", icon: <Undo2 size={13} /> },
          ]}
        />
        <div className="studio__toggles">
          <button type="button" className="chip-toggle" aria-pressed={highlight} onClick={() => setHighlight((v) => !v)} data-testid="studio-highlight">
            <Highlighter size={13} aria-hidden="true" /> Highlights {highlight ? "on" : "off"}
          </button>
          <button type="button" className="chip-toggle" aria-pressed={onlyChanges} onClick={() => setOnlyChanges((v) => !v)} data-testid="studio-only">
            <ListFilter size={13} aria-hidden="true" /> {onlyChanges ? "Changes only" : "All text"}
          </button>
        </div>
        <div className="studio__nav">
          <IconButton label="Previous change" aria-keyshortcuts="Alt+ArrowUp" onClick={() => go(-1)} disabled={!canNavigate || selected === 0} data-testid="studio-prev">
            <ChevronUp size={16} />
          </IconButton>
          <span className="studio__pos" aria-live="polite" data-testid="studio-pos">
            {!canNavigate ? (total ? "Highlights off" : "No changes") : sel ? `Change ${sel.id + 1} of ${total}` : plural(total, "change")}
          </span>
          <IconButton label="Next change" aria-keyshortcuts="Alt+ArrowDown" onClick={() => go(1)} disabled={!canNavigate || selected === total - 1} data-testid="studio-next">
            <ChevronDown size={16} />
          </IconButton>
        </div>
      </div>

      {highlight ? (
        <p className="studio__legend" aria-hidden="true">
          <span className="legend legend--add">underlined</span> added or reworded · <span className="legend legend--del">struck through</span> removed ·{" "}
          <span className="legend legend--fmt">boxed</span> punctuation or spacing · <span className="legend legend--kept">↺</span> kept original
        </p>
      ) : null}

      <div className={`studio__body studio__body--${view}`} ref={body} onClick={pick} data-highlight={highlight ? "on" : "off"}>
        {onlyChanges && highlight ? list : views}
      </div>

      {sel && canNavigate ? (
        <div className="studio__explain" role="region" aria-label="Selected change" data-testid="studio-explain">
          <div className="studio__explain-head">
            <strong>
              Change {sel.id + 1} of {total}
            </strong>
            <span className={`studio-item__type studio-item__type--${LOOK[sel.type]}`}>{TYPE_NAME[sel.type]}</span>
            <IconButton label="Close explanation" className="studio__close" onClick={() => setSelected(null)}>
              <X size={14} />
            </IconButton>
          </div>
          <p className="studio__pair">
            {sel.before ? <del>{shown(sel.before)}</del> : <span className="studio__none">(nothing)</span>} →{" "}
            {sel.after ? <ins>{shown(sel.after)}</ins> : <span className="studio__none">(removed)</span>}
          </p>
          <p className="studio__why" data-testid="studio-reason">
            {why(sel).reason}
          </p>
          <Button
            size="sm"
            variant="secondary"
            icon={kept.has(sel.id) ? <Sparkles size={14} /> : <Undo2 size={14} />}
            onClick={() => h.setChangeReverted(sel.id, !kept.has(sel.id))}
            disabled={h.locked}
            data-testid="studio-revert"
          >
            {kept.has(sel.id) ? "Use the revised wording" : "Keep the original wording"}
          </Button>
        </div>
      ) : null}

      <div className="studio__actions">
        <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copy("revised")} data-testid="studio-copy-revised">
          Copy revised
        </Button>
        <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copy("original")} data-testid="studio-copy-original">
          Copy original
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={14} />}
          onClick={() => h.rerun() && setNote("Checked your original again from scratch.")}
          disabled={h.locked}
          title="Runs the style checks and rewrite again on your original (never on the revised text). Clears kept-original choices."
          data-testid="studio-rerun"
        >
          Re-run on original
        </Button>
        {h.usingOriginal ? null : (
          <Button size="sm" variant="secondary" icon={<Undo2 size={14} />} onClick={h.typeOriginal} disabled={h.locked} data-testid="humanize-restore">
            Restore original
          </Button>
        )}
        <span className="studio__note" role="status" data-testid="studio-note">
          {note?.text}
        </span>
      </div>
    </section>
  );
}
