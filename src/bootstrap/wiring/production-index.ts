import { createBulkTagRows } from "../../application/commands/bulk-tags.ts";
import type { BulkTagPorts, BulkTagRows } from "../../application/commands/bulk-tags.ts";
import { cacheSeal } from "../cache-freeze.ts";
import { productionReaders } from "../document-ports.ts";
import { startProductionIndex } from "../../application/production/index-owner.ts";

let tagger: BulkTagRows | null = null;

export function wireProductionIndex(bulkTags: BulkTagPorts): () => void {
  const stop = startProductionIndex(productionReaders, cacheSeal);
  const mine = createBulkTagRows(bulkTags);
  tagger = mine;
  return () => {
    if (tagger === mine) tagger = null;
    stop();
  };
}

export const bulkTagRows: BulkTagRows = (rows, phrase, cat, name, matchCase, countOnly) => {
  if (!tagger) throw new Error("The bulk tagger is not started yet");
  return tagger(rows, phrase, cat, name, matchCase, countOnly);
};
