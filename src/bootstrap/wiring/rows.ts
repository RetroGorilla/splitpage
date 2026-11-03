import { owned } from "../../features/routing/owned.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits, undoControl as portUndo } from "./ports/editing.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { text as portText } from "./ports/text.ts";
import { ownership as portOwnership } from "./ports/saving.ts";
import { pictures as portPictures } from "./ports/pictures.ts";
import { placeCaretAtTextOffset } from "../../features/common/caret.ts";
import { cellSelection, setCellSelection } from "../../features/common/cell-selection.ts";
import type { PastePlace, BeatMedia, BeatMediaPorts, BeatPorts, Beats } from "../../features/rows/ports.ts";
import { startBeatMedia as mountBeatMedia } from "../../features/rows/beat-media.ts";
import { startBeatRows as mountBeats } from "../../features/rows/beats.ts";
import { randomIds } from "../../adapters/identity/ids.ts";
import { cellEditing, rowDrag } from "./editor-owners.ts";
import { deleteConfirmation } from "./production-editing-owners.ts";

const beats = owned<Beats>();
const media = owned<BeatMedia>();

export function mountBeatsFeature(): Beats {
  return beats.replace(function () {
    const ports: BeatPorts = {
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
    return mountBeats(ports);
  });
}

export const stopBeatsFeature = beats.stop;

export function mountBeatMediaFeature(): BeatMedia {
  return media.replace(function () {
    const ports: BeatMediaPorts = {
      document: portDocument,
      notices: portNotices,
      ownership: portOwnership,
      pictures: portPictures,
      cells: { editGallery: (rowId, message, edit) => cellEditing().editGallery(rowId, message, edit) },
      text: portText,
      selection: { of: cellSelection, set: setCellSelection }
    };
    return mountBeatMedia(ports);
  });
}

export const stopBeatMediaFeature = media.stop;

export function addRow(afterId: string | null | undefined): string | null {
  return beats.owner()?.addRow(afterId) ?? null;
}

export function addRowAndFocus(afterId: string | null | undefined, field: string | null): void {
  beats.owner()?.addRowAndFocus(afterId, field);
}

export function splitCellField(cell: Element): void {
  beats.owner()?.splitCellField(cell);
}

export function focusRowField(rowId: string | null, field: string | null, offset?: number): void {
  beats.owner()?.focusField(rowId, field, offset);
}

export function swapAdjacentRows(rowId: string | null, dir: number): boolean {
  return beats.owner()?.swapAdjacent(rowId, dir) ?? false;
}

export function moveRow(rowId: string, dir: number): void {
  beats.owner()?.moveRow(rowId, dir);
}

export function armDelete(btn: Element, rowId: string): void {
  beats.owner()?.armDelete(btn, rowId);
}

export function clearDropMarkers(): void {
  beats.owner()?.clearDropMarkers();
}

export function setDropMarkerForRow(row: Element, clientY: number): void {
  beats.owner()?.setDropMarkerForRow(row, clientY);
}

export function updateDragScroll(clientX: number, clientY: number): void {
  beats.owner()?.updateDragScroll(clientX, clientY);
}

export function stopDragScroll(): void {
  beats.owner()?.stopDragScroll();
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
  return beats.owner()?.splitField(cell) ?? null;
}
