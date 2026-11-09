import type { ActionDefinition } from "../../application/actions.ts";
import { startBrollPanel as mountPanelState, mountBrollPanel } from "../../features/broll/panel.ts";
import { brollPanelActions as panelDefinitions } from "../../features/broll/actions.ts";
import type { BrollPanelEventsPorts, BrollPanelPorts, BrollPanelState } from "../../features/broll/ports.ts";
import { ids as portIds } from "./ports/identity.ts";
import { brollAnchoring, flags as portFlags, brollView as portBrollView, preferenceValues as portPreferences } from "./ports/preferences.ts";
import { panelControl as portPanels } from "./ports/panels.ts";
import { shotHiding as portShotHiding } from "./ports/shot-hiding.ts";
import { personColors as portPersonColors } from "./ports/person-colors.ts";
import { rows as portRows } from "./ports/rows.ts";
import { actions as portActions } from "./ports/actions.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { undoControl as portUndo } from "./ports/editing.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { createRecordsReconciler } from "../../application/production/broll-records.ts";
import { text as portText } from "./ports/text.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits } from "./ports/editing.ts";
import { production as portProduction } from "./ports/production.ts";
import type { RecordsReconciler } from "../../application/production/broll-records.ts";
import { randomIds } from "../../adapters/identity/ids.ts";
import { anchorBrollInRows, brollHtmlLines, brollKeyHtml } from "../../adapters/production/broll-anchors.ts";
import type { BrollRecordsMount } from "../../features/broll/ports.ts";
import { createBrollRecords } from "../../features/broll/records.ts";
import { domToPos } from "../../features/common/cell-dom.ts";
import { owned } from "../../features/routing/owned.ts";
import { ensureTrailingCaretSpot } from "../../features/common/dom.ts";
import { cellEditing, paintGuard } from "./editor-owners.ts";
import { scriptCellOf } from "../richtext.ts";
import { currentDocument, heldDocument, requestRefresh } from "./session-owner.ts";

const broll = owned<BrollRecordsMount>();

export function mountBrollFeature(): BrollRecordsMount {
  return broll.replace(() => {
    const text = portText;
    const records = createBrollRecords({
      document: { current: currentDocument, read: portDocument.read, numbering: portDocument.numbering },
      edits: portEdits,
      cells: { edit: (cell, change) => cellEditing().edit(cell, change) },
      paint: { whileShown: (edit) => paintGuard().whileShown(edit) },
      text,
      scriptCellOf,
      ids: randomIds,
      caretSpot: ensureTrailingCaretSpot,
      position: domToPos,
      anchors: {
        inRows: (rows) => anchorBrollInRows(heldDocument(), rows, { readers: text.productionReaders, ids: randomIds, cellOf: text.cellOf, inertBody: text.inertBody, sanitize: text.sanitizeHtml, declined: brollAnchoring.declined }),
        htmlLines: brollHtmlLines,
        keyHtml: brollKeyHtml
      },
      anchoring: brollAnchoring,
      refresh: requestRefresh
    });
    return records;
  });
}

export const stopBrollFeature = broll.stop;

export const derivedRecordsPlan: RecordsReconciler = createRecordsReconciler({
  held: heldDocument,
  viewed: currentDocument,
  production: portProduction,
  text: portText,
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

const panelState = owned<BrollPanelState>();
const panelEvents = owned<{ dispose: () => void }>();

export const productionFootage = {
  entries: () => broll.owner()?.brollEntries() ?? [],
  open: (id: string) => { panelState.owner()?.openShot(id); }
};

export function mountBrollPanelStateFeature(): BrollPanelState {
  return panelState.replace(() => {
    const ports: BrollPanelPorts = {
      screen: portScreen,
      view: portBrollView,
      preferences: portPreferences,
      document: portDocument,
      edits: portEdits,
      text: portText,
      ids: portIds,
      production: portProduction,
      shotHiding: portShotHiding,
      panels: portPanels,
      flags: portFlags,
      personColors: portPersonColors,
      undo: portUndo,
      actions: portActions,
      notices: portNotices,
      rows: portRows,
      records: {
        brollEntries: () => broll.owner()?.brollEntries() ?? [],
        addBrollProp: (id, name) => broll.owner()?.addBrollProp(id, name) ?? false,
        renameBrollInScript: (entry, name) => broll.owner()?.renameBrollInScript(entry, name) ?? false,
        updateBrollBadge: () => broll.owner()?.updateBrollBadge()
      }
    };
    return mountPanelState(ports);
  });
}

export function mountBrollPanelFeature(ports: BrollPanelEventsPorts): { dispose: () => void } {
  return panelEvents.replace(() => mountBrollPanel(ports));
}

export const stopBrollPanelFeature = panelEvents.stop;

export function brollPanelActions(): ActionDefinition[] {
  return panelDefinitions(panelState.owner, { screen: portScreen, panels: portPanels });
}

export function currentBrollRecords(): BrollRecordsMount | null {
  return broll.owner();
}

export const stopBrollPanelStateFeature = panelState.stop;
