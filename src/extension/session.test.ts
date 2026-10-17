import { describe, expect, it } from "vitest";
import { buildScript, buildTimeline, DEFAULT_SETTINGS, VirtualField, type KeyAction, type TypingEvent } from "../engine";
import { ChromeTypingSession, verifyField, type Browser, type BrowserEvent, type FocusProbe, type SessionOptions, type SessionUpdate, type TabInfo } from "./session";

/** Virtual time: sleeping advances the clock and fires scheduled hooks. */
class FakeClock {
  t = 0;
  private hooks: { at: number; fn: () => void }[] = [];
  now = () => this.t;
  sleep = async (ms: number) => {
    this.t += Math.max(1, ms);
    this.fire();
  };
  at(at: number, fn: () => void) {
    this.hooks.push({ at, fn });
  }
  fire() {
    const due = this.hooks.filter((h) => h.at <= this.t);
    this.hooks = this.hooks.filter((h) => h.at > this.t);
    for (const h of due) h.fn();
  }
}

/** A tab with one text field, driven only by the key actions it receives. */
class FakeBrowser implements Browser {
  tab: TabInfo | null = { id: 7, windowId: 1 };
  attachFails = false;
  attached: number | null = null;
  attaches: number[] = [];
  detaches = 0;
  field = new VirtualField();
  href = "https://example.com/form";
  title = "Example form";
  elementId: string | null = "el-1";
  kind: FocusProbe["kind"] = "textarea";
  editable = true;
  sensitive: string | null = null;
  readable = true;
  /** Applied to every typed character, to imitate a page that rewrites input. */
  rewrite: (s: string) => string = (s) => s;
  sent: { at: number; action: KeyAction }[] = [];
  onSend: (n: number) => void = () => {};
  private listeners = new Set<(e: BrowserEvent) => void>();

  constructor(private clock: FakeClock) {}

  async eligibleActiveTab() {
    return this.tab;
  }
  async attach(tabId: number) {
    if (this.attachFails) throw new Error("Cannot access a chrome:// URL");
    this.attached = tabId;
    this.attaches.push(tabId);
  }
  async detach() {
    this.attached = null;
    this.detaches++;
  }
  async probe(): Promise<FocusProbe> {
    return {
      href: this.href,
      title: this.title,
      elementId: this.elementId,
      kind: this.kind,
      editable: this.editable,
      sensitive: this.sensitive,
      text: this.readable ? this.field.text() : null,
      selStart: this.readable ? this.field.caret : null,
      selEnd: this.readable ? this.field.caret : null,
    };
  }
  async send(a: KeyAction) {
    if (this.attached === null) throw new Error("not attached");
    this.sent.push({ at: this.clock.t, action: a });
    this.field.apply(a.kind === "text" ? { kind: "text", text: this.rewrite(a.text) } : a);
    this.onSend(this.sent.length);
  }
  onEvent(cb: (e: BrowserEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  fireEvent(e: BrowserEvent) {
    for (const l of this.listeners) l(e);
  }
}

const TEXT = "Héllo wörld — “quotes” & <b>tags</b> $(rm -rf /) 👍🏽 👨‍👩‍👧\nSecond line\twith a tab.";
const settings = { ...DEFAULT_SETTINGS, mistakes: "medium" as const, seed: 11 };
const timeline = (text = TEXT, sec = 20) => buildTimeline(buildScript(text, settings), { ...settings, timingMode: "duration", durationSec: sec });

function setup(text = TEXT, opts: Partial<{ countdownMs: number; resumeCountdownMs: number }> = {}) {
  const clock = new FakeClock();
  const browser = new FakeBrowser(clock);
  const updates: SessionUpdate[] = [];
  const tl = timeline(text);
  const session = new ChromeTypingSession(
    browser,
    tl.events,
    { countdownMs: opts.countdownMs ?? 3000, resumeCountdownMs: opts.resumeCountdownMs ?? 1000, source: text },
    (u) => updates.push(u),
    clock,
  );
  const phases = () => updates.map((u) => u.phase).filter((p, i, a) => p !== a[i - 1]);
  const last = () => updates[updates.length - 1];
  return { clock, browser, updates, session, tl, phases, last };
}

describe("Chrome typing session", () => {
  it("types nothing before the countdown ends, then types the text exactly and verifies it", async () => {
    const s = setup();
    const result = await s.session.run();
    expect(result).toBe("completed");
    expect(s.browser.sent.length).toBeGreaterThan(0);
    expect(s.browser.sent[0].at).toBeGreaterThanOrEqual(3000);
    expect(s.updates.filter((u) => u.phase === "countdown").every((u) => u.index === 0)).toBe(true);
    expect(s.browser.field.text()).toBe(TEXT);
    expect(s.last().verification?.status).toBe("verified");
    expect(s.browser.detaches).toBe(1);
    expect(s.browser.attached).toBeNull();
    // Literal text only: the shell-like and HTML-like parts arrive as plain characters.
    expect(s.browser.sent.some((x) => x.action.kind === "text" && x.action.text === "$")).toBe(true);
  });

  it("keeps the planned timing (no drift) and line breaks/tabs become Enter/Tab", async () => {
    const s = setup();
    await s.session.run();
    const typingStart = s.browser.sent[0].at;
    const lastAt = s.browser.sent[s.browser.sent.length - 1].at;
    expect(lastAt - typingStart).toBeLessThanOrEqual(s.tl.totalMs + 200);
    expect(lastAt - typingStart).toBeGreaterThanOrEqual(s.tl.totalMs - s.tl.events[0].at - 200);
    expect(s.browser.sent.filter((x) => x.action.kind === "enter")).toHaveLength(1);
    expect(s.browser.sent.filter((x) => x.action.kind === "tab")).toHaveLength(1);
  });

  it("waits while no eligible tab is active and starts the countdown only once one is", async () => {
    const s = setup();
    s.browser.tab = null;
    s.clock.at(5000, () => (s.browser.tab = { id: 7, windowId: 1 }));
    await s.session.run();
    expect(s.phases().slice(0, 3)).toEqual(["waiting", "countdown", "typing"]);
    expect(s.browser.sent[0].at).toBeGreaterThanOrEqual(8000);
    expect(s.browser.field.text()).toBe(TEXT);
  });

  it("restarts the countdown when the user switches tabs before it ends", async () => {
    const s = setup();
    s.clock.at(2000, () => (s.browser.tab = { id: 8, windowId: 1 }));
    await s.session.run();
    expect(s.browser.attaches).toEqual([7, 8]);
    expect(s.browser.sent[0].at).toBeGreaterThanOrEqual(5000);
  });

  it("fails without typing on pages Chrome protects", async () => {
    const s = setup();
    s.browser.attachFails = true;
    expect(await s.session.run()).toBe("failed");
    expect(s.last().reason).toBe("unsupported-page");
    expect(s.browser.sent).toHaveLength(0);
  });

  it("refuses password and hidden fields", async () => {
    const s = setup();
    s.browser.kind = "input";
    s.browser.sensitive = "That's a password field.";
    expect(await s.session.run()).toBe("failed");
    expect(s.last().reason).toBe("sensitive");
    expect(s.browser.sent).toHaveLength(0);
    expect(s.browser.attached).toBeNull();
  });

  it("refuses a password field even when it isn't reported as editable", async () => {
    const s = setup();
    s.browser.kind = "input";
    s.browser.editable = false;
    s.browser.sensitive = "This is a password field.";
    expect(await s.session.run()).toBe("failed");
    expect(s.last().reason).toBe("sensitive");
    expect(s.browser.sent).toHaveLength(0);
  });

  it("refuses multi-line text in a single-line field (Enter could submit a form)", async () => {
    const s = setup();
    s.browser.kind = "input";
    expect(await s.session.run()).toBe("failed");
    expect(s.last().reason).toBe("single-line");
    expect(s.browser.sent).toHaveLength(0);
    const one = setup("single line only");
    one.browser.kind = "input";
    expect(await one.session.run()).toBe("completed");
    expect(one.browser.field.text()).toBe("single line only");
  });

  it("waits, typing nothing, until a text field has focus", async () => {
    const s = setup();
    s.browser.editable = false;
    s.browser.kind = "none";
    s.clock.at(9000, () => {
      s.browser.editable = true;
      s.browser.kind = "textarea";
    });
    await s.session.run();
    expect(s.updates.some((u) => u.reason === "no-text-field")).toBe(true);
    expect(s.browser.sent[0].at).toBeGreaterThanOrEqual(9000);
    expect(s.browser.field.text()).toBe(TEXT);
  });

  it("can be cancelled during the countdown without typing anything", async () => {
    const s = setup();
    s.clock.at(1500, () => s.session.send("stop"));
    expect(await s.session.run()).toBe("stopped");
    expect(s.browser.sent).toHaveLength(0);
    expect(s.browser.attached).toBeNull();
  });

  it("stops immediately mid-typing and sends nothing after", async () => {
    const s = setup();
    let stoppedAt = -1;
    s.browser.onSend = (n) => {
      if (n === 20) {
        s.session.send("stop");
        stoppedAt = n;
      }
    };
    expect(await s.session.run()).toBe("stopped");
    expect(s.browser.sent).toHaveLength(stoppedAt);
    expect(s.last().reason).toBe("user");
  });

  it("pauses and resumes exactly, without counting paused time", async () => {
    const s = setup();
    s.browser.onSend = (n) => {
      if (n === 15) {
        s.session.send("pause");
        s.clock.at(s.clock.t + 10_000, () => s.session.send("resume"));
      }
    };
    await s.session.run();
    const paused = s.updates.filter((u) => u.phase === "paused");
    expect(paused.length).toBeGreaterThan(0);
    const during = s.browser.sent.filter((x) => x.at > s.browser.sent[14].at && x.at < s.browser.sent[14].at + 10_000);
    expect(during).toHaveLength(0);
    expect(s.phases()).toContain("resuming");
    expect(s.browser.field.text()).toBe(TEXT);
    expect(s.last().phase).toBe("completed");
  });

  it("stop always wins over a later pause or resume", async () => {
    const s = setup();
    s.browser.onSend = (n) => {
      if (n === 5) {
        s.session.send("stop");
        s.session.send("pause");
        s.session.send("resume");
      }
    };
    expect(await s.session.run()).toBe("stopped");
    expect(s.browser.sent).toHaveLength(5);
  });

  it("pauses when the user switches tabs and resumes only back in the original tab", async () => {
    const s = setup();
    let switchedAt = 0;
    s.browser.onSend = (n) => {
      if (n === 30) {
        switchedAt = s.clock.t;
        s.browser.tab = { id: 9, windowId: 1 };
        s.browser.fireEvent({ type: "tab-activated", tabId: 9, windowId: 1 });
        // Resume while still on the other tab, then return later.
        s.clock.at(switchedAt + 2000, () => s.session.send("resume"));
        s.clock.at(switchedAt + 8000, () => {
          s.browser.tab = { id: 7, windowId: 1 };
          s.browser.fireEvent({ type: "tab-activated", tabId: 7, windowId: 1 });
        });
      }
    };
    await s.session.run();
    expect(s.updates.some((u) => u.phase === "paused" && u.reason === "tab-changed")).toBe(true);
    expect(s.updates.some((u) => u.reason === "waiting-for-target")).toBe(true);
    const after = s.browser.sent.slice(30);
    expect(after.every((x) => x.at >= switchedAt + 8000)).toBe(true);
    expect(s.browser.field.text()).toBe(TEXT);
  });

  it("pauses when focus moves to another field, and continues once it is back", async () => {
    const s = setup();
    let movedAt = 0;
    s.browser.onSend = (n) => {
      if (n === 25) {
        movedAt = s.clock.t;
        s.browser.elementId = "el-2";
        s.clock.at(movedAt + 3000, () => s.session.send("resume"));
        s.clock.at(movedAt + 6000, () => (s.browser.elementId = "el-1"));
      }
    };
    await s.session.run();
    expect(s.updates.some((u) => u.phase === "paused" && u.reason === "focus-changed")).toBe(true);
    // At most the keys of one event can follow before the throttled check notices.
    const leaked = s.browser.sent.filter((x) => x.at > movedAt + 200 && x.at < movedAt + 6000);
    expect(leaked).toHaveLength(0);
    expect(s.browser.field.text()).toBe(TEXT);
  });

  it("pauses (never types) when a password field gets focus mid-session", async () => {
    const s = setup();
    let at = 0;
    s.browser.onSend = (n) => {
      if (n === 10) {
        at = s.clock.t;
        s.browser.sensitive = "That's a password field.";
        s.clock.at(at + 1000, () => s.session.send("stop"));
      }
    };
    expect(await s.session.run()).toBe("stopped");
    expect(s.updates.some((u) => u.reason === "sensitive")).toBe(true);
    expect(s.browser.sent.filter((x) => x.at > at + 200)).toHaveLength(0);
  });

  it("stops when the page navigates or reloads", async () => {
    const s = setup();
    s.browser.onSend = (n) => {
      if (n === 12) s.browser.fireEvent({ type: "navigated" });
    };
    expect(await s.session.run()).toBe("stopped");
    expect(s.last().reason).toBe("navigated");
    expect(s.browser.sent.length).toBeLessThanOrEqual(14);
  });

  it("stops when the URL changes without a reported navigation (single-page apps)", async () => {
    const s = setup();
    s.browser.onSend = (n) => {
      if (n === 12) s.browser.href = "https://example.com/other";
    };
    expect(await s.session.run()).toBe("stopped");
    expect(s.browser.sent.length).toBeLessThanOrEqual(14);
  });

  it("stops when Chrome ends the debugging session or the tab closes", async () => {
    for (const ev of [{ type: "detached", reason: "canceled_by_user" }, { type: "tab-removed", tabId: 7 }] as BrowserEvent[]) {
      const s = setup();
      s.browser.onSend = (n) => {
        if (n === 8) s.browser.fireEvent(ev);
      };
      expect(await s.session.run()).toBe("stopped");
      expect(s.browser.sent.length).toBeLessThanOrEqual(10);
    }
  });

  it("reports a mismatch when the page changes the typed text", async () => {
    const s = setup("plain text");
    s.browser.rewrite = (c) => (c === "p" ? "P" : c);
    await s.session.run();
    expect(s.last().phase).toBe("completed");
    expect(s.last().verification?.status).toBe("mismatch");
  });

  it("never claims a match for Google Docs, whose text can't be read back", async () => {
    const s = setup();
    s.browser.href = "https://docs.google.com/document/d/abc/edit";
    s.browser.kind = "contenteditable";
    s.browser.readable = false;
    await s.session.run();
    expect(s.last().verification?.status).toBe("unreadable");
    expect(s.last().verification?.detail).toMatch(/Google Docs/);
    expect(s.last().target?.appName).toBe("Google Docs");
  });

  it("handles long text with a short duration", async () => {
    const long = "The quick brown fox jumps over the lazy dog. ".repeat(250);
    const clock = new FakeClock();
    const browser = new FakeBrowser(clock);
    const events = buildTimeline(buildScript(long, settings), { ...settings, timingMode: "duration", durationSec: 30 }).events;
    const session = new ChromeTypingSession(browser, events, { countdownMs: 2000, resumeCountdownMs: 500, source: long }, () => {}, clock);
    expect(await session.run()).toBe("completed");
    expect(browser.field.text()).toBe(long);
  });
});

describe("field verification", () => {
  const p = (o: Partial<FocusProbe>): FocusProbe => ({
    href: "https://x.test/",
    title: "",
    elementId: "a",
    kind: "textarea",
    editable: true,
    sensitive: null,
    text: "",
    selStart: 0,
    selEnd: 0,
    ...o,
  });
  it("checks inputs exactly, including text around the insertion point and replaced selections", () => {
    expect(verifyField(p({ text: "AB", selStart: 1, selEnd: 1 }), p({ text: "AxyB" }), "xy")?.status).toBe("verified");
    expect(verifyField(p({ text: "A--B", selStart: 1, selEnd: 3 }), p({ text: "AxyB" }), "xy")?.status).toBe("verified");
    expect(verifyField(p({ text: "AB", selStart: 1, selEnd: 1 }), p({ text: "AXyB" }), "xy")?.status).toBe("mismatch");
  });
  it("for rich editors, requires the text to newly appear", () => {
    const ce = { kind: "contenteditable" as const, selStart: null, selEnd: null };
    expect(verifyField(p({ ...ce, text: "" }), p({ ...ce, text: "Hi there\n" }), "Hi there")?.status).toBe("verified");
    expect(verifyField(p({ ...ce, text: "Hi there" }), p({ ...ce, text: "Hi there. Hi there" }), "Hi there")?.status).toBe("mismatch");
    // DOM text unchanged: the editor keeps its text elsewhere, so it's unknown, not a mismatch.
    expect(verifyField(p({ ...ce, text: "" }), p({ ...ce, text: "" }), "Hi there")?.status).toBe("unreadable");
    expect(verifyField(p({ ...ce, text: "" }), p({ ...ce, text: "“Hi”" }), '"Hi"')?.status).toBe("mismatch");
  });
  it("is unreadable when either side can't be read", () => {
    expect(verifyField(p({ text: null }), p({ text: "x" }), "x")?.status).toBe("unreadable");
  });
});

describe("Chrome typing session: edge and failure paths", () => {
  const step = (at: number, s: Partial<TypingEvent>) => ({ u: 1, p: 0, at, ...s }) as TypingEvent;
  const typed = (text: string, gap = 10) => [...text].map((ch, i) => step(i * gap, { kind: "type", text: ch }));

  function manual(events: TypingEvent[], source: string, opts: Partial<SessionOptions> = {}) {
    const clock = new FakeClock();
    const browser = new FakeBrowser(clock);
    const updates: SessionUpdate[] = [];
    const session = new ChromeTypingSession(browser, events, { countdownMs: 1000, resumeCountdownMs: 500, source, ...opts }, (u) => updates.push(u), clock);
    const last = () => updates[updates.length - 1];
    const phases = () => updates.map((u) => u.phase).filter((p, i, a) => p !== a[i - 1]);
    return { clock, browser, updates, session, last, phases };
  }
  /** Pause mid-typing (by the user) after the n-th key, run `whilePaused`, and resume `after` ms later unless told not to. */
  function pauseAt(s: ReturnType<typeof manual> | ReturnType<typeof setup>, n: number, whilePaused: () => void, resumeAfter: number | null = 1000) {
    let pausedAt = -1;
    s.browser.onSend = (k) => {
      if (k !== n) return;
      pausedAt = s.clock.t;
      s.session.send("pause");
      whilePaused();
      if (resumeAfter !== null) s.clock.at(pausedAt + resumeAfter, () => s.session.send("resume"));
    };
    return () => pausedAt;
  }

  it("completes an empty timeline at once without touching any tab", async () => {
    const s = manual([], "");
    expect(await s.session.run()).toBe("completed");
    expect(s.browser.attaches).toEqual([]);
    expect(s.browser.detaches).toBe(0);
    expect(s.updates).toHaveLength(1);
    expect(s.last()).toMatchObject({ phase: "completed", totalMs: 0, index: 0, target: null });
  });

  it("names a page without a host generically", async () => {
    const s = manual(typed("abc"), "abc");
    s.browser.href = "about:blank";
    expect(await s.session.run()).toBe("completed");
    expect(s.last().target).toMatchObject({ appName: "page", windowId: "7", title: "Example form" });
  });

  it("restarts the countdown when the same tab comes back after no tab was eligible", async () => {
    const s = manual(typed("abc"), "abc", { countdownMs: 3000 });
    s.clock.at(1000, () => (s.browser.tab = null));
    s.clock.at(2000, () => (s.browser.tab = { id: 7, windowId: 1 }));
    expect(await s.session.run()).toBe("completed");
    expect(s.browser.attaches).toEqual([7]);
    expect(s.phases().slice(0, 4)).toEqual(["countdown", "waiting", "countdown", "typing"]);
    expect(s.browser.sent[0].at).toBeGreaterThanOrEqual(5000);
    expect(s.browser.field.text()).toBe("abc");
  });

  it("carries on when detaching from a previous tab or at the end fails", async () => {
    const s = manual(typed("abc"), "abc", { countdownMs: 3000 });
    s.browser.detach = async () => {
      s.browser.detaches++;
      throw new Error("Debugger is not attached to the tab");
    };
    s.clock.at(1000, () => (s.browser.tab = { id: 8, windowId: 1 }));
    expect(await s.session.run()).toBe("completed");
    expect(s.browser.attaches).toEqual([7, 8]);
    expect(s.browser.detaches).toBe(2);
    expect(s.last().phase).toBe("completed");
    expect(s.browser.field.text()).toBe("abc");
  });

  it("pauses when the page can't be inspected, and continues once it can", async () => {
    const s = manual(typed("hello world", 200), "hello world");
    const real = s.browser.probe.bind(s.browser);
    let blind = false;
    (s.browser as Browser).probe = async () => (blind ? null : real());
    let at = 0;
    s.browser.onSend = (n) => {
      if (n !== 3) return;
      at = s.clock.t;
      blind = true;
      s.clock.at(at + 1000, () => s.session.send("resume"));
      s.clock.at(at + 3000, () => (blind = false));
    };
    expect(await s.session.run()).toBe("completed");
    expect(s.updates.some((u) => u.phase === "paused" && u.reason === "focus-unknown")).toBe(true);
    expect(s.updates.some((u) => u.reason === "waiting-for-target")).toBe(true);
    expect(s.browser.sent.slice(3).every((x) => x.at >= at + 3000)).toBe(true);
    expect(s.browser.field.text()).toBe("hello world");
  });

  it("can be stopped while paused, sending nothing more", async () => {
    const s = manual(typed("hello world"), "hello world");
    const pausedAt = pauseAt(s, 4, () => {}, null);
    s.clock.at(10_000, () => s.session.send("stop"));
    expect(await s.session.run()).toBe("stopped");
    expect(s.last()).toMatchObject({ phase: "stopped", reason: "user" });
    expect(s.browser.sent).toHaveLength(4);
    expect(pausedAt()).toBeGreaterThan(0);
    expect(s.browser.attached).toBeNull();
  });

  it("stops between the keys of a single multi-key event", async () => {
    // Typing "abc" then moving the caret to the start is one event made of three Left presses.
    const s = manual([...typed("abc"), step(40, { kind: "caret", to: 0 })], "abc");
    s.browser.onSend = (n) => {
      if (s.browser.sent[n - 1].action.kind === "left") s.session.send("stop");
    };
    expect(await s.session.run()).toBe("stopped");
    expect(s.browser.sent.map((x) => x.action.kind)).toEqual(["text", "text", "text", "left"]);
    expect(s.last().reason).toBe("user");
  });

  it("fails, and detaches, when a key can't be sent", async () => {
    const s = manual(typed("abc"), "abc");
    const real = s.browser.send.bind(s.browser);
    s.browser.send = async (a) => {
      if (s.browser.sent.length === 1) throw new Error("Input domain unavailable");
      return real(a);
    };
    expect(await s.session.run()).toBe("failed");
    expect(s.last()).toMatchObject({ phase: "failed", reason: "send-failed" });
    expect(s.last().message).toMatch(/Couldn't send a key: Error: Input domain unavailable/);
    expect(s.browser.sent).toHaveLength(1);
    expect(s.browser.attached).toBeNull();
  });

  it("reports a stop, not a failure, when the send fails because the tab went away or navigated", async () => {
    for (const ev of [{ type: "detached", reason: "target_closed" }, { type: "navigated" }] as BrowserEvent[]) {
      const s = manual(typed("abc"), "abc");
      const real = s.browser.send.bind(s.browser);
      s.browser.send = async (a) => {
        if (s.browser.sent.length === 2) {
          s.browser.fireEvent(ev);
          throw new Error("Debugger is not attached");
        }
        return real(a);
      };
      expect(await s.session.run()).toBe("stopped");
      expect(s.last()).toMatchObject(
        ev.type === "navigated"
          ? { phase: "stopped", reason: "navigated", message: "The page navigated or reloaded, so typing stopped." }
          : { phase: "stopped", reason: "detached", message: "The tab went away while typing." },
      );
      expect(s.browser.sent).toHaveLength(2);
    }
  });

  it("can't verify when the page can't be read after typing", async () => {
    for (const fail of [async () => null, async () => Promise.reject(new Error("Target closed"))]) {
      const s = manual(typed("ab"), "ab");
      const real = s.browser.probe.bind(s.browser);
      let done = false;
      (s.browser as Browser).probe = async () => (done ? fail() : real());
      s.browser.onSend = (n) => {
        if (n === 2) done = true;
      };
      expect(await s.session.run()).toBe("completed");
      expect(s.last().verification).toEqual({ status: "unreadable", detail: "Couldn't read the page after typing." });
      expect(s.browser.field.text()).toBe("ab");
    }
  });

  it("stops if the page navigates or Chrome detaches while paused", async () => {
    const cases: [BrowserEvent, string][] = [
      [{ type: "navigated" }, "navigated"],
      [{ type: "detached", reason: "canceled_by_user" }, "detached"],
    ];
    for (const [ev, reason] of cases) {
      const s = manual(typed("hello world"), "hello world");
      pauseAt(s, 4, () => s.clock.at(s.clock.t + 500, () => s.browser.fireEvent(ev)), null);
      expect(await s.session.run()).toBe("stopped");
      expect(s.last()).toMatchObject({ phase: "stopped", reason });
      expect(s.browser.sent).toHaveLength(4);
    }
  });

  it("can be stopped during the resume countdown", async () => {
    const s = manual(typed("hello world"), "hello world", { resumeCountdownMs: 3000 });
    const pausedAt = pauseAt(s, 4, () => {}, 1000);
    s.browser.onSend = ((orig) => (n: number) => {
      orig(n);
      if (n === 4) s.clock.at(pausedAt() + 2000, () => s.session.send("stop"));
    })(s.browser.onSend);
    expect(await s.session.run()).toBe("stopped");
    expect(s.phases().slice(-3)).toEqual(["paused", "resuming", "stopped"]);
    expect(s.last().reason).toBe("user");
    expect(s.browser.sent).toHaveLength(4);
  });

  it("can be stopped while waiting to get back to the original field", async () => {
    const s = manual(typed("hello world"), "hello world");
    pauseAt(s, 4, () => (s.browser.elementId = "el-2"), 1000);
    s.clock.at(8000, () => s.session.send("stop"));
    expect(await s.session.run()).toBe("stopped");
    expect(s.updates.some((u) => u.reason === "waiting-for-target")).toBe(true);
    expect(s.last()).toMatchObject({ phase: "stopped", reason: "user" });
    expect(s.browser.sent).toHaveLength(4);
  });

  it("stops after resuming if the page changed while paused", async () => {
    // A URL change (single-page app) while paused: found by the check after the resume countdown.
    const spa = manual(typed("hello world"), "hello world");
    pauseAt(spa, 4, () => (spa.browser.href = "https://example.com/elsewhere"), 1000);
    expect(await spa.session.run()).toBe("stopped");
    // An address change without a page load is a navigation, not a detach.
    expect(spa.last()).toMatchObject({ phase: "stopped", reason: "navigated", message: "The page navigated or the tab went away, so typing stopped." });
    expect(spa.browser.sent).toHaveLength(4);

    // A reload during the resume countdown.
    const nav = manual(typed("hello world"), "hello world", { resumeCountdownMs: 2000 });
    const pausedAt = pauseAt(nav, 4, () => {}, 1000);
    nav.browser.onSend = ((orig) => (n: number) => {
      orig(n);
      if (n === 4) nav.clock.at(pausedAt() + 1500, () => nav.browser.fireEvent({ type: "navigated" }));
    })(nav.browser.onSend);
    expect(await nav.session.run()).toBe("stopped");
    expect(nav.last()).toMatchObject({ phase: "stopped", reason: "navigated" });
    expect(nav.browser.sent).toHaveLength(4);
  });
});
