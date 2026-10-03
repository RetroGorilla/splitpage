import { S } from "../js/_state.js";
import { hasSetLength as coreHasSetLength } from "../core/document/timing.ts";
import { noteEdit } from "../js/12a-undo.js";

export const calls = [];
export const stamped = [];
export const dirtied = [];
const answers = { renderRow: true, reviewMode: false, noteEdit: false };

export let hideShotScenes = false;

export function resetFanout(opts) {
  calls.length = 0;
  stamped.length = 0;
  dirtied.length = 0;
  answers.renderRow = opts && "renderRow" in opts ? opts.renderRow : true;
  answers.reviewMode = !!(opts && opts.reviewMode);
  answers.noteEdit = !!(opts && opts.noteEdit);
  hideShotScenes = !!(opts && opts.hideShot);
}

function rowCopy(row) {
  return JSON.parse(JSON.stringify(row));
}

export function findRowIndex(id) {
  calls.push("findRowIndex");
  return S.state.rows.findIndex((r) => r.id === id);
}

export function stampRow(row) {
  calls.push("stampRow");
  stamped.push(rowCopy(row));
  row.updatedAt = "stamped";
}

export function markDirty() {
  calls.push("markDirty");
  dirtied.push(rowCopy(S.state.rows));
  if (answers.noteEdit) noteEdit();
}

export function armShotHideGrace(id) { calls.push("armShotHideGrace:" + id); }
export function clearShotHideGrace(id) { calls.push("clearShotHideGrace:" + id); }

export function renderRow(id) {
  calls.push("renderRow:" + id);
  return answers.renderRow;
}
export function render() { calls.push("render"); }
export function paintRowTimes() { calls.push("paintRowTimes"); }
export function setRundownExtraSeconds() { calls.push("setRundownExtraSeconds"); }
export function renderRundown() { calls.push("renderRundown"); }
export function paintTargetOverlay() { calls.push("paintTargetOverlay"); }
export function updateScriptStats() { calls.push("updateScriptStats"); }
export function scheduleProductionRefresh() { calls.push("scheduleProductionRefresh"); }
export function scheduleBrollRefresh() { calls.push("scheduleBrollRefresh"); }
export function queueAutoSave() { calls.push("queueAutoSave"); }
export function showToast(text) { calls.push("showToast:" + text); }

export function reviewMode() {
  calls.push("reviewMode");
  return answers.reviewMode;
}

export function undo() { calls.push("undo"); }
export function redo() { calls.push("redo"); }
export function cssAttr(v) { return String(v); }

export const productionReaders = { wordCount: () => 0 };
export function hasSetLength(row) { return coreHasSetLength(row); }
export function estimatedSeconds() { return 0; }
export function rowSeconds() { return 0; }
export function formatDuration(s) { return String(s); }
export function parseSceneLength() { return null; }
