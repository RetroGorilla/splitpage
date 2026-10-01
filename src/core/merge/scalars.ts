import type { StateField } from "../document/fields.ts";
import { targetLengthOf } from "../document/timing.ts";
import type { TargetHolder } from "../document/timing.ts";
import type { MergeConflict } from "./rows.ts";

export type ScalarSide = Readonly<Record<string, unknown>>;

export interface TitleSide {
  title?: unknown;
}

export function mergeTitle(base: TitleSide | null | undefined, mine: TitleSide, theirs: TitleSide, conflicts: MergeConflict[]): unknown {
  let mergedTitle = theirs.title;
  if (base && mine.title !== base.title && theirs.title === base.title) {
    mergedTitle = mine.title;
  } else if (mine.title !== theirs.title && (!base || (mine.title !== base.title && theirs.title !== base.title))) {
    if (mine.title) conflicts.push({ rowId: null, field: "title", mine: mine.title, theirs: theirs.title });
  }
  return mergedTitle;
}

export function mergeChangedSideWins(f: StateField, base: ScalarSide | null | undefined, mine: ScalarSide, theirs: ScalarSide): unknown {
  const m = mine[f.key], t = theirs[f.key];
  const fallback = f.def ? f.def() : null;
  if (base && t === base[f.key] && m !== base[f.key]) return m || fallback;
  return t || m || fallback;
}

export function mergeMaxPlusOne(key: string, mine: ScalarSide, theirs: ScalarSide): number {
  return Math.max((theirs[key] || 0) as number, (mine[key] || 0) as number) + 1;
}

export function mergeTheirsWins(key: string, mine: ScalarSide, theirs: ScalarSide): unknown {
  return theirs[key] || mine[key] || null;
}

export function mergeTargetLength(base: TargetHolder | null | undefined, mine: TargetHolder, theirs: TargetHolder): number | null {
  const m = targetLengthOf(mine), t = targetLengthOf(theirs);
  if (m === t) return t;
  if (base) return t === targetLengthOf(base) ? m : t;
  return t !== null ? t : m;
}
