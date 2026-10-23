import { bindBulkTagRows } from "../../application/commands/bulk-tags.ts";
import { cacheSeal } from "../../legacy/cache-freeze.ts";
import { productionReaders } from "../../legacy/document-ports.ts";
import { startProductionIndex } from "../../legacy/production-index-bridge.ts";
import { stampRow } from "../../js/03-sync.js";
import { bulkTagCell } from "../../js/07-production-tags.js";

export function wireProductionIndex(): () => void {
  const stop = startProductionIndex(productionReaders, cacheSeal);
  bindBulkTagRows({ cell: bulkTagCell, stamp: stampRow });
  return stop;
}