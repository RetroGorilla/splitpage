import * as Y from "yjs";
import { OBJ } from "../../../core/text/runs.ts";
import type { Marks, Run } from "../../../core/text/runs.ts";
import { nativeCellView, nativeLeftAt, nativeStoredOffset, prepareNativeRuns, writeNativeRuns } from "./inline.ts";
import type { NativeDeltaItem } from "./inline.ts";
import { nativeSegmentSpans } from "./reader.ts";
import type { NativeScript } from "./script.ts";
import { decodeNativeValue, encodeNativeValue } from "./values.ts";

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

function availability(script: NativeScript): NativeRefusal | null {
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
  const unavailable = availability(script);
  if (unavailable) return { kind: "refused", reason: unavailable };
  const cell = liveCell(script, target);
  if (!cell) return { kind: "refused", reason: "missing" };
  const view = nativeCellView(cell.items);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > view.length || splitsPair(view.text, from) || splitsPair(view.text, to)) {
    return { kind: "refused", reason: "range" };
  }
  const start = Y.createRelativePositionFromTypeIndex(cell.text, cell.start + nativeStoredOffset(view, from), 0);
  const end = from === to ? start : Y.createRelativePositionFromTypeIndex(cell.text, cell.start + nativeStoredOffset(view, to), -1);
  return { kind: "anchored", range: Object.freeze({ target, from: start, to: end }) };
}

function refuse(reason: NativeRefusal, runs: readonly Run[]): NativeCommitOutcome {
  return Object.freeze({ kind: "recovery", reason, runs });
}

function sameStamp(stored: unknown, stamp: NativeEditStamp): boolean {
  if (!stored || typeof stored !== "object") return false;
  const value = stored as Record<string, unknown>;
  return decodeNativeValue(value.by)?.value === stamp.by && decodeNativeValue(value.at)?.value === stamp.at;
}

// why: the check runs inside the command's own transaction, so what it checked is what it writes to; a command
// called while another transaction is open refuses, since that transaction's changes are not yet observed
export function replaceNativeText(script: NativeScript, range: NativeTextRange, runs: readonly Run[], stamp?: NativeEditStamp): NativeCommitOutcome {
  const unavailable = availability(script);
  if (unavailable) return refuse(unavailable, runs);
  const prepared = prepareNativeRuns(runs);
  if (!prepared || (stamp && (typeof stamp.by !== "string" || typeof stamp.at !== "string"))) return refuse("text", runs);
  let outcome = refuse("missing", runs);
  script.doc.transact(() => {
    const cell = liveCell(script, range.target);
    if (!cell) return;
    const from = Y.createAbsolutePositionFromRelativePosition(range.from, script.doc), to = Y.createAbsolutePositionFromRelativePosition(range.to, script.doc);
    const stored = storedText(cell.items);
    if (!from || !to || from.type !== cell.text || to.type !== cell.text || from.index < cell.start || to.index > cell.end || to.index < from.index
      || splitsPair(stored, from.index - cell.start) || splitsPair(stored, to.index - cell.start)) { outcome = refuse("range", runs); return; }
    if (!prepared.length && from.index === to.index) { outcome = UNCHANGED; return; }
    const end = writeNativeRuns(script.doc, cell.text, from.index, prepared, nativeLeftAt(nativeCellView(cell.items), from.index - cell.start));
    if (to.index > from.index) cell.text.delete(end, to.index - from.index);
    if (stamp && !sameStamp(script.roots.edited.get(range.target.beat), stamp)) {
      script.roots.edited.set(range.target.beat, { by: encodeNativeValue(stamp.by), at: encodeNativeValue(stamp.at) });
    }
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
