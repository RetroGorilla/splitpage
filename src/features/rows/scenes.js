import { rowIndexOf } from "../../core/document/rows.ts";
import { safeId } from "../../core/document/text-policy.ts";
import { addSceneCommand, deleteSceneCommand, isBlankScene, swapScenesCommand } from "../../application/commands/rows.ts";
import { splitSceneCommand, textCut } from "../../application/commands/split-join.ts";
import { REVIEW_REFUSAL_REASON } from "../../application/collaboration/authority.ts";
import { VIEWING_ONLY } from "../../application/collaboration/review.ts";
import { armDeleteButton, disarmDeleteButton } from "./delete-button.ts";

var ports = null;

function rowCellSelector(rowId, field) {
  return '#rows .row[data-id="' + safeId(rowId, "r", ports.ids) +
    '"] .cell-editable[data-field="' + (field === "visualText" ? "visualText" : "audioText") + '"]';
}

function runRowCommand(command) {
  var outcome = ports.edits.run(command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected" && outcome.reason === REVIEW_REFUSAL_REASON) ports.notices.show(VIEWING_ONLY, "warn");
  return outcome.kind === "applied" || outcome.kind === "committed";
}

function addRow(afterId) {
  var createdId = ports.ids.id("r");
  if (!runRowCommand(addSceneCommand(afterId || null, createdId, ports.edits.stamps))) return null;
  return createdId;
}

function addRowAndFocus(afterId, field) {
  var createdId = addRow(afterId);
  if (!createdId) return;
  var cell = document.querySelector(rowCellSelector(createdId, field));
  if (!cell) return;
  cell.focus();
  var range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  cell.scrollIntoView({ behavior: "smooth", block: "center" });
}

function splitField(cellEl) {
  var id = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  if (ports.document.read(function (doc) { return rowIndexOf(doc, id); }) === -1 || (field !== "visualText" && field !== "audioText")) return null;
  ports.cells.sync(cellEl);
  var sel = ports.selection.of(cellEl);
  if (!sel) return null;
  ports.undo.breakCoalescing();
  var createdId = ports.ids.id("r");
  var outcome = ports.edits.run(splitSceneCommand(id, field, textCut(sel.from, sel.to), createdId, ports.edits.text));
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed" ? { id: createdId, field: field } : null;
}

function splitCellField(cellEl) {
  var res = splitField(cellEl);
  if (!res) return;
  focusField(res.id, res.field, 0);
}

function focusField(rowId, field, offset) {
  var cell = document.querySelector(rowCellSelector(rowId, field));
  if (!cell) return;
  cell.focus();
  ports.placeCaret(cell, offset || 0);
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

function setDropMarkerForRow(row, clientY) {
  var box = row.getBoundingClientRect();
  var after = (clientY - box.top) > box.height / 2;
  document.querySelectorAll("#rows .row").forEach(function (r) {
    if (r !== row) r.classList.remove("drop-before", "drop-after");
  });
  row.classList.toggle("drop-before", !after);
  row.classList.toggle("drop-after", after);
}

var DRAG_SCROLL_ZONE = 120;
var DRAG_SCROLL_MIN_SPEED = 6;
var DRAG_SCROLL_MAX_SPEED = 28;
var dragScroll = null;

function dragScrollSpeedFor(depthIntoZone) {
  var t = Math.max(0, Math.min(1, depthIntoZone / DRAG_SCROLL_ZONE));
  return DRAG_SCROLL_MIN_SPEED + t * (DRAG_SCROLL_MAX_SPEED - DRAG_SCROLL_MIN_SPEED);
}

function updateDropMarkersAtPoint(clientX, clientY) {
  var el = document.elementFromPoint(clientX, clientY);
  var row = el && el.closest && el.closest(".row");
  if (!row || row.getAttribute("data-id") === ports.rowDrag.dragging()) return;
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
  cancelAnimationFrame(dragScroll.raf);
  dragScroll = null;
}

function updateDragScroll(clientX, clientY) {
  var vh = window.innerHeight;
  var dir = 0, speed = 0;
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

function deleteRow(id) {
  runRowCommand(deleteSceneCommand(id));
}

function swapAdjacent(id, dir) {
  return runRowCommand(swapScenesCommand(id, dir < 0 ? -1 : 1));
}

function moveRow(id, dir) {
  swapAdjacent(id, dir);
}

function armDelete(btn, id) {
  var idx = ports.document.read(function (doc) { return rowIndexOf(doc, id); });
  var rowEl = document.querySelector('#rows .row[data-id="' + safeId(id, "r", ports.ids) + '"]');
  if (rowEl) rowEl.querySelectorAll(".cell-editable").forEach(function (cellEl) { ports.cells.sync(cellEl); });
  var doc = ports.document.current();
  if (idx !== -1 && isBlankScene(doc, doc.rows[idx], ports.text)) {
    ports.deletes.disarm("row");
    deleteRow(id);
    return;
  }
  if (ports.deletes.armedId("row") === id) {
    ports.deletes.disarm("row");
    deleteRow(id);
    return;
  }
  document.querySelectorAll(".gutter-btn.danger.armed").forEach(disarmDeleteButton);
  ports.deletes.arm("row", id, function () {
    disarmDeleteButton(btn);
  }, function () { armDeleteButton(btn); });
}

export function __init(next) {
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
