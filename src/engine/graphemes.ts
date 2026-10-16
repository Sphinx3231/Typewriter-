/**
 * Splits text into user-perceived characters (grapheme clusters) so emoji,
 * combining marks and surrogate pairs are never cut in half.
 */
type SegmenterLike = { segment(input: string): Iterable<{ segment: string }> };

const segmenter: SegmenterLike | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new (Intl as unknown as { Segmenter: new (l?: string, o?: { granularity: string }) => SegmenterLike }).Segmenter(undefined, {
        granularity: "grapheme",
      })
    : null;

export function toGraphemes(text: string): string[] {
  if (!text) return [];
  if (!segmenter) return Array.from(text);
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

const LETTER = /^\p{L}[\p{M}]*$/u;
const WORDISH = /^[\p{L}\p{N}\p{M}'’_-]+$/u;

/** A single letter (optionally with combining marks). */
export function isLetter(g: string): boolean {
  return LETTER.test(g);
}

/** Part of a word for typing purposes: letters, digits, apostrophes, hyphens. */
export function isWordChar(g: string): boolean {
  return WORDISH.test(g);
}

export function isWhitespace(g: string): boolean {
  return /^\s+$/u.test(g);
}

export function hasCase(g: string): boolean {
  return g.toLowerCase() !== g.toUpperCase();
}
