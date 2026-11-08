import { randomHexBytes, randomIds } from "../../adapters/identity/ids.ts";
import { documentReader as portDocument, documentLifetime as portLifetime } from "./ports/document.ts";
import { edits as portEdits, undoControl as portUndo } from "./ports/editing.ts";
import { pictures as portPictures } from "./ports/pictures.ts";
import { text as portText } from "./ports/text.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { brollSeedOf, recordPastedBroll } from "../../application/production/broll-records.ts";
import { startCellClipboard as mountCellClipboard } from "../../features/clipboard/cell-clipboard.ts";
import type { CellClipboardPorts, CopyPasteMount, BeatClipPorts, BeatSelectPorts } from "../../features/clipboard/ports.ts";
import { startBeatClip as mountBeatClip } from "../../features/clipboard/beat-clip.ts";
import { startBeatSelect as mountBeatSelect } from "../../features/clipboard/beat-select.ts";
import { isScriptCell } from "../../features/editing/cell-page.ts";
import { cellSelection } from "../../features/common/cell-selection.ts";
import { owned } from "../../features/routing/owned.ts";
import { migrateRows } from "../document-ports.ts";
import { stampRow } from "./session-merge.ts";
import { closeRowMenus } from "../../features/rows/row-menu.ts";
import { collectTagsFromRows, scheduleProductionRefresh } from "../../features/tags/production-tags.ts";
import { startNewScript } from "./file-menu-controls.ts";
import { cellEditing, paintGuard, rowDrag } from "./editor-owners.ts";
import { viewFlags } from "./preferences-owner.ts";
import { imageRefOf } from "../richtext.ts";

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
    const clipPorts: BeatClipPorts = {
      document: portDocument,
      ids: randomIds,
      pictures: portPictures,
      text: portText,
      migrate: migrateRows,
      tagsInRows: collectTagsFromRows as BeatClipPorts["tagsInRows"],
      recordPastedBroll: (doc, rowId, cell, ids) => { recordPastedBroll(doc, rowId, cell, ids, portText, randomIds); }
    };
    const selectPorts: BeatSelectPorts = {
      document: portDocument,
      lifetime: portLifetime,
      edits: portEdits,
      undo: portUndo,
      pictures: portPictures,
      notices: portNotices,
      cells: { sync: (cell) => { cellEditing().sync(cell); } },
      rowDrag: { dragging: () => rowDrag().dragging() },
      scriptCell: isScriptCell,
      rows: { closeMenus: () => { closeRowMenus(); } },
      production: { scheduleRefresh: scheduleProductionRefresh },
      stampRow,
      writerOpen: () => viewFlags().writerOpen(),
      startNewScript,
      nonce,
      screen: portScreen
    };
    const cells = mountCellClipboard(cellPorts);
    const beats = mountBeatClip(clipPorts);
    const selection = mountBeatSelect(selectPorts);
    return {
      dispose: () => {
        selection.dispose();
        beats.dispose();
        cells.dispose();
      }
    };
  });
}

export const stopCopyPasteFeature = copyPaste.stop;
