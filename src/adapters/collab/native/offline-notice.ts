import { tagStack } from "../../../core/text/runs.ts";
import type { Run } from "../../../core/text/runs.ts";
import type { NativePendingEdit, NativePendingEditsData, NativeSavedBeat } from "./pending-edits.ts";
import type { NativeReadBeat, NativeScriptReader } from "./reader.ts";
import { sameNativeValue } from "./values.ts";

export type NativeClashKind = "narration" | "visual" | "marks" | "record" | "join" |
  "split-text" | "split-move" | "double-undo" | "displaced";

export interface NativeOfflineClash {
  readonly id: string;
  readonly kinds: readonly NativeClashKind[];
  readonly mine: NativeSavedBeat | null;
  readonly merged: NativeReadBeat | null;
  readonly possibleRemoval: boolean;
  readonly near?: string;
}

function textOf(runs: readonly Run[]): string {
  return runs.map(run => run.text).join("");
}

function units(runs: readonly Run[], marked: boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const { marks: formatting, ...content } = run;
    const marks = Object.entries(formatting).flatMap(([name, value]) =>
      value === true ? [name] : (name === "cmt" || name === "href") && value ? [JSON.stringify([name, value])] : []);
    for (const tag of tagStack(run.marks)) marks.push("tag:" + tag);
    for (const text of run.atom ? [JSON.stringify(content)] : run.text) {
      for (const unit of marked ? marks.map(mark => JSON.stringify([text, mark])) : [text]) {
        counts.set(unit, (counts.get(unit) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function cellClashed(edits: readonly NativePendingEdit[], column: "narration" | "visual",
  merged: NativeReadBeat | null, marked: boolean): boolean {
  const change = new Map<string, { delta: number; wanted: number }>();
  for (const { before, after } of edits) {
    if (!before || !after || sameNativeValue(before[column], after[column])) continue;
    const old = units(before[column], marked), saved = units(after[column], marked);
    for (const unit of new Set([...old.keys(), ...saved.keys()])) {
      const wanted = saved.get(unit) ?? 0, difference = wanted - (old.get(unit) ?? 0);
      if (difference) change.set(unit, { delta: (change.get(unit)?.delta ?? 0) + difference, wanted });
    }
  }
  const live = units(merged?.[column] ?? [], marked);
  return [...change].some(([unit, { delta, wanted }]) => {
    const present = live.get(unit) ?? 0;
    return merged === null ? delta !== 0 : delta > 0 && present < wanted || delta < 0 && present > wanted;
  });
}

function recordClashed(edits: readonly NativePendingEdit[], merged: NativeReadBeat | null): boolean {
  const values = new Map<string, { from: unknown; to: unknown }>();
  for (const { before, after } of edits) {
    if (!before || !after) continue;
    const keys = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
    keys.delete("updatedAt");
    keys.delete("updatedBy");
    for (const key of keys) {
      const from = Object.hasOwn(before.fields, key) ? before.fields[key] : undefined;
      const to = Object.hasOwn(after.fields, key) ? after.fields[key] : undefined;
      if (!sameNativeValue(from, to)) values.set(key, { from: values.has(key) ? values.get(key)?.from : from, to });
    }
  }
  return [...values].some(([key, { from, to }]) => !sameNativeValue(from, to) &&
    (!merged || !sameNativeValue(to, Object.hasOwn(merged.fields, key) ? merged.fields[key] : undefined)));
}

function splitLostText(mine: NativeSavedBeat, merged: NativeReadBeat): boolean {
  const wanted = textOf(mine.narration), shown = textOf(merged.narration);
  let matched = 0;
  for (let index = 0; index < shown.length; index++) if (wanted[matched] === shown[index]) matched++;
  return matched !== wanted.length;
}

export function compareNativeOfflineNotice(journal: NativePendingEditsData, reader: NativeScriptReader): readonly NativeOfflineClash[] {
  const pending = new Map<string, { edits: NativePendingEdit[]; last: NativePendingEdit }>();
  for (const edit of journal.entries) {
    const existing = pending.get(edit.id);
    if (existing) {
      existing.edits.push(edit);
      existing.last = edit;
    } else pending.set(edit.id, { edits: [edit], last: edit });
  }
  const order = reader.rankedOrder(), positions = new Map(order.map(({ id, kind }, index) => [kind + ":" + id, index]));
  const result: NativeOfflineClash[] = [];
  for (const [id, { edits, last }] of pending) {
    const mine = last.after, merged = reader.noticeBeat(id);
    const kinds: NativeClashKind[] = [];
    let near: string | undefined;
    if (mine) {
      if ((!merged && edits.some(edit => edit.inserted)) || cellClashed(edits, "narration", merged, false)) kinds.push("narration");
      if (cellClashed(edits, "visual", merged, false)) kinds.push("visual");
      if (cellClashed(edits, "narration", merged, true) || cellClashed(edits, "visual", merged, true)) kinds.push("marks");
      if (recordClashed(edits, merged)) kinds.push("record");
      const firstJoin = edits.find(({ before, after }) => before && after && !sameNativeValue(before.joined, after.joined))?.before;
      if (firstJoin && !sameNativeValue(firstJoin.joined, mine.joined) &&
        (!merged || merged.row !== mine.row || !sameNativeValue(merged.joined, mine.joined))) kinds.push("join");

      const split = edits.findLast(edit => edit.splitFrom);
      if (split?.splitFrom) {
        if (!merged || splitLostText(mine, merged)) kinds.push("split-text");
        const parent = positions.get("beat:" + split.splitFrom);
        if (merged && parent !== undefined && parent + 1 !== positions.get("beat:" + id)) {
          kinds.push("split-move");
          near = split.splitFrom;
        }
      }
      if (merged && edits.some(edit => edit.restored)) {
        const saved = textOf(mine.narration), live = textOf(merged.narration);
        if (saved && (live === saved + saved || live === "")) kinds.push("double-undo");
      }
    } else if (last.landing && !merged) {
      const landing = pending.get(last.landing.id)?.last.after ?? last.landing;
      const live = reader.noticeBeat(landing.id);
      const saved = textOf(landing.narration), shown = textOf(live?.narration ?? []);
      if (shown.length > saved.length && shown.startsWith(saved)) {
        kinds.push("displaced");
        near = landing.id;
      }
    }
    if (kinds.length) result.push(Object.freeze({ id, kinds: Object.freeze(kinds), mine, merged,
      possibleRemoval: mine !== null && merged === null, ...near === undefined ? {} : { near } }));
  }
  return Object.freeze(result);
}
