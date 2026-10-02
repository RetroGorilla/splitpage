import { cellLength, cleanMarks, cleanText, isDirRun, normalizeCell, projection } from "./runs.ts";
import type { BrollRun, CellInput, MarkName, Marks, NormalizeOptions, Run } from "./runs.ts";

export type AtomChar = { atom: BrollRun; ch?: undefined; marks?: undefined };

export type TextChar = { atom?: undefined; ch: string; marks: Marks };

export type Char = AtomChar | TextChar;

export type CellEdit = { cell: Run[]; end: number };

export type CellRange = { from: number; to: number };

export function explode(cell: CellInput): Char[] {
  const chars: Char[] = [];
  normalizeCell(cell).forEach(function (r) {
    if (r.atom) { chars.push({ atom: r }); return; }
    for (let i = 0; i < r.text.length; i++) chars.push({ ch: r.text[i] as string, marks: r.marks });
  });
  return chars;
}

export function implode(chars: readonly Char[], opts?: NormalizeOptions): Run[] {
  const runs: Run[] = [];
  chars.forEach(function (c) {
    if (c.atom) { runs.push(c.atom); return; }
    const last = runs[runs.length - 1];
    if (last && !last.atom && last.marks === c.marks) last.text += c.ch;
    else runs.push({ text: c.ch, marks: c.marks });
  });
  return normalizeCell(runs, opts);
}

function within(n: number, pos: number): number {
  pos = Math.floor(Number(pos) || 0);
  return pos < 0 ? 0 : (pos > n ? n : pos);
}

function cutsPair(text: string, pos: number): boolean {
  const hi = text.charCodeAt(pos - 1), lo = text.charCodeAt(pos);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

export function clamp(cell: CellInput, pos: number): number {
  const text = projection(cell);
  pos = within(text.length, pos);
  return cutsPair(text, pos) ? pos + 1 : pos;
}

export function clampRange(cell: CellInput, from: number, to: number): CellRange {
  const text = projection(cell);
  let a = within(text.length, from), b = within(text.length, to);
  if (b < a) { const x = a; a = b; b = x; }
  if (a === b) {
    a = b = cutsPair(text, a) ? a + 1 : a;
    return { from: a, to: b };
  }
  if (cutsPair(text, a)) a--;
  if (cutsPair(text, b)) b++;
  return { from: a, to: b };
}

export function marksAt(cell: CellInput, pos: number): Marks {
  const chars = explode(cell);
  pos = clamp(cell, pos);
  const c = chars[pos - 1] || chars[pos];
  return c ? Object.assign({}, c.atom ? c.atom.marks : c.marks) : {};
}

export function typingMarks(cell: CellInput, pos: number): Marks {
  const m = marksAt(cell, pos);
  delete m.tag;
  delete m.cmt;
  delete m.href;
  if (m.dir && !insideDirection(cell, pos)) delete m.dir;
  return m;
}

export function isDirChar(c: Char | null | undefined): boolean { return !!(c && !c.atom && c.marks.dir); }

export function insideDirection(cell: CellInput, pos: number): boolean {
  const chars = explode(cell);
  pos = clamp(cell, pos);
  return isDirChar(chars[pos - 1]) && isDirChar(chars[pos]);
}

export function sliceCell(cell: CellInput, from: number, to?: number): Run[] {
  const chars = explode(cell);
  const end = to === undefined ? chars.length : within(chars.length, to);
  if (end < within(chars.length, from)) return [];
  const r = clampRange(cell, from, end);
  return implode(chars.slice(r.from, r.to));
}

export function insertText(cell: CellInput, pos: number, text: string, marks?: Marks): Run[] {
  const chars = explode(cell);
  pos = clamp(cell, pos);
  const m = cleanMarks(marks === undefined ? typingMarks(cell, pos) : marks, false);
  const clean = cleanText(text);
  const ins: Char[] = [];
  for (let i = 0; i < clean.length; i++) ins.push({ ch: clean[i] as string, marks: m });
  return implode(chars.slice(0, pos).concat(ins, chars.slice(pos)));
}

export function insertBrollKey(cell: CellInput, pos: number, id: string, text: string, marks?: Marks): Run[] {
  const chars = explode(cell);
  pos = clamp(cell, pos);
  const atom: BrollRun = { atom: "broll", id: id, text: text, marks: marks === undefined ? typingMarks(cell, pos) : marks };
  return implode(chars.slice(0, pos).concat([{ atom: atom }], chars.slice(pos)));
}

export function deleteRange(cell: CellInput, from: number, to: number): Run[] {
  const chars = explode(cell);
  const r = clampRange(cell, from, to);
  return implode(chars.slice(0, r.from).concat(chars.slice(r.to)));
}

export function replaceText(cell: CellInput, from: number, to: number, text: string): Run[] {
  const r = clampRange(cell, from, to);
  from = r.from;
  to = r.to;
  if (from === to) return insertText(cell, from, text);
  const chars = explode(cell);
  const first = chars[from] as Char;
  const marks = first.atom ? typingMarks(cell, from) : first.marks;
  return insertText(deleteRange(cell, from, to), from, text, marks);
}

export function replaceWithTag(cell: CellInput, from: number, to: number, text: string, id: string): CellEdit {
  const r = clampRange(cell, from, to);
  const next = replaceText(cell, r.from, r.to, text);
  const end = r.from + cleanText(text).length;
  return { cell: setMark(next, r.from, end, "tag", id), end: end };
}

export function replaceWithBrollKey(cell: CellInput, from: number, to: number, id: string, keyText: string): CellEdit {
  const r = clampRange(cell, from, to);
  return { cell: insertBrollKey(deleteRange(cell, r.from, r.to), r.from, id, keyText, {}), end: r.from + 1 };
}

export function setMark(cell: CellInput, from: number, to: number, name: MarkName, value: unknown): Run[] {
  const chars = explode(cell);
  const r = clampRange(cell, from, to);
  const cache = new Map<Marks, Marks>();
  for (let i = r.from; i < r.to; i++) {
    const c = chars[i] as Char;
    const base = c.atom ? c.atom.marks : c.marks;
    if (c.atom && (name === "tag" || name === "dir" || name === "cue")) continue;
    let next = cache.get(base);
    if (!next) {
      next = Object.assign({}, base);
      if (value === false || value === null || value === undefined) Reflect.deleteProperty(next, name);
      else (next as Record<string, unknown>)[name] = value;
      cache.set(base, next);
    }
    if (c.atom) chars[i] = { atom: Object.assign({}, c.atom, { marks: next }) };
    else chars[i] = { ch: c.ch, marks: next };
  }
  return implode(chars);
}

export function markThroughout(cell: CellInput, from: number, to: number, name: MarkName): boolean {
  const chars = explode(cell);
  const r = clampRange(cell, from, to);
  let seen = false;
  for (let i = r.from; i < r.to; i++) {
    const c = chars[i] as Char;
    if (c.atom || c.ch === "\n") continue;
    if (!c.marks[name]) return false;
    seen = true;
  }
  return seen;
}

export function toggleMark(cell: CellInput, from: number, to: number, name: MarkName): Run[] {
  return setMark(cell, from, to, name, !markThroughout(cell, from, to, name));
}

export function breakLine(cell: CellInput, from: number, to: number): { cell: Run[]; pos: number } {
  const r = clampRange(cell, from, to);
  from = r.from;
  to = r.to;
  const rest = deleteRange(cell, from, to);
  const chars = explode(rest);
  const marks = typingMarks(rest, from);
  const prev = chars[from - 1], next = chars[from];
  if (prev && next) {
    const pm = prev.atom ? prev.atom.marks : prev.marks;
    const nm = next.atom ? next.atom.marks : next.marks;
    if (pm.href && pm.href === nm.href) marks.href = pm.href;
    const cmt = (pm.cmt || []).filter(function (id) { return (nm.cmt || []).indexOf(id) !== -1; });
    if (cmt.length) marks.cmt = cmt;
  }
  const text = from === chars.length ? "\n\n" : "\n";
  return { cell: insertText(rest, from, text, marks), pos: from + 1 };
}

function editComment(cell: CellInput, from: number, to: number, id: string, add: boolean): Run[] {
  const chars = explode(cell);
  const r = clampRange(cell, from, to);
  for (let i = r.from; i < r.to; i++) {
    const c = chars[i] as Char;
    const base = c.atom ? c.atom.marks : c.marks;
    const list = (base.cmt || []).filter(function (x) { return x !== id; });
    if (add) list.push(id);
    const next = Object.assign({}, base, { cmt: list });
    if (c.atom) chars[i] = { atom: Object.assign({}, c.atom, { marks: next }) };
    else chars[i] = { ch: c.ch, marks: next };
  }
  return implode(chars);
}

export function addComment(cell: CellInput, from: number, to: number, id: string): Run[] { return editComment(cell, from, to, id, true); }

export function removeComment(cell: CellInput, id: string, from?: number, to?: number): Run[] {
  return editComment(cell, from === undefined ? 0 : from, to === undefined ? cellLength(cell) : to, id, false);
}

export function commentRange(cell: CellInput, id: string): CellRange | null {
  const chars = explode(cell);
  let from = -1;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as Char;
    const m = c.atom ? c.atom.marks : c.marks;
    const has = !!(m.cmt && m.cmt.indexOf(id) !== -1);
    if (has && from === -1) from = i;
    if (!has && from !== -1) return { from: from, to: i };
  }
  return from === -1 ? null : { from: from, to: chars.length };
}

export function retag(cell: CellInput, fromId: string, toId: string | null | undefined): Run[] {
  return normalizeCell(normalizeCell(cell).map(function (r) {
    if (r.atom || r.marks.tag !== fromId) return r;
    const m = Object.assign({}, r.marks);
    if (toId) m.tag = toId; else delete m.tag;
    return { text: r.text, marks: m };
  }));
}

export function splitCell(cell: CellInput, pos: number): [Run[], Run[]] {
  pos = clamp(cell, pos);
  return [sliceCell(cell, 0, pos), sliceCell(cell, pos)];
}

export function joinCells(a: CellInput, b: CellInput, glue?: string): Run[] {
  const runs = normalizeCell(a).slice();
  const rest = normalizeCell(b);
  if (glue) {
    const marks: Marks = {};
    const last = runs[runs.length - 1], first = rest[0];
    if (last && first) {
      if (last.marks.href && last.marks.href === first.marks.href) marks.href = last.marks.href;
      const cmt = (last.marks.cmt || []).filter(function (id) { return (first.marks.cmt || []).indexOf(id) !== -1; });
      if (cmt.length) marks.cmt = cmt;
      if (isDirRun(last) && isDirRun(first)) marks.dir = true;
    }
    runs.push({ text: glue, marks: marks });
  }
  return normalizeCell(runs.concat(rest));
}
