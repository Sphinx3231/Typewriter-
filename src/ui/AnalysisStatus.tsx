import { AlertTriangle, ArrowDown, Check, LoaderCircle, ScanText } from "lucide-react";
import { CATEGORY_INFO, type Category } from "../analysis";
import type { Session } from "../state/useSession";
import { studioVisible } from "./AnalysisStudio";
import { Button } from "./controls";

/** One line under the editor: what SlopMonster's checker found in the current text. */
export function AnalysisStatus({ session }: { session: Session }) {
  const an = session.analysis;
  if (!an.enabled || session.blank) return null;
  const r = an.result;
  let tone: "busy" | "done" | "plain" | "error";
  let text: string;
  let detail: string | undefined;
  if (an.error && !an.checking) {
    tone = "error";
    text = "Writing analysis failed";
    detail = `${an.error}. Your text is unaffected and is typed exactly as written.`;
  } else if (an.checking || !r) {
    tone = "busy";
    text = "Checking writing style…";
  } else if (!r.findings.length) {
    tone = "plain";
    text = "Nothing to review";
    detail = `SlopMonster found none of its patterns (score ${an.score}/5).`;
  } else {
    tone = "done";
    text = `${r.findings.length.toLocaleString()} ${r.findings.length === 1 ? "finding" : "findings"} to review`;
    const cats = (Object.keys(r.counts) as Category[]).filter((k) => r.counts[k] > 0);
    detail = `SlopMonster score ${an.score}/5 · ${cats.map((k) => CATEGORY_INFO[k].title).join(", ")}. Your text is typed exactly as written.`;
  }
  const Icon = tone === "busy" ? LoaderCircle : tone === "done" ? ScanText : tone === "error" ? AlertTriangle : Check;
  return (
    <div className={`analysis analysis--${tone}`} data-testid="analysis-status">
      <p className="analysis__line" role={tone === "error" ? "alert" : "status"} aria-live="polite">
        <Icon size={15} aria-hidden="true" className={tone === "busy" ? "spin" : undefined} />
        <strong data-testid="analysis-headline">{text}</strong>
        {detail ? <span className="analysis__detail">{detail}</span> : null}
      </p>
      {tone === "error" ? (
        <Button size="sm" variant="ghost" className="analysis__jump" onClick={an.rerun} data-testid="analysis-retry">
          Try again
        </Button>
      ) : null}
      {studioVisible(session) ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowDown size={14} />}
          className="analysis__jump"
          onClick={() => {
            const el = document.getElementById("studio");
            el?.scrollIntoView?.({ block: "start", behavior: "smooth" });
            el?.focus({ preventScroll: true });
          }}
          data-testid="analysis-review"
        >
          Review the findings
        </Button>
      ) : null}
    </div>
  );
}
