/**
 * Chrome DevTools Protocol pieces used through chrome.debugger.
 *
 * Why the debugger API: Google Docs (and many rich editors) ignore untrusted,
 * script-dispatched key events and keep their text off the DOM. Input events
 * sent through the DevTools Protocol are trusted, exactly like real typing,
 * and only ever reach the one tab Typewriter is attached to.
 */
import type { KeyAction } from "../engine";

type Params = Record<string, unknown>;
export type Command = { method: string; params: Params };

const NAMED: Record<"enter" | "backspace" | "left" | "right", Params> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
};

/** The protocol commands that type one key action. The text is passed as data only. */
export function commandsFor(a: KeyAction): Command[] {
  switch (a.kind) {
    case "text": {
      // Printable ASCII goes as a full key press (keydown, keypress/input, keyup), like a keyboard.
      // Anything else (accents, CJK, emoji, combining sequences) is inserted as composed text.
      if (a.text.length === 1 && a.text >= " " && a.text <= "~") {
        return [
          { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: a.text, text: a.text, unmodifiedText: a.text } },
          { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: a.text } },
        ];
      }
      return [{ method: "Input.insertText", params: { text: a.text } }];
    }
    case "tab":
      // A Tab key press would move focus out of plain fields; insert the character instead.
      return [{ method: "Input.insertText", params: { text: "\t" } }];
    case "enter":
      return [
        { method: "Input.dispatchKeyEvent", params: { type: "keyDown", ...NAMED.enter } },
        { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } },
      ];
    default: {
      const k = NAMED[a.kind];
      return [
        { method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", ...k } },
        { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...k } },
      ];
    }
  }
}

/**
 * Fixed inspection script run in the page: describes the focused element. It
 * looks through same-origin iframes (Google Docs takes keyboard input in one) and
 * shadow roots. It reads text only from the focused field, to verify the result.
 */
export const PROBE_SCRIPT = `(() => {
  let el = document.activeElement;
  for (let i = 0; i < 6 && el && el.tagName === "IFRAME"; i++) {
    let d = null;
    try { d = el.contentDocument; } catch (e) { d = null; }
    if (!d) break;
    el = d.activeElement;
  }
  for (let i = 0; i < 6 && el && el.shadowRoot && el.shadowRoot.activeElement; i++) el = el.shadowRoot.activeElement;
  const tag = el ? el.tagName : "";
  let kind = "none", editable = false, sensitive = null, text = null, selStart = null, selEnd = null;
  if (el && tag === "TEXTAREA") {
    kind = "textarea";
    editable = !el.readOnly && !el.disabled;
  } else if (el && tag === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    kind = "input";
    if (t === "password") sensitive = "This is a password field.";
    else if (t === "hidden") sensitive = "This is a hidden field.";
    editable = ["text", "search", "url", "email", "tel"].includes(t) && !el.readOnly && !el.disabled;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/password|one-time-code|cc-number|cc-csc|cc-exp/.test(ac)) sensitive = "This field is marked for passwords or payment details.";
  } else if (el && el.isContentEditable) {
    kind = "contenteditable";
    editable = true;
  }
  if (el && (kind === "input" || kind === "textarea") && !sensitive) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || r.width < 2 || r.height < 2) sensitive = "The focused field is hidden.";
  }
  if (kind === "input" || kind === "textarea") {
    text = el.value; selStart = el.selectionStart; selEnd = el.selectionEnd;
  } else if (kind === "contenteditable" && location.hostname !== "docs.google.com") {
    let h = el;
    while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
    text = h.innerText;
  }
  let id = null;
  if (el && el !== document.body) {
    if (!el.__typewriterId) {
      try { Object.defineProperty(el, "__typewriterId", { value: Math.random().toString(36).slice(2), enumerable: false }); } catch (e) {}
    }
    id = el.__typewriterId || null;
  } else if (el && el.isContentEditable) {
    id = "body";
  }
  return { href: location.href, title: document.title, elementId: id, kind, editable, sensitive, text, selStart, selEnd };
})()`;
