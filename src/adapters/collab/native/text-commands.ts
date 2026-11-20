import * as Y from "yjs";
import { OBJ } from "../../../core/text/runs.ts";
import type { Marks, Run } from "../../../core/text/runs.ts";
import { nativeCellView, nativeLeftAt, nativeStoredOffset, prepareNativeRuns, writeNativeRuns } from "./inline.ts";
import type { NativeDeltaItem } from "./inline.ts";
import { nativeSegmentSpans } from "./reader.ts";
import { throwNativeFailures, transactPreparedNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { encodeNativeValue, nativeWellFormed } from "./values.ts";

export interface NativeTextTarget {
  readonly beat: string;
  readonly cell: "narration" | "visual" | "name";
}

export interface NativeEditStamp {
  readonly by: string;
  readonly at: string;
}

export interface NativeTextRange {
  readonly target: NativeTextTarget;
  readonly from: Y.RelativePosition;
  readonly to: Y.RelativePosition;
  readonly seen?: readonly (readonly [number, number])[];
}

export interface NativeUndoSelection {
  readonly target: NativeTextTarget;
  readonly from: number;
  readonly to: number;
}

interface PlainId { readonly client: number; readonly clock: number }

interface PlainPosition { readonly type: PlainId; readonly tname: null; readonly item: PlainId | null; readonly assoc: number }

export interface NativeRangeData {
  readonly target: NativeTextTarget;
  readonly from: PlainPosition;
  readonly to: PlainPosition | null;
  readonly seen: ReadonlyMap<number, number>;
}

interface UndoEndpoint {
  readonly position: PlainPosition;
  readonly beat: string;
}

interface SelectedUnits {
  readonly client: number;
  readonly from: number;
  readonly until: number;
}

export interface NativeUndoAnchor {
  readonly cell: NativeTextTarget["cell"];
  readonly first: UndoEndpoint;
  readonly last: UndoEndpoint | null;
  readonly units: readonly SelectedUnits[];
}

export type NativeRefusal = "missing" | "range" | "text" | "busy" | "closed" | "full";

export type NativeAnchoring =
  | { readonly kind: "anchored"; readonly range: NativeTextRange }
  | { readonly kind: "refused"; readonly reason: NativeRefusal };

export type NativeCommitOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "recovery"; readonly reason: NativeRefusal; readonly runs: readonly Run[] };

interface LiveCell {
  readonly beat: string;
  readonly text: Y.Text;
  readonly start: number;
  readonly end: number;
  readonly items: readonly NativeDeltaItem[];
}

const WRITTEN: NativeCommitOutcome = Object.freeze({ kind: "written" });
const UNCHANGED: NativeCommitOutcome = Object.freeze({ kind: "unchanged" });

export interface NativeLivePiece {
  readonly beat: string;
  readonly text: Y.Text;
  readonly start: number;
  readonly items: readonly NativeDeltaItem[];
  readonly from: number;
  readonly until: number;
}

export interface NativeLiveRange extends NativeLivePiece { readonly pieces: readonly NativeLivePiece[] }

export function nativeAvailability(script: NativeScript): "busy" | "closed" | null {
  if (script.busy()) return "busy";
  throwNativeFailures(script);
  return script.closed() || script.reader.isClosed() ? "closed" : null;
}

export function nativeWriteAvailability(script: NativeScript): "busy" | "closed" | "full" | null {
  return nativeAvailability(script) ?? script.sizeRefusal?.() ?? null;
}

function liveCells(script: NativeScript, target: NativeTextTarget): LiveCell[] {
  if (target.cell === "name") {
    const cell = script.roots.names.get(target.beat);
    if (!(cell instanceof Y.Text) || !script.reader.headingBoundary(target.beat, false)) return [];
    const name = cell.toString();
    return name.length === cell.length ? [{ beat: target.beat, text: cell, start: 0, end: cell.length, items: [{ insert: name }] }] : [];
  }
  const places = script.reader.narrationSpans(target.beat);
  if (!places.length) return [];
  if (target.cell === "visual") {
    const visual = script.roots.visuals.get(target.beat);
    return script.reader.beatBoundary(target.beat) && visual instanceof Y.Text
      ? [{ beat: target.beat, text: visual, start: 0, end: visual.length, items: visual.toDelta() as NativeDeltaItem[] }] : [];
  }
  const segments = new Map<string, { text: Y.Text; spans: NonNullable<ReturnType<typeof nativeSegmentSpans>> }>();
  const cells: LiveCell[] = [], own = script.reader.beatBoundary(target.beat);
  for (const place of places) {
    let segment = segments.get(place.segment);
    if (!segment) {
      const record = script.roots.segments.get(place.segment), text = record?.get("text"), spans = nativeSegmentSpans(record);
      if (!(text instanceof Y.Text) || !spans) return [];
      segment = { text, spans };
      segments.set(place.segment, segment);
    }
    const span = segment.spans[place.span];
    if (!span) return [];
    if (span.start === span.end && place !== own) continue;
    cells.push({ beat: target.beat, text: segment.text, start: span.start, end: span.end, items: span.items });
  }
  return cells;
}

function readTarget(target: NativeTextTarget): NativeTextTarget | null {
  try {
    const beat: unknown = target.beat, cell: unknown = target.cell;
    return nativeWellFormed(beat) && (cell === "narration" || cell === "visual" || cell === "name") ? Object.freeze({ beat, cell }) : null;
  } catch { return null; }
}

const anchorSources = new WeakMap<Y.Doc, object>();
const authoredEndpoints = new WeakMap<NativeTextRange, {
  readonly source: object; readonly first: UndoEndpoint; readonly last: UndoEndpoint | null;
}>();

function shownPosition(cells: readonly LiveCell[], gaps: readonly number[], offset: number, name: boolean) {
  for (const [index, cell] of cells.entries()) {
    offset -= gaps[index] ?? 0;
    if (offset < 0) return null;
    const view = name ? null : nativeCellView(cell.items), size = view?.length ?? cell.end - cell.start;
    if (offset > size) { offset -= size; continue; }
    if (splitsPair(view?.text ?? storedText(cell.items), offset)) return null;
    return { beat: cell.beat, text: cell.text, index: cell.start + (view ? nativeStoredOffset(view, offset) : offset) };
  }
  return null;
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
  const checked = readTarget(target);
  if (!checked) return { kind: "refused", reason: "range" };
  const { cells, gaps } = anchoringCells(script, checked);
  if (!cells.length) return { kind: "refused", reason: "missing" };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return { kind: "refused", reason: "range" };
  const first = shownPosition(cells, gaps, from, checked.cell === "name");
  const last = from === to ? null : shownPosition(cells, gaps, to, checked.cell === "name");
  if (!first || (from !== to && !last)) return { kind: "refused", reason: "range" };
  const start = undoEndpoint(first, 0), end = last && undoEndpoint(last, -1);
  const positions = { target: checked, from: start.position, to: end?.position ?? start.position };
  // why: only a selection can lose both ends to a peer, so only a selection keeps what its copy had seen
  const range = Object.freeze(end
    ? { ...positions, seen: Object.freeze([...Y.decodeStateVector(Y.encodeStateVector(script.doc))].map(pair => Object.freeze(pair))) }
    : positions);
  const source = anchorSources.get(script.doc) ?? {};
  anchorSources.set(script.doc, source);
  authoredEndpoints.set(range, { source, first: start, last: end });
  return { kind: "anchored", range };
}

function undoEndpoint(point: { readonly beat: string; readonly text: Y.Text; readonly index: number }, assoc: number): UndoEndpoint {
  const { beat, text, index } = point;
  const { type, item } = Y.createRelativePositionFromTypeIndex(text, index, assoc) as PlainPosition;
  return { beat, position: Object.freeze({
    type: Object.freeze({ client: type.client, clock: type.clock }),
    item: item && Object.freeze({ client: item.client, clock: item.clock }), tname: null, assoc
  }) };
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

type IdsRead = Map<object, PlainId | undefined>;

function plainId(value: unknown, read: IdsRead): PlainId | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  if (read.has(value)) return read.get(value);
  const source = value as Readonly<Record<string, unknown>>, client = source.client, clock = source.clock;
  const id = wholeNumber(client) && wholeNumber(clock) ? Object.freeze({ client, clock }) : undefined;
  read.set(value, id);
  return id;
}

// why: each field is read once into plain data before Yjs sees it; every native text cell is nested, so a root-named
// position cannot match one and would make Yjs create an unknown root in doc.share when resolved
function plainPosition(value: unknown, assoc: number, read: IdsRead): PlainPosition | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Readonly<Record<string, unknown>>, type = plainId(source.type, read), item = plainId(source.item, read);
  const tname = source.tname, association = source.assoc;
  if (!type || item === undefined || association !== assoc || (tname !== null && tname !== undefined)) return null;
  return Object.freeze({ type, tname: null, item, assoc });
}

const NO_SEEN: ReadonlyMap<number, number> = new Map();

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
    const authored = authoredEndpoints.get(range);
    if (authored && !authored.last) return { target: range.target, from: authored.first.position, to: null, seen: NO_SEEN };
    const target: unknown = range.target, from: unknown = range.from, to: unknown = range.to, seen = to === from ? NO_SEEN : seenOf(range.seen);
    if (!target || typeof target !== "object" || !seen) return null;
    const checked = readTarget(target as NativeTextTarget);
    if (!checked) return null;
    const read: IdsRead = new Map(), start = plainPosition(from, 0, read), end = to === from ? null : plainPosition(to, -1, read);
    if (!start || (to !== from && !end)) return null;
    return Object.freeze({ target: checked, from: start, to: end, seen });
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
  const cells = liveCells(script, range.target);
  if (!cells.length) return "missing";
  const from = resolve(range.from, script.doc), to = range.to ? resolve(range.to, script.doc) : from;
  if (!from || !to) return "range";
  const live = liveRangeOf(cells, from, to);
  if (typeof live === "string") return live;
  return collapseIfSpent(script.doc, live, range.from, range.to,
    piece => heldAlive(piece.text, piece.from, piece.until, range.seen));
}

function containsAt(cell: LiveCell, at: Y.AbsolutePosition): boolean {
  return at.type === cell.text && at.index >= cell.start && at.index <= cell.end;
}

function liveRangeOf(cells: readonly LiveCell[], from: Y.AbsolutePosition, to: Y.AbsolutePosition): NativeLiveRange | "range" {
  const contains = (cell: LiveCell, at: Y.AbsolutePosition): boolean =>
    containsAt(cell, at) && !splitsPair(storedText(cell.items), at.index - cell.start);
  const first = cells.findIndex(cell => contains(cell, from)), last = cells.findIndex(cell => contains(cell, to));
  if (first < 0 || last < first || (first === last && to.index < from.index)) return "range";
  const pieces = cells.slice(first, last + 1).map((cell, index) => ({
    beat: cell.beat, text: cell.text, start: cell.start, items: cell.items,
    from: index === 0 ? from.index : cell.start, until: index === last - first ? to.index : cell.end
  }));
  const primary = pieces[0];
  return primary ? { ...primary, pieces } : "range";
}

function collapseIfSpent(doc: Y.Doc, live: NativeLiveRange, from: PlainPosition, to: PlainPosition | null,
  surviving: (piece: NativeLivePiece) => boolean): NativeLiveRange {
  if (!to || !unitGone(from, doc) || !unitGone(to, doc) || live.pieces.some(surviving)) return live;
  const first = live.pieces[0] ?? live;
  const caret = { ...first, until: first.from };
  return { ...caret, pieces: [caret] };
}

function undoOwnerOf(script: NativeScript, cell: NativeTextTarget["cell"], at: Y.AbsolutePosition, endpoint: UndoEndpoint): string | null {
  const { beat, position } = endpoint;
  if (cell !== "narration") return beat;
  const owner = script.reader.narrationOwner(at.type, at.index, position.assoc);
  // why: only a surviving unit inside the new span establishes that the caret followed its text into another row
  return owner && (owner.beat === beat || (owner.inside && !unitGone(position, script.doc))) ? owner.beat : null;
}

function rowCells(script: NativeScript, cell: NativeTextTarget["cell"], members: ReturnType<NativeScript["reader"]["rowMembers"]>) {
  const cells: LiveCell[] = [], gaps: number[] = [];
  let hasItems = false;
  for (const { id, glue } of members) {
    const own = liveCells(script, { beat: id, cell }), hasOwnItems = own.some(part => part.items.length);
    if (members.length > 1 && !hasOwnItems) continue;
    gaps[cells.length] = hasItems && hasOwnItems ? (cell === "visual" ? 1 : glue.length) : 0;
    cells.push(...own);
    hasItems ||= hasOwnItems;
  }
  const head = members[0];
  if (!cells.length && head) cells.push(...liveCells(script, { beat: head.id, cell }));
  return { cells, gaps };
}

function anchoringCells(script: NativeScript, target: NativeTextTarget) {
  if (target.cell !== "name") {
    const members = script.reader.rowMembers(target.beat, true);
    if (members.length) return rowCells(script, target.cell, members);
  }
  return { cells: liveCells(script, target), gaps: [] };
}

function* selectedUnits(piece: NativeLivePiece): Iterable<SelectedUnits> {
  let offset = 0;
  for (const item of Y.getTypeChildren(piece.text)) {
    if (item.deleted || !item.countable) continue;
    const end = offset + item.length;
    if (end > piece.from && offset < piece.until) {
      yield { client: item.id.client, from: item.id.clock + Math.max(0, piece.from - offset),
        until: item.id.clock + Math.min(item.length, piece.until - offset) };
    }
    if (end >= piece.until) break;
    offset = end;
  }
}

function originalUnits(live: NativeLiveRange, seen: ReadonlyMap<number, number>): SelectedUnits[] {
  return live.pieces.flatMap(piece => Array.from(selectedUnits(piece)).flatMap(unit => {
    const until = Math.min(unit.until, seen.get(unit.client) ?? 0);
    return unit.from < until ? [{ ...unit, until }] : [];
  }));
}

function undoLayout(script: NativeScript, cell: NativeTextTarget["cell"], beat: string) {
  if (cell === "name") return {
    row: beat, cells: script.reader.showsHeading(beat) ? liveCells(script, { beat, cell }) : [], gaps: []
  };
  const members = script.reader.rowMembers(beat);
  return { row: members[0]?.id ?? beat, ...rowCells(script, cell, members) };
}

export function snapshotNativeUndoAnchor(script: NativeScript, range: NativeTextRange): NativeUndoAnchor | null {
  const authored = authoredEndpoints.get(range);
  const origin = authored && authored.source === anchorSources.get(script.doc) ? authored : null;
  if (origin && !origin.last) return { cell: range.target.cell, first: origin.first, last: null, units: [] };
  const data = nativeRangeSnapshot(range);
  if (!data) return null;
  const { cell } = data.target;
  const from = resolve(data.from, script.doc), to = data.to ? resolve(data.to, script.doc) : from;
  const endpoints = origin && { cell, first: origin.first, last: origin.last, units: [] };
  if (!from || !to) return endpoints;
  const cells = origin ? undoLayout(script, cell, undoOwnerOf(script, cell, from, origin.first) ?? origin.first.beat).cells
    : liveCells(script, data.target);
  const live = liveRangeOf(cells, from, to);
  if (typeof live === "string") return endpoints;
  return {
    cell, first: origin?.first ?? { beat: live.beat, position: data.from },
    last: data.to && (origin?.last ?? { beat: live.pieces.at(-1)?.beat ?? live.beat, position: data.to }),
    units: data.to ? originalUnits(live, data.seen) : []
  };
}

export function resolveNativeUndoSelection(script: NativeScript, range: NativeUndoAnchor): NativeUndoSelection | null {
  const { cell, first, last } = range;
  const from = resolve(first.position, script.doc), to = last ? resolve(last.position, script.doc) : from;
  if (!from || !to) return null;
  const owner = undoOwnerOf(script, cell, from, first);
  const endOwner = last ? undoOwnerOf(script, cell, to, last) : owner;
  if (owner === null || endOwner === null) return null;
  const shown = undoLayout(script, cell, owner);
  const live = liveRangeOf(shown.cells, from, to);
  if (typeof live === "string") return null;
  const settled = collapseIfSpent(script.doc, live, first.position, last?.position ?? null, piece =>
    Array.from(selectedUnits(piece)).some(unit => range.units.some(original =>
      unit.client === original.client && unit.from < original.until && unit.until > original.from)));
  const end = settled.pieces.at(-1) ?? settled;
  let offset = 0, startOffset: number | undefined;
  for (const [index, part] of shown.cells.entries()) {
    offset += shown.gaps[index] ?? 0;
    const view = cell === "name" ? null : nativeCellView(part.items);
    const shownAt = (stored: number): number =>
      offset + (view ? view.ends.filter(unitEnd => unitEnd <= stored - part.start).length : stored - part.start);
    if (part.text === settled.text && part.start === settled.start) startOffset = shownAt(settled.from);
    if (startOffset !== undefined && part.text === end.text && part.start === end.start) {
      return Object.freeze({ target: Object.freeze({ beat: shown.row, cell }), from: startOffset, to: shownAt(end.until) });
    }
    offset += view?.length ?? part.end - part.start;
  }
  return null;
}

// why: a command called while another transaction is open refuses, since that transaction's changes are not yet
// observed
export function replaceNativeText(script: NativeScript, range: NativeTextRange, runs: readonly Run[], stamp?: NativeEditStamp,
  beforeWrite?: (target: NativeTextTarget) => void, adds?: boolean, afterWrite?: (anchor: NativeUndoAnchor) => void): NativeCommitOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refuse(unavailable, runs);
  return transactPreparedNativeCommand(script, () => ({
    prepared: prepareNativeRuns(runs), encoded: encodedStamp(stamp), checked: nativeRangeSnapshot(range)
  }), ({ prepared, encoded, checked }) => {
    if (!prepared || encoded === null) return refuse("text", runs);
    if (!checked || checked.target.cell === "name") return refuse("range", runs);
    const live = nativeLiveRange(script, checked);
    if (typeof live === "string") return refuse(live, runs);
    if (!prepared.length && !live.pieces.some(piece => piece.until > piece.from)) return UNCHANGED;
    const updateStamp = encoded && script.reader.beatBoundary(checked.target.beat) && !sameStamp(script.roots.edited.get(checked.target.beat), encoded);
    beforeWrite?.(checked.target);
    const end = writeNativeRuns(script.doc, live.text, live.from, prepared, nativeLeftAt(nativeCellView(live.items), live.from - live.start));
    const added = end - live.from;
    for (const piece of live.pieces.toReversed()) {
      const shift = piece.text === live.text && piece.from >= live.from ? added : 0;
      if (piece.until > piece.from) piece.text.delete(piece.from + shift, piece.until - piece.from);
    }
    if (encoded && updateStamp) script.roots.edited.set(checked.target.beat, encoded);
    if (afterWrite) {
      const first = undoEndpoint({ beat: live.beat, text: live.text, index: end }, 0);
      afterWrite({ cell: checked.target.cell, first, last: null, units: [] });
    }
    return WRITTEN;
  }, reason => refuse(reason, runs), ({ prepared }) => adds ?? prepared?.length !== 0);
}

export function typeNativeText(script: NativeScript, range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp,
  beforeWrite?: (target: NativeTextTarget) => void, afterWrite?: (anchor: NativeUndoAnchor) => void): NativeCommitOutcome {
  return replaceNativeText(script, range, text ? [{ text, marks }] : [], stamp, beforeWrite, text !== "", afterWrite);
}

export function deleteNativeText(script: NativeScript, range: NativeTextRange, stamp?: NativeEditStamp): NativeCommitOutcome {
  return replaceNativeText(script, range, [], stamp);
}
