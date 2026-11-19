import { cleanMarks, tagNameOf, withTagStack } from "../../../core/text/runs.ts";
import type { Marks } from "../../../core/text/runs.ts";
import { nativeMarkName, nativeRangeUnits, nativeTagKey } from "./inline.ts";
import type { NativeRangeUnits } from "./inline.ts";
import type { NativeScript } from "./script.ts";
import { nativeAvailability, nativeLiveRange, nativeRangeSnapshot } from "./text-commands.ts";
import type { NativeRefusal, NativeTextRange } from "./text-commands.ts";
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

export function formatNativeText(script: NativeScript, range: NativeTextRange, change: NativeMarkChange): NativeFormatOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  return script.doc.transact(() => {
    const checked = checkedChange(change), snapshot = nativeRangeSnapshot(range);
    if (!checked) return refused("mark");
    if (!snapshot || snapshot.target.cell === "name") return refused("range");
    const live = nativeLiveRange(script, snapshot);
    if (typeof live === "string") return refused(live);
    let outcome = UNCHANGED;
    const planned = live.pieces.map(piece => {
      const units = nativeRangeUnits(piece.items, piece.from - piece.start, piece.until - piece.start, checked.on ? checked.key : null, checked.carry);
      return { piece, units, writes: writesFor(script, checked, units) };
    });
    for (const { piece, units, writes } of planned) {
      if (!writes || piece.until <= piece.from) continue;
      if (Object.keys(writes.clear).length) piece.text.format(piece.from, piece.until - piece.from, writes.clear);
      // why: a mark goes only on units whose kind can carry it
      if (writes.set) for (const [start, end] of units.stretches) piece.text.format(piece.start + start, end - start, writes.set);
      outcome = WRITTEN;
    }
    return outcome;
  }, script.origin);
}
