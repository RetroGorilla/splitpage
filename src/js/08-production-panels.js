import { S } from "./_state.js";
import { ROW_STATUSES, formatDuration, rowSeconds, rowStatus } from "./01-scene-status.js";
import { revealRow } from "./01b-hide-shot.js";
import { escapeHtml } from "./02-state.js";
import { openSidePanel, syncPanelClass } from "./03-sync.js";
import { cssAttr, plainText, safeId } from "./04-richtext.js";
import { pad2, render } from "./05-render.js";
import {
  TAG_CATEGORIES,
  TAG_STATUSES,
  bulkDeleteArmed,
  clearProductionSelection,
  deletePerson,
  deleteProductionTagEntry,
  disarmBulkDelete,
  findOrAddPerson,
  healTagRegistry,
  nextTagStatus,
  normalizeTagName,
  personById,
  productionEntries,
  productionSelection,
  pruneProductionSelection,
  registerProductionTag,
  registryEntry,
  removeTag,
  renameTag,
  selectedKeys,
  tagStatus,
  tagStatusLampHtml,
  tagsByCategory,
  updateProductionBadge
} from "./07-production-tags.js";
import { brollShotsByProp } from "./08c-broll.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { breakUndoCoalescing } from "./12a-undo.js";
import { reviewBlocked, reviewMode } from "./13-hosted.js";
import { personColor } from "./13a-presence.js";
import { queueAutoSave } from "./14-export.js";
import { csvEscape } from "./16-csv.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
export var IS_TOUCH;

/* ---- the production panel ---- */

export function openProductionPanel() {
  if (!S.state) return;
  openSidePanel("production-panel");
  renderProduction();
}

export function closeProductionPanel() {
  document.getElementById("production-panel").hidden = true;
  syncPanelClass();
}

/* ---- the gear panel ----

   A thinner, single-category sibling of the production panel rather than
   a second copy of it: cards, status, owner, notes, rename, remove/delete
   are all tagEntityHtml() and the same handlers the production panel
   already uses (wired onto #gear-panel by wireTagEntityContainer() in
   init() — see the note there). The only things genuinely new here are
   the quick-add box and the packing-list export. */

S.gearGroupBy = "flat";   /* "flat" | "scene" */

function gearEntries() {
  return productionEntries().filter(function (e) { return e.cat.id === "gear"; });
}

export function openGearPanel() {
  if (!S.state) return;
  openSidePanel("gear-panel");
  fillGearQuickAdd();
  renderProduction();
}

export function closeGearPanel() {
  document.getElementById("gear-panel").hidden = true;
  syncPanelClass();
}

function updateGearBadge(n) {
  var badge = document.getElementById("gear-badge");
  if (!badge) return;
  if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  else badge.hidden = true;
}

export function updateGearCount() {
  updateGearBadge(S.state ? gearEntries().length : 0);
}

/* "Gear · 2 items" in the panel's head (#169, B-PanelGear). */
function updateGearHeadCount(n) {
  var el = document.getElementById("gear-head-count");
  if (!el) return;
  el.hidden = !n;
  el.innerHTML = '<span class="panel-count">' + n + '</span> item' + (n === 1 ? '' : 's');
}

export function renderGearList() {
  var panel = document.getElementById("gear-panel");
  if (!panel || panel.hidden || !S.state) return;
  dropEditingForReview();
  var listEl = document.getElementById("gear-list");
  var entries = gearEntries();
  updateGearBadge(entries.length);
  updateGearHeadCount(entries.length);

  document.querySelectorAll("#gear-modes [data-group]").forEach(function (b) {
    var on = b.getAttribute("data-group") === S.gearGroupBy;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });

  /* the quick-add box sits at the panel's foot since #169 */
  if (!entries.length) {
    listEl.innerHTML = '<div class="comments-empty">No gear tracked yet.<br><br>' +
      'Type <code>&lt;a lens&gt;</code> straight into the script, select words and ' +
      'press <strong>Tag</strong>, or just list it below — gear doesn’t have to be ' +
      'written into a scene to be tracked.</div>';
    return;
  }

  if (S.gearGroupBy === "scene") {
    var untracked = entries.filter(function (e) { return e.orphaned; }).length;
    listEl.innerHTML = renderProductionByScene(entries.filter(function (e) { return !e.orphaned; })) +
      (untracked ? '<div class="tag-orphan-note">' + untracked +
        (untracked === 1 ? " item isn't" : " items aren't") +
        ' mentioned in any scene — switch to List to see ' +
        (untracked === 1 ? "it" : "them") + '.</div>' : '');
    return;
  }

  listEl.innerHTML = '<ul class="tag-list" aria-label="Gear items">' +
    entries.map(function (e) { return tagEntityHtml(e, { gear: true }); }).join("") + '</ul>';
}

/* The textarea always opens showing what's actually tracked, sorted the
   way a packed list reads best — alphabetically, not script order, since
   half of what's in here may have no place in the script at all. */
function fillGearQuickAdd() {
  var box = document.getElementById("gear-quickadd-input");
  if (!box || document.activeElement === box) return;
  var names = gearEntries().map(function (e) { return e.name; })
    .sort(function (a, b) { return a.localeCompare(b); });
  box.value = names.join("\n");
}

/* One line, one item. Reconciles rather than only adding: a name typed in
   becomes tracked whether or not it's ever mentioned in the script (see
   registerProductionTag), and a name taken back OUT is untracked again —
   but only if nothing in the script still tags it. An item that's live in
   the script can't actually be lost this way: it comes straight back the
   next render via the registry self-heal (healTagRegistry), so this never
   silently drops anything the script itself is still pointing at — it
   only ever forgets the entries that lived here and nowhere else. */
export function applyGearQuickAdd() {
  /* hidden in review by app.css; refused here as well */
  if (reviewBlocked()) return;
  var raw = document.getElementById("gear-quickadd-input").value || "";
  var wanted = {}, order = [];
  raw.split(/\r\n|\r|\n/).forEach(function (line) {
    var name = plainText(line).trim().slice(0, 80);
    if (!name) return;
    var key = normalizeTagName(name);
    if (wanted[key]) return;
    wanted[key] = name;
    order.push(key);
  });

  var removed = 0;
  gearEntries().forEach(function (item) {
    if (wanted[normalizeTagName(item.name)] !== undefined) return;
    if (!item.orphaned) return; /* still tagged live — never silently dropped */
    if (deleteProductionTagEntry("gear", item.name)) removed++;
  });

  var added = 0;
  order.forEach(function (key) {
    if (!registryEntry("gear", wanted[key])) added++;
    registerProductionTag("gear", wanted[key]);
  });

  if (!added && !removed) { fillGearQuickAdd(); return; }
  markDirty();
  renderProduction();
  fillGearQuickAdd();
  queueAutoSave();
  var parts = [];
  if (added) parts.push("added " + added);
  if (removed) parts.push("removed " + removed);
  showToast("Gear list updated — " + parts.join(", ") + ".", "ok");
}

/* The Scenes column (#169, Adam's review): "03, 04, 05", one link per
   scene however the item is written there. A scene with it in both
   columns, or twice in one, is still one link — jumpToTag flashes every
   mention in the scene it lands on, so one link reaches them all — and
   the link's name says what is there ("Scene 03 · Visual and Audio · 2
   mentions"), which is what the old per-column chips showed as text. */
/* The comma between two scene numbers, in the body face: in the mono it
   takes a whole character cell and reads "03 , 04". */
var SCENE_SEP = '<span class="tag-scene-sep">, </span>';

function sceneLinksHtml(item) {
  var byRow = {}, order = [];
  item.mentions.forEach(function (m) {
    var s = byRow[m.rowId];
    if (!s) { s = byRow[m.rowId] = { m: m, n: 0, visual: false, audio: false }; order.push(s); }
    s.n++;
    if (m.field === "visualText") s.visual = true; else s.audio = true;
  });
  order.sort(function (a, b) { return a.m.rowIndex - b.m.rowIndex; });
  return order.map(function (s) {
    var num = pad2(s.m.rowIndex + 1);
    var label = "Scene " + num + " · " +
      (s.visual && s.audio ? "Visual and Audio" : s.visual ? "Visual" : "Audio") +
      (s.n > 1 ? " · " + s.n + " mentions" : "") + " — go to it";
    return '<button type="button" class="tag-scene jump-link" data-action="jump-tag" data-row="' +
      escapeHtml(s.m.rowId) + '" data-key="' + escapeHtml(item.key) + '" title="' +
      escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' + num + '</button>';
  }).join(SCENE_SEP);
}

/* The open Gear item's "Mentions" (B-PanelGear): one link per scene AND
   column, "03 Visual", so "twice in scene 1" is distinguishable from
   "once in the visual and once in the audio". */
function mentionLinksHtml(item) {
  var seen = {}, order = [];
  item.mentions.forEach(function (m) {
    var k = m.rowIndex + "|" + m.field;
    if (seen[k]) { seen[k].n++; return; }
    seen[k] = { n: 1, m: m };
    order.push(k);
  });
  return order.map(function (k) {
    var entry = seen[k];
    var num = pad2(entry.m.rowIndex + 1);
    return '<button type="button" class="tag-mention jump-link" data-action="jump-tag" data-row="' +
      escapeHtml(entry.m.rowId) + '" data-key="' + escapeHtml(item.key) + '" title="Go to this mention in scene ' +
      num + '"><span class="tag-figure">' + num + '</span> ' +
      (entry.m.field === "visualText" ? "Visual" : "Audio") +
      (entry.n > 1 ? ' <span class="tag-figure">×' + entry.n + '</span>' : '') + '</button>';
  }).join(", ");
}

/* An owner in a row or a head: their avatar, in their colour — the one
   table, personColor() in 13a-presence.js — with one initial, the way the
   boards draw an 18px one. */
function personAvatarHtml(name) {
  var initial = Array.from(String(name || "").trim())[0] || "?";
  return '<span class="person-avatar" style="--presence:' + personColor(name) + '" aria-hidden="true">' +
    escapeHtml(initial.toUpperCase()) + '</span>';
}

/* The Owner column: avatar and first name, or a dash (#169). */
function ownerCellHtml(owner) {
  if (!owner) {
    return '<span class="tag-owner is-none"><span aria-hidden="true">—</span>' +
      '<span class="tag-sr">Unassigned</span></span>';
  }
  var first = String(owner.name).trim().split(/\s+/)[0] || owner.name;
  return '<span class="tag-owner" title="' + escapeHtml(owner.name) + '">' + personAvatarHtml(owner.name) +
    '<span class="tag-owner-name">' + escapeHtml(first) + '</span></span>';
}

/* The row's status: its lamp and word, and a click moves it one step on.
   A reviewer gets the same as a label, and a click on it opens the item
   like a click on its name. */
function statusCellHtml(item) {
  var st = tagStatus(item.status) || TAG_STATUSES[0];
  var k = escapeHtml(item.key);
  var inner = tagStatusLampHtml(st.id) + escapeHtml(st.label);
  if (reviewMode()) {
    return '<span class="tag-status-pill is-static" data-action="tag-expand" data-key="' + k + '">' + inner + '</span>';
  }
  var nextSt = tagStatus(nextTagStatus(st.id)) || TAG_STATUSES[0];
  return '<button type="button" class="tag-status-pill" data-action="tag-status-cycle" data-key="' + k +
    '" title="' + escapeHtml(st.label + " — click for " + nextSt.label) + '" aria-label="' +
    escapeHtml("Status: " + st.label + ". Click for " + nextSt.label) + '">' + inner + '</button>';
}

/* An id for a label to point at: unique per item and per panel, since the
   Production and Gear panels can both hold the same item's fields. */
function tagFieldId(what, gear, key) {
  return "tag-" + what + "-" + (gear ? "g-" : "p-") +
    String(key).replace(/[^A-Za-z0-9]/g, function (c) { return "_" + c.charCodeAt(0).toString(16); });
}

function iconHtml(id, cls) {
  return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true" focusable="false"><use href="#' + id + '"/></svg>';
}

/* ---- a review session (#30): the breakdown to read, not to change ----

   A reviewer (13-hosted.js reviewMode) can open a card, switch the
   grouping and jump to a scene, and nothing else: the server keeps none of
   a reviewer's edits, so a change made here would look as if it had worked
   and then be lost. The open card's status and owner are drawn disabled and
   its notes read-only, so the values stay readable; Add person, Rename and
   Remove/Delete, and the "⋯" that holds them, are not drawn; and there is
   no selection, because the only thing a selection is for is the bulk bar.
   Clicks are refused by the click guard (21-events.js REVIEW_SAFE_ACTIONS);
   the change and input handlers (20-teleprompter.js wireTagEntityContainer,
   21-events.js) refuse their own. The same rule as the b-roll panel
   (08d-broll-panel.js). */

/* Whatever was half open when the role arrived — a rename, an add-person
   box, a selection and its bar — goes, rather than being drawn for
   somebody who cannot finish it. */
function dropEditingForReview() {
  if (!reviewMode()) return;
  S.tagRenaming = null;
  S.tagAddingPersonFor = null;
  if (selectedKeys().length) clearProductionSelection();
  if (bulkDeleteArmed) disarmBulkDelete();
}

/* The owner picker, notes box and the destructive actions all live behind
   a click on the item's name — the list stays scannable when you're
   reading it as a breakdown, and the editing controls are there when
   you're working on one item. Renaming forces it open, since its input
   lives in here.

   Since #169 the open item is a label–value list on --surface-2, drawn
   the way each board draws it. The breakdown's (B-PanelProduction) picks
   the status from four lamps and keeps Rename and Remove label in the
   "⋯" beside the owner; Gear's narrower one (B-PanelGear) has the status
   as a menu, lists the item's mentions, and puts Rename under the list
   with the "⋯" beside it. Either way every field shows its border at rest
   (Adam: fields and buttons must be easy to find). */
function tagEntityDetailHtml(item, renaming, gear, detailId) {
  var k = escapeHtml(item.key);
  var name = escapeHtml(item.name);
  var st = tagStatus(item.status) || TAG_STATUSES[0];
  var ro = reviewMode();
  var off = ro ? ' disabled' : '';
  var ownerId = tagFieldId("owner", gear, item.key);
  var notesId = tagFieldId("notes", gear, item.key);
  var renameId = tagFieldId("rename", gear, item.key);

  /* the four states, each its lamp and word: a radiogroup in the
     breakdown, the items of the Status menu in Gear. Either way they are
     .tag-status-seg's buttons, which is what a reviewer's are checked by */
  var choices = TAG_STATUSES.map(function (s) {
    var on = s.id === st.id;
    return '<button type="button" role="' + (gear ? 'menuitemradio' : 'radio') + '" class="' +
        (gear ? 'tag-menu-item' : 'tag-status-choice') + (on ? ' is-active' : '') +
        '" data-action="tag-status-set" data-key="' + k + '" data-status="' + escapeHtml(s.id) +
        '" aria-checked="' + (on ? 'true' : 'false') + '"' + off + '>' +
      tagStatusLampHtml(s.id) + escapeHtml(s.label) + '</button>';
  }).join("");
  var status = gear
    ? '<div class="tag-menu-wrap">' +
        '<button type="button" class="tag-status-menu-btn tag-menu-btn" aria-haspopup="menu" aria-expanded="false" ' +
          'aria-label="' + escapeHtml("Status: " + st.label + (ro ? "" : ". Change")) + '"' + off + '>' +
          tagStatusLampHtml(st.id) + escapeHtml(st.label) + (ro ? '' : iconHtml("i-chevron-down", "tag-chevron")) +
        '</button>' +
        '<div class="tag-menu tag-status-seg" role="menu" aria-label="Status of ' + name + '" hidden>' + choices + '</div>' +
      '</div>'
    : '<div class="tag-status-seg" role="radiogroup" aria-label="Status of ' + name + '">' + choices + '</div>';

  /* a reviewer's select has no box and no chevron: a name to read */
  var ownerField = '<span class="ev-field tag-owner-field' + (ro ? ' is-readonly' : '') + '">' +
      '<select class="tag-owner-select' + (personById(item.owner) ? '' : ' is-unassigned') + '" id="' + ownerId +
        '" data-key="' + k + '"' + off + '>' +
        '<option value=""' + (item.owner ? '' : ' selected') + '>Unassigned</option>' +
        S.state.people.map(function (p) {
          return '<option value="' + escapeHtml(p.id) + '"' +
            (p.id === item.owner ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
        }).join("") +
      '</select>' +
      (ro ? '' : iconHtml("i-chevron-down", "ev-chevron")) +
    '</span>';
  var addPerson = ro ? '' :
    '<button type="button" class="tag-person-add tag-quiet-btn" data-action="tag-person-new" data-key="' + k +
      '" title="Add someone to the crew list"' +
      (gear ? ' aria-label="Add a person to the crew list">' + iconHtml("i-plus") + 'Person' : '>Add person') +
    '</button>';
  var personRow = S.tagAddingPersonFor === item.key
    ? '<div class="tag-person-row">' +
        '<input type="text" class="tag-person-input ev-field" data-key="' + k +
          '" placeholder="Their name" maxlength="60" aria-label="The new person’s name">' +
        '<button type="button" class="btn-outline is-small" data-action="tag-person-save" data-key="' + k + '">Add</button>' +
        '<button type="button" class="tag-quiet-btn" data-action="tag-person-cancel">Cancel</button>' +
      '</div>'
    : '';

  /* "⋯": Rename (the breakdown's; Gear's is out under the list) and the
     one destructive action, whose first click arms it in place — the menu
     stays open for the second (armRemoveTag / armDeleteTag) */
  var more = ro ? '' :
    '<div class="tag-menu-wrap tag-more">' +
      '<button type="button" class="tag-more-btn tag-menu-btn' + (gear ? ' tag-icon-btn' : ' btn-outline is-small is-icon') +
        '" aria-haspopup="menu" aria-expanded="false" title="More" aria-label="' +
        escapeHtml("More actions for " + item.name + ": " + (gear ? "" : "Rename, ") +
          (item.orphaned ? "Delete from list" : "Remove label")) + '">' + iconHtml("i-more") + '</button>' +
      '<div class="tag-menu" role="menu" aria-label="' + escapeHtml("Actions for " + item.name) + '" hidden>' +
        (gear ? '' :
          '<button type="button" role="menuitem" class="tag-menu-item" data-action="tag-rename" data-key="' + k + '">' +
            iconHtml("i-pen") + '<span class="tag-menu-label">Rename</span></button>') +
        (item.orphaned
          ? '<button type="button" role="menuitem" class="tag-menu-item danger" data-action="tag-delete" data-key="' + k + '">' +
              iconHtml("i-trash") + '<span class="tag-menu-label">Delete from list</span></button>'
          : '<button type="button" role="menuitem" class="tag-menu-item danger" data-action="tag-remove" data-key="' + k + '">' +
              iconHtml("i-tag") + '<span class="tag-menu-label">Remove label</span></button>') +
      '</div>' +
    '</div>';

  var dl = '<dl class="tag-entity-detail' + (gear ? ' is-gear' : '') + '" id="' + detailId + '">' +
      (renaming
        ? '<dt><label for="' + renameId + '">Name</label></dt>' +
          '<dd class="tag-rename-row">' +
            '<input type="text" class="tag-rename-input ev-field" id="' + renameId + '" value="' + name +
              '" data-key="' + k + '">' +
            '<button type="button" class="btn-outline is-small" data-action="tag-rename-save" data-key="' + k + '">Save</button>' +
            '<button type="button" class="tag-quiet-btn" data-action="tag-rename-cancel">Cancel</button>' +
          '</dd>'
        : '') +
      '<dt>Status</dt><dd class="tag-status-dd">' + status + '</dd>' +
      (gear
        ? '<dt>Mentions</dt><dd class="tag-mentions">' +
            (item.orphaned ? '<span class="tag-orphan-badge">Not in script</span>' : mentionLinksHtml(item)) + '</dd>'
        : '') +
      '<dt><label for="' + ownerId + '">Assigned to</label></dt>' +
      '<dd class="tag-owner-dd">' + ownerField + addPerson + (gear ? '' : more) + personRow + '</dd>' +
      '<dt><label for="' + notesId + '">Notes &amp; links</label></dt>' +
      '<dd class="tag-notes-dd">' +
        '<textarea class="tag-notes-input ev-field" id="' + notesId + '" data-key="' + k + '" rows="2" ' +
          (ro ? 'readonly placeholder="No notes">'
              : 'placeholder="Reference link, file path, spec, where it’s coming from…">') +
          escapeHtml(item.notes) + '</textarea>' +
      '</dd>' +
    '</dl>';
  if (!gear || ro) return dl;
  return dl +
    '<div class="tag-detail-foot">' +
      (renaming ? '' :
        '<button type="button" class="tag-quiet-btn tag-rename-btn" data-action="tag-rename" data-key="' + k + '">' +
          iconHtml("i-pen") + 'Rename</button>') +
      more +
    '</div>';
}

/* One tracked item, as a row (#169). The breakdown's rows are columns —
   Item · Status · Scenes · Owner, under the label row in page.html
   (#production-cols) — and Gear's are the board's shorter line: a dot, the
   name, the status and where it is. The name is the expander
   (.tag-entity-head); the status beside it and each scene are controls of
   their own, so nothing is nested inside the expander any more. Names and
   scene lists wrap in full, never "…" (Adam's review). */
function tagEntityHtml(item, opts) {
  opts = opts || {};
  var gear = !!opts.gear;
  var renaming = S.tagRenaming === item.key;
  var expanded = S.tagExpanded === item.key || renaming;
  var k = escapeHtml(item.key);
  /* productionSelection is Production-panel-only state (the Gear panel
     wires no Ctrl/Shift-click, no bulk bar, nothing to clear or explain
     a highlight with — see the multi-select comment below) but this
     function is shared by both panels; without gating on opts.selection,
     an item selected via Production still rendered "selected" when
     later viewed in Gear, with no way to make sense of or clear it. */
  var selected = opts.selection && !reviewMode() && productionSelection[item.key];
  var detailId = tagFieldId("detail", gear, item.key);
  /* the category's dot where no section title carries it: Gear's rows,
     and the breakdown grouped by person */
  var dot = '<span class="tag-row-dot" aria-hidden="true"></span>';
  return '<li class="tag-entity' + (gear ? ' is-gear' : '') + (item.orphaned ? ' is-orphaned' : '') +
      (expanded ? ' is-expanded' : '') +
      (selected ? ' is-selected' : '') +
      '" style="--dot:' + item.cat.color + '" data-key="' + k +
      '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
    '<div class="tag-entity-row">' +
      (gear ? dot : '') +
      '<button type="button" class="tag-entity-head" data-action="tag-expand" data-key="' + k +
        '" aria-expanded="' + (expanded ? 'true' : 'false') + '"' +
        (expanded ? ' aria-controls="' + detailId + '"' : '') + '>' +
        (opts.dot ? dot : '') + '<span class="tag-entity-name">' + escapeHtml(item.name) + '</span>' +
      '</button>' +
      statusCellHtml(item) +
      '<span class="tag-scenes">' +
        (item.orphaned ? '<span class="tag-orphan-badge">Not in script</span>' : sceneLinksHtml(item)) +
      '</span>' +
      (gear ? '' : ownerCellHtml(personById(item.owner))) +
    '</div>' +
    (expanded ? tagEntityDetailHtml(item, renaming, gear, detailId) : '') +
  '</li>';
}

function renderProductionByScene(all) {
  var byRow = {};
  all.forEach(function (item) {
    item.mentions.forEach(function (m) {
      if (!byRow[m.rowIndex]) byRow[m.rowIndex] = {};
      byRow[m.rowIndex][item.key] = item;
    });
  });
  var indexes = Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; });
  /* a section per scene titled the way the category sections are (#169),
     its items as outlined chips with their category's dot */
  return indexes.map(function (idx) {
    var items = Object.keys(byRow[idx]).map(function (k) { return byRow[idx][k]; });
    return '<section class="tag-scene-group">' +
      '<h3 class="tag-scene-group-head">Scene <span class="tag-figure">' + pad2(idx + 1) + '</span></h3>' +
      '<ul class="tag-pills">' +
        items.map(function (item) {
          return '<li class="tag-pill" style="--dot:' + item.cat.color + '">' +
            '<span class="tag-cat-dot" aria-hidden="true"></span>' +
            escapeHtml(item.name) + '</li>';
        }).join("") +
      '</ul>' +
    '</section>';
  }).join("");
}

/* Everyone on the crew list gets a group even with nothing assigned yet —
   an empty column is the useful signal that someone has no work on them,
   and it gives you somewhere to drop the first item. Unassigned sorts
   last, since it's the pile you're trying to empty. */
function renderProductionByPerson(all) {
  var buckets = {}, order = [];
  function bucket(id, label) {
    if (!buckets[id]) { buckets[id] = { id: id, label: label, items: [] }; order.push(id); }
    return buckets[id];
  }
  S.state.people.forEach(function (p) { bucket(p.id, p.name); });
  all.forEach(function (item) {
    var p = personById(item.owner);
    bucket(p ? p.id : "", p ? p.name : "Unassigned").items.push(item);
  });
  order.sort(function (a, b) { return (a === "" ? 1 : 0) - (b === "" ? 1 : 0); });

  /* each person a section titled like the categories' (#169), their
     avatar where a category has its dot; the rows carry the dot instead */
  return order.map(function (id) {
    var g = buckets[id];
    return '<section class="tag-group">' +
      '<h3 class="tag-group-head tag-person-head">' +
        (id ? personAvatarHtml(g.label) : iconHtml("i-person", "tag-person-none")) +
        '<span class="tag-person-name">' + escapeHtml(g.label) + '</span>' +
        '<span class="tag-group-count">' + g.items.length + '</span>' +
        (id && !reviewMode() ? '<button type="button" class="tag-person-remove" data-action="person-delete" ' +
                'data-person="' + escapeHtml(id) + '" title="Remove from the crew list" aria-label="' +
                escapeHtml("Remove " + g.label + " from the crew list") + '">' +
                iconHtml("i-close") + '</button>' : '') +
      '</h3>' +
      (g.items.length
        ? '<ul class="tag-list">' +
            g.items.map(function (e) { return tagEntityHtml(e, { selection: true, dot: true }); }).join("") +
          '</ul>'
        : '<div class="tag-orphan-note">Nothing assigned yet.</div>') +
    '</section>';
  }).join("");
}

/* Shooting order: the script reorganised the way a shoot day actually runs.
   Scenes are grouped by the location tagged in them, so everything at one
   place can be shot in one block, and each block lists what has to be
   there — every non-location item tagged in those scenes, with who is
   responsible for it. A scene with no location tagged still has to be shot,
   so it gets its own group rather than being quietly dropped. */
function renderProductionByShoot(entries) {
  /* productionEntries(), not collectTags(): the raw script read has only
     {cat, name, mentions} on it, so the owner and status this view prints
     against each item would silently be undefined. Orphans carry no
     mentions, so they contribute nothing here and need no filtering out. */
  var live = entries || productionEntries();
  var byRow = {};   /* rowIndex -> [item] */
  live.forEach(function (item) {
    item.mentions.forEach(function (m) {
      (byRow[m.rowIndex] = byRow[m.rowIndex] || []).push(item);
    });
  });

  var groups = {}, order = [];
  function group(key, name) {
    if (!groups[key]) { groups[key] = { name: name, rows: [], needs: {}, needOrder: [] }; order.push(key); }
    return groups[key];
  }

  S.state.rows.forEach(function (row, i) {
    var here = byRow[i] || [];
    var locs = here.filter(function (t) { return t.cat.id === "location"; });
    var targets = locs.length
      ? locs.map(function (t) { return { key: t.key, name: t.name }; })
      : [{ key: "", name: "No location set" }];
    targets.forEach(function (t) {
      var g = group(t.key, t.name);
      if (g.rows.indexOf(i) === -1) g.rows.push(i);
      here.forEach(function (item) {
        if (item.cat.id === "location") return;
        if (g.needs[item.key]) return;
        g.needs[item.key] = item;
        g.needOrder.push(item.key);
      });
    });
  });

  if (!order.length) return '<div class="comments-empty">Nothing to schedule yet.</div>';
  /* untagged scenes last — they're the leftovers, not the plan */
  order.sort(function (a, b) { return (a === "" ? 1 : 0) - (b === "" ? 1 : 0); });

  /* A section per location, titled like the categories' (#169): its dot,
     name and "1/2 shot · 0:31"; then its scenes as links ("01, 02" with a
     tick on a shot one) and what has to be there, each need a line with
     its lamp and owner like a breakdown row's. */
  return order.map(function (key) {
    var g = groups[key];
    var shot = g.rows.filter(function (i) { return S.state.rows[i].status === "shot"; }).length;
    var secs = g.rows.reduce(function (n, i) { return n + rowSeconds(S.state.rows[i]); }, 0);
    var done = shot === g.rows.length;
    return '<section class="shoot-group" style="--dot:' + (key ? TAG_CATEGORIES[1].color : "var(--border-strong)") + '">' +
      '<h3 class="shoot-head">' +
        '<span class="tag-cat-dot" aria-hidden="true"></span>' +
        '<span class="shoot-name">' + escapeHtml(g.name) + '</span>' +
        '<span class="shoot-progress' + (done ? ' is-done' : '') + '">' +
          '<span class="tag-figure">' + shot + '/' + g.rows.length + '</span> shot · ' +
          '<span class="tag-figure">' + formatDuration(secs) + '</span></span>' +
      '</h3>' +
      '<dl class="shoot-detail">' +
        '<dt>Scenes</dt>' +
        '<dd class="tag-scenes">' +
          g.rows.map(function (i) {
            var row = S.state.rows[i];
            var st = rowStatus(row.status) || ROW_STATUSES[0];
            var label = "Scene " + pad2(i + 1) + " · " + st.label + " — go to it";
            return '<button type="button" class="tag-scene jump-link' + (row.status === "shot" ? ' is-shot' : '') +
              '" data-action="jump-row" data-row="' + escapeHtml(row.id) + '" title="' + escapeHtml(label) +
              '" aria-label="' + escapeHtml(label) + '">' + pad2(i + 1) +
              (row.status === "shot" ? iconHtml("i-check", "tag-scene-tick") : '') + '</button>';
          }).join(SCENE_SEP) +
        '</dd>' +
        (g.needOrder.length
          ? '<dt>Needs on the day</dt>' +
            '<dd><ul class="shoot-needs">' +
              g.needOrder.map(function (k) {
                var item = g.needs[k];
                var owner = personById(item.owner);
                var nst = tagStatus(item.status) || TAG_STATUSES[0];
                return '<li class="shoot-need" style="--dot:' + item.cat.color + '">' +
                  '<span class="tag-cat-dot" aria-hidden="true"></span>' +
                  '<span class="shoot-need-name">' + escapeHtml(item.name) + '</span>' +
                  '<span class="shoot-need-status">' + tagStatusLampHtml(nst.id) + escapeHtml(nst.label) + '</span>' +
                  ownerCellHtml(owner) +
                '</li>';
              }).join("") +
            '</ul></dd>'
          : '') +
      '</dl>' +
    '</section>';
  }).join("");
}

/* Every caller that changes tagged data — a status cycle, a rename, an
   edit to the script itself — refreshes by calling renderProduction().
   There are now two panels that can show that data: split so BOTH refresh
   from one call, the same way updateFileChip() covers the header's chip
   and the writer's. Neither caller has to know the other panel exists. */
export function renderProduction() {
  renderProductionPanel();
  renderGearList();
}

/* One scan, threaded through everything that needs it. Pruning, the list,
   the badge and the bulk bar all used to call productionEntries()
   separately — four reads of the same document in one synchronous pass.
   Threading rather than caching on a version counter keeps it obviously
   correct: it is the same array, so it cannot disagree with itself. */
function renderProductionPanel() {
  var panel = document.getElementById("production-panel");
  if (!panel || panel.hidden || !S.state) return;
  dropEditingForReview();
  var entries = productionEntries();
  if (selectedKeys().length) pruneProductionSelection(entries);
  renderProductionList(entries);
  renderBulkBar(entries);
  updateProductionBadge(entries.length);
}

function renderProductionList(entries) {
  var listEl = document.getElementById("production-list");
  var panel = document.getElementById("production-panel");
  if (!listEl || !panel || panel.hidden || !S.state) return;
  entries = entries || productionEntries();

  document.querySelectorAll("#production-modes [data-group]").forEach(function (b) {
    var on = b.getAttribute("data-group") === S.productionGroupBy;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });

  var groups = tagsByCategory(entries);
  /* the column labels (#169) head the two groupings drawn as rows */
  var cols = document.getElementById("production-cols");
  if (cols) {
    cols.hidden = !groups.length ||
      (S.productionGroupBy !== "cat" && S.productionGroupBy !== "person");
  }

  /* the shoot view is organised around scenes, so it still has something
     useful to say even when nothing has been tagged yet */
  if (S.productionGroupBy === "shoot") {
    listEl.innerHTML = renderProductionByShoot(entries);
    return;
  }

  if (!groups.length) {
    listEl.innerHTML = '<div class="comments-empty">Nothing labelled yet.<br><br>' +
      'Type <code>[a prop]</code>, <code>{a location}</code> or <code>~an effect~</code> ' +
      'straight into the script, or select any words and press <strong>Tag</strong>. ' +
      'Everything you label shows up here with every scene it appears in — and you can ' +
      'assign who is responsible for it, track it from Needed through to Returned, ' +
      'and keep notes and links against it.</div>';
    return;
  }

  if (S.productionGroupBy === "scene") {
    var orphanCount = groups.reduce(function (n, g) {
      return n + g.items.filter(function (i) { return i.orphaned; }).length;
    }, 0);
    /* live items only — the scene view groups by where a tag appears, and
       an orphan appears nowhere; they are counted separately below */
    listEl.innerHTML = renderProductionByScene(entries.filter(function (e) { return !e.orphaned; })) +
      (orphanCount ? '<div class="tag-orphan-note">' + orphanCount +
        (orphanCount === 1 ? " item doesn't" : " items don't") +
        ' appear in any scene — group by category or person to see ' +
        (orphanCount === 1 ? "it" : "them") + '.</div>' : '');
    return;
  }

  if (S.productionGroupBy === "person") {
    listEl.innerHTML = renderProductionByPerson(entries);
    return;
  }

  /* Section titles that look like titles (Adam's review): 14px bold, the
     category's dot, the count in the mono, a rule under. */
  listEl.innerHTML = groups.map(function (g) {
    return '<section class="tag-group">' +
      '<h3 class="tag-group-head" style="--dot:' + g.cat.color + '">' +
        '<span class="tag-cat-dot" aria-hidden="true"></span>' +
        '<span class="tag-group-label">' + escapeHtml(g.cat.plural) + '</span>' +
        '<span class="tag-group-count">' + g.items.length + '</span>' +
      '</h3>' +
      '<ul class="tag-list">' +
        g.items.map(function (e) { return tagEntityHtml(e, { selection: true }); }).join("") +
      '</ul>' +
    '</section>';
  }).join("");
}

/* The registry record a write to `item` lands on. A live tag the registry
   has not caught up with yet — pasted in a moment ago, before the idle
   refresh's heal ran — shows in the panel like any other item, so a click
   on it must not fall through to nothing: heal first. Quiet, like every
   heal; the write that follows is what dirties the document. */
function trackedEntry(item) {
  healTagRegistry();
  return registryEntry(item.cat.id, item.name);
}

function findTagByKey(key) {
  var all = productionEntries();
  for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
  return null;
}

export function jumpToTag(rowId, key) {
  revealRow(rowId);
  var row = document.querySelector('#rows .row[data-id="' + safeId(rowId, "r") + '"]');
  if (!row) { showToast("That scene is no longer here.", "warn"); return; }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  var item = findTagByKey(key);
  if (!item) return;
  Array.prototype.forEach.call(row.querySelectorAll(".tag-anchor"), function (el) {
    /* category too, not just name — eachTagSpan (07-production-tags.js)
       already checks both; without it, a Prop and an unrelated Cast tag
       sharing a name in the same row both flashed on one click. */
    if (el.getAttribute("data-tag-cat") !== item.cat.id) return;
    if (normalizeTagName(el.getAttribute("data-tag-name")) !== normalizeTagName(item.name)) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  });
}

export function armRemoveTag(btn, key) {
  if (S.tagDeleteArmId === key) {
    clearTimeout(S.tagDeleteArmTimer);
    S.tagDeleteArmId = null;
    var item = findTagByKey(key);
    if (!item) return;
    /* one undo entry of its own: removing touches cells only, so typing
       in one of them just before or after could otherwise coalesce into
       it */
    breakUndoCoalescing();
    var n = removeTag(item.cat.id, item.name);
    markDirty();
    breakUndoCoalescing();
    render();
    queueAutoSave();
    showToast("Removed " + item.name + " from " + n + " mention" + (n === 1 ? "" : "s"), "ok");
    return;
  }
  S.tagDeleteArmId = key;
  var disarm = armButton(btn);
  clearTimeout(S.tagDeleteArmTimer);
  S.tagDeleteArmTimer = setTimeout(function () {
    S.tagDeleteArmId = null;
    disarm();
  }, 2800);
}

/* The first click of a two-click action: the button says "Confirm?" in
   place of its words — beside its icon, where it has one (#169) — until
   the returned function puts them back. */
function armButton(btn) {
  var label = btn.querySelector(".tag-menu-label") || btn;
  var was = label.innerHTML;
  var aria = btn.getAttribute("aria-label");
  label.textContent = "Confirm?";
  if (aria) btn.setAttribute("aria-label", "Confirm? " + aria);
  btn.classList.add("armed");
  return function () {
    label.innerHTML = was;
    if (aria) btn.setAttribute("aria-label", aria);
    btn.classList.remove("armed");
  };
}

/* Deletes the tracked entry itself — only offered once an item is already
   orphaned (see tagEntityHtml). Shares the same arm/confirm state as
   armRemoveTag; the two buttons are never both on screen for one entity,
   so there's no collision. */
export function armDeleteTag(btn, key) {
  if (S.tagDeleteArmId === key) {
    clearTimeout(S.tagDeleteArmTimer);
    S.tagDeleteArmId = null;
    var item = findTagByKey(key);
    if (!item) return;
    deleteProductionTagEntry(item.cat.id, item.name);
    markDirty();
    render();
    queueAutoSave();
    showToast("Deleted " + item.name + " from the production list", "ok");
    return;
  }
  S.tagDeleteArmId = key;
  var disarm = armButton(btn);
  clearTimeout(S.tagDeleteArmTimer);
  S.tagDeleteArmTimer = setTimeout(function () {
    S.tagDeleteArmId = null;
    disarm();
  }, 2800);
}

export function toggleCardSelection(key) {
  if (reviewMode()) return;
  if (productionSelection[key]) delete productionSelection[key];
  else productionSelection[key] = true;
  S.selectionAnchorKey = key;
  disarmBulkDelete();
  renderProduction();
}

/* Long-press on a breakdown card (touch only). Delegated on the list
   container, which survives re-renders; the cards themselves do not. */
var touchPress = { timer: null, key: null, fired: false, x: 0, y: 0 };

function cancelTouchPress() {
  if (touchPress.timer) { clearTimeout(touchPress.timer); touchPress.timer = null; }
}

export function wireTouchSelection() {
  var list = document.getElementById("production-list");
  if (!list) return;

  list.addEventListener("pointerdown", function (e) {
    /* a reviewer has no bulk bar, so nothing to select for: a long-press
       is left to the browser */
    if (e.pointerType === "mouse" || reviewMode()) return;
    var card = e.target.closest(".tag-entity");
    if (!card) return;
    /* not from inside the open card's own inputs — a long-press in the
       notes box is the OS text-selection gesture, leave it alone */
    if (e.target.closest(".tag-entity-detail, .tag-rename-input")) return;
    touchPress.key = card.getAttribute("data-key");
    touchPress.fired = false;
    touchPress.x = e.clientX; touchPress.y = e.clientY;
    cancelTouchPress();
    touchPress.timer = setTimeout(function () {
      touchPress.timer = null;
      touchPress.fired = true;   /* swallow the click that follows the release */
      toggleCardSelection(touchPress.key);
      if (navigator.vibrate) navigator.vibrate(10);
    }, 450);
  });

  /* finger drifting = scrolling, not pressing */
  list.addEventListener("pointermove", function (e) {
    if (!touchPress.timer) return;
    if (Math.abs(e.clientX - touchPress.x) > 10 || Math.abs(e.clientY - touchPress.y) > 10) cancelTouchPress();
  });
  list.addEventListener("pointerup", cancelTouchPress);
  list.addEventListener("pointercancel", cancelTouchPress);

  /* the browser fires a click after the pointer sequence regardless;
     if the long-press already acted, that click must die here */
  list.addEventListener("click", function (e) {
    if (touchPress.fired) {
      touchPress.fired = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  /* Android's long-press context menu on the cards would race the gesture */
  list.addEventListener("contextmenu", function (e) {
    if (IS_TOUCH && e.target.closest(".tag-entity")) e.preventDefault();
  });
}

/* Consumes a modifier-click on a card. Returns true if it handled it, so
   the caller knows not to fall through to expanding the card. */
export function handleSelectionClick(e, card) {
  /* not handled: a reviewer's Ctrl/Shift+click opens the card like a
     plain click, and selects nothing */
  if (reviewMode()) return false;
  var key = card.getAttribute("data-key");
  if (!key) return false;
  /* visual order, read live — it is the order the range runs along, and it
     differs between the Category and Person groupings */
  var order = Array.prototype.map.call(
    document.querySelectorAll("#production-list .tag-entity"),
    function (el) { return el.getAttribute("data-key"); });
  var here = order.indexOf(key);
  if (here === -1) return false;

  var anchor = S.selectionAnchorKey ? order.indexOf(S.selectionAnchorKey) : -1;
  if (e.shiftKey && anchor !== -1) {
    var lo = Math.min(anchor, here), hi = Math.max(anchor, here);
    for (var i = lo; i <= hi; i++) productionSelection[order[i]] = true;
  } else {
    if (productionSelection[key]) delete productionSelection[key];
    else productionSelection[key] = true;
    S.selectionAnchorKey = key;
  }

  /* a Ctrl/Shift+click leaves a stray text selection across the card */
  var sel = window.getSelection();
  if (sel && sel.removeAllRanges) sel.removeAllRanges();
  disarmBulkDelete();
  renderProduction();
  return true;
}

/* Every bulk action resolves keys to registry entries first and skips any
   that no longer resolve, so a stale key can never write to the wrong item. */
function selectedEntries(entries) {
  var byKey = {};
  (entries || productionEntries()).forEach(function (e) { byKey[e.key] = e; });
  return selectedKeys().map(function (k) { return byKey[k]; }).filter(Boolean);
}

export function bulkSetOwner(personId) {
  var items = selectedEntries();
  if (!items.length) return;
  var owner = personById(personId) ? personId : "";
  var n = 0;
  items.forEach(function (item) {
    var entry = trackedEntry(item);
    if (!entry || entry.owner === owner) return;
    entry.owner = owner;
    n++;
  });
  if (!n) { renderProduction(); return; }
  markDirty();
  renderProduction();
  queueAutoSave();
  var who = personById(personId);
  showToast(who ? ("Assigned " + n + " item" + (n === 1 ? "" : "s") + " to " + who.name)
                : ("Unassigned " + n + " item" + (n === 1 ? "" : "s")), "ok");
}

export function bulkSetStatus(statusId) {
  var items = selectedEntries();
  if (!items.length) return;
  var want = (tagStatus(statusId) || TAG_STATUSES[0]);
  var n = 0;
  items.forEach(function (item) {
    var entry = trackedEntry(item);
    if (!entry || entry.status === want.id) return;
    entry.status = want.id;
    n++;
  });
  if (!n) { renderProduction(); return; }
  markDirty();
  renderProduction();
  queueAutoSave();
  showToast("Marked " + n + " item" + (n === 1 ? "" : "s") + " " + want.label, "ok");
}

export function bulkAddPerson() {
  var input = document.getElementById("bulk-person-input");
  if (!input) return;
  var id = findOrAddPerson(input.value);
  S.tagAddingPersonFor = null;
  if (!id) { renderProduction(); return; }
  bulkSetOwner(id);
}

/* One Delete rather than the card's two-step Remove label / Delete from
   list, because in bulk the two-step is the wrong shape: a selection is
   usually a mix of live and orphaned items, and removing only the registry
   entry of a live one is a no-op — healTagRegistry() self-heals it
   straight back from the script. So this strips the labels too, and the
   armed button says how many of the script's labels are about to go. */
export function bulkDeleteSelected() {
  var items = selectedEntries();
  if (!items.length) return;
  var unlabelled = 0;
  breakUndoCoalescing();
  items.forEach(function (item) {
    if (!item.orphaned) unlabelled += removeTag(item.cat.id, item.name);
    deleteProductionTagEntry(item.cat.id, item.name);
  });
  var n = items.length;
  clearProductionSelection();
  markDirty();
  breakUndoCoalescing();
  render();
  queueAutoSave();
  showToast("Deleted " + n + " item" + (n === 1 ? "" : "s") +
    (unlabelled ? " and removed " + unlabelled + " label" + (unlabelled === 1 ? "" : "s") +
      " from the script" : ""), "ok");
}

function bulkCountsLabel(items) {
  var live = 0;
  items.forEach(function (i) { if (!i.orphaned) live += i.mentions.length; });
  return live;
}

/* The bar exists only while a selection does, and only in the two groupings
   that draw cards — Scene shows pills and Shoot shows the day's needs, and
   neither has anything to select. */
function renderBulkBar(entries) {
  var bar = document.getElementById("production-bulk");
  if (!bar) return;
  var items = selectedEntries(entries);
  var cardView = S.productionGroupBy === "cat" || S.productionGroupBy === "person";
  if (!items.length || !cardView || reviewMode()) { bar.hidden = true; bar.innerHTML = ""; return; }

  var n = items.length;
  var liveMentions = bulkCountsLabel(items);
  bar.hidden = false;
  /* the panels' language (#169): the selects as fields with their border
     and chevron at rest, the actions as outlined buttons. The count and
     the × get a line of their own, so the actions keep theirs at the
     panel's usual width, however long the crew's names are. */
  bar.innerHTML =
    '<div class="bulk-row bulk-head">' +
      '<span class="bulk-count"><span class="tag-figure">' + n + '</span> selected</span>' +
      '<button type="button" class="bulk-clear" data-action="bulk-clear" ' +
        'title="Clear the selection (Esc)" aria-label="Clear the selection">' + iconHtml("i-close") + '</button>' +
    '</div>' +
    '<div class="bulk-row">' +
      '<span class="ev-field">' +
        '<select class="bulk-select" id="bulk-owner" aria-label="Assign the selected items to">' +
          '<option value="__none__" selected>Assign to…</option>' +
          '<option value="">Unassigned</option>' +
          S.state.people.map(function (p) {
            return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>';
          }).join("") +
        '</select>' + iconHtml("i-chevron-down", "ev-chevron") +
      '</span>' +
      '<button type="button" class="bulk-btn btn-outline is-small" data-action="bulk-person-new" ' +
        'title="Add someone to the crew list and assign these to them">' + iconHtml("i-plus") + 'Person</button>' +
      '<span class="ev-field">' +
        '<select class="bulk-select" id="bulk-status" aria-label="Set the status of the selected items">' +
          '<option value="__none__" selected>Status…</option>' +
          TAG_STATUSES.map(function (s) {
            return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.label) + '</option>';
          }).join("") +
        '</select>' + iconHtml("i-chevron-down", "ev-chevron") +
      '</span>' +
      '<button type="button" class="bulk-btn btn-outline is-small danger' + (bulkDeleteArmed ? ' armed' : '') + '" ' +
        'data-action="bulk-delete">' + iconHtml("i-trash") +
        (bulkDeleteArmed
          ? 'Delete ' + n + (liveMentions ? ' + ' + liveMentions + ' label' +
              (liveMentions === 1 ? '' : 's') : '') + '?'
          : 'Delete') +
      '</button>' +
    '</div>' +
    (S.tagAddingPersonFor === "__bulk__"
      ? '<div class="bulk-row bulk-person-row">' +
          '<input type="text" class="ev-field" id="bulk-person-input" placeholder="Their name" maxlength="60" ' +
            'aria-label="The new person’s name">' +
          '<button type="button" class="bulk-btn btn-outline is-small" data-action="bulk-person-save">Add</button>' +
          '<button type="button" class="tag-quiet-btn" data-action="bulk-person-cancel">Cancel</button>' +
        '</div>'
      : '') +
    (bulkDeleteArmed
      ? '<div class="bulk-note">Removes ' + n + ' item' + (n === 1 ? '' : 's') +
          ' from the breakdown' +
          (liveMentions ? ', and their labels from the script — the words stay, the labels go' : '') +
          '. Click again to confirm.</div>'
      : '<div class="bulk-note">' + (IS_TOUCH
          ? 'Tap a card to add or drop it · long-press started this'
          : 'Ctrl+click a card to add or drop it · Shift+click for a run') + '</div>');
}

/* ---- assigning people and keeping notes ---- */

/* `statusId` null means "advance one step" — the pill in the card head —
   otherwise it is the exact state the segmented control asked for. Both go
   through here so there is one place that writes it. */
export function setTagStatus(key, statusId) {
  var item = findTagByKey(key);
  if (!item) return;
  var entry = trackedEntry(item);
  if (!entry) return;
  var want = statusId === null
    ? nextTagStatus(entry.status)
    : (tagStatus(statusId) || TAG_STATUSES[0]).id;
  if (entry.status === want) return;
  entry.status = want;
  markDirty();
  renderProduction();
  queueAutoSave();
}

export function setTagOwner(key, personId) {
  var item = findTagByKey(key);
  if (!item) return;
  var entry = trackedEntry(item);
  if (!entry) return;
  entry.owner = personById(personId) ? personId : "";
  markDirty();
  renderProduction();
  queueAutoSave();
}

/* Called on every keystroke in the notes box, so it deliberately does NOT
   re-render — that would blow the textarea away mid-sentence. The panel
   redraws on its own the next time something else changes it. */
export function setTagNotes(key, text) {
  var item = findTagByKey(key);
  if (!item) return;
  var entry = trackedEntry(item);
  if (!entry) return;
  var clean = plainText(text).slice(0, 2000);
  if (entry.notes === clean) return;
  entry.notes = clean;
  markDirty();
}

export function addPersonForTag(key) {
  var input = document.querySelector('.tag-person-input[data-key="' + cssAttr(key) + '"]');
  if (!input) return;
  var id = findOrAddPerson(input.value);
  S.tagAddingPersonFor = null;
  if (!id) { renderProduction(); return; }
  var item = findTagByKey(key);
  var entry = item && trackedEntry(item);
  if (entry) entry.owner = id;
  markDirty();
  renderProduction();
  queueAutoSave();
}

export function armPersonDelete(btn, personId) {
  if (S.tagDeleteArmId === "person:" + personId) {
    clearTimeout(S.tagDeleteArmTimer);
    S.tagDeleteArmId = null;
    var person = personById(personId);
    deletePerson(personId);
    markDirty();
    renderProduction();
    queueAutoSave();
    showToast("Removed " + (person ? person.name : "that person") +
      " — their items are now unassigned", "ok");
    return;
  }
  S.tagDeleteArmId = "person:" + personId;
  var disarm = armButton(btn);
  clearTimeout(S.tagDeleteArmTimer);
  S.tagDeleteArmTimer = setTimeout(function () {
    S.tagDeleteArmId = null;
    disarm();
  }, 2800);
}

export function saveTagRename(key) {
  var input = document.querySelector('.tag-rename-input[data-key="' + cssAttr(key) + '"]');
  var item = findTagByKey(key);
  if (!input || !item) { S.tagRenaming = null; renderProduction(); return; }
  breakUndoCoalescing();
  var changed = renameTag(item.cat.id, item.name, input.value);
  S.tagRenaming = null;
  if (changed) {
    markDirty();
    breakUndoCoalescing();
    render();
    queueAutoSave();
    showToast("Renamed to " + plainText(input.value).trim(), "ok");
  } else {
    renderProduction();
  }
}

/* ---- the breakdown, for exports ---- */

export function breakdownRows() {
  var out = [];
  /* the b-roll shots that need each prop (#149), tagged on their lines or
     added to them by hand */
  var shotsFor = brollShotsByProp();
  tagsByCategory().forEach(function (g) {
    g.items.forEach(function (item) {
      var scenes = [];
      var seen = {};
      item.mentions.forEach(function (m) {
        if (seen[m.rowIndex]) return;
        seen[m.rowIndex] = true;
        scenes.push(pad2(m.rowIndex + 1));
      });
      var owner = personById(item.owner);
      var st = tagStatus(item.status) || TAG_STATUSES[0];
      out.push({
        category: g.cat.plural,
        categoryLabel: g.cat.label,
        name: item.name,
        mentions: item.mentions.length,
        owner: owner ? owner.name : "",
        status: st.id,
        statusLabel: st.label,
        notes: item.notes || "",
        inScript: item.orphaned ? "no" : "yes",
        /* still worth exporting rather than silently dropping — a props
           master reading this later should see it was tracked, not just
           lose it — but flagged rather than left looking like a scene list */
        scenes: item.orphaned ? ["not in script"] : scenes,
        broll: shotsFor[item.key] || []
      });
    });
  });
  return out;
}

/* One flat sheet with a Category column rather than a file per list: it
   filters or pivots into a props list, a graphics list or one person's
   pull list in a couple of clicks, and stays a single thing to send. */
export function buildBreakdownCsv() {
  /* B-roll shots last, so a sheet built on the old columns' positions
     still lines up */
  var lines = [["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "In script", "Notes", "B-roll shots"].join(",")];
  breakdownRows().forEach(function (r) {
    lines.push([
      csvEscape(r.categoryLabel),
      csvEscape(r.name),
      csvEscape(r.statusLabel),
      csvEscape(r.owner),
      csvEscape(r.mentions),
      csvEscape(r.scenes.join(" ")),
      csvEscape(r.inScript),
      csvEscape(r.notes),
      csvEscape(r.broll.join("; "))
    ].join(","));
  });
  if (lines.length === 1) lines.push(csvEscape("(nothing labelled yet)"));
  return "﻿" + lines.join("\r\n");
}

/* ---- an open item's menus (#169) ----

   The "⋯" (Rename, Remove label / Delete from list) and Gear's Status are
   drawn with the item, closed, and opened and closed here, in the DOM:
   what is picked from one goes through the panel's own click delegation
   (onRootClick) like any other data-action, and a re-render closes it by
   drawing it closed again. So there is no state to keep in step — only
   which menu is open, to close it when a click lands anywhere else. Wired
   on the document in __init(), after the panel's own handlers have run. */
var openTagMenu = null;

function closeTagMenu(refocus) {
  var menu = openTagMenu;
  openTagMenu = null;
  if (!menu) return;
  menu.hidden = true;
  var btn = menu.parentNode && menu.parentNode.querySelector(".tag-menu-btn");
  if (!btn) return;
  btn.setAttribute("aria-expanded", "false");
  if (refocus && btn.isConnected) btn.focus();
}

function openTagMenuFor(btn, focusFirst) {
  var menu = btn.parentNode.querySelector(".tag-menu");
  if (!menu) return;
  closeTagMenu(false);
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  openTagMenu = menu;
  /* up rather than down when the list has no room under it — the last
     item on screen — the way the scene's own "⋯" does (06-rows.js) */
  menu.classList.remove("opens-up");
  var list = btn.closest(".comments-list");
  var box = list ? list.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  var r = menu.getBoundingClientRect();
  if (r.bottom > box.bottom - 8 && r.top - r.height - btn.offsetHeight > box.top + 8) menu.classList.add("opens-up");
  if (focusFirst) {
    var first = menu.querySelector(".tag-menu-item.is-active") || menu.querySelector(".tag-menu-item");
    if (first) first.focus();
  }
}

/* A click that re-rendered the panel (a status picked, Rename) leaves the
   focus on nothing; it goes back to the same control, drawn anew. */
function refocusIn(panel, key, selector) {
  var a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  if (!panel) return;
  var el = panel.querySelector('.tag-entity[data-key="' + cssAttr(key) + '"] ' + selector);
  if (el) el.focus();
}

function onTagMenuClick(e) {
  var t = e.target;
  if (!t || !t.closest) return;
  if (openTagMenu && !openTagMenu.isConnected) openTagMenu = null;
  var panel = document.querySelector("#production-panel:not([hidden]), #gear-panel:not([hidden])");

  /* Rename puts its box at the top of the open item; the caret goes there */
  var rename = t.closest('[data-action="tag-rename"]');
  if (rename) {
    var input = panel && panel.querySelector(".tag-rename-input");
    if (input) { input.focus(); input.select(); }
  }

  /* Opening or closing an item, or stepping its status on, redraws the
     list: the focus goes back to the same control, so a keyboard keeps its
     place and hears the new state. An item opened from a reviewer's status
     label (a span carrying tag-expand) lands on its head, the button. */
  var redrawn = t.closest(".tag-entity-head, .tag-status-pill");
  if (redrawn && !redrawn.isConnected) {
    refocusIn(panel, redrawn.getAttribute("data-key"),
      redrawn.getAttribute("data-action") === "tag-status-cycle" ? ".tag-status-pill" : ".tag-entity-head");
    return;
  }

  /* a modifier-click selects the item instead (invariant 12) */
  var btn = t.closest(".tag-menu-btn");
  if (btn && btn.closest(".tag-entity")) {
    if (e.defaultPrevented) return;
    var menu = btn.parentNode.querySelector(".tag-menu");
    if (menu && menu === openTagMenu) closeTagMenu(false);
    /* detail 0: a click the keyboard made, so the first item takes focus */
    else openTagMenuFor(btn, e.detail === 0);
    return;
  }
  if (!openTagMenu) {
    var picked = t.closest('.tag-status-seg [data-action="tag-status-set"]');
    /* Gear's menu is gone with the redraw, so its button; the
       breakdown's radiogroup keeps the state just picked */
    if (picked && !picked.isConnected) {
      refocusIn(panel, picked.getAttribute("data-key"), picked.classList.contains("tag-status-choice")
        ? '.tag-status-choice[data-status="' + cssAttr(picked.getAttribute("data-status")) + '"]'
        : ".tag-status-menu-btn");
    }
    return;
  }
  var item = t.closest(".tag-menu-item");
  if (item && openTagMenu.contains(item)) {
    /* armed, it waits for its second click with the menu still open */
    if (item.classList.contains("armed")) return;
    var key = item.getAttribute("data-key");
    var fromStatus = item.getAttribute("data-action") === "tag-status-set";
    closeTagMenu(item.isConnected);
    if (fromStatus) refocusIn(panel, key, ".tag-status-menu-btn");
    return;
  }
  if (openTagMenu.contains(t)) return;
  closeTagMenu(false);
}

/* The keyboard in an open menu, and ArrowDown on its button, as the
   scene's "⋯" has them (06-rows.js rowMenuKeydown). Capture phase, so an
   Escape that closes a menu does not also clear the selection or close
   the panel. */
function onTagMenuKeydown(e) {
  var t = e.target;
  if (!t || !t.closest) return;
  if (openTagMenu && !openTagMenu.isConnected) openTagMenu = null;
  var btn = t.closest(".tag-menu-btn");
  if (btn && btn.closest(".tag-entity") && !btn.disabled) {
    var own = btn.parentNode.querySelector(".tag-menu");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      openTagMenuFor(btn, true);
    } else if (e.key === "Escape" && own && own === openTagMenu) {
      e.preventDefault();
      e.stopPropagation();
      closeTagMenu(true);
    }
    return;
  }
  var menu = t.closest(".tag-menu");
  if (!menu || menu !== openTagMenu) return;
  var items = Array.prototype.slice.call(menu.querySelectorAll(".tag-menu-item:not(:disabled)"));
  var i = items.indexOf(t);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) items[e.key === "Home" ? 0 : items.length - 1].focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeTagMenu(true);
  } else if (e.key === "Tab") {
    closeTagMenu(false);
  }
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* the item menus above: on the document, so they need nothing from the
     modules that wire the panels (21-events.js, 20-teleprompter.js) */
  document.addEventListener("click", onTagMenuClick);
  document.addEventListener("keydown", onTagMenuKeydown, true);

  /* ---- the multi-select gesture and what it can do ---- */

  /* True on phones and tablets — a device with no hover has no modifier
     keys either, so the whole Ctrl/Shift+click scheme needs a touch
     translation: long-press a card to start selecting, then taps on card
     heads toggle until the selection is cleared. matchMedia rather than a
     user-agent sniff: it is the actual capability that matters. */
  IS_TOUCH = window.matchMedia && window.matchMedia("(hover: none)").matches;
}
