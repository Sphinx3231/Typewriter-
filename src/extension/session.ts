/**
 * Runs a typing timeline into a Chrome tab, with safety guards.
 *
 * Lifecycle:
 *   waiting   – no eligible tab yet (e.g. the Typewriter tab itself is active), or
 *               the focused element isn't a text field; nothing is typed
 *   countdown – visible countdown so the user can click the insertion point
 *   typing    – trusted key events go to the tab that was active when the countdown
 *               ended, into the element that had focus then (the "target")
 *   paused    – by the user, or automatically when the tab or focused element changes
 *               or a password field gets focus
 *   resuming  – short countdown, then waits for the same tab and element again
 *   completed / stopped / failed
 *
 * Timing follows planned event times on a monotonic clock (no drift); pauses
 * shift the clock by exactly the paused time. The text is only ever sent as
 * literal key input; nothing in it is evaluated.
 */
import { Translator, type KeyAction, type TypingEvent } from "../engine";

export interface TabInfo {
  id: number;
  windowId: number;
}

/** What the page reports about its focused element (from a fixed inspection script). */
export interface FocusProbe {
  href: string;
  title: string;
  /** Stable id of the focused element, so a change of focus can be noticed. */
  elementId: string | null;
  kind: "input" | "textarea" | "contenteditable" | "none";
  editable: boolean;
  /** Why typing must not happen here (password field, hidden field…). */
  sensitive: string | null;
  /** Current text of the field when it can be read reliably; null otherwise (e.g. Google Docs). */
  text: string | null;
  selStart: number | null;
  selEnd: number | null;
}

export type BrowserEvent = { type: "detached"; reason: string } | { type: "navigated" } | { type: "tab-activated"; tabId: number; windowId: number } | { type: "tab-removed"; tabId: number };

export interface Browser {
  /** Active tab of the last focused normal window, unless it is an extension page. */
  eligibleActiveTab(): Promise<TabInfo | null>;
  attach(tabId: number): Promise<void>;
  detach(): Promise<void>;
  probe(): Promise<FocusProbe | null>;
  send(a: KeyAction): Promise<void>;
  onEvent(cb: (e: BrowserEvent) => void): () => void;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
};

export interface SessionUpdate {
  phase: "waiting" | "countdown" | "typing" | "paused" | "resuming" | "completed" | "stopped" | "failed";
  index: number;
  elapsedMs: number;
  totalMs: number;
  countdownMs: number;
  target: { windowId: string; processId: number; appName: string; title: string } | null;
  reason: string | null;
  message: string | null;
  verification?: { status: "verified" | "mismatch" | "unreadable"; detail: string };
}

export interface SessionOptions {
  countdownMs: number;
  resumeCountdownMs: number;
  /** The original text, used to check single-line fields and to verify the result. */
  source: string;
}

type Command = "pause" | "resume" | "stop";
const TICK = 25;
/** How often the page is re-inspected while typing (and always before the first key after a pause). */
const PROBE_EVERY_MS = 120;

const norm = (s: string) => s.replace(/\r\n?/g, "\n").replace(/ /g, " ");

export function isDocs(href: string) {
  return /^https:\/\/docs\.google\.com\/document\//.test(href);
}

/** Compare the field's text after typing with what it should be. */
export function verifyField(before: FocusProbe, after: FocusProbe, source: string): SessionUpdate["verification"] {
  if (before.text === null || after.text === null) {
    return {
      status: "unreadable",
      detail: isDocs(after.href)
        ? "Google Docs draws its text on a canvas, so Typewriter can't read it back. Select the typed text, copy it, and use Check copied text."
        : "This editor's text can't be read back reliably. Select the typed text, copy it, and use Check copied text.",
    };
  }
  if (before.kind !== "contenteditable" && before.selStart !== null && before.selEnd !== null) {
    const expected = before.text.slice(0, before.selStart) + source + before.text.slice(before.selEnd);
    return after.text === expected
      ? { status: "verified", detail: "Read back from the field: it contains your text exactly." }
      : { status: "mismatch", detail: "The field's text isn't what was typed. The page may have changed it (autocomplete, formatting, a length limit)." };
  }
  // Rich editors: if the page's text didn't change at all, the editor keeps its text somewhere
  // Typewriter can't see (like Google Docs). That is not evidence either way.
  if (source && norm(after.text) === norm(before.text))
    return {
      status: "unreadable",
      detail: "This editor doesn't keep its text where Typewriter can read it. Select the typed text, copy it, and use Check copied text.",
    };
  // Otherwise the typed text must now appear, and must not have been there before.
  const ok = norm(after.text).includes(norm(source)) && !norm(before.text).includes(norm(source));
  return ok
    ? { status: "verified", detail: "Read back from the editor: your text appears exactly (non-breaking spaces count as spaces)." }
    : { status: "mismatch", detail: "Your text doesn't appear exactly in the editor. It may have reformatted it (lists, smart quotes, auto-capitalisation)." };
}

export class ChromeTypingSession {
  private command: Command | null = null;
  private tabChanged = false;
  private navigated = false;
  private detached: string | null = null;
  private index = 0;
  private elapsed = 0;
  private target: { tab: TabInfo; probe: FocusProbe } | null = null;
  private attachedTo: number | null = null;
  private off: () => void;

  constructor(
    private browser: Browser,
    private events: TypingEvent[],
    private opts: SessionOptions,
    private emit: (u: SessionUpdate) => void,
    private clock: Clock = realClock,
  ) {
    this.off = browser.onEvent((e) => {
      if (e.type === "detached") this.detached = e.reason;
      else if (e.type === "navigated") this.navigated = true;
      else if (e.type === "tab-removed" && e.tabId === this.attachedTo) this.detached = "tab-closed";
      else if (e.type === "tab-activated" && this.target && e.windowId === this.target.tab.windowId && e.tabId !== this.target.tab.id) this.tabChanged = true;
    });
  }

  send(c: Command) {
    if (this.command !== "stop") this.command = c;
  }

  private take(): Command | null {
    const c = this.command;
    this.command = null;
    return c;
  }

  private total() {
    return this.events.length ? this.events[this.events.length - 1].at : 0;
  }

  private update(phase: SessionUpdate["phase"], countdownMs = 0, reason: string | null = null, message: string | null = null, verification?: SessionUpdate["verification"]) {
    const p = this.target?.probe;
    this.emit({
      phase,
      index: this.index,
      elapsedMs: this.elapsed,
      totalMs: this.total(),
      countdownMs,
      target: p ? { windowId: String(this.target!.tab.id), processId: 0, appName: isDocs(p.href) ? "Google Docs" : new URL(p.href).hostname || "page", title: p.title } : null,
      reason,
      message,
      verification,
    });
  }

  private async attach(tabId: number) {
    if (this.attachedTo === tabId) return;
    if (this.attachedTo !== null) await this.browser.detach().catch(() => {});
    this.attachedTo = null;
    await this.browser.attach(tabId);
    this.attachedTo = tabId;
    this.navigated = false;
    this.detached = null;
  }

  private async finish(phase: "completed" | "stopped" | "failed", reason: string | null, message: string | null, verification?: SessionUpdate["verification"]) {
    this.off();
    if (this.attachedTo !== null) await this.browser.detach().catch(() => {});
    this.attachedTo = null;
    this.update(phase, 0, reason, message, verification);
    return phase;
  }

  /** Runs to the end. Returns the final phase. */
  async run(): Promise<string> {
    if (!this.events.length) return this.finish("completed", null, null);
    const armed = await this.arm();
    if (armed !== "ok") return armed;
    return this.typeAll();
  }

  /** Wait for an eligible tab with a focused text field, then count down. Nothing is typed here. */
  private async arm(): Promise<string> {
    let countdownFrom: number | null = null;
    let tabId: number | null = null;
    let lastNote = "";
    let fieldSince: number | null = null;
    for (;;) {
      if (this.take() === "stop") return this.finish("stopped", "user", null);
      if (this.detached) return this.finish("stopped", "detached", "Chrome stopped the typing session (the debugging bar was closed or the tab went away).");
      const tab = await this.browser.eligibleActiveTab();
      if (!tab) {
        countdownFrom = null;
        if (lastNote !== "no-tab") this.update("waiting", this.opts.countdownMs, null, "Switch to the tab you want to type into.");
        lastNote = "no-tab";
        await this.clock.sleep(150);
        continue;
      }
      if (tab.id !== tabId) {
        try {
          await this.attach(tab.id);
        } catch {
          return this.finish("failed", "unsupported-page", "Chrome doesn't let extensions type into this page (browser pages, the Chrome Web Store and some others are protected). Open your document in a normal tab.");
        }
        tabId = tab.id;
        countdownFrom = this.clock.now();
      }
      if (countdownFrom === null) countdownFrom = this.clock.now();
      const left = this.opts.countdownMs - (this.clock.now() - countdownFrom);
      if (left > 0) {
        this.update("countdown", left, null, "Click exactly where the text should start.");
        lastNote = "";
        await this.clock.sleep(Math.min(100, left));
        continue;
      }
      const probe = await this.browser.probe();
      if (probe?.sensitive) return this.finish("failed", "sensitive", `${probe.sensitive} Typewriter never types into password or hidden fields.`);
      if (!probe || !probe.editable) {
        if (lastNote !== "no-field") this.update("waiting", 0, "no-text-field", "Click into a document or text field on the page. Typing starts a moment after.");
        lastNote = "no-field";
        fieldSince = null;
        await this.clock.sleep(150);
        continue;
      }
      // After waiting for a field, give the click a moment to settle before typing.
      if (lastNote === "no-field") {
        fieldSince ??= this.clock.now();
        if (this.clock.now() - fieldSince < 800) {
          await this.clock.sleep(100);
          continue;
        }
      }
      if (probe.kind === "input" && /[\r\n]/.test(this.opts.source))
        return this.finish("failed", "single-line", "That's a single-line field, but your text has line breaks. Pressing Enter there could submit a form, so nothing was typed.");
      this.target = { tab, probe };
      return "ok";
    }
  }

  /** Checks that typing may continue right now. Returns a pause reason and message if not. */
  private async guard(): Promise<[string, string] | "stop" | null> {
    if (this.detached) return "stop";
    if (this.navigated) return "stop";
    if (this.tabChanged) return ["tab-changed", "You switched tabs, so typing paused. It only types into the tab you started in."];
    const p = await this.browser.probe();
    if (!p) return ["focus-unknown", "Couldn't check the page, so typing paused to be safe."];
    if (p.href !== this.target!.probe.href) {
      // The address changed without a page load (a single-page app navigated).
      this.navigated = true;
      return "stop";
    }
    if (p.sensitive) return ["sensitive", `${p.sensitive} Typing paused.`];
    if (p.elementId !== this.target!.probe.elementId) return ["focus-changed", "The text cursor moved to a different field or out of the document, so typing paused."];
    return null;
  }

  private async typeAll(): Promise<string> {
    const tr = new Translator();
    let anchor = this.clock.now();
    let lastProbe = -Infinity;
    let lastEmit = -Infinity;
    this.update("typing");
    while (this.index < this.events.length) {
      const due = this.events[this.index].at;
      for (;;) {
        const c = this.take();
        if (c === "stop") return this.finish("stopped", "user", null);
        if (c === "pause") {
          this.elapsed = Math.min(this.clock.now() - anchor, due);
          const r = await this.pause("user", "Paused.");
          if (r === "stopped") return r;
          anchor += r;
          lastProbe = -Infinity;
          continue;
        }
        const now = this.clock.now() - anchor;
        if (now >= due) break;
        await this.clock.sleep(Math.min(TICK, due - now));
      }
      if (this.clock.now() - lastProbe >= PROBE_EVERY_MS || this.detached || this.navigated || this.tabChanged) {
        const g = await this.guard();
        lastProbe = this.clock.now();
        if (g === "stop")
          return this.finish(
            "stopped",
            this.navigated ? "navigated" : "detached",
            this.navigated ? "The page navigated or reloaded, so typing stopped." : "Chrome stopped the typing session (the debugging bar was closed or the tab went away).",
          );
        if (g) {
          this.elapsed = Math.min(this.clock.now() - anchor, due);
          const r = await this.pause(g[0], g[1]);
          if (r === "stopped") return r;
          anchor += r;
          lastProbe = -Infinity;
          continue;
        }
      }
      for (const a of tr.actions(this.events[this.index])) {
        if (this.command === "stop") return this.finish("stopped", "user", null);
        try {
          await this.browser.send(a);
        } catch (e) {
          if (this.navigated) return this.finish("stopped", "navigated", "The page navigated or reloaded, so typing stopped.");
          if (this.detached) return this.finish("stopped", "detached", "The tab went away while typing.");
          return this.finish("failed", "send-failed", `Couldn't send a key: ${String(e)}`);
        }
      }
      this.index++;
      this.elapsed = due;
      if (this.clock.now() - lastEmit >= 50 || this.index === this.events.length) {
        this.update("typing");
        lastEmit = this.clock.now();
      }
    }
    this.elapsed = this.total();
    const after = await this.browser.probe().catch(() => null);
    const verification = after ? verifyField(this.target!.probe, after, this.opts.source) : { status: "unreadable" as const, detail: "Couldn't read the page after typing." };
    return this.finish("completed", null, "Every key was sent.", verification);
  }

  /** Paused until resume (then countdown and wait for the same tab and field) or stop. Returns the paused duration, or "stopped". */
  private async pause(reason: string, message: string): Promise<number | "stopped"> {
    const t0 = this.clock.now();
    this.update("paused", 0, reason, message);
    for (;;) {
      const c = this.take();
      if (c === "stop") {
        await this.finish("stopped", "user", null);
        return "stopped";
      }
      if (c === "resume") break;
      if (this.detached || this.navigated) {
        await this.finish("stopped", this.navigated ? "navigated" : "detached", this.navigated ? "The page navigated or reloaded, so typing stopped." : "Chrome stopped the typing session.");
        return "stopped";
      }
      await this.clock.sleep(TICK * 4);
    }
    const r0 = this.clock.now();
    for (;;) {
      if (this.take() === "stop") {
        await this.finish("stopped", "user", null);
        return "stopped";
      }
      const left = this.opts.resumeCountdownMs - (this.clock.now() - r0);
      if (left <= 0) break;
      this.update("resuming", left);
      await this.clock.sleep(Math.min(100, left));
    }
    let announced = false;
    for (;;) {
      if (this.take() === "stop") {
        await this.finish("stopped", "user", null);
        return "stopped";
      }
      // Tab switch back? The target tab must be the active one again.
      const tab = await this.browser.eligibleActiveTab();
      if (tab && tab.id === this.target!.tab.id) this.tabChanged = false;
      const g = this.tabChanged ? (["tab-changed", ""] as [string, string]) : await this.guard();
      if (g === "stop") {
        await this.finish("stopped", this.navigated ? "navigated" : "detached", "The page navigated or the tab went away, so typing stopped.");
        return "stopped";
      }
      if (!g) break;
      if (!announced) {
        this.update("resuming", 0, "waiting-for-target", `Go back to "${this.target!.probe.title}" and click where you left off.`);
        announced = true;
      }
      await this.clock.sleep(150);
    }
    this.update("typing");
    return this.clock.now() - t0;
  }
}
