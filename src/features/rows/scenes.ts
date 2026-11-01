import { rowIndexOf } from "../../core/document/rows.ts";
import { safeId } from "../../core/document/text-policy.ts";
import { addSceneCommand, deleteSceneCommand, isBlankScene, swapScenesCommand } from "../../application/commands/rows.ts";
import { splitSceneCommand, textCut } from "../../application/commands/split-join.ts";
import { armDeleteButton, disarmDeleteButton } from "./delete-button.ts";

import type { ScenePorts, Scenes } from "./ports.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { Command, DocumentView } from "../../application/session/document-session.ts";

interface SceneDragScroll {
 dir: number;
 speed: number;
 x: number;
 y: number;
 raf: number | null;
}
type SceneDocument = Pick<DocumentView, "rows" | "comments">;
interface ScenePortUse extends Omit<ScenePorts, "document"> {
 readonly document: {
  readonly read: ScenePorts["document"]["read"];
  readonly current: (...args: Parameters<ScenePorts["document"]["current"]>) => SceneDocument | null;
 };
}
let ports: ScenePorts | null = null;

function rowCellSelector(rowId: string | null, field: string | null) {
  return '#rows .row[data-id="' + safeId(rowId, "r", (ports as ScenePortUse).ids as IdSource) +
    '"] .cell-editable[data-field="' + (field === "visualText" ? "visualText" : "audioText") + '"]';
}

function runRowCommand(command: Command) {
  const outcome = (ports as ScenePortUse).edits.run(command);
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed";
}

function addRow(afterId: string | null | undefined) {
  const createdId = (ports as ScenePortUse).ids.id("r");
  if (!runRowCommand(addSceneCommand(afterId || null, createdId, (ports as ScenePortUse).edits.stamps))) return null;
  return createdId;
}

function addRowAndFocus(afterId: string | null | undefined, field: string | null) {
  const createdId = addRow(afterId);
  if (!createdId) return;
  const cell = document.querySelector<HTMLElement>(rowCellSelector(createdId, field));
  if (!cell) return;
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
  cell.scrollIntoView({ behavior: "smooth", block: "center" });
}

function splitField(cellEl: Element) {
  const id = cellEl.getAttribute("data-id");
  const field = cellEl.getAttribute("data-field");
  if ((ports as ScenePortUse).document.read(function (doc) { return rowIndexOf(doc, id); }) === -1 || (field !== "visualText" && field !== "audioText")) return null;
  (ports as ScenePortUse).cells.sync(cellEl);
  const sel = (ports as ScenePortUse).selection.of(cellEl);
  if (!sel) return null;
  (ports as ScenePortUse).undo.breakCoalescing();
  const createdId = (ports as ScenePortUse).ids.id("r");
  const outcome = (ports as ScenePortUse).edits.run(splitSceneCommand(id as string, field, textCut(sel.from, sel.to), createdId, (ports as ScenePortUse).edits.text));
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed" ? { id: createdId, field: field } : null;
}

function splitCellField(cellEl: Element) {
  const res = splitField(cellEl);
  if (!res) return;
  focusField(res.id, res.field, 0);
}

function focusField(rowId: string | null, field: string | null, offset?: number) {
  const cell = document.querySelector<HTMLElement>(rowCellSelector(rowId, field));
  if (!cell) return;
  cell.focus();
  (ports as ScenePortUse).placeCaret(cell, offset || 0);
  cell.scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearDropMarkers() {
  document.querySelectorAll("#rows .row").forEach(function (r) {
    r.classList.remove("drop-before", "drop-after", "is-dragging");
    r.removeAttribute("draggable");
  });
  document.querySelectorAll("#rows .visual-cell.drag-over").forEach(function (c) {
    c.classList.remove("drag-over");
  });
  stopDragScroll();
}

function setDropMarkerForRow(row: Element, clientY: number) {
  const box = row.getBoundingClientRect();
  const after = (clientY - box.top) > box.height / 2;
  document.querySelectorAll("#rows .row").forEach(function (r) {
    if (r !== row) r.classList.remove("drop-before", "drop-after");
  });
  row.classList.toggle("drop-before", !after);
  row.classList.toggle("drop-after", after);
}

const DRAG_SCROLL_ZONE = 120;
const DRAG_SCROLL_MIN_SPEED = 6;
const DRAG_SCROLL_MAX_SPEED = 28;
let dragScroll: SceneDragScroll | null = null;

function dragScrollSpeedFor(depthIntoZone: number) {
  const t = Math.max(0, Math.min(1, depthIntoZone / DRAG_SCROLL_ZONE));
  return DRAG_SCROLL_MIN_SPEED + t * (DRAG_SCROLL_MAX_SPEED - DRAG_SCROLL_MIN_SPEED);
}

function updateDropMarkersAtPoint(clientX: number, clientY: number) {
  const el = document.elementFromPoint(clientX, clientY);
  const row = el && el.closest && el.closest(".row");
  if (!row || row.getAttribute("data-id") === (ports as ScenePortUse).rowDrag.dragging()) return;
  setDropMarkerForRow(row, clientY);
}

function dragScrollStep() {
  if (!dragScroll) return;
  window.scrollBy(0, dragScroll.dir * dragScroll.speed);
  updateDropMarkersAtPoint(dragScroll.x, dragScroll.y);
  dragScroll.raf = requestAnimationFrame(dragScrollStep);
}

function stopDragScroll() {
  if (!dragScroll) return;
  cancelAnimationFrame(dragScroll.raf as number);
  dragScroll = null;
}

function updateDragScroll(clientX: number, clientY: number) {
  const vh = window.innerHeight;
  let dir = 0, speed = 0;
  if (clientY < DRAG_SCROLL_ZONE) {
    dir = -1;
    speed = dragScrollSpeedFor(DRAG_SCROLL_ZONE - clientY);
  } else if (clientY > vh - DRAG_SCROLL_ZONE) {
    dir = 1;
    speed = dragScrollSpeedFor(clientY - (vh - DRAG_SCROLL_ZONE));
  }
  if (dir === 0) { stopDragScroll(); return; }
  if (!dragScroll) {
    dragScroll = { dir: dir, speed: speed, x: clientX, y: clientY, raf: null };
    dragScroll.raf = requestAnimationFrame(dragScrollStep);
  } else {
    dragScroll.dir = dir;
    dragScroll.speed = speed;
    dragScroll.x = clientX;
    dragScroll.y = clientY;
  }
}

function deleteRow(id: string) {
  runRowCommand(deleteSceneCommand(id));
}

function swapAdjacent(id: string | null, dir: number) {
  return runRowCommand(swapScenesCommand(id as string, dir < 0 ? -1 : 1));
}

function moveRow(id: string, dir: number) {
  swapAdjacent(id, dir);
}

function armDelete(btn: Element, id: string) {
  const idx = (ports as ScenePortUse).document.read(function (doc) { return rowIndexOf(doc, id); });
  const rowEl = document.querySelector<HTMLElement>('#rows .row[data-id="' + safeId(id, "r", (ports as ScenePortUse).ids as IdSource) + '"]');
  if (rowEl) rowEl.querySelectorAll(".cell-editable").forEach(function (cellEl) { (ports as ScenePortUse).cells.sync(cellEl); });
  const doc = (ports as ScenePortUse).document.current() as SceneDocument;
  if (idx !== -1 && isBlankScene(doc, doc.rows[idx], (ports as ScenePortUse).text)) {
    (ports as ScenePortUse).deletes.disarm("row");
    deleteRow(id);
    return;
  }
  if ((ports as ScenePortUse).deletes.armedId("row") === id) {
    (ports as ScenePortUse).deletes.disarm("row");
    deleteRow(id);
    return;
  }
  document.querySelectorAll(".gutter-btn.danger.armed").forEach(disarmDeleteButton);
  (ports as ScenePortUse).deletes.arm("row", id, function () {
    disarmDeleteButton(btn);
  }, function () { armDeleteButton(btn); });
}

export function startSceneRows(next: ScenePorts): Scenes {
  ports = next;
  return {
    addRow: addRow,
    addRowAndFocus: addRowAndFocus,
    splitField: splitField,
    splitCellField: splitCellField,
    focusField: focusField,
    swapAdjacent: swapAdjacent,
    moveRow: moveRow,
    armDelete: armDelete,
    clearDropMarkers: clearDropMarkers,
    setDropMarkerForRow: setDropMarkerForRow,
    updateDragScroll: updateDragScroll,
    stopDragScroll: stopDragScroll,
    dispose: function () {
      stopDragScroll();
      if (ports === next) ports = null;
    }
  };
}
