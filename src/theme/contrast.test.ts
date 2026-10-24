/// <reference types="node" />
/**
 * WCAG contrast for every text/background pairing the UI uses, in both themes,
 * computed from the real tokens.css (not a copy of the values).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const light = block(":root");
const dark = { ...light, ...block(':root[data-theme="dark"]') };

type RGBA = [number, number, number, number];
function parse(v: string): RGBA {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgba = v.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/);
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3], rgba[4] === undefined ? 1 : +rgba[4]];
  throw new Error(`unsupported color ${v}`);
}
/** Composite a (possibly translucent) color over an opaque one. */
function over(top: RGBA, under: RGBA): RGBA {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1) as RGBA;
}
function luminance([r, g, b]: RGBA) {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(theme: Record<string, string>, fg: string, bg: string, base = "surface") {
  const ground = parse(theme[base]);
  const b = over(parse(theme[bg]), ground);
  const f = over(parse(theme[fg]), b);
  const [l1, l2] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const TEXT_ON_SURFACES = ["text", "text-muted", "text-subtle", "primary-text", "accent-text", "danger-text", "success", "warning"];
const SURFACES = ["surface", "surface-2", "surface-3", "bg", "paper"];
// Text drawn on tinted chips and callouts.
const ON_SOFT: [string, string][] = [
  ["primary-text", "primary-soft"],
  ["accent-text", "accent-soft"],
  ["danger-text", "danger-soft"],
  ["text", "primary-soft"],
  ["success", "success-soft"],
  ["warning", "warning-soft"],
];
// Non-text UI: progress, focus, caret, the brand button fill (WCAG 1.4.11, 3:1).
const NON_TEXT: [string, string][] = [
  ["primary", "surface"],
  ["accent", "surface"],
  ["caret", "paper"],
  ["primary-fill", "surface"],
];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme contrast", (_name, theme) => {
  it.each(TEXT_ON_SURFACES.flatMap((t) => SURFACES.map((s) => [t, s])))("%s on %s ≥ 4.5:1", (fg, bg) => {
    expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(ON_SOFT)("%s on %s ≥ 4.5:1", (fg, bg) => {
    expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["primary-fill", "primary-hover", "primary-active", "danger-fill", "danger-fill-hover"])("button text on %s ≥ 4.5:1", (fill) => {
    expect(ratio(theme, "on-primary", fill)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(NON_TEXT)("%s against %s ≥ 3:1", (fg, bg) => {
    expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(3);
  });
});

// Writing analysis highlights: text inside a highlight, on every surface the panel sits on,
// and the underline and box lines as non-text marks.
describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme: Studio highlights", (_name, theme) => {
  it.each(["surface", "surface-2", "paper"])("highlighted text is readable on %s (≥ 4.5:1)", (base) => {
    expect(ratio(theme, "diff-add-text", "diff-add-bg", base)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(theme, "diff-del-text", "diff-del-bg", base)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(theme, "text", "diff-add-bg", base)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["diff-add-line", "diff-del-line", "diff-fmt-line", "diff-selected"])("%s stands out from the surface (≥ 3:1)", (line) => {
    expect(ratio(theme, line, "surface")).toBeGreaterThanOrEqual(3);
    expect(ratio(theme, line, "surface-2")).toBeGreaterThanOrEqual(3);
  });
  it("added and removed use different hues from the theme's own palette", () => {
    expect(theme["diff-add-line"]).not.toBe(theme["diff-del-line"]);
  });
});

describe("palette identity", () => {
  it("light theme is white, purple and blue", () => {
    expect(light.surface).toBe("#ffffff");
    const [r, g, b] = parse(light.primary);
    expect(b > g && r > g).toBe(true); // purple
    const [ar, ag, ab] = parse(light.accent);
    expect(ab > ag && ag > ar).toBe(true); // blue: blue-dominant, not cyan (green ≈ blue)
    expect(ab - ag).toBeGreaterThan(100);
  });
  it("dark theme is black, red and orange", () => {
    expect(luminance(parse(dark.bg))).toBeLessThan(0.01);
    const [r, g, b] = parse(dark.primary);
    expect(r > 200 && g < 100 && b < 100).toBe(true); // red
    const [ar, ag, ab] = parse(dark.accent);
    expect(ar > 200 && ag > 80 && ag < 160 && ab < 60).toBe(true); // orange
  });
});
