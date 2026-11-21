import * as Y from "yjs";
import { copyNativeCompoundInput } from "./compound-input.ts";
import { nativeTextAllowed } from "./inline.ts";
import type { NativeDeltaItem } from "./inline.ts";
import { nativeSegmentSpans } from "./reader.ts";
import { transactNativeCommand, transactPreparedNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { deleteNativePieces, nativeAvailability, nativeLiveRange, nativeRangeSnapshot, nativeWriteAvailability } from "./text-commands.ts";
import type { NativeLiveRange, NativeRefusal, NativeTextRange } from "./text-commands.ts";
import { mintNativeId, nativeWellFormed } from "./values.ts";

export type NativeRowRefusal = NativeRefusal | "taken" | "above" | "stored";

export type NativeSplitOutcome =
  | { readonly kind: "written"; readonly created: string }
  | { readonly kind: "refused"; readonly reason: NativeRowRefusal };

export type NativeRowOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: NativeRowRefusal };

export interface NativeJoinValue {
  readonly into: string;
  readonly glue: string;
}

interface ShownRow {
  readonly record: Y.Map<unknown>;
  readonly cuts: readonly Cut[];
  readonly heads: readonly Y.Map<unknown>[];
}

interface Cut { readonly text: Y.Text; readonly from: number; readonly to: number }

const WRITTEN: NativeRowOutcome = Object.freeze({ kind: "written" });
const UNCHANGED = Object.freeze({ kind: "unchanged" } as const);
const JOINED = "joined";

function refused(reason: NativeRowRefusal): { readonly kind: "refused"; readonly reason: NativeRowRefusal } {
  return Object.freeze({ kind: "refused", reason });
}

function beatId(value: unknown): string | null {
  return nativeWellFormed(value) && value ? value : null;
}

interface ParsedPlace { readonly segment: Y.Map<unknown>; readonly text: Y.Text; readonly spans: NonNullable<ReturnType<typeof nativeSegmentSpans>> }

function parsedPlace(script: NativeScript, key: string, parsed: Map<string, ParsedPlace>): ParsedPlace | null {
  const known = parsed.get(key);
  if (known) return known;
  const segment = script.roots.segments.get(key), text = segment?.get("text"), spans = nativeSegmentSpans(segment);
  if (!segment || !(text instanceof Y.Text) || !spans) return null;
  const place = { segment, text, spans };
  parsed.set(key, place);
  return place;
}

function boundaryCut(place: ParsedPlace, index: number, heads: Y.Map<unknown>[], cuts: Cut[], withText: boolean): void {
  const span = place.spans[index];
  if (!span) return;
  const boundary = span.key?.startsWith("b:") === true;
  if (index === 0 && boundary) heads.push(place.segment);
  cuts.push({ text: place.text, from: boundary && index > 0 ? span.start - 1 : span.start, to: withText ? span.end : span.start });
}

// why: design section 2 and decision 15: a row is found with its record, visual cell, own boundary and every span the
// reader shows for it, before any write; beat boundaries among them go with their text, a heading's boundary stays
function shownRow(script: NativeScript, beat: string): ShownRow | null {
  const roots = script.roots, record = roots.beats.get(beat), own = script.reader.beatBoundary(beat), places = script.reader.narrationSpans(beat);
  if (!(record instanceof Y.Map) || !(roots.visuals.get(beat) instanceof Y.Text) || !own || !places.includes(own)) return null;
  const cuts: Cut[] = [], heads: Y.Map<unknown>[] = [], parsed = new Map<string, ParsedPlace>(), taken = new Set<string>();
  for (const place of places) {
    const segment = parsedPlace(script, place.segment, parsed);
    if (!segment?.spans[place.span]) return null;
    taken.add(place.segment + "\u001f" + String(place.span));
    boundaryCut(segment, place.span, heads, cuts, true);
  }
  // why: a repeat of the row's own boundary the reader hands to no span list would show the row again once the first
  // goes; only the boundary goes, so its text stays with the row the reader already shows it in
  for (const [key, segment] of parsed) segment.spans.forEach((span, index) => {
    if (span.key === "b:" + beat && !taken.has(key + "\u001f" + String(index))) boundaryCut(segment, index, heads, cuts, false);
  });
  return { record, cuts, heads };
}

function attributesBefore(text: Y.Text, index: number): Record<string, true> {
  let offset = 0;
  for (const item of text.toDelta() as NativeDeltaItem[]) {
    offset += typeof item.insert === "string" ? item.insert.length : 1;
    if (offset < index) continue;
    return Object.fromEntries(Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => [key, true] as const));
  }
  return {};
}

// why: decision 7: a caret in the row's own span splits there; in recovered text before it, at the own span's start,
// and after it, at its end, so no narration is copied
function splitPoint(script: NativeScript, beat: string, text: Y.Text, index: number): { readonly text: Y.Text; readonly index: number } | null {
  const own = script.reader.beatBoundary(beat), places = script.reader.narrationSpans(beat), parsed = new Map<string, ParsedPlace>();
  const ownAt = own ? places.indexOf(own) : -1, ownPlace = own ? parsedPlace(script, own.segment, parsed) : null, ownSpan = own ? ownPlace?.spans[own.span] : undefined;
  if (!own || ownAt < 0 || !ownPlace || !ownSpan) return null;
  if (text === ownPlace.text && index >= ownSpan.start && index <= ownSpan.end) return { text, index };
  const caretAt = places.findIndex(place => {
    const segment = parsedPlace(script, place.segment, parsed), span = segment?.spans[place.span];
    return !!span && segment?.text === text && index >= span.start && index <= span.end;
  });
  if (caretAt < 0) return null;
  return { text: ownPlace.text, index: caretAt < ownAt ? ownSpan.start : ownSpan.end };
}

// why: design section 2 and decision 7: a split writes a boundary, a record holding only the parent's rank and an
// empty visual cell, never narration; ties in rank read in stored order, so two splits at once keep narration order
export function splitNativeRow(script: NativeScript, at: NativeTextRange): NativeSplitOutcome {
  const checked = nativeRangeSnapshot(at), unavailable = nativeWriteAvailability(script);
  if (unavailable) return refused(unavailable);
  if (!checked || checked.target.cell !== "narration" || checked.to !== null) return refused("range");
  if (!beatId(checked.target.beat)) return refused("missing");
  return transactNativeCommand(script, () => {
    const live = nativeLiveRange(script, checked);
    return typeof live === "string" ? refused(live) : writeSplit(script, checked.target.beat, live, false);
  });
}

function writeSplit(script: NativeScript, beat: string, live: NativeLiveRange, deleting: boolean): NativeSplitOutcome {
  const { roots } = script, parent = roots.beats.get(beat);
  if (!(parent instanceof Y.Map)) return refused("missing");
  const at = splitPoint(script, beat, live.text, live.from);
  if (!at) return refused("range");
  const ranked = parent.has("rank"), rank: unknown = parent.get("rank"), created = mintNativeId(script.doc, "r");
  if (ranked && (typeof rank !== "string" || !nativeWellFormed(rank))) return refused("stored");
  if (roots.beats.has(created) || roots.visuals.has(created) || script.reader.hasBeatMarker(created)) return refused("taken");
  let index = at.index;
  if (deleting) {
    for (const piece of live.pieces) {
      if (piece.text === at.text) index -= Math.max(0, Math.min(at.index, piece.until) - piece.from);
    }
    deleteNativePieces(live);
  }
  // why: given the formatting in force at its place, the boundary writes no formatting change of its own that a
  // later undo of that formatting could leave behind
  at.text.insertEmbed(index, { b: created }, index > 0 ? attributesBefore(at.text, index) : {});
  const record = new Y.Map<unknown>();
  roots.beats.set(created, record);
  if (ranked) record.set("rank", rank);
  roots.visuals.set(created, new Y.Text());
  return Object.freeze({ kind: "written", created });
}

export function deleteAndSplitNativeRow(script: NativeScript, selection: NativeTextRange): NativeSplitOutcome | typeof UNCHANGED {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  return transactPreparedNativeCommand(script,
    () => nativeRangeSnapshot(copyNativeCompoundInput(selection) as NativeTextRange), checked => {
      if (!checked?.to || checked.target.cell !== "narration") return refused("range");
      if (!beatId(checked.target.beat)) return refused("missing");
      const live = nativeLiveRange(script, checked);
      if (typeof live === "string") return refused(live);
      if (!live.pieces.some(piece => piece.until > piece.from)) return UNCHANGED;
      return writeSplit(script, checked.target.beat, live, true);
    }, refused, () => true, true);
}

function sameJoin(stored: unknown, value: NativeJoinValue): boolean {
  if (!stored || typeof stored !== "object") return false;
  const join = stored as Readonly<Record<string, unknown>>;
  return Object.keys(join).length === 2 && join.into === value.into && join.glue === value.glue;
}

// why: the beat directly above in reading order is the last member of the row above, as the reader reads a join
function rowAbove(script: NativeScript, beat: string): string | null {
  const reader = script.reader, flat = reader.outline().flatMap((entry): readonly (string | null)[] => {
    if (entry.kind === "heading") return [null];
    const members = reader.row(entry.id)?.members ?? [];
    return members.length ? members : [entry.id];
  });
  const at = flat.indexOf(beat);
  return at > 0 ? flat[at - 1] ?? null : null;
}

function readJoin(beat: unknown, into: unknown, glue: unknown): { readonly beat: string; readonly value: NativeJoinValue } | null {
  const lower = beatId(beat), upper = beatId(into);
  if (!lower || !upper || !nativeWellFormed(glue) || !nativeTextAllowed(glue)) return null;
  return { beat: lower, value: Object.freeze({ into: upper, glue }) };
}

// why: design section 2: a join sets `joined` on the lower beat, naming the beat directly above as the person saw it;
// when that is no longer the beat directly above, the command refuses rather than join another row
export function joinNativeRow(script: NativeScript, beat: string, into: string, glue: string): NativeRowOutcome {
  const checked = readJoin(beat, into, glue), unavailable = nativeWriteAvailability(script);
  if (unavailable) return refused(unavailable);
  if (!checked) return refused("text");
  let outcome: NativeRowOutcome = refused("missing");
  transactNativeCommand(script, () => {
    const lower = shownRow(script, checked.beat);
    if (!lower || !shownRow(script, checked.value.into)) return;
    if (rowAbove(script, checked.beat) !== checked.value.into) { outcome = refused("above"); return; }
    if (sameJoin(lower.record.get(JOINED), checked.value)) { outcome = UNCHANGED; return; }
    lower.record.set(JOINED, checked.value);
    outcome = WRITTEN;
  });
  return outcome;
}

export function unjoinNativeRow(script: NativeScript, beat: string): NativeRowOutcome {
  const id = beatId(beat), unavailable = nativeWriteAvailability(script);
  if (unavailable) return refused(unavailable);
  if (!id) return refused("missing");
  let outcome: NativeRowOutcome = refused("missing");
  transactNativeCommand(script, () => {
    const row = shownRow(script, id);
    if (!row) return;
    if (!row.record.has(JOINED)) { outcome = UNCHANGED; return; }
    row.record.delete(JOINED);
    outcome = WRITTEN;
  });
  return outcome;
}

// why: the list is copied by index from one read of its length, so no iterator or getter of the caller's runs
// during the command, and a getter that throws is a plain refusal
function readIds(beats: readonly string[]): string[] | null {
  try {
    if (!Array.isArray(beats)) return null;
    const list: readonly unknown[] = beats, length = list.length, copied: unknown[] = [];
    for (let index = 0; index < length; index++) copied.push(list[index]);
    const ids: string[] = [];
    for (const value of copied) {
      const id = beatId(value);
      if (!id) return null;
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  } catch { return null; }
}

function merged(cuts: readonly Cut[]): Map<Y.Text, [number, number][]> {
  const byText = new Map<Y.Text, [number, number][]>();
  for (const cut of cuts) if (cut.to > cut.from) byText.set(cut.text, [...byText.get(cut.text) ?? [], [cut.from, cut.to]]);
  for (const [text, ranges] of byText) {
    const joined: [number, number][] = [];
    for (const [from, to] of ranges.sort((left, right) => left[0] - right[0])) {
      const last = joined.at(-1);
      if (last && from <= last[1]) last[1] = Math.max(last[1], to); else joined.push([from, to]);
    }
    byText.set(text, joined);
  }
  return byText;
}

// why: design decision 4: removing a row deletes the narration the reader shows for it with its boundary, or its
// segment's head key; its record and visual cell stay, so a removal's undo brings back what others wrote there unseen
export function removeNativeRows(script: NativeScript, beats: readonly string[]): NativeRowOutcome {
  const ids = readIds(beats), unavailable = nativeWriteAvailability(script);
  if (unavailable) return refused(unavailable);
  if (!ids) return refused("missing");
  if (!ids.length) return UNCHANGED;
  let outcome: NativeRowOutcome = refused("missing");
  transactNativeCommand(script, () => {
    const rows: ShownRow[] = [];
    for (const id of ids) {
      const row = shownRow(script, id);
      if (!row) return;
      rows.push(row);
    }
    for (const [text, ranges] of merged(rows.flatMap(row => row.cuts))) for (const [from, to] of ranges.reverse()) text.delete(from, to - from);
    for (const segment of new Set(rows.flatMap(row => row.heads))) segment.delete("head");
    outcome = WRITTEN;
  });
  return outcome;
}
