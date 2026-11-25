import type { SharedScriptCatalogueEntry } from "../../../shared/shared-script.ts";

export interface SharedScriptCatalogueStorage {
  readonly list: () => Promise<readonly SharedScriptCatalogueEntry[]>;
  readonly note: (entry: SharedScriptCatalogueEntry) => Promise<void>;
}

export function createSharedScriptCatalogue(storage: SharedScriptCatalogueStorage, now: () => number) {
  return {
    async list(): Promise<readonly SharedScriptCatalogueEntry[]> {
      return [...await storage.list()].sort((a, b) => b.at - a.at);
    },
    note(entry: Omit<SharedScriptCatalogueEntry, "at">): Promise<void> {
      return storage.note({ ...entry, at: now() });
    }
  };
}
