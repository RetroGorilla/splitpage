import * as Y from "yjs";
import type { CollabRoots } from "./roots.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedJson } from "./snapshot.ts";
import { readSharedRemovalCommand } from "./removal-record.ts";

export const SHARED_GALLERY_RETIREMENT_FIELD = "retired";
type RetirementRoots = Pick<CollabRoots, "beats" | "removalRecords">;
export interface SharedGalleryRetirement { readonly observed: string; readonly seen: readonly string[] }

// why: every write to a picture is a new library item, and the last item of a key keeps its id when older ones merge,
// so a change made anywhere in the picture, also one that only deletes, shows as a different list on every copy.
export function sharedGalleryObservation(record: Y.Map<unknown>): string {
  const entries: unknown[] = [];
  const walk = (map: Y.Map<unknown>, path: readonly string[]): void => {
    for (const key of [...map._map.keys()].sort()) {
      const item = map._map.get(key);
      if (!item || !path.length && key === SHARED_GALLERY_RETIREMENT_FIELD) continue;
      entries.push([...path, key, item.lastId.client, item.lastId.clock, item.deleted]);
      const value: unknown = item.deleted ? null : item.content.getContent()[0];
      if (value instanceof Y.Map) walk(value, [...path, key]);
    }
  };
  walk(record, []);
  return JSON.stringify(entries);
}

function removalKeys(roots: RetirementRoots, beat: unknown): string[] {
  const stored: unknown = typeof beat === "string" ? roots.beats.get(beat) : null, flags: unknown = stored instanceof Y.Map ? stored.get("removals") : null;
  return flags instanceof Y.Map ? [...flags.keys()].sort() : [];
}

function readRetirement(raw: unknown): SharedGalleryRetirement | null {
  const value = sharedJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { observed, seen } = value as Record<string, unknown>;
  if (typeof observed !== "string" || !Array.isArray(seen)) return null;
  const keys: string[] = [];
  for (let index = 0; index < seen.length; index++) {
    const key: unknown = seen[index];
    if (typeof key !== "string" || !isStableSharedIdentity(key)) return null;
    keys.push(key);
  }
  return { observed, seen: keys };
}

// why: an undone picture stays hidden only while it is as the undo saw it; a removal of its beat that still listed the
// picture was made without seeing the undo, so it brings the picture back with the beat.
export function isSharedGalleryRetired(roots: RetirementRoots, key: string, record: unknown): boolean {
  if (!(record instanceof Y.Map)) return false;
  const retirement = readRetirement(record.get(SHARED_GALLERY_RETIREMENT_FIELD));
  if (!retirement || sharedGalleryObservation(record) !== retirement.observed) return false;
  return !removalKeys(roots, record.get("beat")).some(removal => {
    const stored = retirement.seen.includes(removal) ? null : readSharedRemovalCommand(removal, roots.removalRecords.get(removal));
    return stored?.kind === "remove" && stored.gallery.includes(key);
  });
}

export function sharedGalleryRetirementValue(roots: RetirementRoots, record: Y.Map<unknown>): SharedGalleryRetirement {
  return { observed: sharedGalleryObservation(record), seen: removalKeys(roots, record.get("beat")) };
}

export function readSharedRetirementObservation(record: unknown): string | null {
  return record instanceof Y.Map ? readRetirement(record.get(SHARED_GALLERY_RETIREMENT_FIELD))?.observed ?? null : null;
}

export function isSharedGalleryShown(roots: RetirementRoots, key: string, record: unknown): boolean {
  return record instanceof Y.Map && !(record.has(SHARED_GALLERY_RETIREMENT_FIELD) && isSharedGalleryRetired(roots, key, record));
}

export function readSharedBeatPictures(roots: Pick<CollabRoots, "beats" | "removalRecords" | "gallery">, beat: string): readonly (readonly [string, Y.Map<unknown>])[] {
  const found: [string, Y.Map<unknown>][] = [];
  for (const [key, record] of roots.gallery.entries()) {
    if (record instanceof Y.Map && record.get("beat") === beat && isSharedGalleryShown(roots, key, record)) found.push([key, record]);
  }
  return found.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

export function readSharedStoredPicture(roots: Pick<CollabRoots, "gallery">, key: string): Y.Map<unknown> | null {
  const record = roots.gallery.get(key);
  return record instanceof Y.Map ? record : null;
}

interface PlannedScratch { readonly scratch: <T>(key: string, create: () => T) => T }
const planned = (view: PlannedScratch) => view.scratch("gallery-planned-retirement", () => new Map<string, boolean>());

// why: a staged write has no library item yet, so the list notes what each earlier operation did to the picture:
// a retirement hides it as it applies, and a restore or any field write makes the retirement no longer hold.
export function noteSharedPlannedPicture(view: PlannedScratch, key: string, retired: boolean): void {
  planned(view).set(key, retired);
}

export function isSharedPlannedPictureShown(view: PlannedScratch, key: string, stored: () => boolean): boolean {
  const noted = planned(view).get(key);
  return noted === undefined ? stored() : !noted;
}
