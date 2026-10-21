import type { KeyValueStorage } from "./conflict-stash.ts";

export const LEGACY_SNAPSHOTS_KEY = "splitpage-snapshots";

export interface LegacySnapshotsPorts {
  readonly storage: () => KeyValueStorage | null | undefined;
}

export interface LegacySnapshots {
  readonly readRaw: () => string | null;
  readonly remove: () => boolean;
}

export function createLegacySnapshots(ports: LegacySnapshotsPorts): LegacySnapshots {
  function storage(): KeyValueStorage {
    const found = ports.storage();
    if (!found) throw new Error("no local storage");
    return found;
  }

  return Object.freeze({
    readRaw: function (): string | null {
      try {
        const raw = storage().getItem(LEGACY_SNAPSHOTS_KEY);
        return typeof raw === "string" ? raw : null;
      } catch (e) { return null; }
    },
    remove: function (): boolean {
      try {
        storage().removeItem(LEGACY_SNAPSHOTS_KEY);
        return true;
      } catch (e) { return false; }
    }
  });
}
