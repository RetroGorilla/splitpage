import { isDirRun, normalizeCell, projection } from "./runs.ts";
import type { CellInput, Run } from "./runs.ts";
import { clamp, deleteRange, explode, isDirChar, markThroughout, setMark } from "./edits.ts";
import type { CellEdit, CellRange, Char, TextChar } from "./edits.ts";

export type DirectionToggle = { from: number; to: number; off: boolean };

export const DIRECTION_MAX = 200;

export function directionRangeAt(cell: CellInput, pos: number): CellRange | null {
  const chars = explode(cell);
  pos = clamp(cell, pos);
  const at = isDirChar(chars[pos]) ? pos : isDirChar(chars[pos - 1]) ? pos - 1 : -1;
  if (at === -1) return null;
  let a = at, b = at + 1;
  while (a > 0 && isDirChar(chars[a - 1])) a--;
  while (b < chars.length && isDirChar(chars[b])) b++;
  return { from: a, to: b };
}

export function toggleDirection(cell: CellInput, from: number, to: number): Run[] {
  const r = directionToggleRange(cell, from, to);
  return setMark(cell, r.from, r.to, "dir", !r.off);
}

export function directionToggleRange(cell: CellInput, from: number, to: number): DirectionToggle {
  from = clamp(cell, from);
  to = clamp(cell, to);
  if (to < from) { const x = from; from = to; to = x; }
  if (markThroughout(cell, from, to, "dir")) return { from: from, to: to, off: true };
  const p = projection(cell);
  while (from < to && /\s/.test(p.charAt(from))) from++;
  while (to > from && /\s/.test(p.charAt(to - 1))) to--;
  return { from: from, to: to, off: false };
}

export function directionShortcut(cell: CellInput, pos: number): CellEdit | null {
  const chars = explode(cell);
  pos = clamp(cell, pos);
  const p = projection(cell);
  if (pos < 5 || p.slice(pos - 2, pos) !== "))") return null;
  const open = p.lastIndexOf("((", pos - 5);
  if (open === -1) return null;
  const inner = p.slice(open + 2, pos - 2);
  if (!inner.trim() || inner.length > DIRECTION_MAX || /[()\n￼]/.test(inner)) return null;
  for (let i = open; i < pos; i++) {
    const c = chars[i] as Char;
    if (c.atom || c.marks.dir) return null;
    if (c.marks.tag && (i < open + 2 || i >= pos - 2)) return null;
  }
  const lead = inner.length - inner.replace(/^\s+/, "").length;
  const trail = inner.length - inner.replace(/\s+$/, "").length;
  const next = deleteRange(deleteRange(cell, pos - 2, pos), open, open + 2);
  return { cell: setMark(next, open + lead, pos - 4 - trail, "dir", true), end: pos - 4 };
}

export function importDirections(cell: CellInput): Run[] {
  let out = normalizeCell(cell);
  const chars = explode(out);
  const drop: number[] = [];
  for (let i = 0; i < chars.length;) {
    if (!isDirChar(chars[i])) { i++; continue; }
    let j = i;
    while (j < chars.length && isDirChar(chars[j])) j++;
    const first = chars[i] as TextChar, last = chars[j - 1] as TextChar;
    if (j - i >= 3 && first.ch === "(" && last.ch === ")" &&
        !first.marks.tag && !last.marks.tag) drop.push(i, j - 1);
    i = j;
  }
  for (let d = drop.length - 1; d >= 0; d--) out = deleteRange(out, drop[d] as number, (drop[d] as number) + 1);
  for (let guard = 0; guard < 1000; guard++) {
    const p = projection(out);
    let done = true;
    const re = /\(\([^()\n￼]{1,200}\)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p)) !== null) {
      const got = directionShortcut(out, m.index + m[0].length);
      if (got) { out = got.cell; done = false; break; }
    }
    if (done) break;
  }
  return out;
}

export function flattenDirections(cell: CellInput): Run[] {
  const runs = normalizeCell(cell);
  if (!runs.some(isDirRun)) return runs;
  const out: Run[] = [];
  runs.forEach(function (r, i) {
    if (!isDirRun(r)) { out.push(r); return; }
    const m = Object.assign({}, r.marks);
    delete m.dir;
    const edge = Object.assign({}, m);
    delete edge.tag;
    if (!isDirRun(runs[i - 1])) out.push({ text: "(", marks: edge });
    out.push({ text: r.text, marks: m });
    if (!isDirRun(runs[i + 1])) out.push({ text: ")", marks: edge });
  });
  return normalizeCell(out);
}
