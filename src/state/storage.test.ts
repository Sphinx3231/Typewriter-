// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJSON, readString, removeKey, writeJSON, writeString } from "./storage";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const fail = (method: "getItem" | "setItem" | "removeItem") =>
  vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });

describe("storage", () => {
  it("round-trips JSON under the typewriter: prefix", () => {
    expect(writeJSON("prefs", { wpm: 80, tags: ["a"] })).toBe(true);
    expect(localStorage.getItem("typewriter:prefs")).toBe('{"wpm":80,"tags":["a"]}');
    expect(readJSON("prefs", null)).toEqual({ wpm: 80, tags: ["a"] });
  });

  it("returns the fallback for missing or corrupt JSON", () => {
    const fallback = { wpm: 60 };
    expect(readJSON("missing", fallback)).toBe(fallback);
    localStorage.setItem("typewriter:bad", "{not json");
    expect(readJSON("bad", fallback)).toBe(fallback);
  });

  it("stored JSON null is returned as null, not the fallback", () => {
    localStorage.setItem("typewriter:n", "null");
    expect(readJSON("n", "fallback")).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    fail("getItem");
    fail("setItem");
    fail("removeItem");
    expect(readJSON("prefs", 1)).toBe(1);
    expect(readString("theme")).toBeNull();
    expect(writeJSON("prefs", {})).toBe(false);
    expect(() => writeString("theme", "dark")).not.toThrow();
    expect(() => writeString("theme", null)).not.toThrow();
    expect(() => removeKey("theme")).not.toThrow();
  });

  it("writeJSON reports failure when the quota is full", () => {
    fail("setItem");
    expect(writeJSON("history", ["x"])).toBe(false);
  });

  it("writeJSON reports failure for values JSON can't encode", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(writeJSON("cyclic", cyclic)).toBe(false);
    expect(localStorage.getItem("typewriter:cyclic")).toBeNull();
  });

  it("reads, writes and removes strings", () => {
    expect(readString("theme")).toBeNull();
    writeString("theme", "dark");
    expect(localStorage.getItem("typewriter:theme")).toBe("dark");
    expect(readString("theme")).toBe("dark");
    writeString("theme", null);
    expect(readString("theme")).toBeNull();
    writeString("theme", "light");
    removeKey("theme");
    expect(localStorage.getItem("typewriter:theme")).toBeNull();
  });
});
