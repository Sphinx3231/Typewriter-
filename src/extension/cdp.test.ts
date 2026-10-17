// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { commandsFor, PROBE_SCRIPT } from "./cdp";
import type { FocusProbe } from "./session";

describe("commandsFor", () => {
  it("sends printable ASCII as a full keyDown/keyUp press carrying the character", () => {
    expect(commandsFor({ kind: "text", text: "a" })).toEqual([
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a", text: "a", unmodifiedText: "a" } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a" } },
    ]);
    // Both ends of the printable range are key presses.
    for (const ch of [" ", "~", "$", "<"]) {
      const cmds = commandsFor({ kind: "text", text: ch });
      expect(cmds.map((c) => c.params.type)).toEqual(["keyDown", "keyUp"]);
      expect(cmds[0].params.text).toBe(ch);
    }
  });

  it("inserts anything outside printable ASCII as composed text, never as code", () => {
    for (const text of ["é", "ö", "日", "👍🏽", "👨‍👩‍👧", "\u007f", "\u001f", "ab", "$(rm -rf /)"]) {
      expect(commandsFor({ kind: "text", text })).toEqual([{ method: "Input.insertText", params: { text } }]);
    }
  });

  it("inserts a tab character instead of pressing Tab (which would move focus)", () => {
    expect(commandsFor({ kind: "tab" })).toEqual([{ method: "Input.insertText", params: { text: "\t" } }]);
  });

  it("presses Enter with a carriage return so editors create a new line", () => {
    const [down, up] = commandsFor({ kind: "enter" });
    expect(down).toEqual({
      method: "Input.dispatchKeyEvent",
      params: { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" },
    });
    expect(up).toEqual({ method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } });
  });

  it("sends Backspace and arrow keys as raw key presses with their virtual key codes", () => {
    const cases = [
      ["backspace", "Backspace", 8],
      ["left", "ArrowLeft", 37],
      ["right", "ArrowRight", 39],
    ] as const;
    for (const [kind, key, code] of cases) {
      const cmds = commandsFor({ kind });
      expect(cmds).toHaveLength(2);
      expect(cmds[0].params).toMatchObject({ type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      expect(cmds[1].params).toMatchObject({ type: "keyUp", key, windowsVirtualKeyCode: code });
      // Non-printing keys carry no text.
      expect(cmds[0].params.text).toBeUndefined();
    }
  });
});

describe("PROBE_SCRIPT (run in a page)", () => {
  const probe = () => (0, eval)(PROBE_SCRIPT) as FocusProbe;
  const visible = (el: Element) => {
    el.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
  };
  const editable = (el: HTMLElement, text?: string) => {
    Object.defineProperty(el, "isContentEditable", { value: true, configurable: true });
    if (text !== undefined) Object.defineProperty(el, "innerText", { value: text, configurable: true });
  };

  afterEach(() => {
    document.body.innerHTML = "";
    document.title = "";
  });

  it("describes a focused, visible text input with its text and selection", () => {
    document.title = "Form";
    document.body.innerHTML = '<input id="f" value="hello">';
    const el = document.getElementById("f") as HTMLInputElement;
    visible(el);
    el.focus();
    el.setSelectionRange(2, 4);
    const p = probe();
    expect(p).toMatchObject({ title: "Form", kind: "input", editable: true, sensitive: null, text: "hello", selStart: 2, selEnd: 4 });
    expect(p.href).toBe(location.href);
    expect(typeof p.elementId).toBe("string");
    // The same element keeps the same id, so a change of focus can be told apart.
    expect(probe().elementId).toBe(p.elementId);
  });

  it("gives a different element a different id", () => {
    document.body.innerHTML = '<textarea id="a"></textarea><textarea id="b"></textarea>';
    const a = document.getElementById("a") as HTMLTextAreaElement;
    const b = document.getElementById("b") as HTMLTextAreaElement;
    visible(a);
    visible(b);
    a.focus();
    const first = probe();
    b.focus();
    const second = probe();
    expect(first.kind).toBe("textarea");
    expect(first.editable).toBe(true);
    expect(second.elementId).not.toBe(first.elementId);
  });

  it("flags password, hidden and payment/one-time-code fields as sensitive", () => {
    document.body.innerHTML = '<input id="pw" type="password"><input id="otp" autocomplete="one-time-code"><input id="cc" autocomplete="cc-number">';
    for (const id of ["pw", "otp", "cc"]) {
      const el = document.getElementById(id) as HTMLInputElement;
      visible(el);
      el.focus();
      expect(probe().sensitive).toMatch(/password|payment/);
    }
    // jsdom can't focus a hidden input, so check that branch via a stand-in activeElement.
    const hidden = document.createElement("input");
    hidden.setAttribute("type", "hidden");
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement")!;
    Object.defineProperty(document, "activeElement", { get: () => hidden, configurable: true });
    try {
      expect(probe().sensitive).toBe("This is a hidden field.");
    } finally {
      Object.defineProperty(document, "activeElement", desc);
      delete (document as unknown as Record<string, unknown>).activeElement;
    }
  });

  it("treats invisible or zero-size fields as hidden, and read-only or non-text inputs as not editable", () => {
    document.body.innerHTML = '<textarea id="t"></textarea><input id="r" readonly><input id="n" type="number">';
    const t = document.getElementById("t") as HTMLTextAreaElement;
    t.focus(); // jsdom reports a 0x0 box
    expect(probe().sensitive).toBe("The focused field is hidden.");
    visible(t);
    t.style.visibility = "hidden";
    expect(probe().sensitive).toBe("The focused field is hidden.");
    t.style.visibility = "";
    expect(probe().sensitive).toBeNull();

    const r = document.getElementById("r") as HTMLInputElement;
    visible(r);
    r.focus();
    expect(probe()).toMatchObject({ kind: "input", editable: false });
    const n = document.getElementById("n") as HTMLInputElement;
    visible(n);
    n.focus();
    expect(probe()).toMatchObject({ kind: "input", editable: false });
  });

  it("reads a rich editor's text from its outermost editable ancestor", () => {
    document.body.innerHTML = '<div id="root"><p id="inner" tabindex="0">x</p></div>';
    const root = document.getElementById("root")!;
    const inner = document.getElementById("inner")!;
    editable(root, "Whole document");
    editable(inner, "x");
    inner.focus();
    expect(probe()).toMatchObject({ kind: "contenteditable", editable: true, text: "Whole document", selStart: null, selEnd: null });
  });

  it("reports nothing editable when only the page body has focus", () => {
    const p = probe();
    expect(p).toMatchObject({ kind: "none", editable: false, sensitive: null, text: null, elementId: null });
    // A contenteditable body gets the fixed id "body".
    editable(document.body);
    expect(probe()).toMatchObject({ kind: "contenteditable", elementId: "body" });
    delete (document.body as unknown as Record<string, unknown>).isContentEditable;
  });

  it("looks through same-origin iframes and shadow roots to the real focused field", () => {
    document.body.innerHTML = '<iframe id="fr"></iframe><div id="host"></div>';
    const frame = document.getElementById("fr") as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<textarea id="inside">framed</textarea>';
    const inside = doc.getElementById("inside") as HTMLTextAreaElement;
    visible(inside);
    frame.focus();
    inside.focus();
    expect(probe()).toMatchObject({ kind: "textarea", text: "framed" });

    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<input id="sh" value="shadowed">';
    const sh = shadow.getElementById("sh") as HTMLInputElement;
    visible(sh);
    sh.focus();
    expect(probe()).toMatchObject({ kind: "input", text: "shadowed" });
  });
});
