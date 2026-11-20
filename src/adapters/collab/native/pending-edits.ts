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

interface PendingBeat {
  readonly id: string;
  first: number;
  last: number;
  before: NativeReadBeat | null;
  split?: { readonly parent: string; readonly at: number };
  created?: number;
  restored?: number;
  landingId?: string;
  heading?: true;
}

export interface NativePendingEdit extends Readonly<PendingBeat> {
  readonly after: NativeSavedBeat | null;
  readonly landing: NativeReadBeat | null;
  readonly peer: boolean;
}

interface EncodedPendingEdit extends Omit<NativePendingEdit, "after"> {
  readonly after: (NativeReadBeat & {
    readonly placement: Omit<NativeBeatPlacement, "sceneOrder"> & { readonly order: number };
  }) | null;
}

export interface NativePendingEditsData {
  readonly through: number;
  readonly entries: readonly EncodedPendingEdit[];
  readonly orders?: readonly (readonly string[])[];
  readonly checkpoint?: {
    readonly through: number;
    readonly beats: readonly (readonly [string, NativeReadBeat | null])[];
  };
}

interface NativeJournalCommand {
  readonly created?: string;
  readonly split?: boolean;
  readonly press?: "undo" | "redo";
}

interface Reading {
  readonly after: NativeSavedBeat | null;
  readonly landing: NativeReadBeat | null;
}

function placementOf(reader: NativeScriptReader) {
  const placements = new Map<string, NativeBeatPlacement>(), headings = new Map<string, string>();
  let scene: string | null = null, previous: string | null = null;
  let sceneOrder: string[] = [];
  for (const entry of reader.outline()) {
    if (entry.kind === "heading") {
      Object.freeze(sceneOrder);
      sceneOrder = [];
      if (previous !== null) headings.set(entry.id, previous);
      scene = entry.id;
      continue;
    }
    for (const id of reader.row(entry.id)?.members ?? []) {
      const left = sceneOrder.at(-1) ?? null;
      const prior = left === null ? undefined : placements.get(left);
      if (left !== null && prior) placements.set(left, { ...prior, right: id });
      placements.set(id, { scene, left, right: null, sceneOrder });
      sceneOrder.push(id);
      previous = id;
    }
  }
  Object.freeze(sceneOrder);
  return { placements, headings };
}

export function openNativePendingEdits(reader: NativeScriptReader, saved?: NativePendingEditsData) {
  const restored = deepFrozen(structuredClone(saved));
  let through = restored?.through ?? 0, checkpoint = restored?.checkpoint;
  let { placements, headings } = placementOf(reader);
  const beats = new Map<string, NativeReadBeat>();
  const entries = new Map<string, PendingBeat>(), held = new Map<string, Reading>();
  for (const id of placements.keys()) updateBeat(id);
  reader.refreshNotice();
  for (const { after, landing, peer, ...entry } of restored?.entries ?? []) {
    const key = entry.heading ? "h:" + entry.id : "b:" + entry.id;
    entries.set(key, entry);
    if (peer) {
      const saved = after && {
        ...after, placement: { scene: after.placement.scene, left: after.placement.left, right: after.placement.right,
          sceneOrder: restored?.orders?.[after.placement.order] ?? [] }
      };
      held.set(key, { after: saved, landing });
    }
  }

  function reading(entry: PendingBeat): Reading {
    const beat = entry.heading ? undefined : beats.get(entry.id), placement = placements.get(entry.id);
    return {
      after: beat && placement ? { ...beat, placement } : null,
      landing: entry.landingId === undefined ? null : beats.get(entry.landingId) ?? null
    };
  }

  function updateBeat(id: string): NativeReadBeat | null {
    const beat = reader.noticeBeat(id);
    if (beat) beats.set(id, beat); else beats.delete(id);
    return beat;
  }

  function note(key: string, id: string, old: NativeReadBeat | null): PendingBeat {
    const entry = entries.get(key) ?? { id, first: through + 1, last: through + 1, before: old };
    entry.last = through + 1;
    entries.set(key, entry);
    held.delete(key);
    return entry;
  }

  function pending(): NativePendingEdit[] {
    return [...entries].map(([key, entry]) => ({ ...entry, ...(held.get(key) ?? reading(entry)), peer: held.has(key) }));
  }

  function sync(command?: NativeJournalCommand): void {
    const changes = reader.refreshNotice(), oldPlacements = placements, oldHeadings = headings;
    if (changes.layout) ({ placements, headings } = placementOf(reader));

    let edited = false;
    for (const id of changes.beats) {
      const old = beats.get(id) ?? null, after = updateBeat(id);
      if (!command) continue;
      if (sameNativeValue(old, after) && sameNativeValue(oldPlacements.get(id), placements.get(id))) continue;
      const entry = note("b:" + id, id, old);
      const parent = placements.get(id)?.left;
      if (id === command.created && command.split && parent) {
        entry.split = { parent, at: entry.last };
        entry.before = after;
      }
      if (id === command.created && !command.split || command.press === "redo" && !old && after) entry.created = entry.last;
      if (command.press === "undo" && !old && after) entry.restored = entry.last;
      const above = oldPlacements.get(id)?.left;
      if (!after && command.press !== "undo" && above) entry.landingId = above;
      else delete entry.landingId;
      edited = true;
    }
    if (command && changes.layout) for (const [id, above] of oldHeadings) {
      if (headings.has(id)) continue;
      const entry = note("h:" + id, id, null);
      entry.heading = true;
      entry.landingId = above;
      edited = true;
    }
    if (edited) through++;
  }

  return Object.freeze({
    sync,
    pending,
    peer(): void {
      for (const [key, entry] of entries) if (!held.has(key)) held.set(key, reading(entry));
    },
    data(): NativePendingEditsData {
      const indexes = new Map<readonly string[], number>();
      const packed = pending().map(({ after, ...entry }) => {
        if (!after) return { ...entry, after: null };
        const { sceneOrder, ...placement } = after.placement;
        const order = indexes.get(sceneOrder) ?? indexes.size;
        indexes.set(sceneOrder, order);
        return { ...entry, after: { ...after, placement: { ...placement, order } } };
      });
      return deepFrozen({
        through, entries: packed, ...indexes.size && { orders: [...indexes.keys()] }, ...checkpoint && { checkpoint }
      });
    },
    confirmationPoint(): number {
      if (!entries.size) return through;
      if (!checkpoint) checkpoint = { through, beats: [...entries].map(([key, entry]) => {
        const after = (held.get(key) ?? reading(entry)).after;
        if (!after) return [key, null] as const;
        const { id, row, narration, visual, fields, joined } = after;
        return [key, { id, row, narration, visual, fields, joined }] as const;
      }) };
      return checkpoint.through;
    },
    clearThrough(confirmed: number): void {
      const confirmedBeats = new Map(checkpoint && confirmed >= checkpoint.through ? checkpoint.beats : []);
      if (checkpoint && confirmed >= checkpoint.through) checkpoint = undefined;
      for (const [key, entry] of entries) {
        if (entry.last <= confirmed) {
          entries.delete(key);
          held.delete(key);
        } else if (entry.first <= confirmed) {
          entry.first = confirmed + 1;
          if (confirmedBeats.has(key)) entry.before = confirmedBeats.get(key) ?? null;
          if (entry.split && entry.split.at <= confirmed) delete entry.split;
          if (entry.created !== undefined && entry.created <= confirmed) delete entry.created;
          if (entry.restored !== undefined && entry.restored <= confirmed) delete entry.restored;
        }
      }
    }
  });
}
