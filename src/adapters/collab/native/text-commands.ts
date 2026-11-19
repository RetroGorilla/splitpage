import * as Y from "yjs";
import type { Marks, Run } from "../../../core/text/runs.ts";
import { nativeItemLength, writeNativeRuns } from "./inline.ts";
import type { NativeDeltaItem } from "./inline.ts";
import type { NativeScript } from "./script.ts";

export interface NativeTextTarget {
  readonly beat: string;
  readonly cell: "narration" | "visual";
}

export interface NativeEditStamp {
  readonly by: string;
  readonly at: string;
}

export type NativeRefusal = "missing" | "range" | "text";

export type NativeCommitOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "recovery"; readonly reason: NativeRefusal; readonly runs: readonly Run[] };

interface CellPlace {
  readonly text: Y.Text;
  readonly start: number;
  readonly items: readonly NativeDeltaItem[];
}

const WRITTEN: NativeCommitOutcome = Object.freeze({ kind: "written" });
const UNCHANGED: NativeCommitOutcome = Object.freeze({ kind: "unchanged" });

function placeOf(script: NativeScript, target: NativeTextTarget): CellPlace | null {
  if (target.cell === "narration") return script.reader.narrationPlace(target.beat);
  const visual = script.roots.visuals.get(target.beat);
  if (!script.reader.row(target.beat) || !(visual instanceof Y.Text)) return null;
  return { text: visual, start: 0, items: visual.toDelta() as NativeDeltaItem[] };
}

function cellString(items: readonly NativeDeltaItem[]): string {
  return items.map(item => typeof item.insert === "string" ? item.insert : "￼").join("");
}

function attributesBefore(items: readonly NativeDeltaItem[], at: number): Readonly<Record<string, unknown>> | null {
  let offset = 0;
  for (const item of items) {
    offset += nativeItemLength(item);
    if (offset >= at) return at > 0 ? item.attributes ?? {} : null;
  }
  return null;
}

function splitsPair(cell: string, at: number): boolean {
  return at > 0 && at < cell.length && /[\ud800-\udbff]/.test(cell.charAt(at - 1)) && /[\udc00-\udfff]/.test(cell.charAt(at));
}

function sound(runs: readonly Run[]): boolean {
  return runs.every(run => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(run.text));
}

function refuse(reason: NativeRefusal, runs: readonly Run[]): NativeCommitOutcome {
  return Object.freeze({ kind: "recovery", reason, runs });
}

export function replaceNativeText(script: NativeScript, target: NativeTextTarget, from: number, to: number, runs: readonly Run[], stamp?: NativeEditStamp): NativeCommitOutcome {
  const place = placeOf(script, target);
  if (!place) return refuse("missing", runs);
  const cell = cellString(place.items);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > cell.length || splitsPair(cell, from) || splitsPair(cell, to)) return refuse("range", runs);
  if (!sound(runs)) return refuse("text", runs);
  const inserted = runs.some(run => run.atom || run.text);
  if (!inserted && from === to) return UNCHANGED;
  script.doc.transact(() => {
    const end = writeNativeRuns(script.doc, place.text, place.start + from, runs, attributesBefore(place.items, from));
    if (to > from) place.text.delete(end, to - from);
    const previous = script.roots.edited.get(target.beat) as Partial<NativeEditStamp> | undefined;
    if (stamp && (previous?.by !== stamp.by || previous.at !== stamp.at)) script.roots.edited.set(target.beat, { by: stamp.by, at: stamp.at });
  }, script.origin);
  return WRITTEN;
}

export function typeNativeText(script: NativeScript, target: NativeTextTarget, at: number, text: string, marks: Marks, stamp?: NativeEditStamp): NativeCommitOutcome {
  return replaceNativeText(script, target, at, at, text ? [{ text, marks }] : [], stamp);
}

export function deleteNativeText(script: NativeScript, target: NativeTextTarget, from: number, to: number, stamp?: NativeEditStamp): NativeCommitOutcome {
  return replaceNativeText(script, target, from, to, [], stamp);
}
