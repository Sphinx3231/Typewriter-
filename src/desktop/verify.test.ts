import { describe, expect, it } from "vitest";
import { verifyCopiedText } from "./verify";

describe("verifyCopiedText", () => {
  it("asks for a copy when the clipboard is empty", () => {
    const r = verifyCopiedText("hello", "");
    expect(r.status).toBe("empty");
    expect(r.detail).toMatch(/clipboard is empty/);
  });

  it("verifies an exact match", () => {
    expect(verifyCopiedText("Hello, world.", "Hello, world.")).toEqual({
      status: "verified",
      detail: "The document text matches your original exactly.",
    });
  });

  it("treats CRLF, CR and LF line endings as equal, but nothing else", () => {
    expect(verifyCopiedText("a\nb\nc", "a\r\nb\rc").status).toBe("verified");
    expect(verifyCopiedText("a\r\nb", "a\nb").status).toBe("verified");
    expect(verifyCopiedText("a b", "a  b").status).toBe("mismatch");
    expect(verifyCopiedText("Café", "Cafe").status).toBe("mismatch");
  });

  it("accepts exactly one trailing line break added by the document", () => {
    const r = verifyCopiedText("line", "line\r\n");
    expect(r.status).toBe("verified");
    expect(r.detail).toMatch(/one extra line break/);
    const two = verifyCopiedText("line", "line\n\n");
    expect(two.status).toBe("mismatch");
    expect(two.detail).toBe('The copied text has extra content after the end: …"line\\n\\n"…');
  });

  it("reports where a copy stops early", () => {
    const r = verifyCopiedText("abcdef", "abc");
    expect(r).toEqual({ status: "mismatch", detail: 'The copied text stops early, at character 4 of 6. Expected …"abcdef"…' });
  });

  it("reports extra content after the end", () => {
    const r = verifyCopiedText("abc", "abc!!");
    expect(r).toEqual({ status: "mismatch", detail: 'The copied text has extra content after the end: …"abc!!"…' });
    expect(verifyCopiedText("", "x").detail).toBe('The copied text has extra content after the end: …"x"…');
  });

  it("reports the first difference with context around it", () => {
    const source = "The quick brown fox jumps over the lazy dog and keeps running far away.";
    const copied = source.replace("lazy", "LAZY");
    const r = verifyCopiedText(source, copied);
    const i = source.indexOf("lazy");
    expect(r.status).toBe("mismatch");
    expect(r.detail).toBe(
      `First difference at character ${i + 1}. Expected …${JSON.stringify(source.slice(i - 12, i + 12))}…, found …${JSON.stringify(copied.slice(i - 12, i + 12))}…`,
    );
  });

  it("counts positions in code points so emoji count as one character", () => {
    const r = verifyCopiedText("😀😀x", "😀😀y");
    expect(r.detail).toMatch(/^First difference at character 3\./);
  });
});
