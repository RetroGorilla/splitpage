import { bindBulkTagRows } from "../../application/commands/bulk-tags.ts";
import type { BulkTagPorts } from "../../application/commands/bulk-tags.ts";
import { cacheSeal } from "../../legacy/cache-freeze.ts";
import { productionReaders } from "../../legacy/document-ports.ts";
import { startProductionIndex } from "../../legacy/production-index-bridge.ts";

export function wireProductionIndex(bulkTags: BulkTagPorts): () => void {
  const stop = startProductionIndex(productionReaders, cacheSeal);
  bindBulkTagRows(bulkTags);
  return stop;
}
