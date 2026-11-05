import { withoutLoneSurrogates } from "../document/text-policy.ts";
import type { Run } from "./runs.ts";

type SearchPiece = { start: number; text: string };
type TaggedPiece = SearchPiece & { tag: string };
type SearchPieces = { free: SearchPiece[]; tagged: TaggedPiece[] };

function escapeRegExpLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findAllMatches(text: string, needle: string, matchCase: boolean) {
  needle = withoutLoneSurrogates(needle);
  if (!needle) return [];
  const re = new RegExp(escapeRegExpLiteral(needle), matchCase ? "g" : "gi");
  const out: { start: number; end: number }[] = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

export function searchablePieces(cell: readonly Run[]) {
  const free: SearchPiece[] = [], tagged: TaggedPiece[] = [];
  let pos = 0, cur: SearchPiece | null = null, curTag: TaggedPiece | null = null;
  cell.forEach(function (r) {
    if (r.atom) { cur = null; curTag = null; pos += 1; return; }
    const tag = r.marks.tag;
    if (tag) {
      cur = null;
      if (curTag && curTag.tag === tag) curTag.text += r.text;
      else tagged.push(curTag = { tag: tag, start: pos, text: r.text });
    } else {
      curTag = null;
      if (cur) cur.text += r.text;
      else free.push(cur = { start: pos, text: r.text });
    }
    pos += r.text.length;
  });
  return { free: free, tagged: tagged };
}

export function findInCell(cell: readonly Run[], needle: string, matchCase: boolean) {
  if (!needle) return [];
  return matchesInPieces(searchablePieces(cell), needle, matchCase);
}

export function matchesInPieces(pieces: SearchPieces, needle: string, matchCase: boolean) {
  const out: { from: number; to: number }[] = [];
  pieces.free.forEach(function (p) {
    findAllMatches(p.text, needle, matchCase).forEach(function (m) {
      out.push({ from: p.start + m.start, to: p.start + m.end });
    });
  });
  return out;
}

export function countInTags(cell: readonly Run[], needle: string, matchCase: boolean) {
  if (!needle) return 0;
  return countInPieces(searchablePieces(cell), needle, matchCase);
}

export function countInPieces(pieces: SearchPieces, needle: string, matchCase: boolean) {
  return pieces.tagged.reduce(function (n, p) {
    return n + findAllMatches(p.text, needle, matchCase).length;
  }, 0);
}
