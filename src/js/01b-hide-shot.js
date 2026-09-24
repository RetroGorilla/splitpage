import { S } from "./_state.js";
import { escapeHtml } from "./02-state.js";
import { findRowIndex } from "./03-sync.js";
import { render } from "./05-render.js";
import { showToast } from "./12-dirty-toast.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
export var hideShotScenes;

/* ================= hide shot scenes (issue #25) =================

   A reading mode, not a document change: every scene marked Shot
   collapses into a thin "N shot scenes hidden" strip, so a half-finished
   script reads as what's left to record. Lives in localStorage keyed to
   this device — like the writer's remembered text size and the
   prompter's mirror/flip — never in `state`, so it never dirties the
   document or travels with the file (invariant: HANDOFF's escaping rule
   aside, a reading preference is not something the next person to open
   this script should inherit).

   `expandedShotRowIds` is the "peek" list: a row id in here is shown in
   full even though it is Shot, either because someone clicked its hidden
   strip open, a jump landed on it, or it only just became Shot and is
   still in its short grace window (armShotHideGrace below). It is purely
   in-memory UI state, rebuilt fresh from nothing every reload — there is
   nothing here worth persisting. */
var HIDE_SHOT_KEY = "splitpage-hide-shot";
var HIDE_SHOT_GRACE_MS = 1400;

function readHideShotFlag() {
  try { return localStorage.getItem(HIDE_SHOT_KEY) === "1"; } catch (e) { return false; }
}
var expandedShotRowIds = {};
var shotHideTimers = {};

function isRowHiddenByShotToggle(row) {
  return !!(hideShotScenes && row.status === "shot" && !expandedShotRowIds[row.id]);
}

/* The menu entry is a switch (#145), and aria-checked is its position —
   same as updateAutoSaveMenu() (14-export.js). */
export function updateHideShotMenu() {
  var item = document.getElementById("menu-hide-shot");
  if (!item) return;
  item.setAttribute("aria-checked", hideShotScenes ? "true" : "false");
}

function setHideShotScenes(on) {
  on = !!on;
  if (on === hideShotScenes) return;
  hideShotScenes = on;
  /* Turning it on starts a clean slate — any earlier peek is stale the
     moment hiding is off, and re-enabling should collapse everything
     Shot again rather than remember what used to be expanded. */
  if (on) expandedShotRowIds = {};
  try { localStorage.setItem(HIDE_SHOT_KEY, on ? "1" : "0"); } catch (e) {}
  updateHideShotMenu();
  if (S.state) render();
}

export function toggleHideShotScenes() {
  setHideShotScenes(!hideShotScenes);
  showToast(hideShotScenes
    ? "Hiding shot scenes — collapsed into strips you can click open."
    : "Showing every scene again.", "ok");
}

/* Changing a VISIBLE scene to Shot while the toggle is on must not yank
   it out from under the click that just landed on it — so it stays
   expanded for a short grace window, then settles into its strip on its
   own. Called only from cycleRowStatus (01-scene-status.js). */
export function armShotHideGrace(rowId) {
  expandedShotRowIds[rowId] = true;
  if (shotHideTimers[rowId]) clearTimeout(shotHideTimers[rowId]);
  shotHideTimers[rowId] = setTimeout(function () {
    delete shotHideTimers[rowId];
    delete expandedShotRowIds[rowId];
    render();
  }, HIDE_SHOT_GRACE_MS);
}

/* A scene leaving Shot status (by whatever path) has nothing left to hide
   or to grace — drop any pending timer so a stale one can't fire later
   and undo an expand a different action already made permanent. */
export function clearShotHideGrace(rowId) {
  if (shotHideTimers[rowId]) { clearTimeout(shotHideTimers[rowId]); delete shotHideTimers[rowId]; }
}

/* Find & replace, comments "jump to" and tag "jump to" all land on a row
   by querying `#rows .row[data-id=...]` directly — which finds nothing
   once that row is folded into a strip. Called before any of those
   queries: if the row is currently hidden, expand the whole contiguous
   run of Shot scenes it belongs to (not just the one row — a lone row
   poking out of an otherwise-collapsed run reads as broken) and repaint
   so the caller's own lookup succeeds right after this returns. */
export function revealRow(rowId) {
  if (!hideShotScenes || !S.state) return;
  var idx = findRowIndex(rowId);
  if (idx === -1 || !isRowHiddenByShotToggle(S.state.rows[idx])) return;
  var start = idx, end = idx;
  while (start > 0 && S.state.rows[start - 1].status === "shot") start--;
  while (end < S.state.rows.length - 1 && S.state.rows[end + 1].status === "shot") end++;
  for (var i = start; i <= end; i++) expandedShotRowIds[S.state.rows[i].id] = true;
  render();
}

/* The strip itself — a real <button> so Enter/Space open it for free,
   exactly like every other data-action control in this app. Its markup is
   a function of the ids it covers and nothing else, which is what lets
   render() (05-render.js) treat "same key" as "same strip". */
export function hiddenShotStripHtml(ids) {
  var count = ids.length;
  var label = count + " shot scene" + (count === 1 ? "" : "s") + " hidden";
  return '<button type="button" class="hidden-shot-strip" data-action="expand-hidden-shot" data-ids="' +
    escapeHtml(ids.join(",")) + '" title="Click to show">' +
      '<span class="hidden-shot-label">' + escapeHtml(label) + '</span>' +
      '<span class="hidden-shot-hint">Click to show</span>' +
    '</button>';
}

/* Expand every id named on a clicked strip — the run it represents,
   exactly as built below. */
export function expandHiddenShotStrip(idsAttr) {
  if (!idsAttr) return;
  idsAttr.split(",").forEach(function (id) { if (id) expandedShotRowIds[id] = true; });
  render();
}

/* The one walk of the document both views share: `rows` in document
   order, as a list of what #rows (or the writer) should hold — a visible
   scene as `{row, index}`, and every contiguous run of hidden-by-toggle
   rows folded into one `{strip: ids}`. `index` is always the row's real
   position in the document, never a "visible-only" count, so scene
   numbers never shift just because the toggle is on. render() (05-render.js)
   reconciles #rows against this list by key; renderWriter() (19-writer.js)
   still builds its paragraphs as one string through renderRowGroups(). */
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

/* rowGroupItems() as one string, handing each visible row to
   `rowRenderer(row, index)` — the writer's writerBlockHtml(). */
export function renderRowGroups(rows, rowRenderer) {
  return rowGroupItems(rows).map(function (item) {
    return item.strip ? hiddenShotStripHtml(item.strip) : rowRenderer(item.row, item.index);
  }).join("");
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  hideShotScenes = readHideShotFlag();
}
