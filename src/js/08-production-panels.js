import { S } from "./_state.js";
import { ROW_STATUSES, formatDuration, rowSeconds, rowStatus } from "./01-scene-status.js";
import { revealRow } from "./01b-hide-shot.js";
import { openSidePanel, syncPanelClass } from "./03-sync.js";
import { cssAttr, plainText, safeId } from "./04-richtext.js";
import { pad2, render } from "./05-render.js";
import {
  TAG_CATEGORIES,
  TAG_STATUSES,
  addRegistryTags,
  bulkDeleteArmed,
  bulkTagRows,
  clearProductionSelection,
  currentProductionIndex,
  deletePerson,
  deleteProductionTagEntry,
  disarmBulkDelete,
  findOrAddPerson,
  healTagRegistry,
  nextTagStatus,
  normalizeTagName,
  personById,
  productionEntries,
  productionReaders,
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
import { sceneFacts } from "./14b-export-kit.js";
import { csvEscape } from "./16-csv.js";
import { idMap } from "../core/document/id-map.ts";
import { cappedLongText, escapeHtml } from "../core/document/text-policy.ts";
import { planQuickAdd } from "../core/production/tags.ts";

export var IS_TOUCH;

export function openProductionPanel() {
  if (!S.state) return;
  openSidePanel("production-panel");
  renderProduction();
}

export function closeProductionPanel() {
  document.getElementById("production-panel").hidden = true;
  syncPanelClass();
}

S.gearGroupBy = "flat";

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

function fillGearQuickAdd() {
  var box = document.getElementById("gear-quickadd-input");
  if (!box || document.activeElement === box) return;
  var names = gearEntries().map(function (e) { return e.name; })
    .sort(function (a, b) { return a.localeCompare(b); });
  box.value = names.join("\n");
}

export function applyGearQuickAdd() {
  if (reviewBlocked()) return;
  var raw = document.getElementById("gear-quickadd-input").value || "";
  var plan = planQuickAdd(S.state, productionReaders, raw, currentProductionIndex());
  plan.remove.forEach(function (name) { deleteProductionTagEntry("gear", name); });
  addRegistryTags(plan.register);
  var added = plan.added, removed = plan.removed;

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

function joinSceneLinks(links) {
  return links.map(function (html, i) {
    return i < links.length - 1
      ? '<span class="tag-scene-unit">' + html + '<span class="tag-scene-sep">,</span></span>'
      : html;
  }).join('<span class="tag-scene-sep"> </span>');
}

function sceneLinksHtml(item) {
  var byRow = idMap(), order = [];
  item.mentions.forEach(function (m) {
    var s = byRow[m.rowId];
    if (!s) { s = byRow[m.rowId] = { m: m, n: 0, visual: false, audio: false }; order.push(s); }
    s.n++;
    if (m.field === "visualText") s.visual = true; else s.audio = true;
  });
  order.sort(function (a, b) { return a.m.rowIndex - b.m.rowIndex; });
  return joinSceneLinks(order.map(function (s) {
    var num = pad2(s.m.rowIndex + 1);
    var label = "Scene " + num + " · " +
      (s.visual && s.audio ? "Visual and Audio" : s.visual ? "Visual" : "Audio") +
      (s.n > 1 ? " · " + s.n + " mentions" : "") + " — go to it";
    return '<button type="button" class="tag-scene jump-link" data-action="jump-tag" data-row="' +
      escapeHtml(s.m.rowId) + '" data-key="' + escapeHtml(item.key) + '" title="' +
      escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' + num + '</button>';
  }));
}

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

function personAvatarHtml(name) {
  var initial = Array.from(String(name || "").trim())[0] || "?";
  return '<span class="person-avatar" style="--presence:' + personColor(name) + '" aria-hidden="true">' +
    escapeHtml(initial.toUpperCase()) + '</span>';
}

function ownerCellHtml(owner) {
  if (!owner) {
    return '<span class="tag-owner is-none"><span aria-hidden="true">—</span>' +
      '<span class="tag-sr">Unassigned</span></span>';
  }
  var first = String(owner.name).trim().split(/\s+/)[0] || owner.name;
  return '<span class="tag-owner" title="' + escapeHtml(owner.name) + '">' + personAvatarHtml(owner.name) +
    '<span class="tag-owner-name">' + escapeHtml(first) + '</span></span>';
}

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

function tagFieldId(what, gear, key) {
  return "tag-" + what + "-" + (gear ? "g-" : "p-") +
    String(key).replace(/[^A-Za-z0-9]/g, function (c) { return "_" + c.charCodeAt(0).toString(16); });
}

function iconHtml(id, cls) {
  return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true" focusable="false"><use href="#' + id + '"/></svg>';
}

function dropEditingForReview() {
  if (!reviewMode()) return;
  S.tagRenaming = null;
  S.tagAddingPersonFor = null;
  if (selectedKeys().length) clearProductionSelection();
  if (bulkDeleteArmed) disarmBulkDelete();
}

function untaggedMentionCount(item) {
  if (!S.state || !item.name) return 0;
  return bulkTagRows(S.state.rows, item.name, item.cat.id, item.name, false, true).hits;
}

function untaggedMentionsHtml(item, ro) {
  if (ro) return "";
  var n = untaggedMentionCount(item);
  if (!n) return "";
  return '<dt>Untagged</dt><dd class="tag-untagged-dd">' +
    '<button type="button" class="btn-outline is-small" data-action="tag-all-mentions" data-key="' +
      escapeHtml(item.key) + '" title="Tag every plain-text mention of ' + escapeHtml(item.name) +
      ' in the Visual column">Tag all ' + n + ' mention' + (n === 1 ? '' : 's') + '</button></dd>';
}

export function tagAllMentions(key) {
  if (reviewBlocked()) return;
  var item = findTagByKey(key);
  if (!item) return;
  breakUndoCoalescing();
  var done = bulkTagRows(S.state.rows, item.name, item.cat.id, item.name, false, false);
  if (!done.hits) { showToast("No untagged mentions of " + item.name + " left.", "warn"); return; }
  registerProductionTag(item.cat.id, item.name);
  markDirty();
  breakUndoCoalescing();
  render();
  queueAutoSave();
  showToast("Tagged " + done.hits + " mention" + (done.hits === 1 ? "" : "s") + " of " + item.name, "ok");
}

function tagEntityDetailHtml(item, renaming, gear, detailId) {
  var k = escapeHtml(item.key);
  var name = escapeHtml(item.name);
  var st = tagStatus(item.status) || TAG_STATUSES[0];
  var ro = reviewMode();
  var off = ro ? ' disabled' : '';
  var ownerId = tagFieldId("owner", gear, item.key);
  var notesId = tagFieldId("notes", gear, item.key);
  var renameId = tagFieldId("rename", gear, item.key);

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
      untaggedMentionsHtml(item, ro) +
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

function tagEntityHtml(item, opts) {
  opts = opts || {};
  var gear = !!opts.gear;
  var renaming = S.tagRenaming === item.key;
  var expanded = S.tagExpanded === item.key || renaming;
  var k = escapeHtml(item.key);
  var selected = opts.selection && !reviewMode() && productionSelection[item.key];
  var detailId = tagFieldId("detail", gear, item.key);
  var dot = '<span class="tag-row-dot" data-tag-cat="' + item.cat.id + '" aria-hidden="true"></span>';
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
  return indexes.map(function (idx) {
    var items = Object.keys(byRow[idx]).map(function (k) { return byRow[idx][k]; });
    return '<section class="tag-scene-group">' +
      '<h3 class="tag-scene-group-head">Scene <span class="tag-figure">' + pad2(idx + 1) + '</span></h3>' +
      '<ul class="tag-pills">' +
        items.map(function (item) {
          return '<li class="tag-pill" style="--dot:' + item.cat.color + '">' +
            '<span class="tag-cat-dot" data-tag-cat="' + item.cat.id + '" aria-hidden="true"></span>' +
            escapeHtml(item.name) + '</li>';
        }).join("") +
      '</ul>' +
    '</section>';
  }).join("");
}

function renderProductionByPerson(all) {
  var buckets = idMap(), order = [];
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

function renderProductionByShoot(entries) {
  var live = entries || productionEntries();
  var byRow = {};
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
  order.sort(function (a, b) { return (a === "" ? 1 : 0) - (b === "" ? 1 : 0); });

  return order.map(function (key) {
    var g = groups[key];
    var shot = g.rows.filter(function (i) { return S.state.rows[i].status === "shot"; }).length;
    var secs = g.rows.reduce(function (n, i) { return n + rowSeconds(S.state.rows[i]); }, 0);
    var done = shot === g.rows.length;
    return '<section class="shoot-group" style="--dot:' + (key ? TAG_CATEGORIES[1].color : "var(--border-strong)") + '">' +
      '<h3 class="shoot-head">' +
        '<span class="tag-cat-dot"' + (key ? ' data-tag-cat="' + TAG_CATEGORIES[1].id + '"' : '') + ' aria-hidden="true"></span>' +
        '<span class="shoot-name">' + escapeHtml(g.name) + '</span>' +
        '<span class="shoot-progress' + (done ? ' is-done' : '') + '">' +
          '<span class="tag-figure">' + shot + '/' + g.rows.length + '</span> shot · ' +
          '<span class="tag-figure">' + formatDuration(secs) + '</span></span>' +
      '</h3>' +
      '<dl class="shoot-detail">' +
        '<dt>Scenes</dt>' +
        '<dd class="tag-scenes">' +
          joinSceneLinks(g.rows.map(function (i) {
            var row = S.state.rows[i];
            var st = rowStatus(row.status) || ROW_STATUSES[0];
            var label = "Scene " + pad2(i + 1) + " · " + st.label + " — go to it";
            return '<button type="button" class="tag-scene jump-link' + (row.status === "shot" ? ' is-shot' : '') +
              '" data-action="jump-row" data-row="' + escapeHtml(row.id) + '" title="' + escapeHtml(label) +
              '" aria-label="' + escapeHtml(label) + '">' + pad2(i + 1) +
              (row.status === "shot" ? iconHtml("i-check", "tag-scene-tick") : '') + '</button>';
          })) +
        '</dd>' +
        (g.needOrder.length
          ? '<dt>Needs on the day</dt>' +
            '<dd><ul class="shoot-needs">' +
              g.needOrder.map(function (k) {
                var item = g.needs[k];
                var owner = personById(item.owner);
                var nst = tagStatus(item.status) || TAG_STATUSES[0];
                return '<li class="shoot-need" style="--dot:' + item.cat.color + '">' +
                  '<span class="tag-cat-dot" data-tag-cat="' + item.cat.id + '" aria-hidden="true"></span>' +
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

export function renderProduction() {
  renderProductionPanel();
  renderGearList();
}

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
  var cols = document.getElementById("production-cols");
  if (cols) {
    cols.hidden = !groups.length ||
      (S.productionGroupBy !== "cat" && S.productionGroupBy !== "person");
  }

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

  listEl.innerHTML = groups.map(function (g) {
    return '<section class="tag-group">' +
      '<h3 class="tag-group-head" style="--dot:' + g.cat.color + '">' +
        '<span class="tag-cat-dot" data-tag-cat="' + g.cat.id + '" aria-hidden="true"></span>' +
        '<span class="tag-group-label">' + escapeHtml(g.cat.plural) + '</span>' +
        '<span class="tag-group-count">' + g.items.length + '</span>' +
      '</h3>' +
      '<ul class="tag-list">' +
        g.items.map(function (e) { return tagEntityHtml(e, { selection: true }); }).join("") +
      '</ul>' +
    '</section>';
  }).join("");
}

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
    if (el.getAttribute("data-tag-cat") !== item.cat.id) return;
    if (normalizeTagName(el.getAttribute("data-tag-name")) !== normalizeTagName(item.name)) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  });
  if (item.cat.id !== "sound") return;
  Array.prototype.forEach.call(row.querySelectorAll(".audio-cue"), function (el) {
    var name = (el.textContent || "").replace(/\u200B/g, "").replace(/^\s*(sfx|music)\s*:/i, "");
    if (normalizeTagName(name) !== normalizeTagName(item.name)) return;
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

var touchPress = { timer: null, key: null, fired: false, x: 0, y: 0 };

function cancelTouchPress() {
  if (touchPress.timer) { clearTimeout(touchPress.timer); touchPress.timer = null; }
}

export function wireTouchSelection() {
  var list = document.getElementById("production-list");
  if (!list) return;

  list.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" || reviewMode()) return;
    var card = e.target.closest(".tag-entity");
    if (!card) return;
    if (e.target.closest(".tag-entity-detail, .tag-rename-input")) return;
    touchPress.key = card.getAttribute("data-key");
    touchPress.fired = false;
    touchPress.x = e.clientX; touchPress.y = e.clientY;
    cancelTouchPress();
    touchPress.timer = setTimeout(function () {
      touchPress.timer = null;
      touchPress.fired = true;
      toggleCardSelection(touchPress.key);
      if (navigator.vibrate) navigator.vibrate(10);
    }, 450);
  });

  list.addEventListener("pointermove", function (e) {
    if (!touchPress.timer) return;
    if (Math.abs(e.clientX - touchPress.x) > 10 || Math.abs(e.clientY - touchPress.y) > 10) cancelTouchPress();
  });
  list.addEventListener("pointerup", cancelTouchPress);
  list.addEventListener("pointercancel", cancelTouchPress);

  list.addEventListener("click", function (e) {
    if (touchPress.fired) {
      touchPress.fired = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  list.addEventListener("contextmenu", function (e) {
    if (IS_TOUCH && e.target.closest(".tag-entity")) e.preventDefault();
  });
}

export function handleSelectionClick(e, card) {
  if (reviewMode()) return false;
  var key = card.getAttribute("data-key");
  if (!key) return false;
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

  var sel = window.getSelection();
  if (sel && sel.removeAllRanges) sel.removeAllRanges();
  disarmBulkDelete();
  renderProduction();
  return true;
}

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

function renderBulkBar(entries) {
  var bar = document.getElementById("production-bulk");
  if (!bar) return;
  var items = selectedEntries(entries);
  var cardView = S.productionGroupBy === "cat" || S.productionGroupBy === "person";
  if (!items.length || !cardView || reviewMode()) { bar.hidden = true; bar.innerHTML = ""; return; }

  var n = items.length;
  var liveMentions = bulkCountsLabel(items);
  bar.hidden = false;
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

export function setTagNotes(key, text) {
  var item = findTagByKey(key);
  if (!item) return;
  var entry = trackedEntry(item);
  if (!entry) return;
  var clean = cappedLongText(plainText(text), 2000);
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

export function breakdownRows() {
  var out = [];
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
        catId: g.cat.id,
        category: g.cat.plural,
        categoryLabel: g.cat.label,
        name: item.name,
        mentions: item.mentions.length,
        owner: owner ? owner.name : "",
        status: st.id,
        statusLabel: st.label,
        notes: item.notes || "",
        inScript: item.orphaned ? "no" : "yes",
        scenes: item.orphaned ? ["not in script"] : scenes,
        broll: shotsFor[item.key] || []
      });
    });
  });
  return out;
}

export function breakdownTable() {
  var starts = sceneFacts().map(function (f) { return f.start; });
  var out = {
    head: ["Category", "Item", "Status", "Assigned to", "Mentions", "Scenes", "In script", "Notes", "B-roll shots",
           "First scene at", "Group"],
    rows: []
  };
  breakdownRows().forEach(function (r) {
    var first = r.inScript === "no" ? "" : (starts[Number(r.scenes[0]) - 1] || "");
    out.rows.push({ catId: r.catId, status: r.status, cells: [
      r.categoryLabel,
      r.name,
      r.statusLabel,
      r.owner,
      r.mentions,
      r.scenes.join(" "),
      r.inScript,
      r.notes,
      r.broll.join("; "),
      first,
      r.category
    ] });
  });
  return out;
}

export function buildBreakdownCsv() {
  var t = breakdownTable();
  var lines = [t.head.join(",")];
  t.rows.forEach(function (r) { lines.push(r.cells.map(csvEscape).join(",")); });
  if (lines.length === 1) lines.push(csvEscape("(nothing labelled yet)"));
  return "﻿" + lines.join("\r\n");
}

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

  var rename = t.closest('[data-action="tag-rename"]');
  if (rename) {
    var input = panel && panel.querySelector(".tag-rename-input");
    if (input) { input.focus(); input.select(); }
  }

  var redrawn = t.closest(".tag-entity-head, .tag-status-pill");
  if (redrawn && !redrawn.isConnected) {
    refocusIn(panel, redrawn.getAttribute("data-key"),
      redrawn.getAttribute("data-action") === "tag-status-cycle" ? ".tag-status-pill" : ".tag-entity-head");
    return;
  }

  var btn = t.closest(".tag-menu-btn");
  if (btn && btn.closest(".tag-entity")) {
    if (e.defaultPrevented) return;
    var menu = btn.parentNode.querySelector(".tag-menu");
    if (menu && menu === openTagMenu) closeTagMenu(false);
    else openTagMenuFor(btn, e.detail === 0);
    return;
  }
  if (!openTagMenu) {
    var picked = t.closest('.tag-status-seg [data-action="tag-status-set"]');
    if (picked && !picked.isConnected) {
      refocusIn(panel, picked.getAttribute("data-key"), picked.classList.contains("tag-status-choice")
        ? '.tag-status-choice[data-status="' + cssAttr(picked.getAttribute("data-status")) + '"]'
        : ".tag-status-menu-btn");
    }
    return;
  }
  var item = t.closest(".tag-menu-item");
  if (item && openTagMenu.contains(item)) {
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

export function __init() {
  document.addEventListener("click", onTagMenuClick);
  document.addEventListener("keydown", onTagMenuKeydown, true);

  IS_TOUCH = window.matchMedia && window.matchMedia("(hover: none)").matches;
}
