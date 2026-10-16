import { CUE_LINE_RE, cellLength, isCueRun, normalizeCell, projection } from "./runs.ts";
import type { CellInput, Run } from "./runs.ts";
import { clamp, deleteRange, insertText, replaceText, setMark } from "./edits.ts";
import type { CellRange } from "./edits.ts";

export type CueLine = { from: number; to: number; cue: boolean };

export type Cue = { kind: string; name: string; text: string };

const CUE_TYPED_RE = /^[ \t\u00a0]*(sfx|music)[ \t\u00a0]*:$/i;

export function cueLines(cell: CellInput): CueLine[] {
  const runs = normalizeCell(cell);
  const lines: CueLine[] = [{ from: 0, to: 0, cue: false }];
  let pos = 0;
  runs.forEach(function (r) {
    if (r.atom) { pos++; (lines[lines.length - 1] as CueLine).to = pos; return; }
    const parts = r.text.split("\n");
    parts.forEach(function (part, i) {
      if (i > 0) { pos++; lines.push({ from: pos, to: pos, cue: false }); }
      pos += part.length;
      (lines[lines.length - 1] as CueLine).to = pos;
      if (part && r.marks.cue) (lines[lines.length - 1] as CueLine).cue = true;
    });
  });
  return lines;
}

function cueNameSpans(runs: readonly Run[], from: number, to: number): CellRange[] {
  const other: boolean[] = [];
  runs.forEach(function (r) {
    if (r.atom) { other.push(true); return; }
    const inOther = !!(r.marks.tag || r.marks.dir);
    for (let i = 0; i < r.text.length; i++) other.push(inOther);
  });
  const p = projection(runs);
  const spans: CellRange[] = [];
  let at = -1;
  for (let i = from; i <= to; i++) {
    const plain = i < to && !other[i];
    if (plain && at === -1) at = i;
    if (!plain && at !== -1) {
      let s = at, e = i;
      while (s < e && /[\s\u00a0]/.test(p.charAt(s))) s++;
      while (e > s && /[\s\u00a0]/.test(p.charAt(e - 1))) e--;
      if (e > s) spans.push({ from: s, to: e });
      at = -1;
    }
  }
  return spans;
}

function cueNameOf(p: string, spans: readonly CellRange[]): string {
  return spans.map(function (s) { return p.slice(s.from, s.to); }).join(" ")
    .replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function cuesInCell(cell: CellInput): Cue[] {
  const runs = normalizeCell(cell);
  if (!runs.some(isCueRun)) return [];
  const p = projection(runs);
  const out: Cue[] = [];
  cueLines(runs).forEach(function (l) {
    if (!l.cue) return;
    const line = p.slice(l.from, l.to).replace(/\u00a0/g, " ");
    const m = CUE_LINE_RE.exec(line);
    if (!m) return;
    out.push({
      kind: (m[1] as string).toLowerCase(),
      name: cueNameOf(p, cueNameSpans(runs, l.from + m[0].length, l.to)),
      text: line.replace(/\uFFFC/g, "").trim()
    });
  });
  return out;
}

export function withoutCues(cell: CellInput): Run[] {
  const runs = normalizeCell(cell);
  if (!runs.some(isCueRun)) return runs;
  const lines = cueLines(runs);
  let n = cellLength(runs);
  let out = runs;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as CueLine;
    if (!l.cue) continue;
    if (l.to < n) out = deleteRange(out, l.from, l.to + 1);
    else if (l.from > 0) out = deleteRange(out, l.from - 1, l.to);
    else out = deleteRange(out, l.from, l.to);
    n = cellLength(out);
  }
  return out;
}

export function cueShortcut(cell: CellInput, pos: number): Run[] | null {
  pos = clamp(cell, pos);
  const p = projection(cell);
  if (p.charAt(pos - 1) !== ":") return null;
  const from = p.lastIndexOf("\n", pos - 1) + 1;
  if (!CUE_TYPED_RE.test(p.slice(from, pos))) return null;
  let to = p.indexOf("\n", pos);
  if (to === -1) to = p.length;
  const line = cueLines(cell).filter(function (l) { return l.from === from; })[0];
  if (line && line.cue) return null;
  return setMark(cell, from, to, "cue", true);
}

export function importCues(cell: CellInput): Run[] {
  let out = normalizeCell(cell);
  const p = projection(out);
  if (!/(sfx|music)[ \t\u00a0]*:/i.test(p)) return out;
  cueLines(out).forEach(function (l) {
    if (!l.cue && CUE_LINE_RE.test(p.slice(l.from, l.to))) out = setMark(out, l.from, l.to, "cue", true);
  });
  return out;
}

export function editCues(cell: CellInput, match: (name: string) => unknown, newName: string | null): Run[] {
  let out = normalizeCell(cell);
  if (!out.some(isCueRun)) return out;
  const lines = cueLines(out);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as CueLine;
    if (!l.cue) continue;
    const p = projection(out);
    const text = p.slice(l.from, l.to);
    const m = CUE_LINE_RE.exec(text.replace(/\u00a0/g, " "));
    if (!m) continue;
    const start = l.from + m[0].length;
    const spans = cueNameSpans(out, start, l.to);
    if (!match(cueNameOf(p, spans))) continue;
    if (newName === null) {
      out = setMark(out, l.from, l.to, "cue", false);
      continue;
    }
    if (!spans.length) continue;
    for (let k = spans.length - 1; k > 0; k--) {
      const span = spans[k] as CellRange, before = spans[k - 1] as CellRange;
      let from = span.from;
      while (from > before.to && /[ \t\u00a0]/.test(p.charAt(from - 1))) from--;
      out = deleteRange(out, from, span.to);
    }
    const first = spans[0] as CellRange;
    const at = first.from;
    out = replaceText(out, at, first.to, newName);
    if (at === start) out = insertText(out, at, " ");
  }
  return out;
}

export function flattenCues(cell: CellInput): Run[] {
  const runs = normalizeCell(cell);
  if (!runs.some(isCueRun)) return runs;
  return setMark(runs, 0, cellLength(runs), "cue", false);
}
