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

export const clashLine: Readonly<Record<ClashKind, string>> = {
  narration: "A beat you changed in narration was removed. Your wording may still be in another row.",
  visual: "A beat you changed in the visual column was removed.",
  marks: "A beat you formatted or tagged was removed.",
  record: "A beat whose details you changed was removed.",
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
  include: (kind: ClashKind) => boolean = () => true
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
      if (addsMarks(old?.narration ?? [], saved.narration) || addsMarks(old?.visual ?? [], saved.visual)) add("marks", id);
      if (old ? changedFields(old, saved) : saved.status !== null || Object.keys(saved.fields).some(key => key !== "joined")) add("record", id);
      if (old ? !same(old.fields.joined, saved.fields.joined) : saved.fields.joined !== undefined) add("join", id);
      continue;
    }
    if (saved.row !== live.row && saved.fields.joined !== undefined &&
      (!same(old?.fields.joined, saved.fields.joined) || old?.row !== saved.row ||
        (typeof saved.fields.joined === "object" && saved.fields.joined !== null &&
          "into" in saved.fields.joined && typeof saved.fields.joined.into === "string" && !final.has(saved.fields.joined.into)))) add("join", id);
    if (old && same(old.narration, saved.narration)) {
      const original = plainNoticeText(saved.narration), current = plainNoticeText(live.narration);
      if (original && (current === original + original || current === "")) add("double-undo", id);
    }
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
    const before = local.get(above.id), after = final.get(above.id);
    if (!before || !after) continue;
    const text = plainNoticeText(before.narration), settled = plainNoticeText(after.narration);
    if (settled.length > text.length && settled.startsWith(text)) add("displaced", removed.id, above.id);
  }
  return clashes;
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
