export type NoticeValue = null | boolean | number | string | readonly NoticeValue[] | { readonly [key: string]: NoticeValue };
export type NoticeFields = Readonly<Record<string, NoticeValue>>;
export interface NoticeRun {
  readonly insert: string | NoticeFields;
  readonly marks?: NoticeFields;
}

export interface NoticeBeat {
  readonly id: string | null;
  readonly scene: string | null;
  readonly row: string | null;
  readonly narration: readonly NoticeRun[];
  readonly visual: readonly NoticeRun[];
  readonly status: NoticeValue;
  readonly fields: NoticeFields;
}

export type NoticeReading = readonly NoticeBeat[];
export type ClashKind = "narration" | "visual" | "marks" | "record" | "join" | "split-text" |
  "split-move" | "double-undo" | "displaced";

export interface NoticeClash {
  readonly kind: ClashKind;
  readonly id: string;
  readonly mine: NoticeBeat | null;
  readonly merged: NoticeBeat | null;
  readonly near?: string;
}

export type NoticeLocalChange =
  | { kind: "narration" | "visual"; id: string; text: string; erased?: true }
  | { kind: "marks"; id: string; column: "narration" | "visual"; mark: string }
  | { kind: "record"; id: string; field: string }
  | { kind: "join" | "double-undo"; id: string }
  | { kind: "split"; id: string; parent: string }
  | { kind: "displaced"; id: string; above: string };

type NoticePart = "visual-marks" | "record-fields";

export const clashLine: Readonly<Record<ClashKind, string>> = {
  narration: "A beat you changed in narration was removed. Your wording may still be in another row.",
  visual: "A visual edit is missing from the shared script.",
  marks: "Formatting or a tag you applied is missing from the shared script.",
  record: "A change you made to a beat's details is missing from the shared script.",
  join: "A join or separation you made no longer shows as it did on your copy.",
  "split-text": "Part of the narration is missing from a beat you split off.",
  "split-move": "The beat you split off is now apart from its first half.",
  "double-undo": "This beat's narration changed. Check for repeated or missing words.",
  displaced: "A beat you removed may have left someone else's narration in the row above."
};

export function plainNoticeText(runs: readonly NoticeRun[]): string {
  return runs.map(run => typeof run.insert === "string" ? run.insert : "\uFFFC").join("");
}

export function noticeKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return "[" + value.map(noticeKey).join(",") + "]";
  return "{" + Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => JSON.stringify(key) + ":" + noticeKey(entry)).join(",") + "}";
}

function same(left: unknown, right: unknown): boolean {
  return left === right || noticeKey(left) === noticeKey(right);
}

function addsText(before: readonly NoticeRun[], after: readonly NoticeRun[]): boolean {
  const hasAtom = (runs: readonly NoticeRun[]) => runs.some(run => typeof run.insert !== "string");
  const units = (runs: readonly NoticeRun[]) => runs.flatMap(run => typeof run.insert === "string"
    ? run.insert.split("") : ["embed " + noticeKey(run.insert)]);
  const rich = hasAtom(before) || hasAtom(after);
  const previous = rich ? units(before) : plainNoticeText(before), next = rich ? units(after) : plainNoticeText(after);
  if (previous === next) return false;
  let matched = 0;
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] === next[matched]) matched++;
  }
  return matched !== next.length;
}

function marks(runs: readonly NoticeRun[]) {
  return runs.flatMap(run =>
    Array.from({ length: typeof run.insert === "string" ? run.insert.length : 1 }, () => run.marks ?? {}));
}

function addsMarks(before: readonly NoticeRun[], after: readonly NoticeRun[]): boolean {
  if (!before.some(run => run.marks) && !after.some(run => run.marks)) return false;
  return plainNoticeText(before) === plainNoticeText(after)
    ? !same(marks(before), marks(after))
    : after.some(run => run.marks && !before.some(old => same(old.marks, run.marks)));
}

function editsMissing<T>(base: readonly T[], mine: readonly T[], merged: readonly T[], includeErases = false): boolean {
  const counts = (values: readonly T[]) => {
    const result = new Map<T, number>();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  };
  const old = counts(base), saved = counts(mine), live = counts(merged);
  for (const [value, count] of saved) {
    if (count > (old.get(value) ?? 0) && count > (live.get(value) ?? 0)) return true;
  }
  if (includeErases) for (const [value, count] of old) {
    const retained = saved.get(value) ?? 0;
    if (retained < count && retained < (live.get(value) ?? 0)) return true;
  }
  return false;
}

function visualUnits(runs: readonly NoticeRun[]): string[] {
  return runs.flatMap(run => typeof run.insert === "string" ? [...run.insert] : ["embed " + noticeKey(run.insert)]);
}

function losesVisual(base: readonly NoticeRun[], mine: readonly NoticeRun[], merged: readonly NoticeRun[]): boolean {
  const textOnly = (runs: readonly NoticeRun[]) => runs.every(run => typeof run.insert === "string");
  if (plainNoticeText(base) === plainNoticeText(mine) && textOnly(base) && textOnly(mine)) return false;
  return editsMissing(visualUnits(base), visualUnits(mine), visualUnits(merged), true);
}

function markedUnits(runs: readonly NoticeRun[], name?: string): string[] {
  return runs.flatMap(run => Object.entries(run.marks ?? {}).flatMap(([key, value]) =>
    name === undefined || key === name ? visualUnits([run]).map(unit => noticeKey([unit, key, value])) : []));
}

function losesMarks(base: readonly NoticeRun[], mine: readonly NoticeRun[], merged: readonly NoticeRun[]): boolean {
  return mine.some(run => run.marks) && editsMissing(markedUnits(base), markedUnits(mine), markedUnits(merged));
}

function losesRecord(base: NoticeBeat | undefined, mine: NoticeBeat, merged: NoticeBeat | undefined, fields: boolean): boolean {
  if (!same(base ? base.status : null, mine.status) && (!merged || !same(mine.status, merged.status))) return true;
  if (!fields) return false;
  const keys = new Set([...Object.keys(base?.fields ?? {}), ...Object.keys(mine.fields)]);
  keys.delete("joined");
  return [...keys].some(key => !same(base?.fields[key], mine.fields[key]) && (!merged || !same(mine.fields[key], merged.fields[key])));
}

function fitsDoubleUndo(saved: NoticeBeat, live: NoticeBeat): boolean {
  const original = plainNoticeText(saved.narration), current = plainNoticeText(live.narration);
  return original !== "" && (current === original + original || current === "");
}

function hasSuffix(before: NoticeBeat | undefined, after: NoticeBeat | undefined): boolean {
  if (!before || !after) return false;
  const text = plainNoticeText(before.narration), settled = plainNoticeText(after.narration);
  return settled.length > text.length && settled.startsWith(text);
}

function changedFields(before: NoticeBeat, after: NoticeBeat): boolean {
  const keys = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
  keys.delete("joined");
  return !same(before.status, after.status) || [...keys].some(key => !same(before.fields[key], after.fields[key]));
}

function byBeat(reading: NoticeReading): Map<string, NoticeBeat> {
  return new Map(reading.flatMap(beat => beat.id === null ? [] : [[beat.id, beat] as const]));
}

export function compareNotices(
  base: NoticeReading, mine: NoticeReading, merged: NoticeReading,
  include: (kind: ClashKind) => boolean = () => true,
  includePart: (part: NoticePart) => boolean = () => true
): NoticeClash[] {
  const initial = byBeat(base), local = byBeat(mine), final = byBeat(merged);
  const previous = new Map<string, NoticeBeat | undefined>();
  mine.forEach((beat, index) => { if (beat.id !== null) previous.set(beat.id, mine[index - 1]); });
  const positions = new Map(merged.map((beat, index) => [beat.id, index]));
  const clashes: NoticeClash[] = [];
  function add(kind: ClashKind, id: string, near?: string): void {
    if (include(kind)) clashes.push({ kind, id, mine: local.get(id) ?? null, merged: final.get(id) ?? null,
      ...(near === undefined ? {} : { near }) });
  }

  for (const [id, saved] of local) {
    const old = initial.get(id), live = final.get(id);
    if (!live) {
      if (addsText(old?.narration ?? [], saved.narration)) add("narration", id);
      if (addsText(old?.visual ?? [], saved.visual)) add("visual", id);
      if (addsMarks(old?.narration ?? [], saved.narration) ||
        (includePart("visual-marks") && addsMarks(old?.visual ?? [], saved.visual))) add("marks", id);
      if (losesRecord(old, saved, undefined, includePart("record-fields"))) add("record", id);
      if (old ? !same(old.fields.joined, saved.fields.joined) : saved.fields.joined !== undefined) add("join", id);
      continue;
    }
    if (old) {
      if (losesVisual(old.visual, saved.visual, live.visual)) add("visual", id);
      if (losesMarks(old.narration, saved.narration, live.narration) ||
        (includePart("visual-marks") && losesMarks(old.visual, saved.visual, live.visual))) add("marks", id);
      if (losesRecord(old, saved, live, includePart("record-fields"))) add("record", id);
    }
    if (saved.row !== live.row && saved.fields.joined !== undefined &&
      (!same(old?.fields.joined, saved.fields.joined) || old?.row !== saved.row ||
        (typeof saved.fields.joined === "object" && saved.fields.joined !== null &&
          "into" in saved.fields.joined && typeof saved.fields.joined.into === "string" && !final.has(saved.fields.joined.into)))) add("join", id);
    if (old && same(old.narration, saved.narration) && fitsDoubleUndo(saved, live)) add("double-undo", id);
    if (old) continue;
    if (addsText(live.narration, saved.narration)) add("split-text", id);
    const parent = previous.get(id), parentId = parent?.id;
    const oldParent = parentId ? initial.get(parentId) : undefined;
    const parentPosition = parentId ? positions.get(parentId) : undefined;
    if (parentId && oldParent && parentPosition !== undefined &&
      parent.scene === saved.scene && plainNoticeText(parent.narration) + plainNoticeText(saved.narration) ===
      plainNoticeText(oldParent.narration) &&
      parentPosition + 1 !== positions.get(id)) add("split-move", id, parentId);
  }

  for (const [index, removed] of base.entries()) {
    const above = base[index - 1];
    if (!removed.id || !above?.id || local.has(removed.id) || final.has(removed.id)) continue;
    if (hasSuffix(local.get(above.id), final.get(above.id))) add("displaced", removed.id, above.id);
  }
  return clashes;
}

export function compareLocalChanges(mine: NoticeReading, merged: NoticeReading, changes: readonly NoticeLocalChange[]): NoticeClash[] {
  const local = byBeat(mine), final = byBeat(merged);
  const positions = new Map(merged.map((beat, index) => [beat.id, index]));
  const clashes = new Map<string, NoticeClash>();
  for (const change of changes) {
    const { id } = change, saved = local.get(id), live = final.get(id);
    function add(kind: ClashKind, near?: string): void {
      clashes.set(kind + "/" + id, { kind, id, mine: saved ?? null, merged: live ?? null,
        ...(near === undefined ? {} : { near }) });
    }
    if (change.kind === "displaced") {
      if (!saved && !live && hasSuffix(local.get(change.above), final.get(change.above))) add("displaced", change.above);
      continue;
    }
    if (!saved) continue;
    switch (change.kind) {
      case "narration":
      case "visual": {
        const count = (beat: NoticeBeat) => plainNoticeText(beat[change.kind]).split(change.text).length - 1;
        if (change.erased) {
          if (change.text && live && count(live) > count(saved)) add(change.kind);
          break;
        }
        if (change.text && count(saved) > 0 && (!live || (change.kind === "visual" && count(live) < count(saved)))) add(change.kind);
        break;
      }
      case "marks":
        if (!live || editsMissing([], markedUnits(saved[change.column], change.mark), markedUnits(live[change.column], change.mark))) add("marks");
        break;
      case "record": {
        const value = (beat: NoticeBeat) => change.field === "status" ? beat.status : beat.fields[change.field];
        if (!live || !same(value(saved), value(live))) add("record");
        break;
      }
      case "join":
        if (!live || live.row !== saved.row || !same(live.fields.joined, saved.fields.joined)) add("join");
        break;
      case "split": {
        if (live && addsText(live.narration, saved.narration)) add("split-text");
        const parent = positions.get(change.parent);
        if (live && parent !== undefined && parent + 1 !== positions.get(id)) add("split-move", change.parent);
        break;
      }
      case "double-undo":
        if (live && fitsDoubleUndo(saved, live)) add("double-undo");
        break;
    }
  }
  return [...clashes.values()];
}

export function remoteRemoved(before: NoticeReading, after: NoticeReading, edited: ReadonlySet<string>): string[] {
  const final = byBeat(after);
  return before.flatMap(beat => beat.id !== null && edited.has(beat.id) && !final.has(beat.id) ? [beat.id] : []);
}

export function reviewStillOpen(clash: NoticeClash, current: NoticeReading, restoredId?: string): boolean {
  const rows = byBeat(current);
  if (restoredId !== undefined && rows.has(restoredId)) return false;
  const live = rows.get(clash.id), saved = clash.mine;
  if (!saved) return !live;
  if (!live) return true;
  switch (clash.kind) {
    case "visual": return !same(saved.visual, live.visual);
    case "record": return changedFields(saved, live);
    case "join": return saved.row !== live.row || !same(saved.fields.joined, live.fields.joined);
    case "marks": return !same(marks(saved.narration), marks(live.narration)) || !same(marks(saved.visual), marks(live.visual));
    case "split-move": return current[current.indexOf(live) - 1]?.id !== clash.near;
    default: return !same(saved.narration, live.narration);
  }
}
