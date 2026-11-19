import * as Y from "yjs";
import { OBJ } from "../../../core/text/runs.ts";
import type { Marks, Run } from "../../../core/text/runs.ts";
import { nativeCellView, nativeLeftAt, nativeStoredOffset, prepareNativeRuns, writeNativeRuns } from "./inline.ts";
import type { NativeDeltaItem } from "./inline.ts";
import { nativeSegmentSpans } from "./reader.ts";
import { throwNativeFailures } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { encodeNativeValue } from "./values.ts";

export interface NativeTextTarget {
  readonly beat: string;
  readonly cell: "narration" | "visual";
}

export interface NativeEditStamp {
  readonly by: string;
  readonly at: string;
}

export interface NativeTextRange {
  readonly target: NativeTextTarget;
  readonly from: Y.RelativePosition;
  readonly to: Y.RelativePosition;
  readonly seen: readonly (readonly [number, number])[];
}

interface PlainId { readonly client: number; readonly clock: number }

interface PlainPosition { readonly type: PlainId | null; readonly tname: string | null; readonly item: PlainId | null; readonly assoc: number }

export interface NativeRangeData {
  readonly target: NativeTextTarget;
  readonly from: PlainPosition;
  readonly to: PlainPosition | null;
  readonly seen: ReadonlyMap<number, number>;
}

export type NativeRefusal = "missing" | "range" | "text" | "busy" | "closed";

export type NativeAnchoring =
  | { readonly kind: "anchored"; readonly range: NativeTextRange }
  | { readonly kind: "refused"; readonly reason: NativeRefusal };

export type NativeCommitOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "recovery"; readonly reason: NativeRefusal; readonly runs: readonly Run[] };

interface LiveCell {
  readonly text: Y.Text;
  readonly start: number;
  readonly end: number;
  readonly items: readonly NativeDeltaItem[];
}

const WRITTEN: NativeCommitOutcome = Object.freeze({ kind: "written" });
const UNCHANGED: NativeCommitOutcome = Object.freeze({ kind: "unchanged" });

export interface NativeLiveRange {
  readonly text: Y.Text;
  readonly start: number;
  readonly items: readonly NativeDeltaItem[];
  readonly from: number;
  readonly until: number;
}

export function nativeAvailability(script: NativeScript): NativeRefusal | null {
  throwNativeFailures(script);
  if (script.closed() || script.reader.isClosed()) return "closed";
  return script.busy() ? "busy" : null;
}

// why: one live check for both cells: a row shows only while its narration span is placed and its records exist
function liveCell(script: NativeScript, target: NativeTextTarget): LiveCell | null {
  const places = script.reader.narrationSpans(target.beat), place = places[0];
  if (places.length !== 1 || !place) return null;
  const segment = script.roots.segments.get(place.segment), span = nativeSegmentSpans(segment)?.[place.span];
  const visual = script.roots.visuals.get(target.beat);
  if (!span || span.key !== "b:" + target.beat || !(script.roots.beats.get(target.beat) instanceof Y.Map) || !(visual instanceof Y.Text)) return null;
  if (target.cell === "visual") return { text: visual, start: 0, end: visual.length, items: visual.toDelta() as NativeDeltaItem[] };
  const text = segment?.get("text");
  return text instanceof Y.Text ? { text, start: span.start, end: span.end, items: span.items } : null;
}

function storedText(items: readonly NativeDeltaItem[]): string {
  return items.map(item => typeof item.insert === "string" ? item.insert : OBJ).join("");
}

function splitsPair(text: string, at: number): boolean {
  return at > 0 && at < text.length && /[\ud800-\udbff]/.test(text.charAt(at - 1)) && /[\udc00-\udfff]/.test(text.charAt(at));
}

export function anchorNativeText(script: NativeScript, target: NativeTextTarget, from: number, to = from): NativeAnchoring {
  const unavailable = nativeAvailability(script);
  if (unavailable) return { kind: "refused", reason: unavailable };
  const cell = liveCell(script, target);
  if (!cell) return { kind: "refused", reason: "missing" };
  const view = nativeCellView(cell.items);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > view.length || splitsPair(view.text, from) || splitsPair(view.text, to)) {
    return { kind: "refused", reason: "range" };
  }
  const start = Y.createRelativePositionFromTypeIndex(cell.text, cell.start + nativeStoredOffset(view, from), 0);
  const end = from === to ? start : Y.createRelativePositionFromTypeIndex(cell.text, cell.start + nativeStoredOffset(view, to), -1);
  const seen = Object.freeze([...Y.decodeStateVector(Y.encodeStateVector(script.doc))].map(pair => Object.freeze(pair)));
  return { kind: "anchored", range: Object.freeze({ target, from: start, to: end, seen }) };
}

function refuse(reason: NativeRefusal, runs: readonly Run[]): NativeCommitOutcome {
  return Object.freeze({ kind: "recovery", reason, runs });
}

interface EncodedStamp { readonly by: string; readonly at: string }

function encodedStamp(stamp: NativeEditStamp | undefined): EncodedStamp | null | undefined {
  if (stamp === undefined) return undefined;
  try {
    const by: unknown = stamp.by, at: unknown = stamp.at;
    return typeof by === "string" && typeof at === "string" ? { by: encodeNativeValue(by), at: encodeNativeValue(at) } : null;
  } catch { return null; }
}

function sameStamp(stored: unknown, stamp: EncodedStamp): boolean {
  if (!stored || typeof stored !== "object") return false;
  const value = stored as Record<string, unknown>;
  return value.by === stamp.by && value.at === stamp.at;
}

const wholeNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function plainId(value: unknown): PlainId | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  const source = value as Readonly<Record<string, unknown>>, client = source.client, clock = source.clock;
  return wholeNumber(client) && wholeNumber(clock) ? Object.freeze({ client, clock }) : undefined;
}

// why: each field is read once into plain data and checked before Yjs sees it; a fractional or negative clock, or
// an association other than the anchor's, reached Yjs and corrupted the cell
function plainPosition(value: unknown, assoc: number): PlainPosition | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Readonly<Record<string, unknown>>, type = plainId(source.type), item = plainId(source.item);
  const tname = source.tname, association = source.assoc;
  if (type === undefined || item === undefined || association !== assoc || (tname !== null && tname !== undefined && typeof tname !== "string")) return null;
  const name = typeof tname === "string" ? tname : null;
  if ((type === null) === (name === null)) return null;
  return Object.freeze({ type, tname: name, item, assoc });
}

function seenOf(value: unknown): ReadonlyMap<number, number> | null {
  if (!Array.isArray(value)) return null;
  const seen = new Map<number, number>();
  for (const pair of value as readonly unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const client: unknown = pair[0], clock: unknown = pair[1];
    if (!wholeNumber(client) || !wholeNumber(clock) || seen.has(client)) return null;
    seen.set(client, clock);
  }
  return seen;
}

function resolve(position: PlainPosition, doc: Y.Doc): Y.AbsolutePosition | null {
  try { return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position), doc); } catch { return null; }
}

// why: a deleted unit resolves to the same index from either side, a live one does not; public API only
function unitGone(position: PlainPosition, doc: Y.Doc): boolean {
  if (!position.item) return false;
  const here = resolve(position, doc), other = resolve({ ...position, assoc: position.assoc === -1 ? 0 : -1 }, doc);
  return !!here && !!other && here.index === other.index;
}

// why: a range is read once into plain data, so a caller's later change to it, or a getter, cannot alter what the
// command checked
export function nativeRangeSnapshot(range: NativeTextRange): NativeRangeData | null {
  try {
    const target: unknown = range.target, from: unknown = range.from, to: unknown = range.to, seen = seenOf(range.seen);
    if (!target || typeof target !== "object" || !seen) return null;
    const beat: unknown = (target as NativeTextTarget).beat, cell: unknown = (target as NativeTextTarget).cell;
    if (typeof beat !== "string" || (cell !== "narration" && cell !== "visual")) return null;
    const start = plainPosition(from, 0), end = to === from ? null : plainPosition(to, -1);
    if (!start || (to !== from && !end)) return null;
    return Object.freeze({ target: Object.freeze({ beat, cell }), from: start, to: end, seen });
  } catch { return null; }
}

// why: when a peer deleted both end units, the selection still holds what it held: it collapses only if no unit
// alive between the ends existed when it was anchored, so surviving text is covered and later typing alone is not
function heldAlive(text: Y.Text, from: number, to: number, seen: ReadonlyMap<number, number>): boolean {
  for (let index = from; index < to; index++) {
    const item = Y.createRelativePositionFromTypeIndex(text, index, 0).item;
    if (item && item.clock < (seen.get(item.client) ?? 0)) return true;
  }
  return false;
}

// why: called inside the command's own transaction, so what it checked is what the command writes to; a stale range
// covers text a peer typed inside it
export function nativeLiveRange(script: NativeScript, range: NativeRangeData): NativeLiveRange | NativeRefusal {
  const cell = liveCell(script, range.target);
  if (!cell) return "missing";
  const from = resolve(range.from, script.doc), to = range.to ? resolve(range.to, script.doc) : from;
  const stored = storedText(cell.items);
  if (!from || !to || from.type !== cell.text || to.type !== cell.text || from.index < cell.start || to.index > cell.end || to.index < from.index
    || splitsPair(stored, from.index - cell.start) || splitsPair(stored, to.index - cell.start)) return "range";
  const collapsed = !!range.to && unitGone(range.from, script.doc) && unitGone(range.to, script.doc) && !heldAlive(cell.text, from.index, to.index, range.seen);
  return { text: cell.text, start: cell.start, items: cell.items, from: from.index, until: collapsed ? from.index : to.index };
}

// why: a command called while another transaction is open refuses, since that transaction's changes are not yet
// observed
export function replaceNativeText(script: NativeScript, range: NativeTextRange, runs: readonly Run[], stamp?: NativeEditStamp): NativeCommitOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refuse(unavailable, runs);
  const prepared = prepareNativeRuns(runs), encoded = encodedStamp(stamp), checked = nativeRangeSnapshot(range);
  if (!prepared || encoded === null) return refuse("text", runs);
  if (!checked) return refuse("range", runs);
  let outcome = refuse("missing", runs);
  script.doc.transact(() => {
    const live = nativeLiveRange(script, checked);
    if (typeof live === "string") { outcome = refuse(live, runs); return; }
    if (!prepared.length && live.from === live.until) { outcome = UNCHANGED; return; }
    const end = writeNativeRuns(script.doc, live.text, live.from, prepared, nativeLeftAt(nativeCellView(live.items), live.from - live.start));
    if (live.until > live.from) live.text.delete(end, live.until - live.from);
    if (encoded && !sameStamp(script.roots.edited.get(checked.target.beat), encoded)) script.roots.edited.set(checked.target.beat, encoded);
    outcome = WRITTEN;
  }, script.origin);
  return outcome;
}

export function typeNativeText(script: NativeScript, range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp): NativeCommitOutcome {
  return replaceNativeText(script, range, text ? [{ text, marks }] : [], stamp);
}

export function deleteNativeText(script: NativeScript, range: NativeTextRange, stamp?: NativeEditStamp): NativeCommitOutcome {
  return replaceNativeText(script, range, [], stamp);
}
