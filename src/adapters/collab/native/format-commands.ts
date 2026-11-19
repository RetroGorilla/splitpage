import { cleanMarks } from "../../../core/text/runs.ts";
import { nativeMarkName, nativeRangeUnits, nativeTagKey } from "./inline.ts";
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
  readonly textOnly: boolean;
  readonly family: string | null;
  readonly tag: string | null;
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
  return { key: mark, on, textOnly: mark === "dir" || mark === "cue", family: null, tag: null };
}

function commentChange(id: unknown, on: unknown): CheckedChange | null {
  if (!nativeWellFormed(id) || !id || typeof on !== "boolean" || cleanMarks({ cmt: [id] }).cmt?.[0] !== id) return null;
  return { key: "c:" + id, on, textOnly: false, family: null, tag: null };
}

function linkChange(href: unknown): CheckedChange | null {
  if (href === null) return { key: "l:", on: false, textOnly: false, family: "l:", tag: null };
  if (!nativeWellFormed(href) || !href || cleanMarks({ href }).href !== href) return null;
  return { key: "l:" + href, on: true, textOnly: false, family: "l:", tag: null };
}

function tagChange(id: unknown, on: unknown): CheckedChange | null {
  if (!nativeWellFormed(id) || !id || id.includes(APPLICATION) || typeof on !== "boolean" || cleanMarks({ tag: id }).tag !== id) return null;
  return { key: "t:" + id, on, textOnly: true, family: null, tag: id };
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
function attributesFor(script: NativeScript, change: CheckedChange, units: ReturnType<typeof nativeRangeUnits>): Record<string, true | null> | null {
  const shown = change.textOnly ? units.text : units.text + units.atoms;
  if (!shown) return null;
  if (change.tag !== null) {
    if (change.on) return { [nativeTagKey(script.doc, change.tag)]: true };
    const seen = seenApplications(units.keys, change.key);
    return seenApplications(units.shownKeys, change.key).length ? Object.fromEntries(seen.map(key => [key, null])) : null;
  }
  if (change.family !== null) {
    const others = [...units.keys].filter(key => key.startsWith(change.family as string) && (!change.on || key !== change.key)).sort();
    const shownOthers = [...units.shownKeys].some(key => key.startsWith(change.family as string) && (!change.on || key !== change.key));
    if (!shownOthers && !(change.on && units.lacking)) return null;
    const attributes: Record<string, true | null> = Object.fromEntries(others.map(key => [key, null]));
    if (change.on) attributes[change.key] = true;
    return attributes;
  }
  if (change.on) return units.lacking ? { [change.key]: true } : null;
  return units.shownKeys.has(change.key) ? { [change.key]: null } : null;
}

export function formatNativeText(script: NativeScript, range: NativeTextRange, change: NativeMarkChange): NativeFormatOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  const checked = checkedChange(change), snapshot = nativeRangeSnapshot(range);
  if (!checked) return refused("mark");
  if (!snapshot) return refused("range");
  let outcome = refused("missing");
  script.doc.transact(() => {
    const live = nativeLiveRange(script, snapshot);
    if (typeof live === "string") { outcome = refused(live); return; }
    if (live.until <= live.from) { outcome = UNCHANGED; return; }
    const units = nativeRangeUnits(live.items, live.from - live.start, live.until - live.start, checked.on ? checked.key : null, checked.textOnly);
    const attributes = attributesFor(script, checked, units);
    if (!attributes) { outcome = UNCHANGED; return; }
    live.text.format(live.from, live.until - live.from, attributes);
    outcome = WRITTEN;
  }, script.origin);
  return outcome;
}
