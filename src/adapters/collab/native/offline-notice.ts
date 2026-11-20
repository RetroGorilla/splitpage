import { tagStack } from "../../../core/text/runs.ts";
import type { Run } from "../../../core/text/runs.ts";
import type { NativePendingEdit, NativeSavedBeat } from "./pending-edits.ts";
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

function cellClashed(before: readonly Run[], mine: readonly Run[], merged: readonly Run[] | undefined, marked: boolean): boolean {
  const old = units(before, marked), saved = units(mine, marked), live = units(merged ?? [], marked);
  for (const unit of new Set([...old.keys(), ...saved.keys()])) {
    const wanted = saved.get(unit) ?? 0, delta = wanted - (old.get(unit) ?? 0), present = live.get(unit) ?? 0;
    if (merged === undefined ? delta !== 0 : delta > 0 && present < wanted || delta < 0 && present > wanted) return true;
  }
  return false;
}

function recordClashed(before: NativeReadBeat, mine: NativeSavedBeat, merged: NativeReadBeat | null): boolean {
  const keys = new Set([...Object.keys(before.fields), ...Object.keys(mine.fields)]);
  keys.delete("updatedAt");
  keys.delete("updatedBy");
  const value = (beat: NativeReadBeat, key: string) => Object.hasOwn(beat.fields, key) ? beat.fields[key] : undefined;
  return [...keys].some(key => !sameNativeValue(value(before, key), value(mine, key)) &&
    (!merged || !sameNativeValue(value(mine, key), value(merged, key))));
}

function splitLostText(mine: NativeSavedBeat, merged: NativeReadBeat): boolean {
  const wanted = textOf(mine.narration), shown = textOf(merged.narration);
  let matched = 0;
  for (let index = 0; index < shown.length; index++) if (wanted[matched] === shown[index]) matched++;
  return matched !== wanted.length;
}

export function compareNativeOfflineNotice(edits: readonly NativePendingEdit[], reader: NativeScriptReader): readonly NativeOfflineClash[] {
  const pending = edits.filter(entry => entry.peer);
  if (!pending.length) return [];
  const order = reader.rankedOrder(), positions = new Map(order.map(({ id, kind }, index) => [kind + ":" + id, index]));
  const result: NativeOfflineClash[] = [], displaced = new Map<string, { entry: NativePendingEdit; clash: NativeOfflineClash }>();
  for (const entry of pending) {
    const { id, before, after: mine, landing, split } = entry;
    const merged = entry.heading ? null : reader.noticeBeat(id);
    const kinds: NativeClashKind[] = [];
    let near: string | undefined;
    if (mine) {
      if (entry.created !== undefined && !merged || before && cellClashed(before.narration, mine.narration, merged?.narration, false)) kinds.push("narration");
      if (before) {
        if (cellClashed(before.visual, mine.visual, merged?.visual, false)) kinds.push("visual");
        if (cellClashed(before.narration, mine.narration, merged?.narration, true) ||
          cellClashed(before.visual, mine.visual, merged?.visual, true)) kinds.push("marks");
        if (recordClashed(before, mine, merged)) kinds.push("record");
        if (!sameNativeValue(before.joined, mine.joined) &&
          (!merged || merged.row !== mine.row || !sameNativeValue(merged.joined, mine.joined))) kinds.push("join");
      }

      if (split) {
        if (!merged || splitLostText(mine, merged)) kinds.push("split-text");
        const parent = positions.get("beat:" + split.parent);
        if (merged && mine.placement.left === split.parent && parent !== undefined && parent + 1 !== positions.get("beat:" + id)) {
          kinds.push("split-move");
          near = split.parent;
        }
      }
      if (merged && entry.restored !== undefined) {
        const saved = textOf(mine.narration), live = textOf(merged.narration);
        if (live !== saved && (live === saved + saved || live === "")) kinds.push("double-undo");
      }
    } else if (landing && !merged && (!entry.heading || !positions.has("heading:" + id))) {
      const live = reader.noticeBeat(landing.id);
      const saved = textOf(landing.narration), shown = textOf(live?.narration ?? []);
      if (shown.length > saved.length && shown.startsWith(saved)) {
        kinds.push("displaced");
        near = landing.id;
      }
    }
    if (!kinds.length) continue;
    const clash = Object.freeze({ id, kinds: Object.freeze(kinds), mine, merged,
      possibleRemoval: mine !== null && merged === null, ...near === undefined ? {} : { near } });
    if (landing && kinds.includes("displaced")) {
      const prior = displaced.get(landing.id);
      if (!prior || prior.entry.heading && !entry.heading) displaced.set(landing.id, { entry, clash });
    } else result.push(clash);
  }
  return Object.freeze(result.concat([...displaced.values()].map(({ clash }) => clash)));
}
