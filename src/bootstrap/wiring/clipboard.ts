import { randomHexBytes, randomIds } from "../../adapters/identity/ids.ts";
import { __init as mountCellClipboard } from "../../features/clipboard/cell-clipboard.js";
import type { CellClipboardPorts, CopyPasteMount, SceneClipPorts, SceneSelectPorts } from "../../features/clipboard/ports.ts";
import { __init as mountSceneClip } from "../../features/clipboard/scene-clip.js";
import { __init as mountSceneSelect } from "../../features/clipboard/scene-select.js";
import { isScriptCell } from "../../features/editing/cell-page.ts";
import { cellSelection } from "../../features/editing/cell-selection.ts";
import { owned } from "../../features/routing/owned.ts";
import { migrateRows } from "../../js/02-state.js";
import { stampRow } from "../../js/03-sync.js";
import { closeRowMenus } from "../../js/06-rows.js";
import { collectTagsFromRows, scheduleProductionRefresh } from "../../js/07-production-tags.js";
import { brollSeedOf, recordPastedBroll } from "../../js/08c-broll.js";
import { onServerDoc } from "../../js/13-hosted.js";
import { startNewScript } from "../../js/18b-file-menu.js";
import { cellEditing, paintGuard, rowDrag } from "../../legacy/editor-bridge.ts";
import { viewFlags } from "../../legacy/preferences-bridge.ts";
import { imageRefOf } from "../../legacy/richtext.ts";
import { REVIEW_ONLY } from "../../legacy/session-bridge.ts";
import { sharedPorts } from "./shared-ports.ts";

const copyPaste = owned<CopyPasteMount>();

function nonce(): string {
  return randomHexBytes(16);
}

export function mountCopyPasteFeature(): CopyPasteMount {
  return copyPaste.replace(() => {
    const shared = sharedPorts();
    const cellPorts: CellClipboardPorts = {
      document: shared.document,
      edits: shared.edits,
      undo: shared.undo,
      pictures: shared.pictures,
      text: shared.text,
      imageRefOf,
      ids: randomIds,
      nonce,
      selection: cellSelection,
      cells: { open: (cell) => cellEditing().open(cell), close: (cell, html, sel) => cellEditing().close(cell, html, sel) },
      paintGuard: { whileShown: (edit) => paintGuard().whileShown(edit) },
      brollSeed: brollSeedOf
    };
    const clipPorts: SceneClipPorts = {
      document: shared.document,
      ids: randomIds,
      pictures: shared.pictures,
      text: shared.text,
      migrate: migrateRows,
      tagsInRows: collectTagsFromRows,
      recordPastedBroll
    };
    const selectPorts: SceneSelectPorts = {
      document: shared.document,
      edits: shared.edits,
      reviewRefusal: REVIEW_ONLY,
      undo: shared.undo,
      saves: shared.saves,
      pictures: shared.pictures,
      review: shared.review,
      notices: shared.notices,
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
