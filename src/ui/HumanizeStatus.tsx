import { AlertTriangle, ArrowDown, Check, LoaderCircle, Minus, Sparkles } from "lucide-react";
import type { HumanizeResult } from "../humanize";
import type { TextDiff } from "../humanize/diff";
import type { Session } from "../state/useSession";
import { Button } from "./controls";
import { studioVisible } from "./HumanizeStudio";

/** One line: what Smart Humanization decided for the current text. */
function headline(
  r: HumanizeResult | null,
  checking: boolean,
  usingOriginal: boolean,
  diff: TextDiff | null,
): { text: string; detail?: string; tone: "busy" | "done" | "plain" | "error" } {
  if (checking || !r) return { text: "Checking writing style…", tone: "busy" };
  const counts = r.score === null ? "" : `${r.score}% (${r.flagged} of ${r.applicable} style checks flagged)`;
  switch (r.status) {
    case "humanized":
      return usingOriginal
        ? { text: "Typing your original", detail: `You chose the original. A humanized copy is ready (${counts}).`, tone: "plain" }
        : {
            text: "Humanized automatically",
            detail: `${counts}; ${diff ? `${diff.stats.changes} ${diff.stats.changes === 1 ? "change" : "changes"}` : `${r.edits.length} edits`}. The revised text is what will be typed.`,
            tone: "done",
          };
    case "no-change-needed":
      return { text: "No changes needed", detail: `${counts}, below 50%. Your text is typed as written.`, tone: "plain" };
    case "no-safe-edit":
      return { text: "No changes made", detail: `${counts}, but no safe small edit was found. Your text is typed as written.`, tone: "plain" };
    case "too-short":
      return { text: "Too short to check", detail: "Your text is typed as written.", tone: "plain" };
    case "failed":
      return { text: "Humanization unavailable", detail: `${r.error ?? "The style check failed."} Your original text will be typed, exactly as written.`, tone: "error" };
  }
}

export function HumanizeStatus({ session }: { session: Session }) {
  const h = session.humanize;
  if (!h.enabled || session.blank) return null;
  const r = h.result;
  const line = headline(r, h.checking, h.usingOriginal, h.diff);
  const Icon = line.tone === "busy" ? LoaderCircle : line.tone === "done" ? Sparkles : line.tone === "error" ? AlertTriangle : Check;
  const ready = r && !h.checking;
  return (
    <div className={`humanize humanize--${line.tone}`} data-testid="humanize-status">
      <p className="humanize__line" role={line.tone === "error" ? "alert" : "status"} aria-live="polite">
        <Icon size={15} aria-hidden="true" className={line.tone === "busy" ? "spin" : undefined} />
        <strong data-testid="humanize-headline">{line.text}</strong>
        {line.detail ? <span className="humanize__detail">{line.detail}</span> : null}
      </p>
      {studioVisible(session) ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowDown size={14} />}
          className="humanize__jump"
          onClick={() => {
            const el = document.getElementById("studio");
            el?.scrollIntoView?.({ block: "start", behavior: "smooth" });
            el?.focus({ preventScroll: true });
          }}
          data-testid="humanize-review"
        >
          Review the changes
        </Button>
      ) : null}
      {ready && r.status !== "too-short" ? (
        <details className="humanize__more">
          <summary>Style checks</summary>
          <p className="humanize__note">
            The score is a writing-style heuristic: flagged checks out of the checks that apply. It does not and cannot tell who, or what, wrote the text. It runs on this
            device; nothing is sent anywhere.
          </p>
          <ul className="humanize__checks" data-testid="humanize-checks">
            {r.checks.map((c) => (
              <li key={c.id} className={!c.applicable ? "is-na" : c.flagged ? "is-flagged" : ""}>
                {!c.applicable ? <Minus size={13} aria-hidden="true" /> : c.flagged ? <AlertTriangle size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                <span>
                  {c.label}: {!c.applicable ? "doesn't apply" : c.flagged ? "flagged" : "fine"}
                  {c.evidence.length ? <span className="humanize__evidence"> ({c.evidence.join("; ")})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
