import { onServerDoc } from "../../legacy/location-bridge.ts";
import { randomHexBytes, randomIds } from "../../adapters/identity/ids.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits, undoControl as portUndo } from "./ports/editing.ts";
import { pictures as portPictures } from "./ports/pictures.ts";
import { text as portText } from "./ports/text.ts";
import { saves as portSaves } from "./ports/saving.ts";
import { review as portReview } from "./ports/location.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { brollSeedOf, recordPastedBroll } from "../../application/production/broll-records.ts";
import { startCellClipboard as mountCellClipboard } from "../../features/clipboard/cell-clipboard.js";
import type { CellClipboardPorts, CopyPasteMount, SceneClipPorts, SceneSelectPorts } from "../../features/clipboard/ports.ts";
import { startSceneClip as mountSceneClip } from "../../features/clipboard/scene-clip.js";
import { startSceneSelect as mountSceneSelect } from "../../features/clipboard/scene-select.js";
import { isScriptCell } from "../../features/editing/cell-page.ts";
import { cellSelection } from "../../features/common/cell-selection.ts";
import { owned } from "../../features/routing/owned.ts";
import { migrateRows } from "../../legacy/document-ports.ts";
import { stampRow } from "../../js/03-sync.js";
import { closeRowMenus } from "../../features/rows/row-menu.js";
import { collectTagsFromRows, scheduleProductionRefresh } from "../../js/07-production-tags.js";
import { startNewScript } from "./file-menu-controls.ts";
import { cellEditing, paintGuard, rowDrag } from "../../legacy/editor-bridge.ts";
import { viewFlags } from "../../legacy/preferences-bridge.ts";
import { imageRefOf } from "../../legacy/richtext.ts";
import { REVIEW_ONLY } from "../../legacy/session-bridge.ts";

const copyPaste = owned<CopyPasteMount>();

function nonce(): string {
  return randomHexBytes(16);
}

export function mountCopyPasteFeature(): CopyPasteMount {
  return copyPaste.replace(() => {
    const cellPorts: CellClipboardPorts = {
      document: portDocument,
      edits: portEdits,
      undo: portUndo,
      pictures: portPictures,
      text: portText,
      imageRefOf,
      ids: randomIds,
      nonce,
      selection: cellSelection,
      cells: { open: (cell) => cellEditing().open(cell), close: (cell, html, sel) => cellEditing().close(cell, html, sel) },
      paintGuard: { whileShown: (edit) => paintGuard().whileShown(edit) },
      brollSeed: (row) => brollSeedOf(row, portText)
    };
    const clipPorts: SceneClipPorts = {
      document: portDocument,
      ids: randomIds,
      pictures: portPictures,
      text: portText,
      migrate: migrateRows,
      tagsInRows: collectTagsFromRows,
      recordPastedBroll: (doc, rowId, cell, ids) => { recordPastedBroll(doc, rowId, cell, ids, portText, randomIds); }
    };
    const selectPorts: SceneSelectPorts = {
      document: portDocument,
      edits: portEdits,
      reviewRefusal: REVIEW_ONLY,
      undo: portUndo,
      saves: portSaves,
      pictures: portPictures,
      review: portReview,
      notices: portNotices,
      cells: { sync: (cell) => { cellEditing().sync(cell); } },
      rowDrag: { dragging: () => rowDrag().dragging() },
      scriptCell: isScriptCell,
      rows: { closeMenus: () => { closeRowMenus(); } },
      production: { scheduleRefresh: scheduleProductionRefresh },
      stampRow,
      onServer: onServerDoc,
      writerOpen: () => viewFlags().writerOpen(),
      startNewScript,
      nonce
    };
    const cells = mountCellClipboard(cellPorts);
    const scenes = mountSceneClip(clipPorts);
    const selection = mountSceneSelect(selectPorts);
    return {
      dispose: () => {
        selection.dispose();
        scenes.dispose();
        cells.dispose();
      }
    };
  });
}

export const stopCopyPasteFeature = copyPaste.stop;
