import type { Rng } from "./rng";

/** QWERTY neighbours, used for plausible "fat finger" typos. */
const ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
const OFFSETS = [0, 0.5, 0.75, 1.25];

const NEIGHBOURS: Record<string, string[]> = (() => {
  const pos: Record<string, [number, number]> = {};
  ROWS.forEach((row, r) => [...row].forEach((ch, c) => (pos[ch] = [r, c + OFFSETS[r]])));
  const map: Record<string, string[]> = {};
  for (const a of Object.keys(pos)) {
    map[a] = Object.keys(pos).filter((b) => {
      if (a === b) return false;
      const [ra, ca] = pos[a];
      const [rb, cb] = pos[b];
      return Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1.01;
    });
  }
  return map;
})();

/** A key next to `ch` on a QWERTY layout, keeping its case; null if `ch` isn't on the layout. */
export function adjacentKey(ch: string, rng: Rng): string | null {
  const lower = ch.toLowerCase();
  const options = NEIGHBOURS[lower]?.filter((k) => /[a-z]/.test(k) === /[a-z]/.test(lower));
  if (!options || options.length === 0) return null;
  const k = rng.pick(options);
  return ch === lower ? k : k.toUpperCase();
}

/** Punctuation that is easy to hit by mistake instead of the intended mark. */
export const PUNCTUATION_SLIPS: Record<string, string[]> = {
  ",": ["."],
  ".": [","],
  ";": [":", "'"],
  ":": [";"],
  "?": ["/"],
  "!": ["1"],
};
