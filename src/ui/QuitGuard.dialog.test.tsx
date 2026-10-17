// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackStatus } from "../engine";
import type { Session } from "../state/useSession";
import { QuitGuard } from "./QuitGuard";

type CloseEvent = { preventDefault: () => void };

const tauri = vi.hoisted(() => {
  const state = {
    handler: null as ((e: { preventDefault: () => void }) => void) | null,
    unlisten: (() => {}) as () => void,
    /** Lets a test hold the registration back (resolve later). */
    gate: null as Promise<void> | null,
    invoke: (async () => undefined) as (cmd: string) => Promise<unknown>,
    destroy: (async () => undefined) as () => Promise<void>,
    log: [] as string[],
  };
  return state;
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (fn: (e: CloseEvent) => void) => {
      if (tauri.gate) await tauri.gate;
      tauri.handler = fn;
      return () => tauri.unlisten();
    },
    destroy: () => tauri.destroy(),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => tauri.invoke(cmd) }));

beforeAll(() => {
  // jsdom has <dialog> but not its modal methods.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

let invoke: ReturnType<typeof vi.fn>;
let destroy: ReturnType<typeof vi.fn>;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  tauri.handler = null;
  tauri.gate = null;
  tauri.log = [];
  invoke = vi.fn(async (cmd: string) => {
    tauri.log.push(`invoke:${cmd}`);
  });
  destroy = vi.fn(async () => {
    tauri.log.push("destroy");
  });
  unlisten = vi.fn();
  tauri.invoke = invoke as unknown as typeof tauri.invoke;
  tauri.destroy = destroy as unknown as typeof tauri.destroy;
  tauri.unlisten = unlisten as unknown as typeof tauri.unlisten;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeSession(o: { text?: string; rememberText?: boolean; status?: PlaybackStatus; external?: boolean } = {}) {
  const stop = vi.fn(() => {
    tauri.log.push("stop");
    return true;
  });
  const session = {
    text: o.text ?? "",
    prefs: { rememberText: o.rememberText ?? false, theme: "system" },
    snapshot: { status: o.status ?? "empty", external: o.external ? { phase: "typing" } : null },
    stop,
  } as unknown as Session;
  return { session, stop };
}

async function mount(session: Session) {
  const view = render(<QuitGuard session={session} />);
  await waitFor(() => expect(tauri.handler).not.toBeNull());
  return view;
}

/** Simulates the user closing the window; returns whether the close was prevented. */
async function requestClose() {
  const preventDefault = vi.fn();
  await act(async () => {
    tauri.handler!({ preventDefault });
    await Promise.resolve();
  });
  return preventDefault;
}

const dialog = () => screen.getByTestId("quit-dialog") as HTMLDialogElement;

describe("QuitGuard (desktop close protection)", () => {
  it("answers every close request and lets the window close when nothing would be lost", async () => {
    const { session } = makeSession({ text: "kept", rememberText: true, status: "completed" });
    await mount(session);
    const prevent = await requestClose();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("close_answered"));
    expect(prevent).not.toHaveBeenCalled();
    expect(dialog().open).toBe(false);
    expect(destroy).not.toHaveBeenCalled();

    // A second close request is answered too.
    await requestClose();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  it("still handles the close when telling the app it is alive fails", async () => {
    tauri.invoke = vi.fn(async () => {
      throw new Error("no app");
    });
    const { session } = makeSession({ text: "essay", status: "ready" });
    await mount(session);
    const prevent = await requestClose();
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(true);
  });

  it("asks about unsaved text only, offering to save it", async () => {
    const { session } = makeSession({ text: "my essay", status: "ready" });
    await mount(session);
    const prevent = await requestClose();
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(true);
    expect(screen.getByRole("heading", { name: /Quit Typewriter\?/ })).toBeTruthy();
    expect(screen.getByTestId("quit-unsaved").textContent).toMatch(/isn't saved on this computer/);
    expect(screen.queryByTestId("quit-running")).toBeNull();
    expect(screen.getByTestId("quit-save").textContent).toBe("Save text and quit");
    expect(screen.getByTestId("quit-confirm").textContent).toBe("Quit without saving");
    expect(screen.getByTestId("quit-keep").textContent).toBe("Keep Typewriter open");
  });

  it("asks about a running preview session (text remembered): plain Quit, no save option", async () => {
    const { session } = makeSession({ text: "x", rememberText: true, status: "playing" });
    await mount(session);
    await requestClose();
    expect(screen.getByTestId("quit-running").textContent).toBe("A session is still playing. Quitting stops it.");
    expect(screen.queryByTestId("quit-unsaved")).toBeNull();
    expect(screen.queryByTestId("quit-save")).toBeNull();
    expect(screen.getByTestId("quit-confirm").textContent).toBe("Quit");
  });

  it("explains that typing into another app stops, and shows both warnings when text is also unsaved", async () => {
    const { session } = makeSession({ text: "x", status: "paused", external: true });
    await mount(session);
    await requestClose();
    expect(screen.getByTestId("quit-running").textContent).toMatch(/Typing into another app is still in progress/);
    expect(screen.getByTestId("quit-running").textContent).toMatch(/keys already typed stay in your document/);
    expect(screen.getByTestId("quit-unsaved")).toBeTruthy();
    expect(screen.getByTestId("quit-save")).toBeTruthy();
  });

  it("Keep closes the dialog, keeps the window and text, and stores nothing", async () => {
    const { session, stop } = makeSession({ text: "my essay", status: "playing" });
    await mount(session);
    await requestClose();
    expect(dialog().open).toBe(true);
    fireEvent.click(screen.getByTestId("quit-keep"));
    expect(dialog().open).toBe(false);
    expect(screen.queryByTestId("quit-unsaved")).toBeNull();
    expect(destroy).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(localStorage.getItem("typewriter:text")).toBeNull();
    expect(session.text).toBe("my essay");

    // Asking again opens the dialog again.
    await requestClose();
    expect(dialog().open).toBe(true);
  });

  it("Escape (the dialog's cancel) behaves like Keep", async () => {
    const { session } = makeSession({ text: "my essay", status: "ready" });
    await mount(session);
    await requestClose();
    fireEvent(dialog(), new Event("cancel"));
    expect(dialog().open).toBe(false);
    expect(screen.queryByTestId("quit-save")).toBeNull();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("Save text and quit writes the text and turns on Remember my text before destroying the window", async () => {
    const { session, stop } = makeSession({ text: "my essay\nline 2", status: "ready" });
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      tauri.log.push(`store:${k}`);
      setItem.call(this, k, v);
    });
    await mount(session);
    await requestClose();
    fireEvent.click(screen.getByTestId("quit-save"));
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(stop).not.toHaveBeenCalled();
    expect(localStorage.getItem("typewriter:text")).toBe("my essay\nline 2");
    expect(JSON.parse(localStorage.getItem("typewriter:prefs")!)).toEqual({ rememberText: true, theme: "system" });
    // Storage is written before the window goes away.
    expect(tauri.log.filter((x) => !x.startsWith("invoke"))).toEqual(["store:typewriter:prefs", "store:typewriter:text", "destroy"]);
  });

  it("Quit without saving stops a running session first, stores nothing, then destroys the window", async () => {
    const { session, stop } = makeSession({ text: "my essay", status: "playing", external: true });
    await mount(session);
    await requestClose();
    fireEvent.click(screen.getByTestId("quit-confirm"));
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(tauri.log.filter((x) => !x.startsWith("invoke"))).toEqual(["stop", "destroy"]);
    expect(localStorage.getItem("typewriter:text")).toBeNull();
    expect(localStorage.getItem("typewriter:prefs")).toBeNull();
  });

  it("Save and quit during a paused session saves, stops, then destroys", async () => {
    const { session, stop } = makeSession({ text: "draft", status: "paused" });
    await mount(session);
    await requestClose();
    fireEvent.click(screen.getByTestId("quit-save"));
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("typewriter:text")).toBe("draft");
    expect(tauri.log.filter((x) => !x.startsWith("invoke"))).toEqual(["stop", "destroy"]);
  });

  it("uses the latest session state at close time, not the one it was mounted with", async () => {
    const empty = makeSession({ text: "", status: "empty" });
    const view = await mount(empty.session);
    const typed = makeSession({ text: "now there is text", status: "ready" });
    view.rerender(<QuitGuard session={typed.session} />);
    const prevent = await requestClose();
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("quit-unsaved")).toBeTruthy();
  });

  it("a second close request while the dialog is open doesn't reopen it", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const { session } = makeSession({ text: "my essay", status: "ready" });
    await mount(session);
    await requestClose();
    await requestClose();
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(true);
  });

  it("unregisters the close handler on unmount", async () => {
    const { session } = makeSession({ text: "x", status: "ready" });
    const view = await mount(session);
    expect(unlisten).not.toHaveBeenCalled();
    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unmounting before the handler is registered unregisters it as soon as it is", async () => {
    let release: () => void = () => {};
    tauri.gate = new Promise<void>((r) => (release = r));
    const { session } = makeSession({ text: "x", status: "ready" });
    const view = render(<QuitGuard session={session} />);
    view.unmount();
    expect(unlisten).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});
