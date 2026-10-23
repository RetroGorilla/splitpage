import { createRecordsReconciler } from "../../application/production/broll-records.ts";
import type { RecordsReconciler } from "../../application/production/broll-records.ts";
import { randomIds } from "../../adapters/identity/ids.ts";
import { anchorBrollInRows, brollHtmlLines, brollKeyHtml } from "../../adapters/production/broll-anchors.ts";
import type { BrollRecordsMount } from "../../features/broll/ports.ts";
import { createBrollRecords } from "../../features/broll/records.ts";
import { domToPos } from "../../features/editing/cell-dom.ts";
import { owned } from "../../features/routing/owned.ts";
import { ensureTrailingCaretSpot } from "../../js/04-richtext.js";
import { handBrollPanelTo } from "../../legacy/broll-bridge.ts";
import { cellEditing, paintGuard } from "../../legacy/editor-bridge.ts";
import { scriptCellOf } from "../../legacy/richtext.ts";
import { currentDocument, heldDocument, requestRefresh } from "../../legacy/session-bridge.ts";
import { sharedPorts } from "./shared-ports.ts";

const broll = owned<BrollRecordsMount>();

export function mountBrollFeature(): BrollRecordsMount {
  return broll.replace(() => {
    const shared = sharedPorts();
    const text = shared.text;
    const records = createBrollRecords({
      document: { current: currentDocument, read: shared.document.read },
      edits: shared.edits,
      cells: { edit: (cell, change) => cellEditing().edit(cell, change) },
      paint: { whileShown: (edit) => paintGuard().whileShown(edit) },
      text,
      scriptCellOf,
      ids: randomIds,
      caretSpot: ensureTrailingCaretSpot,
      position: domToPos,
      anchors: {
        inRows: (rows) => anchorBrollInRows(heldDocument(), rows, { readers: text.productionReaders, ids: randomIds, cellOf: text.cellOf, inertBody: text.inertBody, sanitize: text.sanitizeHtml }),
        htmlLines: brollHtmlLines,
        keyHtml: brollKeyHtml
      },
      refresh: requestRefresh
    });
    handBrollPanelTo(records);
    return { ...records, dispose: () => { handBrollPanelTo(null); records.dispose(); } };
  });
}

export const stopBrollFeature = broll.stop;

export const derivedRecordsPlan: RecordsReconciler = createRecordsReconciler({
  held: heldDocument,
  viewed: currentDocument,
  production: sharedPorts().production,
  text: sharedPorts().text,
  ids: randomIds
});

export function maybeCaptureBroll(e: Pick<Event, "target">, cellEl: Element): void {
  broll.owner()?.maybeCaptureBroll(e as InputEvent, cellEl);
}

export function anchorBrollInLeftCell(cellEl: Element): number {
  return broll.owner()?.anchorBrollInLeftCell(cellEl) ?? 0;
}

export function scheduleBrollRefresh(): void {
  broll.owner()?.scheduleBrollRefresh();
}

export function updateBrollBadge(): void {
  broll.owner()?.updateBrollBadge();
}
