import { bindBulkTagRows } from "../../application/commands/bulk-tags.ts";
import type { BulkTagPorts } from "../../application/commands/bulk-tags.ts";
import { cacheSeal } from "../cache-freeze.ts";
import { productionReaders } from "../document-ports.ts";
import { startProductionIndex } from "../../application/production/index-owner.ts";

export function wireProductionIndex(bulkTags: BulkTagPorts): () => void {
  const stop = startProductionIndex(productionReaders, cacheSeal);
  bindBulkTagRows(bulkTags);
  return stop;
}
