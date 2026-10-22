import { isSha256Hex } from "../../../shared/blob-policy.js";
import { byId } from "../../core/merge/rows.ts";

const STASH_KEY = "splitpage-conflict-stash";
const RELOAD_GUARD_KEY = "splitpage-conflict-reloaded";
const STRIPPED_IMAGE = "__IMAGE__";

export interface KeyValueStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

export interface ConflictStashPorts {
  readonly storage: () => KeyValueStorage | null | undefined;
  readonly internImage: (dataUrl: string) => void;
}

export interface StashedWork {
  [field: string]: unknown;
  mine?: unknown;
  base?: unknown;
  blobs?: unknown;
  imagesStripped?: unknown;
}

export interface ConflictStash {
  readonly save: (payload: StashedWork) => boolean;
  readonly read: () => StashedWork | null;
  readonly clear: () => void;
  readonly accept: <T>(stash: T, theirs: unknown) => T;
  readonly dropReloadGuard: () => void;
}

interface StashRow {
  id: string;
  visualImage?: unknown;
  imageRef?: unknown;
}

function rowsOf(doc: unknown): unknown[] | null {
  const rows = doc && typeof doc === "object" ? (doc as { rows?: unknown }).rows : null;
  return Array.isArray(rows) ? rows : null;
}

export function createConflictStash(ports: ConflictStashPorts): ConflictStash {
  function storage(): KeyValueStorage {
    const found = ports.storage();
    if (!found) throw new Error("no session storage");
    return found;
  }

  function internBlobs(blobs: unknown): void {
    if (!blobs || typeof blobs !== "object") return;
    const table = blobs as Record<string, unknown>;
    Object.keys(table).forEach(function (sha) {
      const dataUrl = table[sha];
      if (isSha256Hex(sha) && typeof dataUrl === "string") ports.internImage(dataUrl);
    });
  }

  function restoreStrippedImages(stash: StashedWork, theirs: unknown): void {
    const theirRows = byId((rowsOf(theirs) || []) as StashRow[]);
    [stash.mine, stash.base].forEach(function (doc) {
      const rows = rowsOf(doc);
      if (!rows) return;
      rows.forEach(function (item) {
        const r = item as StashRow | null;
        if (!r || r.visualImage !== STRIPPED_IMAGE) return;
        const t = theirRows[r.id] as StashRow | undefined;
        delete r.visualImage;
        r.imageRef = t && t.imageRef ? JSON.parse(JSON.stringify(t.imageRef)) : null;
      });
    });
    delete stash.imagesStripped;
  }

  return Object.freeze({
    save: function (payload: StashedWork): boolean {
      try {
        storage().setItem(STASH_KEY, JSON.stringify(payload));
        return true;
      } catch (e) { return false; }
    },
    read: function (): StashedWork | null {
      try {
        const raw = storage().getItem(STASH_KEY);
        return raw ? JSON.parse(raw) as StashedWork : null;
      } catch (e) { return null; }
    },
    clear: function (): void {
      try { storage().removeItem(STASH_KEY); } catch (e) {}
    },
    accept: function <T>(stash: T, theirs: unknown): T {
      if (!stash || typeof stash !== "object") return stash;
      const work = stash as StashedWork;
      internBlobs(work.blobs);
      if (work.imagesStripped) restoreStrippedImages(work, theirs);
      return stash;
    },
    dropReloadGuard: function (): void {
      try { storage().removeItem(RELOAD_GUARD_KEY); } catch (e) {}
    }
  });
}
