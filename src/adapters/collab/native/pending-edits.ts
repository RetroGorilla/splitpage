import type { NativeReadBeat, NativeScriptReader } from "./reader.ts";
import { deepFrozen, sameNativeValue } from "./values.ts";

export interface NativeBeatPlacement {
  readonly scene: string | null;
  readonly left: string | null;
  readonly right: string | null;
  readonly sceneOrder: readonly string[];
}

export interface NativeSavedBeat extends NativeReadBeat {
  readonly placement: NativeBeatPlacement;
}

export interface NativePendingEdit {
  readonly sequence: number;
  readonly id: string;
  readonly before: NativeSavedBeat | null;
  readonly after: NativeSavedBeat | null;
  readonly splitFrom?: string;
  readonly inserted?: true;
  readonly restored?: true;
  readonly landing?: NativeSavedBeat;
}

export interface NativePendingEditsData {
  readonly through: number;
  readonly entries: readonly NativePendingEdit[];
}

interface NativeJournalCommand {
  readonly created?: string;
  readonly split?: boolean;
  readonly undo?: boolean;
}

function placementOf(reader: NativeScriptReader) {
  const placements = new Map<string, NativeBeatPlacement>(), headings = new Map<string, string | null>();
  let scene: string | null = null, previous: string | null = null;
  let sceneOrder: string[] = [];
  for (const entry of reader.outline()) {
    if (entry.kind === "heading") {
      Object.freeze(sceneOrder);
      sceneOrder = [];
      headings.set(entry.id, previous);
      scene = entry.id;
      continue;
    }
    for (const id of reader.row(entry.id)?.members ?? []) {
      const left = previous === null ? undefined : placements.get(previous);
      if (left?.scene === scene && previous !== null) placements.set(previous, { ...left, right: id });
      placements.set(id, { scene, left: left?.scene === scene ? previous : null, right: null, sceneOrder });
      sceneOrder.push(id);
      previous = id;
    }
  }
  Object.freeze(sceneOrder);
  return { placements, headings };
}

export function openNativePendingEdits(reader: NativeScriptReader, saved?: NativePendingEditsData) {
  let through = saved?.through ?? 0, entries = deepFrozen(structuredClone(saved?.entries ?? [])).slice();
  let { placements, headings } = placementOf(reader);
  const beats = new Map<string, NativeReadBeat>(), rows = new Map<string, readonly string[]>();
  for (const entry of reader.outline()) {
    if (entry.kind === "row") updateRow(entry.id, new Map());
  }
  reader.refreshNoticeRows();

  function snapshot(id: string, position = placements): NativeSavedBeat | null {
    const beat = beats.get(id), placement = position.get(id);
    return beat && placement ? { ...beat, placement } : null;
  }

  function updateRow(row: string, before: Map<string, NativeSavedBeat | null>): boolean {
    const old = rows.get(row) ?? [], members = reader.row(row)?.members ?? [];
    for (const id of new Set([...old, ...members])) {
      if (!before.has(id)) before.set(id, snapshot(id));
      const beat = reader.noticeBeat(id);
      if (beat) beats.set(id, beat); else beats.delete(id);
    }
    if (members.length) rows.set(row, members); else rows.delete(row);
    return !sameNativeValue(old, members);
  }

  function sync(command?: NativeJournalCommand): void {
    const changes = reader.refreshNoticeRows(), before = new Map<string, NativeSavedBeat | null>();
    const previousHeadings = headings;
    let structural = changes.outline;
    for (const row of new Set([...changes.gone, ...changes.rows])) structural = updateRow(row, before) || structural;
    if (structural) ({ placements, headings } = placementOf(reader));
    if (!command) return;

    const edits: Omit<NativePendingEdit, "sequence">[] = [];
    for (const [id, old] of before) {
      const after = snapshot(id);
      if (sameNativeValue(old, after)) continue;
      const created = id === command.created, splitFrom = created && command.split ? after?.placement.left : null;
      const landing = command.undo || after || !old?.placement.left ? null : snapshot(old.placement.left);
      edits.push({ id, before: old, after, ...splitFrom && { splitFrom }, ...created && !command.split && { inserted: true },
        ...command.undo && !old && after && { restored: true }, ...landing && { landing } });
    }
    if (structural) for (const [id, above] of previousHeadings) {
      const landing = above === null || headings.has(id) ? null : snapshot(above);
      if (landing) edits.push({ id, before: null, after: null, landing });
    }
    if (!edits.length) return;
    through++;
    for (const edit of edits) entries.push(deepFrozen({ ...edit, sequence: through }));
  }

  return Object.freeze({
    sync,
    data: (): NativePendingEditsData => Object.freeze({ through, entries: Object.freeze(entries.slice()) }),
    clearThrough(confirmed: number): void {
      entries = entries.filter(entry => entry.sequence > confirmed);
    }
  });
}
