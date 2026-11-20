import type { Run } from "../../../core/text/runs.ts";
import { currentNoticeEffects, noticeCellClashed } from "./notice-effects.ts";
import type { NativeNoticeEffects } from "./notice-effects.ts";
import type { NativePendingEdit, NativeSavedBeat } from "./pending-edits.ts";
import type { NativeReadBeat, NativeScriptReader } from "./reader.ts";
import { deepFrozen, sameNativeValue } from "./values.ts";

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

function savedReading(mine: NativeSavedBeat, effects: NativeNoticeEffects): NativeSavedBeat {
  const fields = new Map(Object.entries(mine.fields));
  for (const [key, change] of effects.fields ?? []) {
    if (change.after === undefined) fields.delete(key);
    else fields.set(key, change.after);
  }
  return deepFrozen({ ...mine, fields: Object.fromEntries(fields), joined: effects.join ? effects.join.after : mine.joined,
    narration: effects.narration?.reading ?? mine.narration, visual: effects.visual?.reading ?? mine.visual });
}

function splitLostText(mine: NativeSavedBeat, merged: NativeReadBeat): boolean {
  const wanted = textOf(mine.narration), shown = textOf(merged.narration);
  let matched = 0;
  for (let index = 0; index < shown.length; index++) if (wanted[matched] === shown[index]) matched++;
  return matched !== wanted.length;
}

export function compareNativeOfflineNotice(edits: readonly NativePendingEdit[], reader: NativeScriptReader): readonly NativeOfflineClash[] {
  const pending = edits.filter(entry => entry.peer || entry.periods?.peer);
  if (!pending.length) return [];
  const order = reader.rankedOrder(), positions = new Map(order.map(({ id, kind }, index) => [kind + ":" + id, index]));
  const result: NativeOfflineClash[] = [], displaced = new Map<string, { entry: NativePendingEdit; clash: NativeOfflineClash }>();
  for (const entry of pending) {
    const { id, before, after, landing, split } = entry;
    const merged = entry.heading ? null : reader.noticeBeat(id);
    const kinds: NativeClashKind[] = [];
    let near: string | undefined;
    const effects = currentNoticeEffects(before, after, entry.periods);
    if (after) {
      if (entry.created !== undefined && !merged || noticeCellClashed(effects.narration, merged?.narration, false)) kinds.push("narration");
      if (noticeCellClashed(effects.visual, merged?.visual, false)) kinds.push("visual");
      if (noticeCellClashed(effects.narration, merged?.narration, true) ||
        noticeCellClashed(effects.visual, merged?.visual, true)) kinds.push("marks");
      if (effects.fields?.some(([key, change]) => !merged ||
        !sameNativeValue(change.after, Object.hasOwn(merged.fields, key) ? merged.fields[key] : undefined))) kinds.push("record");
      if (effects.join && (!merged || merged.row !== after.row || !sameNativeValue(merged.joined, effects.join.after))) kinds.push("join");

      if (split) {
        if (!merged || splitLostText(after, merged)) kinds.push("split-text");
        const parent = positions.get("beat:" + split.parent);
        if (merged && after.placement.left === split.parent && parent !== undefined && parent + 1 !== positions.get("beat:" + id)) {
          kinds.push("split-move");
          near = split.parent;
        }
      }
      if (merged && entry.restored !== undefined) {
        const saved = textOf(after.narration), live = textOf(merged.narration);
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
    const clash = Object.freeze({ id, kinds: Object.freeze(kinds), mine: after ? savedReading(after, effects) : null, merged,
      possibleRemoval: after !== null && merged === null, ...near === undefined ? {} : { near } });
    if (landing && kinds.includes("displaced")) {
      const prior = displaced.get(landing.id);
      if (!prior || prior.entry.heading && !entry.heading) displaced.set(landing.id, { entry, clash });
    } else result.push(clash);
  }
  return Object.freeze(result.concat([...displaced.values()].map(({ clash }) => clash)));
}
