import { viewFlags } from "../legacy/preferences-bridge.ts";
import { S } from "../js/_state.js";
import { hasSetLength as coreHasSetLength } from "../core/document/timing.ts";
import { noteEdit } from "../js/12a-undo.js";
import { startTestSession } from "./_session.mjs";

export function wireSession(effects) {
  const given = Object.assign({
    dirty: () => {},
    draft: () => {},
    save: () => {},
    edit: () => ({ allowed: true }),
    editorName: () => "Anonymous",
    attribute: () => null
  }, effects);
  startTestSession({ effects: given, editorName: () => given.editorName(), refresh: () => {}, records: () => null });
  return given;
}

export const calls = [];
export const stamped = [];
export const dirtied = [];
const answers = { renderRow: true, reviewMode: false, noteEdit: false };

export function resetFanout(opts) {
  calls.length = 0;
  stamped.length = 0;
  dirtied.length = 0;
  answers.renderRow = opts && "renderRow" in opts ? opts.renderRow : true;
  answers.reviewMode = !!(opts && opts.reviewMode);
  answers.noteEdit = !!(opts && opts.noteEdit);
  viewFlags().setHideShot(!!(opts && opts.hideShot));
}

function rowCopy(row) {
  return JSON.parse(JSON.stringify(row));
}

export function stampRow(row) {
  calls.push("stampRow");
  stamped.push(rowCopy(row));
  row.updatedAt = "stamped";
  row.updatedBy = "stub editor";
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
export function afterThisPaint(fn) { fn(); }
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
