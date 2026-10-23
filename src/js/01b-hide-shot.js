import { escapeHtml } from "../core/document/text-policy.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { shotHiding } from "../legacy/shot-hiding-bridge.ts";

export function updateHideShotMenu() {
  var item = document.getElementById("menu-hide-shot");
  if (!item) return;
  item.setAttribute("aria-checked", shotHiding().on() ? "true" : "false");
}

export function setHideShotScenes(on) {
  if (shotHiding().set(on)) updateHideShotMenu();
}

export function toggleHideShotScenes() {
  setHideShotScenes(!shotHiding().on());
  showToast(shotHiding().on()
    ? "Hiding shot scenes — collapsed into strips you can click open."
    : "Showing every scene again.", "ok");
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
  shotHiding().expand(idsAttr.split(","));
}

export function renderRowGroups(rows, rowRenderer) {
  return shotHiding().groups(rows).map(function (item) {
    return item.strip ? hiddenShotStripHtml(item.strip) : rowRenderer(item.row, item.index);
  }).join("");
}

export function __init() {}
