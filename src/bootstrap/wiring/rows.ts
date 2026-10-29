import { owned } from "../../features/routing/owned.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits, undoControl as portUndo } from "./ports/editing.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { text as portText } from "./ports/text.ts";
import { ownership as portOwnership } from "./ports/saving.ts";
import { pictures as portPictures } from "./ports/pictures.ts";
import { placeCaretAtTextOffset } from "../../features/common/caret.ts";
import { cellSelection, setCellSelection } from "../../features/common/cell-selection.ts";
import type { PastePlace, SceneMedia, SceneMediaPorts, ScenePorts, Scenes } from "../../features/rows/ports.ts";
import { startSceneMedia as mountSceneMedia } from "../../features/rows/scene-media.js";
import { startSceneRows as mountScenes } from "../../features/rows/scenes.js";
import { randomIds } from "../../adapters/identity/ids.ts";
import { cellEditing, rowDrag } from "./editor-owners.ts";
import { deleteConfirmation } from "../../legacy/production-editing-bridge.ts";

const scenes = owned<Scenes>();
const media = owned<SceneMedia>();

export function mountScenesFeature(): Scenes {
  return scenes.replace(function () {
    const ports: ScenePorts = {
      document: portDocument,
      edits: portEdits,
      notices: portNotices,
      ids: randomIds,
      text: portText,
      cells: { sync: (cell) => { cellEditing().sync(cell); } },
      undo: portUndo,
      selection: { of: cellSelection },
      placeCaret: placeCaretAtTextOffset,
      rowDrag: { dragging: () => rowDrag().dragging() },
      deletes: {
        armedId: (area) => deleteConfirmation().armedId(area),
        arm: (area, id, expired, show, timers) => { deleteConfirmation().arm(area, id, expired, show, timers); },
        disarm: (area) => { deleteConfirmation().disarm(area); }
      }
    };
    return mountScenes(ports);
  });
}

export const stopScenesFeature = scenes.stop;

export function mountSceneMediaFeature(): SceneMedia {
  return media.replace(function () {
    const ports: SceneMediaPorts = {
      document: portDocument,
      notices: portNotices,
      ownership: portOwnership,
      pictures: portPictures,
      cells: { editGallery: (rowId, message, edit) => cellEditing().editGallery(rowId, message, edit) },
      text: portText,
      selection: { of: cellSelection, set: setCellSelection }
    };
    return mountSceneMedia(ports);
  });
}

export const stopSceneMediaFeature = media.stop;

export function addRow(afterId: string | null | undefined): string | null {
  return scenes.owner()?.addRow(afterId) ?? null;
}

export function addRowAndFocus(afterId: string | null | undefined, field: string | null): void {
  scenes.owner()?.addRowAndFocus(afterId, field);
}

export function splitCellField(cell: Element): void {
  scenes.owner()?.splitCellField(cell);
}

export function focusRowField(rowId: string | null, field: string | null, offset?: number): void {
  scenes.owner()?.focusField(rowId, field, offset);
}

export function swapAdjacentRows(rowId: string | null, dir: number): boolean {
  return scenes.owner()?.swapAdjacent(rowId, dir) ?? false;
}

export function moveRow(rowId: string, dir: number): void {
  scenes.owner()?.moveRow(rowId, dir);
}

export function armDelete(btn: Element, rowId: string): void {
  scenes.owner()?.armDelete(btn, rowId);
}

export function clearDropMarkers(): void {
  scenes.owner()?.clearDropMarkers();
}

export function setDropMarkerForRow(row: Element, clientY: number): void {
  scenes.owner()?.setDropMarkerForRow(row, clientY);
}

export function updateDragScroll(clientX: number, clientY: number): void {
  scenes.owner()?.updateDragScroll(clientX, clientY);
}

export function stopDragScroll(): void {
  scenes.owner()?.stopDragScroll();
}

export function capturePastePlace(cell: Element): PastePlace {
  return media.owner()?.capturePastePlace(cell) ?? { html: null, sel: null };
}

export function restorePastePlace(cell: Element, place: PastePlace): void {
  media.owner()?.restorePastePlace(cell, place);
}

export function showPictureNotAdded(): void {
  media.owner()?.showPictureNotAdded();
}

export function handleImageFile(rowId: string, file: File, slot?: number): void {
  media.owner()?.addPicture(rowId, file, slot);
}

export function removeImage(rowId: string, slot?: number): void {
  media.owner()?.removePicture(rowId, slot);
}

export function removeImageLink(rowId: string, slot: number, key: string): void {
  media.owner()?.removeLink(rowId, slot, key);
}

export function splitRowFieldCore(cell: Element) {
  return scenes.owner()?.splitField(cell) ?? null;
}
