import { S } from "./_state.js";
import { findRowIndex } from "./03-sync.js";
import { render } from "./05-render.js";
import { idMap } from "../core/document/id-map.ts";
import { escapeHtml } from "../core/document/text-policy.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { preferences, viewFlags } from "../legacy/preferences-bridge.ts";

var HIDE_SHOT_GRACE_MS = 1400;

function hideShotOn() {
  return viewFlags().hideShot();
}
var expandedShotRowIds = idMap();
var shotHideTimers = idMap();

function isRowHiddenByShotToggle(row) {
  return !!(hideShotOn() && row.status === "shot" && !expandedShotRowIds[row.id]);
}

export function updateHideShotMenu() {
  var item = document.getElementById("menu-hide-shot");
  if (!item) return;
  item.setAttribute("aria-checked", hideShotOn() ? "true" : "false");
}

export function setHideShotScenes(on) {
  on = !!on;
  if (on === hideShotOn()) return;
  viewFlags().setHideShot(on);
  if (on) expandedShotRowIds = idMap();
  preferences().setHideShot(on);
  updateHideShotMenu();
  if (S.state) render();
}

export function toggleHideShotScenes() {
  setHideShotScenes(!hideShotOn());
  showToast(hideShotOn()
    ? "Hiding shot scenes — collapsed into strips you can click open."
    : "Showing every scene again.", "ok");
}

export function armShotHideGrace(rowId) {
  expandedShotRowIds[rowId] = true;
  if (shotHideTimers[rowId]) clearTimeout(shotHideTimers[rowId]);
  shotHideTimers[rowId] = setTimeout(function () {
    delete shotHideTimers[rowId];
    delete expandedShotRowIds[rowId];
    render();
  }, HIDE_SHOT_GRACE_MS);
}

export function clearShotHideGrace(rowId) {
  if (shotHideTimers[rowId]) { clearTimeout(shotHideTimers[rowId]); delete shotHideTimers[rowId]; }
}

export function revealRow(rowId) {
  if (!hideShotOn() || !S.state) return;
  var idx = findRowIndex(rowId);
  if (idx === -1 || !isRowHiddenByShotToggle(S.state.rows[idx])) return;
  var start = idx, end = idx;
  while (start > 0 && S.state.rows[start - 1].status === "shot") start--;
  while (end < S.state.rows.length - 1 && S.state.rows[end + 1].status === "shot") end++;
  for (var i = start; i <= end; i++) expandedShotRowIds[S.state.rows[i].id] = true;
  render();
}

export function hiddenShotStripHtml(ids) {
  var count = ids.length;
  var label = count + " shot scene" + (count === 1 ? "" : "s") + " hidden";
  return '<button type="button" class="hidden-shot-strip" data-action="expand-hidden-shot" data-ids="' +
    escapeHtml(ids.join(",")) + '" title="Click to show">' +
      '<span class="hidden-shot-label">' + escapeHtml(label) + '</span>' +
      '<span class="hidden-shot-hint">Click to show</span>' +
    '</button>';
}

export function expandHiddenShotStrip(idsAttr) {
  if (!idsAttr) return;
  idsAttr.split(",").forEach(function (id) { if (id) expandedShotRowIds[id] = true; });
  render();
}

export function rowGroupItems(rows) {
  var items = [];
  var i = 0;
  while (i < rows.length) {
    var row = rows[i];
    if (isRowHiddenByShotToggle(row)) {
      var ids = [];
      var j = i;
      while (j < rows.length && isRowHiddenByShotToggle(rows[j])) { ids.push(rows[j].id); j++; }
      items.push({ strip: ids });
      i = j;
    } else {
      items.push({ row: row, index: i });
      i++;
    }
  }
  return items;
}

export function renderRowGroups(rows, rowRenderer) {
  return rowGroupItems(rows).map(function (item) {
    return item.strip ? hiddenShotStripHtml(item.strip) : rowRenderer(item.row, item.index);
  }).join("");
}

export function __init() {}
