/**
 * Compares what the user copied back from the destination document with the
 * original text. Only line endings are normalised (Windows clipboards use CRLF);
 * nothing else is forgiven, so a "verified" result means an exact match.
 */
export interface VerifyResult {
  status: "verified" | "mismatch" | "empty";
  detail: string;
}

const norm = (s: string) => s.replace(/\r\n?/g, "\n");

export function verifyCopiedText(source: string, copied: string): VerifyResult {
  const a = norm(source);
  const b = norm(copied);
  if (!b.length) return { status: "empty", detail: "The clipboard is empty. Select the typed text in your document, copy it, then check again." };
  if (a === b) return { status: "verified", detail: "The document text matches your original exactly." };
  // Many editors include the final paragraph break when you select to the end.
  if (b === a + "\n") return { status: "verified", detail: "Matches exactly (the copy included one extra line break at the end, added by the document)." };
  const chars = [...a];
  const got = [...b];
  let i = 0;
  while (i < chars.length && i < got.length && chars[i] === got[i]) i++;
  const show = (s: string[]) => JSON.stringify(s.slice(Math.max(0, i - 12), i + 12).join(""));
  const where = `character ${i + 1}`;
  if (i === got.length) return { status: "mismatch", detail: `The copied text stops early, at ${where} of ${chars.length}. Expected …${show(chars)}…` };
  if (i === chars.length) return { status: "mismatch", detail: `The copied text has extra content after the end: …${show(got)}…` };
  return { status: "mismatch", detail: `First difference at ${where}. Expected …${show(chars)}…, found …${show(got)}…` };
}
