import { OBJ, atomId, isMediaRun, normalizeCell } from "./runs.ts";
import type { CellInput } from "./runs.ts";

export type SelectionField = "visualText" | "audioText";

export type Affinity = "backward" | "forward";

export interface ModelSelection {
  readonly epoch: number;
  readonly rowId: string;
  readonly field: SelectionField;
  readonly anchor: number;
  readonly head: number;
  readonly affinity: Affinity;
}

export interface SelectionSnapshot {
  readonly selection: ModelSelection;
  readonly keys: readonly string[];
  readonly order: readonly string[];
}

export interface SelectionWorld {
  readonly epoch: number;
  readonly order: readonly string[];
  readonly keys: (rowId: string, field: SelectionField) => readonly string[] | null;
}

export const MAX_DIFF_STEPS = 500;

export function isSelectionField(field: unknown): field is SelectionField {
  return field === "visualText" || field === "audioText";
}

export function atomKey(id: string): string {
  return OBJ + id;
}

export function unitKey(ch: string): string {
  return ch === "\u00a0" ? " " : ch;
}

export const MEDIA_KEY = atomKey("#media");

function keysOf(cell: CellInput, mediaAsShown: boolean): string[] {
  const keys: string[] = [];
  normalizeCell(cell).forEach(function (r) {
    if (r.atom) { keys.push(mediaAsShown && isMediaRun(r) ? MEDIA_KEY : atomKey(atomId(r))); return; }
    for (let i = 0; i < r.text.length; i++) keys.push(unitKey(r.text[i] as string));
  });
  return keys;
}

export function cellKeys(cell: CellInput): string[] {
  return keysOf(cell, false);
}

export function editorKeys(cell: CellInput): string[] {
  return keysOf(cell, true);
}

export function isCollapsed(sel: { anchor: number; head: number }): boolean {
  return sel.anchor === sel.head;
}

export function selectionRange(sel: { anchor: number; head: number }): { from: number; to: number } {
  return sel.anchor <= sel.head ? { from: sel.anchor, to: sel.head } : { from: sel.head, to: sel.anchor };
}

export function isBackward(sel: { anchor: number; head: number }): boolean {
  return sel.head < sel.anchor;
}

const WORD = /[\p{L}\p{N}\p{M}_'\u2019]/u;

function isWordUnit(key: string): boolean {
  return key.length === 1 && WORD.test(key);
}

function isHighSurrogate(key: string | undefined): boolean {
  if (key === undefined || key.length !== 1) return false;
  const c = key.charCodeAt(0);
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(key: string | undefined): boolean {
  if (key === undefined || key.length !== 1) return false;
  const c = key.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff;
}

interface Tokens {
  readonly text: string[];
  readonly start: number[];
}

function tokenize(keys: readonly string[]): Tokens {
  const text: string[] = [];
  const start: number[] = [];
  let i = 0;
  while (i < keys.length) {
    const from = i;
    const key = keys[i] as string;
    if (isWordUnit(key) || (isHighSurrogate(key) && isLowSurrogate(keys[i + 1]))) {
      i++;
      while (i < keys.length && (isWordUnit(keys[i] as string) || isLowSurrogate(keys[i]))) i++;
    } else {
      i++;
    }
    text.push(keys.slice(from, i).join("\u0000"));
    start.push(from);
  }
  start.push(keys.length);
  return { text: text, start: start };
}

function keptTokens(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) { pairs.push([lo, lo]); lo++; }
  let ea = a.length, eb = b.length;
  const tail: Array<[number, number]> = [];
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; tail.push([ea, eb]); }
  const middle = myers(a, b, lo, ea, lo, eb);
  middle.forEach(function (p) { pairs.push(p); });
  tail.reverse().forEach(function (p) { pairs.push(p); });
  return pairs;
}

function myers(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number): Array<[number, number]> {
  const n = a1 - a0, m = b1 - b0;
  if (!n || !m) return [];
  const max = Math.min(n + m, MAX_DIFF_STEPS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found === -1; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number)))
        ? v[offset + k + 1] as number
        : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found === -1) return [];
  const pairs: Array<[number, number]> = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (prev[offset + k - 1] as number) < (prev[offset + k + 1] as number));
    const pk = down ? k + 1 : k - 1;
    const px = prev[offset + pk] as number;
    const py = px - pk;
    while (x > px && y > py) {
      x--; y--;
      pairs.push([a0 + x, b0 + y]);
    }
    x = px; y = py;
  }
  while (x > 0 && y > 0) { x--; y--; pairs.push([a0 + x, b0 + y]); }
  return pairs.reverse();
}

function keepEdges(kept: Int32Array, before: readonly string[], after: readonly string[], oa: number, ob: number, na: number, nb: number): void {
  while (oa < ob && na < nb && before[oa] === after[na]) kept[oa++] = na++;
  while (ob > oa && nb > na && before[ob - 1] === after[nb - 1]) kept[--ob] = --nb;
}

export function keptUnits(before: readonly string[], after: readonly string[]): Int32Array {
  const kept = new Int32Array(before.length).fill(-1);
  const ta = tokenize(before), tb = tokenize(after);
  let oa = 0, na = 0;
  keptTokens(ta.text, tb.text).forEach(function (p) {
    const fa = ta.start[p[0]] as number, fb = tb.start[p[1]] as number;
    keepEdges(kept, before, after, oa, fa, na, fb);
    const len = (ta.start[p[0] + 1] as number) - fa;
    for (let i = 0; i < len; i++) kept[fa + i] = fb + i;
    oa = fa + len;
    na = fb + len;
  });
  keepEdges(kept, before, after, oa, before.length, na, after.length);
  return kept;
}

function clampUnits(keys: readonly string[], pos: number): number {
  if (pos < 0) return 0;
  if (pos > keys.length) return keys.length;
  return isHighSurrogate(keys[pos - 1]) && isLowSurrogate(keys[pos]) ? pos + 1 : pos;
}

function lastKeptBefore(kept: Int32Array, pos: number): number {
  for (let i = Math.min(pos, kept.length) - 1; i >= 0; i--) if ((kept[i] as number) !== -1) return (kept[i] as number) + 1;
  return 0;
}

function firstKeptFrom(kept: Int32Array, pos: number, afterLength: number): number {
  for (let i = Math.max(pos, 0); i < kept.length; i++) if ((kept[i] as number) !== -1) return kept[i] as number;
  return afterLength;
}

export function mapPoint(kept: Int32Array, afterLength: number, pos: number, affinity: Affinity): number {
  const bound = affinity === "backward" ? kept[pos - 1] : kept[pos];
  if (bound !== undefined && bound !== -1) return affinity === "backward" ? bound + 1 : bound;
  return affinity === "backward" ? firstKeptFrom(kept, pos, afterLength) : lastKeptBefore(kept, pos);
}

function intact(kept: Int32Array, from: number, to: number): boolean {
  const base = kept[from] as number;
  if (base === -1) return false;
  for (let i = from + 1; i < to; i++) if ((kept[i] as number) !== base + (i - from)) return false;
  return true;
}

export interface CellPoints {
  readonly anchor: number;
  readonly head: number;
  readonly affinity: Affinity;
}

export function headAffinity(sel: CellPoints): Affinity {
  if (isCollapsed(sel)) return sel.affinity;
  return isBackward(sel) ? "forward" : "backward";
}

export function mapThroughCell(sel: CellPoints, before: readonly string[], after: readonly string[]): CellPoints {
  const kept = keptUnits(before, after);
  const range = selectionRange(sel);
  if (!isCollapsed(sel) && intact(kept, range.from, range.to)) {
    const from = kept[range.from] as number;
    const to = (kept[range.to - 1] as number) + 1;
    return isBackward(sel)
      ? { anchor: clampUnits(after, to), head: clampUnits(after, from), affinity: sel.affinity }
      : { anchor: clampUnits(after, from), head: clampUnits(after, to), affinity: sel.affinity };
  }
  const affinity = headAffinity(sel);
  const at = clampUnits(after, mapPoint(kept, after.length, sel.head, affinity));
  return { anchor: at, head: at, affinity: affinity };
}

function sameKeys(a: readonly string[], b: readonly string[], aFrom: number, bFrom: number, length: number): boolean {
  for (let i = 0; i < length; i++) if (a[aFrom + i] !== b[bFrom + i]) return false;
  return true;
}

function shifted(sel: CellPoints, by: number, keys: readonly string[]): CellPoints {
  return { anchor: clampUnits(keys, sel.anchor + by), head: clampUnits(keys, sel.head + by), affinity: sel.affinity };
}

function caret(pos: number, affinity: Affinity): CellPoints {
  return { anchor: pos, head: pos, affinity: affinity };
}

function within(rowId: string, field: SelectionField, epoch: number, points: CellPoints): ModelSelection {
  return Object.freeze({ epoch: epoch, rowId: rowId, field: field, anchor: points.anchor, head: points.head, affinity: points.affinity });
}

function splitInto(snap: SelectionSnapshot, world: SelectionWorld, now: readonly string[]): ModelSelection | null {
  const sel = snap.selection;
  const before = snap.keys;
  if (now.length >= before.length || !sameKeys(before, now, 0, 0, now.length)) return null;
  const at = world.order.indexOf(sel.rowId);
  const nextId = world.order[at + 1];
  if (nextId === undefined || snap.order.indexOf(nextId) !== -1) return null;
  const next = world.keys(nextId, sel.field);
  if (!next || next.length !== before.length - now.length || !sameKeys(before, next, now.length, 0, next.length)) return null;
  const cut = now.length;
  const range = selectionRange(sel);
  const headSide = headAffinity(sel);
  const inNext = range.from > cut || (range.from === cut && (isCollapsed(sel) ? sel.affinity === "forward" : true));
  if (inNext) return within(nextId, sel.field, world.epoch, shifted(sel, -cut, next));
  if (range.to <= cut) return within(sel.rowId, sel.field, world.epoch, sel);
  if (sel.head > cut) return within(nextId, sel.field, world.epoch, caret(sel.head - cut, headSide));
  return within(sel.rowId, sel.field, world.epoch, caret(sel.head, headSide));
}

function vanished(snap: SelectionSnapshot, world: SelectionWorld): ModelSelection | null {
  const sel = snap.selection;
  const at = snap.order.indexOf(sel.rowId);
  for (let i = at - 1; i >= 0; i--) {
    const id = snap.order[i] as string;
    if (world.order.indexOf(id) === -1) continue;
    const keys = world.keys(id, sel.field) || [];
    const old = snap.keys;
    const start = keys.length - old.length;
    if (old.length && start >= 0 && sameKeys(keys, old, start, 0, old.length)) {
      return within(id, sel.field, world.epoch, shifted(sel, start, keys));
    }
    return within(id, sel.field, world.epoch, caret(keys.length, "backward"));
  }
  for (let j = at + 1; j < snap.order.length; j++) {
    const id = snap.order[j] as string;
    if (world.order.indexOf(id) !== -1) return within(id, sel.field, world.epoch, caret(0, "forward"));
  }
  const first = world.order[0];
  return first === undefined ? null : within(first, sel.field, world.epoch, caret(0, "forward"));
}

export function resolveSelection(snap: SelectionSnapshot | null, world: SelectionWorld): ModelSelection | null {
  if (!snap || snap.selection.epoch !== world.epoch) return null;
  const sel = snap.selection;
  if (world.order.indexOf(sel.rowId) === -1) return vanished(snap, world);
  const now = world.keys(sel.rowId, sel.field);
  if (!now) return null;
  const split = splitInto(snap, world, now);
  if (split) return split;
  return within(sel.rowId, sel.field, world.epoch, mapThroughCell(sel, snap.keys, now));
}

export function takeSnapshot(selection: ModelSelection, keys: readonly string[], order: readonly string[]): SelectionSnapshot {
  const length = keys.length;
  const points = {
    anchor: clampUnits(keys, Math.min(Math.max(0, selection.anchor), length)),
    head: clampUnits(keys, Math.min(Math.max(0, selection.head), length)),
    affinity: selection.affinity
  };
  return Object.freeze({
    selection: within(selection.rowId, selection.field, selection.epoch, points),
    keys: Object.freeze(keys.slice()),
    order: Object.freeze(order.slice())
  });
}
