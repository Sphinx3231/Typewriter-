import { Check, ChevronDown, ChevronUp, Copy, FileText, Highlighter, List, RefreshCw, ScanText, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { CATEGORY_INFO, explain, segments, type Analysis, type Category, type Finding } from "../analysis";
import type { Session } from "../state/useSession";
import { Button, IconButton, Segmented } from "./controls";
import { copyText } from "./SessionBar";

type View = "text" | "list";

/** How a finding looks: words and phrases underlined, punctuation and list shapes boxed, number claims tinted as a warning. */
export const LOOK: Record<Category, "word" | "shape" | "claim"> = {
  vocab: "word",
  phrases: "word",
  punctuation: "shape",
  rhythm: "shape",
  proof: "claim",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** A finding's text for labels: line breaks made visible, long text shortened. */
function shown(t: string): string {
  const v = t.replace(/\r?\n/g, "↵").replace(/\s+/g, " ");
  return v.length > 80 ? `${v.slice(0, 77)}…` : v;
}
function describe(f: Finding, reviewed: boolean): string {
  return `${CATEGORY_INFO[f.category].title}: “${shown(f.excerpt)}”${f.category === "vocab" ? "" : ` (${f.rule})`}.${reviewed ? " Reviewed." : ""}`;
}

/** The text, exactly as it is typed, with each finding as a selectable highlight. */
function textNodes(a: Analysis, reviewed: ReadonlySet<number>): ReactNode[] {
  return segments(a.source.length, a.findings).map((s, i) => {
    const t = a.source.slice(s.start, s.end);
    if (!s.ids.length) return t;
    // A click picks the innermost finding here: the one whose range around this stretch is shortest.
    const top = innermost(a, s.ids, s.start);
    const done = s.ids.every((id) => reviewed.has(id));
    const label = s.ids.map((id) => describe(a.findings[id], reviewed.has(id))).join(" ");
    return (
      <button key={i} type="button" tabIndex={-1} className={`find find--${LOOK[top.category]}${s.ids.length > 1 ? " is-nested" : ""}${done ? " is-reviewed" : ""}`} data-f={s.ids.join(" ")} data-pick={top.id} aria-label={label} title={label}>
        {t}
      </button>
    );
  });
}

/** Of the findings covering `at`, the one whose covering range is shortest (the first in reading order on a tie). */
function innermost(a: Analysis, ids: number[], at: number): Finding {
  let best = a.findings[ids[0]];
  let bestLen = Infinity;
  for (const id of ids) {
    const f = a.findings[id];
    for (const [x, y] of f.ranges)
      if (x <= at && at < y && y - x < bestLen) {
        best = f;
        bestLen = y - x;
      }
  }
  return best;
}

const CONTEXT = 36;
const LIST_PAGE = 200;

/** Words around a finding, cut at a word boundary. */
function context(text: string, from: number, to: number): [string, string] {
  let left = text.slice(Math.max(0, from - CONTEXT), from);
  let right = text.slice(to, to + CONTEXT);
  if (from > CONTEXT) left = `…${left.replace(/^\S*\s/, "")}`;
  if (to + CONTEXT < text.length) right = `${right.replace(/\s\S*$/, "")}…`;
  return [left.replace(/\s+/g, " "), right.replace(/\s+/g, " ")];
}

/** The panel is shown once the latest text was checked and has findings. */
export function studioVisible(session: Session): boolean {
  const a = session.analysis;
  return a.enabled && !session.blank && !a.checking && !!a.result && a.result.findings.length > 0;
}

/** The analysis as its own workspace panel (spanning both text columns), or nothing. */
export function StudioPanel({ session }: { session: Session }) {
  return studioVisible(session) ? <AnalysisStudio session={session} /> : null;
}

export function AnalysisStudio({ session }: { session: Session }) {
  const an = session.analysis;
  const a = an.result!;
  const reviewed = an.reviewed;
  const total = a.findings.length;

  const [view, setView] = useState<View>("text");
  const [highlight, setHighlight] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [listed, setListed] = useState(LIST_PAGE);
  // A new object each time, so the same message twice in a row restarts its 4-second display.
  // The panel is hidden while "Check again" runs, so it confirms the new check when it comes back.
  const [note, setNoteState] = useState<{ text: string } | null>(() => (an.rechecked ? { text: "Checked your text again." } : null));
  const setNote = (text: string) => setNoteState({ text });
  const body = useRef<HTMLDivElement>(null);

  // A new result means new findings: start over.
  useEffect(() => {
    setSelected(null);
    setListed(LIST_PAGE);
  }, [a]);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNoteState(null), 4000);
    return () => clearTimeout(id);
  }, [note]);

  const markup = useMemo(() => (highlight ? textNodes(a, reviewed) : null), [a, reviewed, highlight]);

  // Mark the selected finding in the text and the list without re-rendering them.
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    for (const el of root.querySelectorAll(".is-selected")) {
      el.classList.remove("is-selected");
      el.removeAttribute("aria-current");
    }
    if (selected === null) return;
    const els = root.querySelectorAll<HTMLElement>(`[data-f~="${selected}"], [data-item="${selected}"]`);
    els.forEach((el, i) => {
      el.classList.add("is-selected");
      el.setAttribute("aria-current", "true");
      if (i === 0) el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  }, [selected, view, highlight, markup, listed]);

  const go = useCallback(
    (step: 1 | -1) => {
      if (!total) return;
      setSelected((s) => {
        const next = Math.min(total - 1, Math.max(0, s === null ? (step === 1 ? 0 : total - 1) : s + step));
        if (next >= listed) setListed(Math.ceil((next + 1) / LIST_PAGE) * LIST_PAGE);
        return next;
      });
    },
    [total, listed],
  );
  const pick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-pick], [data-item]");
    if (el) setSelected(Number(el.dataset.pick ?? el.dataset.item));
  };
  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    go(e.key === "ArrowDown" ? 1 : -1);
  };
  const copy = async () => {
    const ok = await copyText(a.source);
    setNote(ok ? "Copied your text." : "Couldn't copy: the clipboard isn't available here.");
  };

  const sel = selected === null ? null : a.findings[selected];
  const canNavigate = (highlight || view === "list") && total > 0;
  const cats = (Object.keys(a.counts) as Category[]).filter((k) => a.counts[k] > 0);

  const list = (
    <ol className="studio__list" data-testid="studio-list">
      {a.findings.slice(0, listed).map((f) => {
        const [s, e] = f.ranges[0] ?? [f.start, f.start];
        const [left, right] = context(a.source, s, e);
        const done = reviewed.has(f.id);
        return (
          <li key={f.id}>
            <button type="button" className={`studio-item${done ? " is-reviewed" : ""}`} data-item={f.id} aria-label={`Finding ${(f.id + 1).toLocaleString()}: ${describe(f, done)}`}>
              <span className="studio-item__head">
                <span className="studio-item__n">{f.id + 1}</span>
                <span className={`studio-item__type studio-item__type--${LOOK[f.category]}`}>{CATEGORY_INFO[f.category].title}</span>
                {done ? <span className="studio-item__kept">reviewed</span> : null}
              </span>
              <span className="studio-item__ctx">
                {left}
                <mark className={`find find--${LOOK[f.category]}`}>{a.source.slice(s, e)}</mark>
                {right}
              </span>
              <span className="studio-item__why">{f.category === "vocab" ? `“${f.rule}”` : f.rule}</span>
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
          <ScanText size={15} aria-hidden="true" /> Writing analysis
        </h2>
        <p className="studio__summary" data-testid="studio-summary" title="SlopMonster's score: 5, minus one for each category with a finding.">
          {plural(total, "finding")} in {plural(cats.length, "category", "categories")} · SlopMonster score {an.score}/5
          <span className="studio__sub">
            {" "}
            ({cats.map((k) => `${CATEGORY_INFO[k].title} ${a.counts[k]}`).join(", ")}
            {reviewed.size ? `; ${reviewed.size} reviewed` : ""})
          </span>
        </p>
      </header>

      <p className="studio__banner" role="note">
        Nothing here changes your text: it is typed exactly as shown. The findings are prompts to review, from SlopMonster's English patterns; they can flag ordinary wording, miss
        weak writing, and say nothing about who wrote the text.
      </p>

      <div className="studio__toolbar" role="toolbar" aria-label="Analysis view">
        <Segmented<View>
          label="View"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "text", label: "Your text", icon: <FileText size={13} /> },
            { value: "list", label: "Findings", icon: <List size={13} /> },
          ]}
        />
        {view === "text" ? (
          <div className="studio__toggles">
            <button type="button" className="chip-toggle" aria-pressed={highlight} onClick={() => setHighlight((v) => !v)} data-testid="studio-highlight">
              <Highlighter size={13} aria-hidden="true" /> Highlights {highlight ? "on" : "off"}
            </button>
          </div>
        ) : null}
        <div className="studio__nav">
          <IconButton label="Previous finding" aria-keyshortcuts="Alt+ArrowUp" onClick={() => go(-1)} disabled={!canNavigate || selected === 0} data-testid="studio-prev">
            <ChevronUp size={16} />
          </IconButton>
          <span className="studio__pos" aria-live="polite" data-testid="studio-pos">
            {!canNavigate ? "Highlights off" : sel ? `Finding ${(sel.id + 1).toLocaleString()} of ${total.toLocaleString()}` : plural(total, "finding")}
          </span>
          <IconButton label="Next finding" aria-keyshortcuts="Alt+ArrowDown" onClick={() => go(1)} disabled={!canNavigate || selected === total - 1} data-testid="studio-next">
            <ChevronDown size={16} />
          </IconButton>
        </div>
      </div>

      {highlight && view === "text" ? (
        <p className="studio__legend" aria-hidden="true">
          <span className="legend find find--word">underlined</span> words and phrases · <span className="legend find find--shape">boxed</span> punctuation and list shapes ·{" "}
          <span className="legend find find--claim">tinted</span> number claims · <span className="legend find is-reviewed">dashed</span> reviewed
        </p>
      ) : null}

      <div className={`studio__body studio__body--${view}`} ref={body} onClick={pick} data-highlight={highlight ? "on" : "off"}>
        {view === "list" ? (
          list
        ) : (
          <div className="studio__text" data-testid="studio-text">
            {markup ?? a.source}
          </div>
        )}
      </div>

      {sel && canNavigate ? (
        <div className="studio__explain" role="region" aria-label="Selected finding" data-testid="studio-explain">
          <div className="studio__explain-head">
            <strong>
              Finding {(sel.id + 1).toLocaleString()} of {total.toLocaleString()}
            </strong>
            <span className={`studio-item__type studio-item__type--${LOOK[sel.category]}`}>{CATEGORY_INFO[sel.category].title}</span>
            <IconButton label="Close explanation" className="studio__close" onClick={() => setSelected(null)}>
              <X size={14} />
            </IconButton>
          </div>
          <p className="studio__pair">
            <mark className={`find find--${LOOK[sel.category]}`}>{shown(sel.excerpt)}</mark>
            {sel.ranges.length > 1 ? <span className="studio__none"> and {sel.ranges.length - 1} more in the text</span> : null}
          </p>
          <p className="studio__why" data-testid="studio-reason">
            {explain(sel)}
          </p>
          <p className="studio__rule">
            SlopMonster rule: {sel.category === "vocab" ? `“${sel.rule}”` : sel.rule}
            {sel.detail && sel.category === "punctuation" ? ` (${sel.detail})` : ""}
          </p>
          <Button size="sm" variant="secondary" icon={<Check size={14} />} onClick={() => an.setReviewed(sel.id, !reviewed.has(sel.id))} data-testid="studio-review">
            {reviewed.has(sel.id) ? "Mark as not reviewed" : "Mark as reviewed"}
          </Button>
        </div>
      ) : null}

      <div className="studio__actions">
        <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copy()} data-testid="studio-copy">
          Copy text
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={14} />}
          onClick={() => void an.rerun()}
          title="Runs SlopMonster's checker again on your text. Clears reviewed marks."
          data-testid="studio-rerun"
        >
          Check again
        </Button>
        <span className="studio__note" role="status" data-testid="studio-note">
          {note?.text}
        </span>
      </div>
    </section>
  );
}
