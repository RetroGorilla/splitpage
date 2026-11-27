import { cueShortcutRange } from "../../../core/text/cues.ts";
import { cleanMarks, namedTagId, tagNameOf, withTagStack } from "../../../core/text/runs.ts";
import type { Marks } from "../../../core/text/runs.ts";
import { marksAt, setMark, sliceCell } from "../../../core/text/edits.ts";
import { toHtml } from "../../../core/text/html.ts";
import { tagCategoryId } from "../../../core/document/tags.ts";
import type { TagCategoryId } from "../../../core/document/tags.ts";
import { nativeCellView, nativeMarkName, nativeRangeUnits, nativeTagKey, prepareNativeRuns, writeNativeRuns } from "./inline.ts";
import type { NativeRangeUnits } from "./inline.ts";
import { claimNativeProductionTag } from "./registry-commands.ts";
import { copyArgument, RECORD_WRITTEN, refuseRecord } from "./record-values.ts";
import type { NativeRecordOutcome } from "./record-values.ts";
import { transactPreparedNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { nativeAvailability, nativeLiveRange, nativeRangeSnapshot } from "./text-commands.ts";
import type { NativeLivePiece, NativeRefusal, NativeTextRange } from "./text-commands.ts";
import { nativeWellFormed } from "./values.ts";

export type NativePlainMark = "b" | "i" | "u" | "s" | "hl" | "dir" | "cue";

export type NativeMarkChange =
  | { readonly kind: "plain"; readonly mark: NativePlainMark; readonly on: boolean }
  | { readonly kind: "comment"; readonly id: string; readonly on: boolean }
  | { readonly kind: "link"; readonly href: string | null }
  | { readonly kind: "tag"; readonly id: string; readonly on: boolean };

export type NativeFormatRefusal = NativeRefusal | "mark";

export type NativeFormatOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: NativeFormatRefusal };

export interface NativeVisualLabel {
  readonly cat: TagCategoryId;
  readonly name: string;
  readonly words: string;
  readonly prefix?: string;
  readonly completion?: string | null;
}

interface CheckedChange {
  readonly key: string;
  readonly on: boolean;
  readonly carry: Marks;
  readonly family: string | null;
  readonly tag: string | null;
}

interface Writes {
  readonly clear: Readonly<Record<string, null>>;
  readonly set: Readonly<Record<string, true>> | null;
}

const PLAIN: readonly string[] = ["b", "i", "u", "s", "hl", "dir", "cue"];
const APPLICATION = "\u001f";
const WRITTEN: NativeFormatOutcome = Object.freeze({ kind: "written" });
const UNCHANGED: NativeFormatOutcome = Object.freeze({ kind: "unchanged" });

function refused(reason: NativeFormatRefusal): NativeFormatOutcome {
  return Object.freeze({ kind: "refused", reason });
}

function plainChange(mark: unknown, on: unknown): CheckedChange | null {
  if (typeof mark !== "string" || !PLAIN.includes(mark) || typeof on !== "boolean") return null;
  return { key: mark, on, carry: { [mark]: true } as Marks, family: null, tag: null };
}

function commentChange(id: unknown, on: unknown): CheckedChange | null {
  if (!nativeWellFormed(id) || !id || typeof on !== "boolean" || cleanMarks({ cmt: [id] }).cmt?.[0] !== id) return null;
  return { key: "c:" + id, on, carry: { cmt: [id] }, family: null, tag: null };
}

function linkChange(href: unknown): CheckedChange | null {
  if (href === null) return { key: "l:", on: false, carry: {}, family: "l:", tag: null };
  if (!nativeWellFormed(href) || !href || cleanMarks({ href }).href !== href) return null;
  return { key: "l:" + href, on: true, carry: { href }, family: "l:", tag: null };
}

// why: a tag id must have the form the cell's tag markup reads, whether or not the registry names it yet
function tagChange(id: unknown, on: unknown): CheckedChange | null {
  if (!nativeWellFormed(id) || !id || id.includes(APPLICATION) || typeof on !== "boolean" || cleanMarks({ tag: id }).tag !== id || !tagNameOf(id)) return null;
  return { key: "t:" + id, on, carry: withTagStack({}, [id]), family: null, tag: id };
}

// why: every value the caller hands in is read once, here, and the command writes only what this returned
function checkedChange(change: NativeMarkChange): CheckedChange | null {
  try {
    if (!change || typeof change !== "object") return null;
    const value: Readonly<Record<string, unknown>> = change, kind = value.kind;
    if (kind === "plain") return plainChange(value.mark, value.on);
    if (kind === "comment") return commentChange(value.id, value.on);
    if (kind === "link") return linkChange(value.href);
    if (kind === "tag") return tagChange(value.id, value.on);
    return null;
  } catch { return null; }
}

function seenApplications(keys: ReadonlySet<string>, name: string): string[] {
  return [...keys].filter(key => nativeMarkName(key) === name).sort();
}

// why: design section 2: plain kinds, comments and links write one plain key; a tag writes a fresh application key and
// an untag clears the applications seen on the range; nothing is re-keyed
function writesFor(script: NativeScript, change: CheckedChange, units: NativeRangeUnits): Writes | null {
  if (change.tag !== null) {
    if (change.on) return units.eligible ? { clear: {}, set: { [nativeTagKey(script.doc, change.tag)]: true } } : null;
    const seen = seenApplications(units.keys, change.key);
    return seenApplications(units.shownKeys, change.key).length ? { clear: Object.fromEntries(seen.map(key => [key, null])), set: null } : null;
  }
  if (change.family !== null) {
    const others = [...units.keys].filter(key => key.startsWith(change.family as string) && (!change.on || key !== change.key)).sort();
    const shownOthers = [...units.shownKeys].some(key => key.startsWith(change.family as string) && (!change.on || key !== change.key));
    if (!shownOthers && !(change.on && units.lacking)) return null;
    return { clear: Object.fromEntries(others.map(key => [key, null])), set: change.on ? { [change.key]: true } : null };
  }
  if (change.on) return units.lacking ? { clear: {}, set: { [change.key]: true } } : null;
  return units.shownKeys.has(change.key) ? { clear: { [change.key]: null }, set: null } : null;
}

function planMark(script: NativeScript, pieces: readonly NativeLivePiece[], checked: CheckedChange): (() => NativeFormatOutcome) | null {
  const planned = pieces.flatMap(piece => {
    const units = nativeRangeUnits(piece.items, piece.from - piece.start, piece.until - piece.start, checked.on ? checked.key : null, checked.carry);
    const writes = writesFor(script, checked, units);
    return writes && piece.until > piece.from ? [{ piece, units, writes }] : [];
  });
  if (!planned.length) return null;
  return () => {
    for (const { piece, units, writes } of planned) {
      if (Object.keys(writes.clear).length) piece.text.format(piece.from, piece.until - piece.from, writes.clear);
      // why: a mark goes only on units whose kind can carry it
      if (writes.set) for (const [start, end] of units.stretches) piece.text.format(piece.start + start, end - start, writes.set);
    }
    return WRITTEN;
  };
}

export function planNativeCommentMark(script: NativeScript, snapshot: NonNullable<ReturnType<typeof nativeRangeSnapshot>>, id: string) {
  const checked = commentChange(id, true), live = nativeLiveRange(script, snapshot);
  if (!checked || typeof live === "string") return null;
  return planMark(script, live.pieces, checked);
}

export function formatNativeText(script: NativeScript, range: NativeTextRange, change: NativeMarkChange): NativeFormatOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  return transactPreparedNativeCommand(script, () => ({
    checked: checkedChange(change), snapshot: nativeRangeSnapshot(range)
  }), ({ checked, snapshot }) => {
    if (!checked) return refused("mark");
    if (!snapshot || snapshot.target.cell === "name") return refused("range");
    const live = nativeLiveRange(script, snapshot);
    if (typeof live === "string") return refused(live);
    return planMark(script, live.pieces, checked)?.() ?? UNCHANGED;
  }, refused);
}

export function formatNativeCue(script: NativeScript, beat: string, offset: number): NativeFormatOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  if (!nativeWellFormed(beat) || !Number.isSafeInteger(offset) || offset <= 0) return refused("range");
  return transactPreparedNativeCommand(script, () => null, () => {
    const row = script.reader.row(beat);
    if (!row) return refused("missing");
    const span = cueShortcutRange(row.narration, offset);
    if (!span || offset > span.to) return UNCHANGED;
    const pieces = script.reader.narrationPieces(beat, span.from, span.to);
    return planMark(script, pieces, { key: "cue", on: true, carry: { cue: true }, family: null, tag: null })?.() ?? UNCHANGED;
  }, refused);
}

export function labelNativeVisual(script: NativeScript, range: NativeTextRange, label: NativeVisualLabel): NativeRecordOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refuseRecord(unavailable);
  return transactPreparedNativeCommand(script, () => ({ snapshot: nativeRangeSnapshot(range), label: copyArgument(() => ({ ...label })) }),
    ({ snapshot, label: input }) => {
      if (!snapshot || snapshot.target.cell !== "visual") return refuseRecord("range");
      if (!input) return refuseRecord("value");
      const { cat, name, words, prefix = "", completion = null } = input.value;
      if (!tagCategoryId(cat) || typeof name !== "string" || typeof words !== "string" || !words || typeof prefix !== "string" ||
        completion !== null && (typeof completion !== "string" || !completion)) return refuseRecord("value");
      const checked = tagChange(namedTagId(cat, name), true);
      if (!checked?.tag) return refuseRecord("value");
      const live = nativeLiveRange(script, snapshot);
      if (typeof live === "string") return refuseRecord(live);
      const view = nativeCellView(live.items);
      if (view.hidden || view.unknown || view.text.slice(live.from, live.until) !== prefix + words) return refuseRecord("range");
      const start = live.from + prefix.length;
      const selected = sliceCell(view.runs, live.from, live.until);
      if (selected.some(run => run.atom || run.marks.href) || sliceCell(view.runs, live.from, start).some(run => run.marks.tag)) {
        return refuseRecord("range");
      }
      const marked = setMark(view.runs, start, live.until, "tag", checked.tag);
      if (toHtml(marked) === toHtml(view.runs)) return refuseRecord("range");
      const plan = !completion && planMark(script, { ...live, from: start, pieces: [{ ...live, from: start }] }, checked);
      const replacement = completion && !selected.some(run => run.marks.tag)
        ? prepareNativeRuns([{ text: completion, marks: { ...marksAt(view.runs, start), tag: checked.tag } }]) : null;
      if (!plan && !replacement) return refuseRecord("range");
      const record = claimNativeProductionTag(script, cat, name);
      if (record.kind === "refused") return record;
      if (replacement) {
        const end = writeNativeRuns(script.doc, live.text, start, replacement, null);
        live.text.delete(end, words.length);
      } else if (plan) plan();
      if (prefix) live.text.delete(live.from, prefix.length);
      return RECORD_WRITTEN;
    }, refuseRecord);
}
