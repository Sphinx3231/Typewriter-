import { toGraphemes } from "./graphemes";

export interface TextStats {
  characters: number;
  charactersNoSpaces: number;
  words: number;
  lines: number;
  paragraphs: number;
}

export const EMPTY_STATS: TextStats = { characters: 0, charactersNoSpaces: 0, words: 0, lines: 0, paragraphs: 0 };

export function computeStats(text: string, graphemes: string[] = toGraphemes(text)): TextStats {
  if (!text) return EMPTY_STATS;
  let nonSpace = 0;
  for (const g of graphemes) if (!/^\s+$/u.test(g)) nonSpace++;
  const words = text.match(/\S+/gu)?.length ?? 0;
  const lines = text.split("\n").length;
  const paragraphs = text.split(/\n[^\S\n]*\n/u).filter((p) => p.trim().length > 0).length;
  return { characters: graphemes.length, charactersNoSpaces: nonSpace, words, lines, paragraphs };
}

/** True when the text has nothing to type (empty or whitespace only). */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}
