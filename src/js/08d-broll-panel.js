import { S } from "./_state.js";
import { formatTimecode, rowSeconds } from "./01-scene-status.js";
import { revealRow } from "./01b-hide-shot.js";
import { escapeHtml } from "./02-state.js";
import { openSidePanel, syncPanelClass } from "./03-sync.js";
import { closeAllSidePanels } from "./03b-side-panels.js";
import { cssAttr, plainText } from "./04-richtext.js";
import { pad2, render } from "./05-render.js";
import { focusRowField } from "./06-rows.js";
import {
  findOrAddPerson,
  normalizeTagName,
  personById,
  productionEntries,
  scheduleProductionRefresh,
  tagCategory,
  tagStatus
} from "./07-production-tags.js";
import {
  BROLL_NAME_MAX,
  BROLL_TEXT_MAX,
  addBrollProp,
  brollEntries,
  brollRecord,
  brollSortedForList,
  deleteBrollRecord,
  newBrollRecord,
  removeBrollProp,
  renameBrollInScript,
  updateBrollBadge
} from "./08c-broll.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { breakUndoCoalescing } from "./12a-undo.js";
import { reviewBlocked, reviewMode } from "./13-hosted.js";
import { personColor } from "./13a-presence.js";
import { queueAutoSave } from "./14-export.js";
import { csvEscape } from "./16-csv.js";
import { exportAs } from "./18-local-files.js";

/* ================= the b-roll panel (#148) =================

   The list itself — reading the markers, the records, anchoring, the
   props a shot needs — is 08c-broll.js. This is how it is shown and
   edited: the side panel, and the full-page shot list (#150, below).

   One line per shot, because the question the panel is opened to answer
   is "what is still to shoot", and a card per shot answered it three at a
   time. The line is a checkbox (Shot / To shoot in one click), the name —
   in full, however long (#169: nothing ends in "…") — and beside it where,
   who and what it needs; everything else waits behind a click on the line.
   The head says how far the whole list has got ("1 of 3 shot" and a small
   bar), and text tabs under it cut the list down to what is left. The
   look is B-BrollCalm, the calmer of the two boards (#169).

   Nothing here keeps a copy of the document: every edit lands on the
   record (brollRecord) and ends in markDirty(), so undo (12a-undo.js)
   records it the way it records any edit — and a change to many shots at
   once is one markDirty(), so one Ctrl+Z. */

/* ---- how the list is looked at: per device, never the document's ----

   Which filter is on and how the list is grouped are the reader's, not
   the script's — the same shape as the comments panel's sort — so they
   live in localStorage and never touch state: switching them must not
   mark the document dirty or land on the undo stack. */
var VIEW_KEY = "splitpage-broll-view";

var FILTERS = [
  { id: "all",     label: "All" },
  { id: "unshot",  label: "To shoot" },
  { id: "flagged", label: "Flagged" },
  { id: "shot",    label: "Shot" }
];

/* The ids brollGroupBy always had: "flat" is the list with no groups.
   `button` is what the quiet menu button in the tab bar says (#169). */
var GROUPS = [
  { id: "scene",    label: "Scene",    button: "By scene" },
  { id: "location", label: "Location", button: "By location" },
  { id: "flat",     label: "None",     button: "Not grouped" }
];

var view = { filter: "all", group: "scene" };

function oneOf(list, id, fallback) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return id;
  return fallback;
}

function loadView() {
  try {
    var saved = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    if (saved && typeof saved === "object") {
      view.filter = oneOf(FILTERS, saved.filter, view.filter);
      view.group = oneOf(GROUPS, saved.group, view.group);
      loadPageView(saved);
    }
  } catch (e) { /* unreadable or blocked storage: the defaults */ }
}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(Object.assign({}, view, pageViewToSave())));
  } catch (e) { /* storage refused: it still works, it just forgets */ }
}

function setFilter(id) {
  view.filter = oneOf(FILTERS, id, "all");
  saveView();
  renderBrollViews();
}

function matchesFilter(e, filter) {
  if (filter === "unshot") return e.status !== "shot";
  if (filter === "shot") return e.status === "shot";
  if (filter === "flagged") return e.reshoot;
  return true;
}

function filterCounts(entries) {
  var n = { all: entries.length, unshot: 0, shot: 0, flagged: 0 };
  entries.forEach(function (e) {
    if (e.status === "shot") n.shot++; else n.unshot++;
    if (e.reshoot) n.flagged++;
  });
  return n;
}

/* ---- the panel's own state, none of it the document's ---- */

var openId = null;          /* the shot whose detail is showing */
var renamingId = null;
var addingPersonFor = null;
var editingLocFor = null;   /* the location picker, open as a text box */
var editingRefFor = null;   /* "Cuts against", open for editing */
var menuFor = null;         /* the ⋯ menu at the foot of an open shot */
var groupMenuOpen = false;
var selection = Object.create(null);
var selectionAnchor = null;
var bulkInput = null;       /* "person" | "location": the bar's one text box */

/* ---- a review session (#30): the list to read, not to change ----

   A reviewer (13-hosted.js reviewMode) can open a shot, filter, group, go
   to its scene and take the CSV or the printed list away, and nothing
   else: the server keeps none of a reviewer's edits to the list, so an
   edit made here would look as if it had worked and then be lost. The
   controls that change a shot are not drawn, or drawn disabled where the
   value is what a reader wants (the tick, the assignee, the note), and
   the handlers below refuse them anyway, as the script's click guard does
   (21-events.js REVIEW_SAFE_ACTIONS). An allow-list for the same reason
   as that one: an action added to the panel or the page has to be
   thought about here before a reviewer can reach it. */
var BROLL_REVIEW_SAFE_ACTIONS = {
  "broll-expand": 1, "broll-jump": 1, "broll-filter": 1, "broll-group-menu": 1, "broll-group": 1,
  "broll-bulk-clear": 1, "broll-open-page": 1, "broll-page-close": 1, "broll-page-jump": 1,
  "broll-page-csv": 1, "broll-page-print": 1
};

/* Whatever was half open when the role arrived — a rename, a location
   box, a menu, a selection and its bar — goes, rather than being drawn
   for somebody who cannot finish it. */
function dropEditingForReview() {
  if (!reviewMode()) return;
  renamingId = null; addingPersonFor = null; editingLocFor = null; editingRefFor = null;
  menuFor = null;
  clearSelection();
}

/* ---- small pieces of markup ---- */

/* Inline stroke icons, never emoji or a font's glyphs: they take the text
   colour they sit in, so a state colour and dark mode come for free. */
var ICONS = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/>',
  go: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H6M11 6l-6 6 6 6"/>',
  pencil: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  unlink: '<path d="M9 17H7a5 5 0 0 1-2.5-9.3M15 7h2a5 5 0 0 1 2.5 9.3M3 3l18 18"/>',
  orphan: '<path d="M4 5h16M4 12h9M4 19h6"/><path d="M16 15l5 5M21 15l-5 5"/>',
  box: '<path d="M4 7.5l8-4 8 4v9l-8 4-8-4z"/><path d="M4 7.5l8 4 8-4M12 11.5v9"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M7 14h10v7H7z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'
};

export function brollIcon(name, size, cls) {
  var px = size || 16;
  return '<svg class="broll-ico' + (cls ? " " + cls : "") + '" width="' + px + '" height="' + px +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || "") + '</svg>';
}

/* An icon from the page's sprite (page.html, #169): the panel draws B's
   1.75-stroke set wherever the sprite has the icon, and keeps brollIcon
   above for the few it doesn't (a note, a pencil, a loose line). Sized
   and stroked by .broll-si in app.css. */
function icon(name, cls) {
  return '<svg class="broll-si' + (cls ? " " + cls : "") + '" aria-hidden="true" focusable="false"><use href="#i-' +
    name + '"/></svg>';
}

/* A category's colour, from TAG_CATEGORIES like every breakdown card's, so
   a palette change lands here with no second copy of the hex. */
function catColor(id) {
  var cat = tagCategory(id);
  return cat ? cat.color : "var(--text-dim)";
}

function initials(name) {
  var words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  var first = Array.from(words[0])[0] || "";
  var last = words.length > 1 ? (Array.from(words[words.length - 1])[0] || "") : "";
  return (first + last).toUpperCase();
}

/* A person in their own colour, the same everywhere they appear (#169:
   personColor, 13a-presence.js — the header's avatars, comments, the
   breakdown's owners); .person-avatar is the shared circle. */
function avatarHtml(person) {
  return '<span class="person-avatar broll-avatar" aria-hidden="true" style="--presence:' +
    escapeHtml(personColor(person.name)) + '">' + escapeHtml(initials(person.name)) + '</span>';
}

function sceneLabel(e) {
  return e.rowIndex === -1 ? "" : pad2(e.rowIndex + 1);
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many);
}

/* Where each scene starts in the programme, by row id: the same running
   sum paintRowTimes() (05-render.js) writes into each scene's gutter, so
   "Scene 03 · 00:31" here reads what the script beside it says. */
function sceneStarts() {
  var t = 0, out = Object.create(null);
  S.state.rows.forEach(function (row) { out[row.id] = t; t += rowSeconds(row); });
  return out;
}

function startOf(e, starts) {
  return e.rowId && starts[e.rowId] !== undefined ? formatTimecode(starts[e.rowId]) : "";
}

/* ---- props, as a shot shows them (#149) ----

   A chip per prop: its name, and how far along the breakdown has it
   (Needed / Sourcing / Have it / Returned) — the question a shooter asks
   of a prop is "is it here yet". A hand-added one can be taken off here;
   one the script names is taken off by editing the script, so it has no
   ×. Since #169 the status is the breakdown's own lamp (Adam: the same
   12×6 lamp wherever an item's status shows), with its word beside it. */
function propChipHtml(e, p, removable) {
  var st = tagStatus(p.status);
  return '<span class="broll-prop-chip' + (p.tracked ? '' : ' is-untracked') + '" title="' +
      escapeHtml(p.auto
        ? p.name + " — tagged on this shot's lines in the script"
        : p.tracked ? p.name + " — added to this shot" : p.name + " — no longer in the breakdown") + '">' +
      (st ? itemLampHtml(st, "", true) : '') +
      '<span class="broll-prop-name">' + escapeHtml(p.name) + '</span>' +
      (st ? '<span class="broll-prop-st">' + escapeHtml(st.label) + '</span>' : '') +
      (removable && p.ref
        ? '<button type="button" class="broll-prop-remove" data-action="broll-prop-remove" data-id="' +
            escapeHtml(e.id) + '" data-ref="' + escapeHtml(p.ref) + '" aria-label="' +
            escapeHtml("Take " + p.name + " off this shot") + '">' + icon("close") + '</button>'
        : '') +
    '</span>';
}

/* An item's status as the shared lamp (app.css .item-lamp): a 12×6 bar,
   or the return arrow for Returned. The word is its title and its name
   for a screen reader; the wrapper carries both, since an <svg> shows no
   title attribute. Beside its own word (a chip) it is only a picture. */
function itemLampHtml(st, cls, besideWord) {
  var named = ' title="' + escapeHtml(st.label) + '"' +
    (besideWord ? ' aria-hidden="true"' : ' role="img" aria-label="' + escapeHtml(st.label) + '"');
  var extra = cls ? " " + cls : "";
  if (st.id === "returned") {
    return '<span class="broll-lamp-returned' + extra + '"' + named + '>' +
      '<svg class="item-lamp is-returned" aria-hidden="true" focusable="false"><use href="#i-return"/></svg></span>';
  }
  return '<span class="item-lamp is-' + escapeHtml(st.id) + extra + '"' + named + '></span>';
}

/* The props the document already tracks, for Add prop to offer. */
function propOptionsHtml() {
  var seen = Object.create(null);
  return productionEntries().filter(function (t) { return t.cat.id === "prop"; })
    .map(function (t) { return t.name; })
    .sort(function (a, b) { return a.localeCompare(b); })
    .filter(function (n) { var k = normalizeTagName(n); if (seen[k]) return false; seen[k] = true; return true; })
    .map(function (n) { return '<option value="' + escapeHtml(n) + '"></option>'; }).join("");
}

/* The props as a line of text with a status dot before each name (#149):
   "is it here yet" readable at a glance, on the compact line and in the
   sheet, without opening anything. The dot's colour is its status class's
   (app.css, from the tokens, so dark mode follows); its title is the word.
   A prop the breakdown no longer has has no status, so no dot. The names
   stay the element's only text, separated by ", ". */
function propStatusDot(p) {
  var st = tagStatus(p.status);
  if (!st) return "";
  return '<span class="broll-st-dot is-' + escapeHtml(st.id) + '" title="' + escapeHtml(st.label) +
    '" role="img" aria-label="' + escapeHtml(st.label) + '"></span>';
}

function propListHtml(e) {
  return e.props.map(function (p) {
    return '<span class="broll-prop-item">' + propStatusDot(p) + escapeHtml(p.name) + '</span>';
  }).join(", ");
}

/* The panel's line says the same with the breakdown's lamp before each
   name instead of the dot (#169, as the chips do); the full page keeps
   the dot above in its table. */
function propLampListHtml(e) {
  return e.props.map(function (p) {
    var st = tagStatus(p.status);
    return '<span class="broll-prop-item">' + (st ? itemLampHtml(st, "broll-prop-lamp") : '') + escapeHtml(p.name) + '</span>';
  }).join(", ");
}

/* "Kettle (Sourcing), Drone (Needed)": the same, for a title attribute. */
function propListTitle(e) {
  return e.props.map(function (p) {
    var st = tagStatus(p.status);
    return p.name + (st ? " (" + st.label + ")" : "");
  }).join(", ");
}

/* The chips, then the Add box as a field with its border at rest (#169:
   "fields must be easy to find") — typing a name, or picking one the
   breakdown already tracks from its list, adds it. */
function propsEditHtml(e, readOnly) {
  var id = escapeHtml(e.id);
  if (readOnly && !e.props.length) return '<span class="broll-muted">None</span>';
  return '<div class="broll-props">' +
      e.props.map(function (p) { return propChipHtml(e, p, !readOnly); }).join("") +
      (readOnly ? '' :
        '<input type="text" class="broll-prop-input ev-field" data-id="' + id + '" list="broll-prop-options" ' +
          'maxlength="80" placeholder="Add prop" aria-label="Add a prop this shot needs">') +
    '</div>';
}

/* Every location anybody has named: the Location tags, and what shots
   already say. */
function knownLocations() {
  var seen = Object.create(null), out = [];
  function add(name) {
    var clean = String(name || "").trim();
    var k = normalizeTagName(clean);
    if (!clean || seen[k]) return;
    seen[k] = true;
    out.push(clean);
  }
  productionEntries().forEach(function (t) { if (t.cat.id === "location") add(t.name); });
  (S.state.brollShots || []).forEach(function (r) { add(r.location); });
  return out.sort(function (a, b) { return a.localeCompare(b); });
}

function datalistsHtml() {
  return '<datalist id="broll-prop-options">' + propOptionsHtml() + '</datalist>' +
    '<datalist id="broll-loc-options">' + knownLocations().map(function (n) {
      return '<option value="' + escapeHtml(n) + '"></option>';
    }).join("") + '</datalist>';
}

/* ---- the summary, the filters, the grouping ---- */

/* One segment per shot, in list order: how far along the whole list is,
   readable at a glance and before reading a single line. B draws it 56px
   wide in the head (#169), so the gaps between segments close up as the
   list grows rather than pushing it wider. */
function progressBarHtml(entries) {
  var n = filterCounts(entries);
  var gap = n.all <= 12 ? 2 : n.all <= 24 ? 1 : 0;
  return '<div class="broll-bar" role="progressbar" aria-label="Shots done" aria-valuemin="0" aria-valuemax="' + n.all +
      '" aria-valuenow="' + n.shot + '" aria-valuetext="' +
      escapeHtml(n.shot + " of " + n.all + " shot" + (n.flagged ? ", " + n.flagged + " flagged" : "")) +
      '" style="--seg-gap:' + gap + 'px">' +
      brollSortedForList(entries).map(function (e) {
        var cls = e.reshoot ? "is-flagged" : e.status === "shot" ? "is-shot" : "is-todo";
        return '<span class="broll-bar-seg ' + cls + '"></span>';
      }).join("") +
    '</div>';
}

/* The head's "1 of 3 shot" (B-BrollCalm): the figures in the mono. */
function summaryHtml(entries) {
  var n = filterCounts(entries);
  return '<span class="broll-summary-line"><span class="broll-summary-n">' + n.shot + '</span> of ' +
      '<span class="broll-summary-n">' + n.all + '</span> shot</span>' +
    progressBarHtml(entries);
}

/* The panel's filters (#169): the shared text tabs, each with its count.
   They keep .broll-chip and the data-filter the suites and focusKey know
   them by. */
function filterTabsHtml(entries) {
  var n = filterCounts(entries);
  return '<div class="panel-tabs broll-tabs" role="radiogroup" aria-label="Show shots">' +
    FILTERS.map(function (f) {
      var on = f.id === view.filter;
      return '<button type="button" class="panel-tab broll-chip' + (on ? ' is-active' : '') +
        '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '" data-action="broll-filter" data-filter="' +
        f.id + '">' + escapeHtml(f.label) + ' <span class="panel-count broll-chip-n">' + n[f.id] + '</span></button>';
    }).join("") +
  '</div>';
}

/* The full page's filters: the same four, as chips (renderBrollPage). */
function filterChipsHtml(entries) {
  var n = filterCounts(entries);
  return '<div class="broll-filters" role="radiogroup" aria-label="Show">' +
    FILTERS.map(function (f) {
      var on = f.id === view.filter;
      return '<button type="button" class="broll-chip' + (on ? ' is-active' : '') +
        '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '" data-action="broll-filter" data-filter="' +
        f.id + '">' + escapeHtml(f.label) + ' <span class="broll-chip-n">' + n[f.id] + '</span></button>';
    }).join("") +
  '</div>';
}

/* "By scene ▾" at the end of the tab bar (#169): quiet, since it changes
   how the list reads rather than what is in it. */
function groupMenuHtml() {
  var current = GROUPS.filter(function (g) { return g.id === view.group; })[0] || GROUPS[0];
  return '<div class="broll-group-wrap">' +
      '<button type="button" class="broll-group-btn" data-action="broll-group-menu" aria-haspopup="menu" ' +
        'aria-expanded="' + (groupMenuOpen ? 'true' : 'false') + '" title="Group the shots">' + escapeHtml(current.button) +
        icon("chevron-down") + '</button>' +
      (groupMenuOpen
        ? '<div class="broll-menu broll-group-menu" role="menu" aria-label="Group shots by">' +
            GROUPS.map(function (g) {
              var on = g.id === view.group;
              return '<button type="button" role="menuitemradio" aria-checked="' + (on ? 'true' : 'false') +
                '" class="broll-menu-item' + (on ? ' is-active' : '') + '" data-action="broll-group" data-group="' +
                g.id + '">' + escapeHtml(g.label) + (on ? icon("check", "broll-menu-check") : '') + '</button>';
            }).join("") +
          '</div>'
        : '') +
    '</div>';
}

/* Groups of entries, in order, each {key, kind, label, row, items}: shared
   by the panel and the full page so the two can never disagree about what
   "Scene" or "Location" puts together. */
export function brollGroups(entries, by) {
  var sorted = brollSortedForList(entries);
  if (by === "flat") return [{ key: "all", kind: "flat", label: "", items: sorted }];
  var groups = [], byKey = Object.create(null);
  sorted.forEach(function (e) {
    var key, label, kind = by, row = null;
    if (by === "scene") {
      if (e.rowIndex === -1) { key = "added"; label = "Added here"; kind = "added"; }
      else { key = "r:" + e.rowId; label = "Scene " + pad2(e.rowIndex + 1); row = S.state.rows[e.rowIndex] || null; }
    } else if (by === "location") {
      key = e.location ? "l:" + normalizeTagName(e.location) : "none";
      label = e.location || "No location";
    } else {
      var who = personById(e.owner);
      key = who ? "p:" + who.id : "none";
      label = who ? who.name : "Unassigned";
    }
    if (!byKey[key]) {
      byKey[key] = { key: key, kind: kind, label: label, row: row, items: [], none: key === "none" };
      groups.push(byKey[key]);
    }
    byKey[key].items.push(e);
  });
  /* Scene groups keep script order ("Added here" last, where the sort put
     it); the others read alphabetically, the empty group last. */
  if (by !== "scene") {
    groups.sort(function (a, b) {
      if (a.none !== b.none) return a.none ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  }
  return groups;
}

function doneCountHtml(items, cls) {
  var done = items.filter(function (e) { return e.status === "shot"; }).length;
  return '<span class="' + cls + (done === items.length ? ' is-done' : '') + '">' + done + '/' + items.length + '</span>';
}

/* A 32px group head (B-BrollCalm): the scene and where it starts, then
   done/total — in the b-roll colour once the group is all shot. The
   scene's audio used to follow, cut short with "…"; B dropped it for the
   start time, and the open shot's "Cuts against" has the words in full. */
function groupHeadHtml(g, starts) {
  if (g.kind === "flat") return "";
  var title, time = "";
  if (g.kind === "scene") {
    title = '<span class="broll-group-scene">' + escapeHtml(g.label) + '</span>';
    if (g.row && starts[g.row.id] !== undefined) {
      time = '<span class="broll-group-time">' + formatTimecode(starts[g.row.id]) + '</span>';
    }
  } else if (g.kind === "location") {
    title = '<span class="broll-group-title">' +
      (g.none ? '' : '<span class="broll-loc-pin">' + icon("pin") + '</span>') +
      escapeHtml(g.label) + '</span>';
  } else {
    title = '<span class="broll-group-title">' + escapeHtml(g.label) + '</span>';
  }
  return '<h3 class="broll-group-head">' + title + time + doneCountHtml(g.items, "broll-group-count") + '</h3>';
}

/* ---- one shot, one line ---- */

/* Beside the name, quietly (B-BrollCalm): where (a pin and the place),
   who (their avatar; the name is its title and a screen reader's) and
   what it needs (a lamp and the name of each prop). Most shots have one
   of the three, which is all the board draws; a shot with more shows them
   all, wrapping at the right rather than hiding any. */
function rowMetaHtml(e) {
  var parts = [];
  if (e.location) {
    parts.push('<span class="broll-meta-item broll-meta-loc"><span class="broll-loc-pin">' + icon("pin") + '</span>' +
      escapeHtml(e.location) + '</span>');
  }
  var who = personById(e.owner);
  if (who) {
    parts.push('<span class="broll-meta-item broll-meta-owner" title="' + escapeHtml("Assigned to " + who.name) + '">' +
      avatarHtml(who) + '<span class="broll-sr">' + escapeHtml(who.name) + '</span></span>');
  }
  if (e.props.length) {
    parts.push('<span class="broll-meta-item broll-meta-props" title="' + escapeHtml(propListTitle(e)) + '">' +
      propLampListHtml(e) + '</span>');
  }
  return parts.join("");
}

function rowStateIconsHtml(e) {
  var out = "";
  /* Quieter than they were (badges): nothing is wrong yet, but a line
     matched by name alone, or a shot whose line has gone, is worth being
     able to see. */
  if (e.markerless) {
    out += '<span class="broll-state-ico broll-loose-badge" title="This line has no marker yet, so it is matched ' +
      'by name — click away from the script and it gets one." aria-label="Not anchored yet">' + brollIcon("unlink", 14) + '</span>';
  }
  if (e.orphaned) {
    out += '<span class="broll-state-ico broll-orphan-ico" title="The line this came from is no longer in the script." ' +
      'aria-label="No longer in the script">' + brollIcon("orphan", 14) + '</span>';
  }
  if (e.notes) out += '<span class="broll-state-ico broll-note-ico" title="Has a note" aria-label="Has a note">' + brollIcon("note", 15) + '</span>';
  if (e.reshoot) out += '<span class="broll-state-ico broll-flag-ico" title="Flagged" aria-label="Flagged">' + brollIcon("flag", 15) + '</span>';
  return out;
}

function checkHtml(e) {
  var shot = e.status === "shot";
  var ro = reviewMode();
  return '<button type="button" class="broll-check" role="checkbox" aria-checked="' + (shot ? 'true' : 'false') +
    '"' + (ro ? ' disabled' : '') + ' data-action="broll-status-toggle" data-id="' + escapeHtml(e.id) + '" aria-label="' +
    escapeHtml("Shot: " + (e.name || "Untitled shot")) + '" title="' +
    (ro ? (shot ? 'Shot' : 'To shoot') : shot ? 'Shot — click to mark To shoot' : 'To shoot — click to mark Shot') +
    '"><span class="broll-check-box">' + icon("check") + '</span></button>';
}

/* The whole line but the checkbox is one button that opens the shot, the
   meta inside it, so the line is as easy to hit as it looks. The flag and
   note icons, and Go to scene on hover, sit after it. */
function rowHtml(e, starts) {
  var id = escapeHtml(e.id);
  var open = openId === e.id || renamingId === e.id;
  return '<div class="broll-row' + (e.status === "shot" ? ' is-shot' : '') + (e.reshoot ? ' is-flagged' : '') +
      (selection[e.id] ? ' is-selected' : '') + (open ? ' is-open' : '') + (e.orphaned ? ' is-orphaned' : '') +
      '" data-id="' + id + '" aria-selected="' + (selection[e.id] ? 'true' : 'false') + '">' +
      checkHtml(e) +
      '<button type="button" class="broll-row-main" data-action="broll-expand" data-id="' + id +
        '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="broll-row-name">' + escapeHtml(e.name || "Untitled shot") + '</span>' +
        '<span class="broll-row-meta">' + rowMetaHtml(e) + '</span>' +
      '</button>' +
      '<span class="broll-row-icons">' + rowStateIconsHtml(e) + '</span>' +
      (e.rowId
        ? '<button type="button" class="broll-row-go" data-action="broll-jump" data-id="' + id + '" title="Go to scene ' +
            sceneLabel(e) + '">Go to scene' + icon("arrow-right") + '</button>'
        : '') +
    '</div>' +
    (open ? cardHtml(e, starts) : '');
}

/* ---- the open shot: label–value rows under its line ----

   B-BrollCalm: on the line's own --surface-2, lined up under the name, a
   definition list whose fields show their border at rest (#169, Adam:
   "fields and buttons must be easy to find"), then Flag for reshoot and
   the ⋯ menu (Rename, Delete) at its foot. */

function field(label, valueHtml) {
  return '<dt class="broll-label">' + escapeHtml(label) + '</dt><dd class="broll-value">' + valueHtml + '</dd>';
}

/* The chevron an .ev-field draws at its right (app.css "side panel parts"). */
function chevronHtml() {
  return '<svg class="ev-chevron" aria-hidden="true" focusable="false"><use href="#i-chevron-down"/></svg>';
}

var SHOT_STATUSES = [{ id: "unshot", label: "To shoot" }, { id: "shot", label: "Shot" }];

/* The scene gutter's lamp, in the b-roll colour: an empty square to
   shoot, filled with a tick once shot. */
function statusLampHtml(status) {
  return '<span class="broll-status-lamp' + (status === "shot" ? ' is-shot' : '') + '" aria-hidden="true">' +
    (status === "shot" ? icon("check") : '') + '</span>';
}

/* Status as a field that flips To shoot ↔ Shot in one click (Adam, #169:
   like the breakdown's status, which cycles), so no chevron and no menu.
   It is the line's tick in words, with the same data-action. A reviewer
   gets the value, disabled. */
function statusFieldHtml(e, ro) {
  var id = escapeHtml(e.id);
  var cur = SHOT_STATUSES.filter(function (s) { return s.id === e.status; })[0] || SHOT_STATUSES[0];
  var next = SHOT_STATUSES.filter(function (s) { return s.id !== cur.id; })[0];
  var says = "Status: " + cur.label + (ro ? "" : ". Click to mark " + next.label.toLowerCase());
  return '<span class="ev-field broll-status-field">' +
      '<button type="button" class="broll-status-btn" data-action="broll-status-toggle" data-id="' + id + '" data-status="' +
        cur.id + '" aria-label="' + escapeHtml(says) + '" title="' + escapeHtml(says) + '"' + (ro ? ' disabled' : '') + '>' +
        statusLampHtml(cur.id) + escapeHtml(cur.label) + '</button>' +
    '</span>';
}

function cardHtml(e, starts) {
  var id = escapeHtml(e.id);
  var ro = reviewMode();
  var off = ro ? ' disabled' : '';
  var renaming = renamingId === e.id;

  /* "03 · 00:31": the scene and where it starts, one link to it */
  var when = startOf(e, starts);
  var scene = e.rowId
    ? '<button type="button" class="jump-link broll-scene-link" data-action="broll-jump" data-id="' + id + '" title="Go to scene ' +
        sceneLabel(e) + '"><span class="broll-scene-n">' + sceneLabel(e) + '</span>' + (when ? ' · ' + when : '') + '</button>'
    : e.orphaned
      ? '<span class="broll-muted">No longer in the script — its line was deleted.</span>'
      : '<span class="broll-muted">Added here</span>';

  /* Looks like B's select; opens the text box with the known places in
     its list, so a new place can still be typed in one go. */
  var location = ro
    ? '<span class="broll-static">' +
        (e.location ? escapeHtml(e.location) : '<span class="broll-muted">No location</span>') + '</span>'
    : editingLocFor === e.id
    ? '<input type="text" class="broll-loc-input ev-field" data-id="' + id + '" list="broll-loc-options" maxlength="80" ' +
        'placeholder="Where it gets shot" aria-label="Location" value="' + escapeHtml(e.location) + '">'
    : '<span class="ev-field broll-loc-field"><button type="button" class="broll-picker" data-action="broll-loc-edit" data-id="' + id +
        '" aria-label="' + escapeHtml("Location: " + (e.location || "none") + ". Change") + '">' +
        (e.location ? escapeHtml(e.location) : '<span class="broll-muted">Choose…</span>') + '</button>' +
        chevronHtml() + '</span>';

  var who = personById(e.owner);
  var assigned = '<div class="broll-owner-row">' +
      '<span class="ev-field broll-owner-field">' + (who ? avatarHtml(who) : '') +
        '<select class="broll-owner-select' + (who ? '' : ' is-empty') + '" data-id="' + id + '" aria-label="Assigned to"' + off + '>' +
          '<option value=""' + (e.owner ? '' : ' selected') + '>Unassigned</option>' +
          S.state.people.map(function (p) {
            return '<option value="' + escapeHtml(p.id) + '"' + (p.id === e.owner ? ' selected' : '') + '>' +
              escapeHtml(p.name) + '</option>';
          }).join("") +
        '</select>' +
        (ro ? '' : chevronHtml()) +
      '</span>' +
      (ro ? '' :
        '<button type="button" class="broll-person-btn btn-outline is-small" data-action="broll-person-new" data-id="' + id +
          '" title="Add someone to the crew list">' + icon("plus") + 'Add person</button>') +
    '</div>' +
    (addingPersonFor === e.id
      ? '<div class="broll-owner-row">' +
          '<input type="text" class="broll-person-input ev-field" data-id="' + id + '" placeholder="Their name" maxlength="60" aria-label="New person\'s name">' +
          '<button type="button" class="btn-outline is-small" data-action="broll-person-save" data-id="' + id + '">Add</button>' +
          '<button type="button" class="btn-outline is-small" data-action="broll-person-cancel">Cancel</button>' +
        '</div>'
      : '');

  /* The words in full, in the script's face (#169: never cut short) */
  var cuts = editingRefFor === e.id
    ? '<textarea class="broll-ref-input ev-field" data-id="' + id + '" rows="3" aria-label="Cuts against" ' +
        'placeholder="The line of audio this cuts against">' + escapeHtml(e.audioRef) + '</textarea>'
    : '<div class="broll-cuts">' +
        (e.audioRef
          ? '<blockquote class="broll-quote">' + escapeHtml(e.audioRef) + '</blockquote>'
          : '<span class="broll-muted">No line yet</span>') +
        (ro ? '' :
          '<button type="button" class="broll-icon-btn" data-action="broll-ref-edit" data-id="' + id +
            '" aria-label="Edit the line this cuts against" title="Edit">' + brollIcon("pencil", 16) + '</button>') +
      '</div>';

  /* Flag for reshoot, and ⋯ with what is left: outlined buttons (#169).
     The menu opens upward, since it sits at the foot of the shot. */
  var foot = '<div class="broll-card-foot">' +
      '<button type="button" class="broll-flag-btn btn-outline is-small' + (e.reshoot ? ' is-active' : '') + '"' + off +
        ' data-action="broll-reshoot-toggle" data-id="' + id + '" aria-pressed="' + (e.reshoot ? 'true' : 'false') + '" title="' +
        (ro ? (e.reshoot ? 'Flagged' : 'Not flagged')
            : e.reshoot ? 'Flagged — click to clear' : 'Flag it: a reshoot, or anything else worth a second look') + '">' +
        icon("flag") + (e.reshoot ? 'Flagged' : 'Flag for reshoot') + '</button>' +
      (ro ? '' :
        '<div class="broll-more-wrap">' +
          '<button type="button" class="broll-more-btn btn-outline is-small is-icon" data-action="broll-menu" data-id="' + id +
            '" aria-haspopup="menu" aria-expanded="' + (menuFor === e.id ? 'true' : 'false') +
            '" aria-label="More actions for this shot" title="More">' + icon("more") + '</button>' +
          (menuFor === e.id
            ? '<div class="broll-menu broll-more-menu" role="menu">' +
                (e.rowId ? '<button type="button" role="menuitem" class="broll-menu-item" data-action="broll-rename" data-id="' + id +
                  '">Rename in script</button>' : '') +
                '<button type="button" role="menuitem" class="broll-menu-item danger" data-action="broll-delete" data-id="' + id +
                  '">Delete from list</button>' +
              '</div>'
            : '') +
        '</div>') +
    '</div>';

  return '<div class="broll-card" data-id="' + id + '">' +
      (renaming
        ? '<div class="broll-card-rename">' +
            '<input type="text" class="broll-rename-input ev-field" data-id="' + id + '" maxlength="200" aria-label="Shot name" value="' +
              escapeHtml(e.name) + '">' +
            '<button type="button" class="btn-outline is-small" data-action="broll-rename-save" data-id="' + id + '">Save</button>' +
            '<button type="button" class="btn-outline is-small" data-action="broll-rename-cancel">Cancel</button>' +
          '</div>'
        : e.desc ? '<div class="broll-card-desc">' + escapeHtml(e.desc) + '</div>' : '') +
      '<dl class="broll-fields">' +
        field("Status", statusFieldHtml(e, ro)) +
        field("Scene", scene) +
        field("Location", location) +
        field("Assigned", assigned) +
        field("Props", propsEditHtml(e, ro)) +
        field("Cuts against", cuts) +
        field("Note", '<textarea class="broll-notes-input ev-field" data-id="' + id + '" rows="1" aria-label="Note" ' +
          (ro ? 'readonly placeholder="No note">' : 'placeholder="Add a note…">') + escapeHtml(e.notes) + '</textarea>') +
      '</dl>' +
      foot +
    '</div>';
}

/* ---- the bulk bar: several shots, one change, one undo ---- */

function selectedIds(entries) {
  return entries.filter(function (e) { return selection[e.id]; }).map(function (e) { return e.id; });
}

function bulkBarHtml(entries) {
  if (reviewMode()) return "";
  var chosen = entries.filter(function (e) { return selection[e.id]; });
  if (!chosen.length) return "";
  var allShot = chosen.every(function (e) { return e.status === "shot"; });
  var allFlagged = chosen.every(function (e) { return e.reshoot; });
  /* #169: the panel's own language — outlined buttons and fields on a
     raised strip — rather than the dark bar it was */
  return '<div class="broll-bulk-row">' +
      '<span class="broll-bulk-n">' + chosen.length + ' selected</span>' +
      '<button type="button" class="broll-bulk-btn btn-outline is-small" data-action="broll-bulk-shot">' +
        icon("check") + (allShot ? 'Mark to shoot' : 'Mark shot') + '</button>' +
      '<select class="broll-bulk-select" id="broll-bulk-owner" aria-label="Assign the selected shots">' +
        '<option value="__none__" selected>Assign</option>' +
        '<option value="">Unassigned</option>' +
        S.state.people.map(function (p) {
          return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>';
        }).join("") +
        '<option value="__new__">+ Person…</option>' +
      '</select>' +
      '<select class="broll-bulk-select" id="broll-bulk-location" aria-label="Set the location of the selected shots">' +
        '<option value="__none__" selected>Location</option>' +
        '<option value="">No location</option>' +
        knownLocations().map(function (n) {
          return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>';
        }).join("") +
        '<option value="__new__">New location…</option>' +
      '</select>' +
      '<button type="button" class="broll-bulk-btn btn-outline is-small" data-action="broll-bulk-flag">' +
        icon("flag") + (allFlagged ? 'Unflag' : 'Flag') + '</button>' +
      '<button type="button" class="broll-bulk-clear" data-action="broll-bulk-clear" aria-label="Clear the selection" ' +
        'title="Clear the selection (Esc)">' + icon("close") + '</button>' +
    '</div>' +
    (bulkInput
      ? '<div class="broll-bulk-row">' +
          '<input type="text" id="broll-bulk-input" class="ev-field" maxlength="' + (bulkInput === "person" ? 60 : 80) + '" placeholder="' +
            (bulkInput === "person" ? 'Their name' : 'Where they get shot') + '" aria-label="' +
            (bulkInput === "person" ? 'New person' : 'New location') + '"' +
            (bulkInput === "location" ? ' list="broll-loc-options"' : '') + '>' +
          '<button type="button" class="broll-bulk-btn btn-outline is-small" data-action="broll-bulk-input-save">' +
            (bulkInput === "person" ? 'Assign' : 'Set') + '</button>' +
          '<button type="button" class="broll-bulk-btn btn-outline is-small" data-action="broll-bulk-input-cancel">Cancel</button>' +
        '</div>'
      : '');
}

/* ---- drawing ---- */

/* A re-render replaces the list's markup, so whatever had the focus in it
   is put back: the same control, and for a text box what was typed and
   where the caret was. The list re-renders on the idle refresh, which can
   land while a note is half written. */
function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.id) return "#" + cssAttr(el.id);
  var cls = el.classList && el.classList[0];
  if (!cls) return null;
  var sel = "." + cls;
  ["data-id", "data-action", "data-filter", "data-group", "data-status", "data-ref"].forEach(function (a) {
    var v = el.getAttribute(a);
    if (v !== null) sel += "[" + a + '="' + cssAttr(v) + '"]';
  });
  return sel;
}

function keepingFocus(container, draw) {
  var active = document.activeElement;
  var kept = null;
  if (active && container.contains(active)) {
    var typed = active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.type === "text");
    kept = { key: focusKey(active), typed: typed, value: active.value,
             start: typed ? active.selectionStart : 0, end: typed ? active.selectionEnd : 0 };
  }
  draw();
  if (!kept || !kept.key) return;
  var again = container.querySelector(kept.key);
  if (!again) return;
  if (kept.typed) {
    again.value = kept.value;
    try { again.setSelectionRange(kept.start, kept.end); } catch (e) { /* not a text control */ }
  }
  again.focus({ preventScroll: true });
}

function emptyListHtml(entries) {
  if (!entries.length) {
    return '<div class="broll-empty">No b-roll yet.<br><br>Start a line in the Visual column with ' +
      '<code>B-roll:</code> and whatever follows it becomes a shot to track — or add one below.</div>';
  }
  var msg = {
    unshot: "Nothing left to shoot — everything on the list is in the can.",
    shot: "Nothing shot yet.",
    flagged: "Nothing flagged."
  }[view.filter] || "No shots match.";
  return '<div class="broll-empty">' + escapeHtml(msg) + '</div>';
}

export function renderBroll() {
  updateBrollBadge();
  var panel = document.getElementById("broll-panel");
  if (!panel || panel.hidden || !S.state) return;
  dropEditingForReview();
  var entries = brollEntries();
  pruneSelection(entries);
  var summary = document.getElementById("broll-summary");
  var controls = document.getElementById("broll-controls");
  var listEl = document.getElementById("broll-list");
  var bulk = document.getElementById("broll-bulk");

  keepingFocus(panel, function () {
    /* the count and the bar live in the head, the tabs under it (#169) */
    if (summary) summary.innerHTML = entries.length ? summaryHtml(entries) : '';
    controls.innerHTML = entries.length ? filterTabsHtml(entries) + groupMenuHtml() : '';
    var shown = entries.filter(function (e) { return matchesFilter(e, view.filter); });
    var starts = sceneStarts();
    listEl.innerHTML = datalistsHtml() + (shown.length
      ? brollGroups(shown, view.group).map(function (g) {
          return '<div class="broll-group" role="group" aria-label="' + escapeHtml(g.label || "Shots") + '">' +
            groupHeadHtml(g, starts) + g.items.map(function (e) { return rowHtml(e, starts); }).join("") + '</div>';
        }).join("")
      : emptyListHtml(entries));
    var bar = bulkBarHtml(entries);
    bulk.innerHTML = bar;
    bulk.hidden = !bar;
  });
  fitNotes(listEl);
}

/* A note or a "Cuts against" being edited is one line tall until it has
   more, then grows to show all of it (#169: nothing cut off). CSS
   field-sizing does that where the browser has it; elsewhere the box is
   measured after every draw and every keystroke. */
function fitNotes(root) {
  if (typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content")) return;
  Array.prototype.forEach.call(root.querySelectorAll("textarea.ev-field"), fitTextarea);
}

function fitTextarea(box) {
  if (typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content")) return;
  box.style.height = "auto";
  box.style.height = (box.scrollHeight + box.offsetHeight - box.clientHeight) + "px";
}

/* Everything that shows the list: the panel, and the full page when it is
   open. The idle refresh (08c-broll.js runBrollRefresh) and every edit
   below end here. */
export function renderBrollViews() {
  renderBroll();
  renderBrollPage();
}

/* ---- editing ---- */

function entryById(id) {
  var all = brollEntries();
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

/* Every edit lands on the record, marks the document dirty and redraws —
   the one exception being a rename, which has to reach the script itself
   first (renameBrollInScript). */
function updateRecord(id, fields) {
  var rec = brollRecord(id);
  if (!rec) return null;
  Object.keys(fields).forEach(function (k) { rec[k] = fields[k]; });
  markDirty();
  queueAutoSave();
  renderBrollViews();
  return rec;
}

export function toggleBrollShot(id) {
  var rec = brollRecord(id);
  if (!rec) return;
  updateRecord(id, { status: rec.status === "shot" ? "unshot" : "shot" });
}

/* The same change to every selected shot, as ONE edit: one markDirty, so
   the undo stack records one entry (12a-undo.js diffs after it), and the
   coalescing broken first so it never merges into the typing before it. */
function bulkUpdate(apply, describe) {
  var entries = brollEntries();
  var ids = selectedIds(entries);
  if (!ids.length) return;
  breakUndoCoalescing();
  var n = 0;
  ids.forEach(function (id) {
    var rec = brollRecord(id);
    if (rec && apply(rec)) n++;
  });
  if (!n) { renderBrollViews(); return; }
  markDirty();
  queueAutoSave();
  renderBrollViews();
  showToast(describe(n), "ok");
}

function shotsWord(n) { return plural(n, "shot", "shots"); }

function bulkMarkShot() {
  var entries = brollEntries().filter(function (e) { return selection[e.id]; });
  var allShot = entries.length && entries.every(function (e) { return e.status === "shot"; });
  var want = allShot ? "unshot" : "shot";
  bulkUpdate(function (rec) {
    if (rec.status === want) return false;
    rec.status = want;
    return true;
  }, function (n) { return "Marked " + shotsWord(n) + (want === "shot" ? " shot" : " to shoot") + "."; });
}

function bulkFlag() {
  var entries = brollEntries().filter(function (e) { return selection[e.id]; });
  var want = !(entries.length && entries.every(function (e) { return e.reshoot; }));
  bulkUpdate(function (rec) {
    if (!!rec.reshoot === want) return false;
    rec.reshoot = want;
    return true;
  }, function (n) { return (want ? "Flagged " : "Unflagged ") + shotsWord(n) + "."; });
}

function bulkAssign(personId) {
  var owner = personById(personId) ? personId : "";
  bulkUpdate(function (rec) {
    if ((rec.owner || "") === owner) return false;
    rec.owner = owner;
    return true;
  }, function (n) {
    var who = personById(owner);
    return who ? "Assigned " + shotsWord(n) + " to " + who.name + "." : "Unassigned " + shotsWord(n) + ".";
  });
}

function bulkLocation(name) {
  var clean = plainText(name).trim().slice(0, 80);
  bulkUpdate(function (rec) {
    if ((rec.location || "") === clean) return false;
    rec.location = clean;
    return true;
  }, function (n) { return clean ? "Moved " + shotsWord(n) + " to " + clean + "." : "Cleared the location of " + shotsWord(n) + "."; });
}

/* A new person named in the bar joins the crew list in the same edit as
   the assignment, so one undo takes both. */
function bulkAssignNewPerson(name) {
  var entries = brollEntries();
  if (!selectedIds(entries).length) return;
  breakUndoCoalescing();
  var id = findOrAddPerson(name);
  if (!id) { renderBrollViews(); return; }
  var owner = id, n = 0;
  selectedIds(entries).forEach(function (sid) {
    var rec = brollRecord(sid);
    if (rec && rec.owner !== owner) { rec.owner = owner; n++; }
  });
  markDirty();
  queueAutoSave();
  renderBrollViews();
  var who = personById(owner);
  showToast("Assigned " + shotsWord(n) + " to " + (who ? who.name : "them") + ".", "ok");
}

function clearSelection() {
  selection = Object.create(null);
  selectionAnchor = null;
  bulkInput = null;
}

function pruneSelection(entries) {
  var live = Object.create(null);
  entries.forEach(function (e) { live[e.id] = true; });
  Object.keys(selection).forEach(function (id) { if (!live[id]) delete selection[id]; });
  if (!Object.keys(selection).length) bulkInput = null;
}

/* Ctrl/Cmd+click adds or drops a line; Shift+click takes the run of lines
   between the last one clicked and this one, in the order they are shown. */
function selectWithModifier(e, id, orderIds) {
  if (e.shiftKey && selectionAnchor && orderIds.indexOf(selectionAnchor) !== -1) {
    var a = orderIds.indexOf(selectionAnchor), b = orderIds.indexOf(id);
    var lo = Math.min(a, b), hi = Math.max(a, b);
    for (var i = lo; i <= hi; i++) selection[orderIds[i]] = true;
  } else {
    if (selection[id]) delete selection[id]; else selection[id] = true;
    selectionAnchor = id;
  }
  var sel = window.getSelection();
  if (sel && sel.removeAllRanges) sel.removeAllRanges();
}

function shownOrder(container) {
  return Array.prototype.map.call(container.querySelectorAll(".broll-row[data-id]"), function (r) {
    return r.getAttribute("data-id");
  });
}

function addBrollFromPanel() {
  if (reviewBlocked()) return;
  var input = document.getElementById("broll-add-input");
  if (!input) return;
  var name = plainText(input.value).trim().slice(0, BROLL_NAME_MAX);
  if (!name) return;
  /* No line in the script, and no flag for it either: a shot nobody has
     written a scene for yet is an ordinary thing to want on the list. */
  var rec = newBrollRecord({ name: name, origin: "list" });
  input.value = "";
  openId = rec.id;
  markDirty();
  queueAutoSave();
  renderBrollViews();
  showToast("Added to the b-roll list.", "ok");
}

export function jumpToBrollShot(id) {
  var e = entryById(id);
  if (!e || !e.rowId) return false;
  revealRow(e.rowId);
  focusRowField(e.rowId, "visualText");
  return true;
}

/* The Add prop box: Enter, or a name picked from its list. */
function commitPropInput(input) {
  var id = input.getAttribute("data-id");
  var name = input.value;
  input.value = "";
  if (!plainText(name).trim()) return;
  if (addBrollProp(id, name)) {
    markDirty();
    queueAutoSave();
    scheduleProductionRefresh();
  }
  renderBrollViews();
  var again = document.querySelector('.broll-prop-input[data-id="' + cssAttr(id) + '"]');
  if (again) again.focus();
}

function commitLocation(input) {
  var id = input.getAttribute("data-id");
  var rec = brollRecord(id);
  editingLocFor = null;
  var clean = plainText(input.value).trim().slice(0, 80);
  if (rec && rec.location !== clean) updateRecord(id, { location: clean });
  else renderBrollViews();
}

function renameShot(id, box) {
  var e = entryById(id);
  var next = box ? plainText(box.value).trim().slice(0, BROLL_NAME_MAX) : "";
  renamingId = null;
  /* the typing in the script before this is its own undo entry: broken
     off first, since what is flushed unreported is taken in with no entry */
  breakUndoCoalescing();
  if (e && next && next !== e.name && renameBrollInScript(e, next)) {
    render();
    markDirty();
    queueAutoSave();
  }
  renderBrollViews();
}

function deleteShot(id) {
  var e = entryById(id);
  if (!e) return;
  /* Deleting here only ever forgets the record. The words stay where they
     were written — taking somebody's line out of their script from a side
     panel is not this button's business. */
  deleteBrollRecord(id);
  if (openId === id) openId = null;
  menuFor = null;
  delete selection[id];
  markDirty();
  queueAutoSave();
  renderBrollViews();
  showToast(e.rowId ? "Removed from the list — the line stays in the script." : "Removed from the list.", "ok");
}

/* ---- the one set of handlers, for the panel and the full page ----

   Both show the same controls (the checkbox, the assignee, the note) with
   the same data-action names, so both are wired here: an edit made on the
   page is the same edit, with the same undo, as one made in the panel. */
function onBrollClick(e, root) {
  var btn = e.target.closest("[data-action]");
  if (!btn || !root.contains(btn)) {
    if (groupMenuOpen || menuFor) { groupMenuOpen = false; menuFor = null; renderBrollViews(); }
    return;
  }
  var action = btn.getAttribute("data-action");
  var id = btn.getAttribute("data-id");

  if (reviewMode() && !BROLL_REVIEW_SAFE_ACTIONS[action]) {
    reviewBlocked();
    return;
  }
  if (action !== "broll-group-menu" && action !== "broll-group") groupMenuOpen = false;
  if (action !== "broll-menu" && action !== "broll-rename" && action !== "broll-delete") menuFor = null;

  if (action === "broll-status-toggle") {
    e.stopPropagation();
    var fromField = btn.classList.contains("broll-status-btn");
    toggleBrollShot(id);
    /* the open shot's Status field is drawn anew saying the other state;
       the focus stays on it, for the next press of Space */
    var again = fromField && root.querySelector('.broll-status-btn[data-id="' + cssAttr(id) + '"]');
    if (again) again.focus();
  } else if (action === "broll-expand") {
    /* a selection is only ever for the bulk bar, which a reviewer has none of */
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && !reviewMode()) {
      e.preventDefault();
      selectWithModifier(e, id, shownOrder(root));
      renderBrollViews();
      return;
    }
    openId = openId === id ? null : id;
    renamingId = null; editingLocFor = null; editingRefFor = null; addingPersonFor = null;
    renderBrollViews();
  } else if (action === "broll-reshoot-toggle") {
    var rec = brollRecord(id);
    if (!rec) return;
    var raising = !rec.reshoot;
    openId = id;
    updateRecord(id, { reshoot: raising });
    /* Raising the flag asks why: the note is the useful half of it, and
       the moment it is raised is the only moment anyone knows the answer. */
    if (raising) {
      var notes = root.querySelector('.broll-notes-input[data-id="' + cssAttr(id) + '"]');
      if (notes) notes.focus();
    }
  } else if (action === "broll-jump") {
    jumpToBrollShot(id);
  } else if (action === "broll-filter") {
    setFilter(btn.getAttribute("data-filter"));
  } else if (action === "broll-group-menu") {
    groupMenuOpen = !groupMenuOpen;
    renderBrollViews();
    if (groupMenuOpen) {
      var first = root.querySelector('.broll-group-menu .broll-menu-item.is-active, .broll-group-menu .broll-menu-item');
      if (first) first.focus();
    }
  } else if (action === "broll-group") {
    view.group = oneOf(GROUPS, btn.getAttribute("data-group"), "scene");
    groupMenuOpen = false;
    saveView();
    renderBrollViews();
    var gb = root.querySelector(".broll-group-btn");
    if (gb) gb.focus();
  } else if (action === "broll-menu") {
    menuFor = menuFor === id ? null : id;
    renderBrollViews();
  } else if (action === "broll-rename") {
    menuFor = null;
    renamingId = id;
    openId = id;
    renderBrollViews();
    var input = root.querySelector('.broll-rename-input[data-id="' + cssAttr(id) + '"]');
    if (input) { input.focus(); input.select(); }
  } else if (action === "broll-rename-save") {
    renameShot(id, root.querySelector('.broll-rename-input[data-id="' + cssAttr(id) + '"]'));
  } else if (action === "broll-rename-cancel") {
    renamingId = null;
    renderBrollViews();
  } else if (action === "broll-delete") {
    deleteShot(id);
  } else if (action === "broll-loc-edit") {
    editingLocFor = id;
    renderBrollViews();
    var loc = root.querySelector('.broll-loc-input[data-id="' + cssAttr(id) + '"]');
    if (loc) { loc.focus(); loc.select(); }
  } else if (action === "broll-ref-edit") {
    editingRefFor = id;
    renderBrollViews();
    var ref = root.querySelector('.broll-ref-input[data-id="' + cssAttr(id) + '"]');
    if (ref) ref.focus();
  } else if (action === "broll-prop-remove") {
    if (removeBrollProp(id, btn.getAttribute("data-ref"))) {
      markDirty();
      queueAutoSave();
    }
    renderBrollViews();
  } else if (action === "broll-person-new") {
    addingPersonFor = id;
    renderBrollViews();
    var pi = root.querySelector('.broll-person-input[data-id="' + cssAttr(id) + '"]');
    if (pi) pi.focus();
  } else if (action === "broll-person-save") {
    var nameBox = root.querySelector('.broll-person-input[data-id="' + cssAttr(id) + '"]');
    addingPersonFor = null;
    breakUndoCoalescing();
    var personId = nameBox ? findOrAddPerson(nameBox.value) : "";
    if (personId) updateRecord(id, { owner: personId });
    else renderBrollViews();
  } else if (action === "broll-person-cancel") {
    addingPersonFor = null;
    renderBrollViews();
  } else if (action === "broll-bulk-shot") {
    bulkMarkShot();
  } else if (action === "broll-bulk-flag") {
    bulkFlag();
  } else if (action === "broll-bulk-clear") {
    clearSelection();
    renderBrollViews();
  } else if (action === "broll-bulk-input-save") {
    var box = document.getElementById("broll-bulk-input");
    var value = box ? box.value : "";
    var mode = bulkInput;
    bulkInput = null;
    if (mode === "person") bulkAssignNewPerson(value);
    else if (mode === "location" && plainText(value).trim()) bulkLocation(value);
    else renderBrollViews();
  } else if (action === "broll-bulk-input-cancel") {
    bulkInput = null;
    renderBrollViews();
  } else {
    onBrollPageAction(action, btn, e);
  }
}

function onBrollChange(e) {
  var t = e.target;
  if (reviewMode()) {
    /* a select a reviewer should never have had enabled: say so, and draw
       it back as it was */
    if (t.classList.contains("broll-owner-select") || t.id === "broll-bulk-owner" || t.id === "broll-bulk-location") {
      reviewBlocked();
      renderBrollViews();
    }
    return;
  }
  if (t.classList.contains("broll-owner-select")) {
    updateRecord(t.getAttribute("data-id"), { owner: personById(t.value) ? t.value : "" });
  } else if (t.id === "broll-bulk-owner") {
    if (t.value === "__new__") { bulkInput = "person"; renderBrollViews(); focusBulkInput(); }
    else if (t.value !== "__none__") bulkAssign(t.value);
  } else if (t.id === "broll-bulk-location") {
    if (t.value === "__new__") { bulkInput = "location"; renderBrollViews(); focusBulkInput(); }
    else if (t.value !== "__none__") bulkLocation(t.value);
  }
}

function focusBulkInput() {
  var box = document.getElementById("broll-bulk-input");
  if (box) box.focus();
}

/* Typed fields commit on the way out rather than per keystroke: a redraw
   on every character would take the caret with it. */
function onBrollFocusOut(e) {
  if (reviewMode()) return;
  var el = e.target;
  var id = el.getAttribute && el.getAttribute("data-id");
  if (!id) return;
  var rec = brollRecord(id);
  if (!rec) return;
  if (el.classList.contains("broll-notes-input")) {
    var notes = plainText(el.value).slice(0, BROLL_TEXT_MAX);
    if (rec.notes !== notes) updateRecord(id, { notes: notes });
  } else if (el.classList.contains("broll-ref-input")) {
    editingRefFor = null;
    var ref = plainText(el.value).slice(0, BROLL_TEXT_MAX);
    if (rec.audioRef !== ref) updateRecord(id, { audioRef: ref });
    else renderBrollViews();
  } else if (el.classList.contains("broll-loc-input")) {
    commitLocation(el);
  }
}

function onBrollKeydown(e, root) {
  var t = e.target;
  var onPage = root.id === "broll-page";
  if (e.key === "Escape") {
    /* Escape takes back the most recent thing opened, one at a time: a
       menu, a field being edited, the selection, then the open shot —
       whose line gets the focus back. Only once there is nothing left to
       close does it reach the window (the full page closes on it). */
    var refocus = null;
    if (groupMenuOpen) { groupMenuOpen = false; refocus = ".broll-group-btn"; }
    else if (menuFor) { refocus = '[data-action="broll-menu"][data-id="' + cssAttr(menuFor) + '"]'; menuFor = null; }
    else if (t.classList.contains("broll-loc-input")) editingLocFor = null;
    else if (t.classList.contains("broll-ref-input")) editingRefFor = null;
    else if (t.classList.contains("broll-rename-input")) renamingId = null;
    else if (t.classList.contains("broll-person-input")) addingPersonFor = null;
    else if (t.id === "broll-bulk-input") bulkInput = null;
    else if (!onPage && Object.keys(selection).length) clearSelection();
    else if (!onPage && openId) {
      refocus = '.broll-row-main[data-id="' + cssAttr(openId) + '"]';
      openId = null;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    renderBrollViews();
    var back = refocus && root.querySelector(refocus);
    if (back) back.focus();
    return;
  }
  /* Up and Down move through an open menu's items, as in any menu. */
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && t.classList && t.classList.contains("broll-menu-item")) {
    var items = Array.prototype.slice.call(t.parentNode.querySelectorAll(".broll-menu-item"));
    var at = items.indexOf(t) + (e.key === "ArrowDown" ? 1 : -1);
    e.preventDefault();
    items[(at + items.length) % items.length].focus();
    return;
  }
  if (e.key !== "Enter") return;
  /* Every box Enter would commit writes a shot; in a review session the
     only one left in the page is Add a shot's, hidden by app.css. */
  if (reviewMode()) {
    if (t.tagName === "INPUT" && !t.readOnly) { e.preventDefault(); reviewBlocked(); }
    return;
  }
  if (t.id === "broll-add-input") { e.preventDefault(); addBrollFromPanel(); }
  else if (t.classList.contains("broll-prop-input")) { e.preventDefault(); commitPropInput(t); }
  else if (t.classList.contains("broll-loc-input")) { e.preventDefault(); commitLocation(t); }
  else if (t.classList.contains("broll-rename-input")) {
    e.preventDefault();
    renameShot(t.getAttribute("data-id"), t);
  } else if (t.classList.contains("broll-person-input")) {
    e.preventDefault();
    var add = root.querySelector('[data-action="broll-person-save"][data-id="' + cssAttr(t.getAttribute("data-id")) + '"]');
    if (add) add.click();
  } else if (t.id === "broll-bulk-input") {
    e.preventDefault();
    var save = root.querySelector('[data-action="broll-bulk-input-save"]');
    if (save) save.click();
  }
}

function onBrollInput(e) {
  if (reviewMode()) return;
  var box = e.target;
  if (box.tagName === "TEXTAREA" && box.classList.contains("ev-field")) fitTextarea(box);
  /* A name picked from the Add prop box's list is a choice made, not
     typing on the way to one: it goes in at once. */
  if (box.classList && box.classList.contains("broll-prop-input") &&
      (e.inputType === "insertReplacementText" || e.inputType === undefined)) {
    commitPropInput(box);
  }
}

function wireBrollRoot(root) {
  root.addEventListener("click", function (e) { onBrollClick(e, root); });
  root.addEventListener("change", onBrollChange);
  root.addEventListener("focusout", onBrollFocusOut);
  root.addEventListener("keydown", function (e) { onBrollKeydown(e, root); });
  root.addEventListener("input", onBrollInput);
}

/* ---- opening and closing the panel ---- */

export function openBrollPanel() {
  if (!S.state) return;
  openSidePanel("broll-panel");
  renderBroll();
}

export function closeBrollPanel() {
  var p = document.getElementById("broll-panel");
  if (p) p.hidden = true;
  groupMenuOpen = false;
  menuFor = null;
  syncPanelClass();
}

export function wireBrollPanel() {
  var panel = document.getElementById("broll-panel");
  if (!panel) return;
  wireBrollRoot(panel);
  wireBrollPage();

  var addBtn = document.getElementById("broll-add-save");
  if (addBtn) addBtn.addEventListener("click", addBrollFromPanel);
  var closeBtn = document.getElementById("broll-close");
  if (closeBtn) closeBtn.addEventListener("click", closeBrollPanel);
  var openBtn = document.getElementById("btn-broll");
  if (openBtn) openBtn.addEventListener("click", function () {
    var p = document.getElementById("broll-panel");
    if (p && !p.hidden) closeBrollPanel(); else openBrollPanel();
  });
  /* A click outside an open menu closes it, like any menu. */
  document.addEventListener("mousedown", function (e) {
    if (!groupMenuOpen && !menuFor) return;
    if (e.target.closest && e.target.closest(".broll-menu, .broll-group-btn, [data-action=\"broll-menu\"]")) return;
    groupMenuOpen = false;
    menuFor = null;
    renderBrollViews();
  });
  /* Ctrl+clicking lines leaves the focus wherever it was, so the panel's
     own keydown may never see Escape: clearing a selection is caught at
     the window too, as the production panel's is. */
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !Object.keys(selection).length) return;
    var p = document.getElementById("broll-panel");
    if (!p || p.hidden || p.contains(e.target)) return;
    clearSelection();
    renderBrollViews();
  });
}

/* ---- the full-page shot list (#150) ----

   The same list, as a sheet: a table in a card over the whole screen,
   grouped by location by default — the order a day of b-roll is actually
   shot in — or by scene or by person. The panel is for keeping track while
   writing; this is for planning the day and handing it over, with a CSV
   and a printable PDF from its header.

   It shows the same controls as the panel for what can be done on a sheet
   — the checkbox, the assignee, the note — with the same data-action names
   and classes, wired by the same wireBrollRoot(): an edit here is exactly
   the edit the panel makes, with the same undo. The filter is the panel's
   (one question, "what am I looking at", asked in two places); the page's
   grouping is its own, since it defaults differently.

   It covers the whole screen, so it closes the side panels through
   closeAllSidePanels() (HANDOFF invariant #16) — the b-roll panel, which
   is where the page is opened from, comes back when it closes if it was
   open — and owns the focus while it is up (invariant #19): Escape or
   "← Script" closes it and gives the focus back to what opened it. */

var PAGE_GROUPS = [
  { id: "location", label: "Location" },
  { id: "scene",    label: "Scene" },
  { id: "person",   label: "Person" }
];

var pageView = { group: "location" };
var pageReturnFocus = null;
var pagePanelWasOpen = false;

function loadPageView(saved) {
  pageView.group = oneOf(PAGE_GROUPS, saved.pageGroup, pageView.group);
}

function pageViewToSave() {
  return { pageGroup: pageView.group };
}

function brollPageEl() {
  return document.getElementById("broll-page");
}

export function brollPageOpen() {
  var page = brollPageEl();
  return !!page && !page.hidden;
}

export function openBrollPage() {
  var page = brollPageEl();
  if (!page || !S.state) return;
  pageReturnFocus = document.activeElement;
  var panel = document.getElementById("broll-panel");
  pagePanelWasOpen = !!panel && !panel.hidden;
  groupMenuOpen = false;
  menuFor = null;
  closeAllSidePanels();
  page.hidden = false;
  document.body.classList.add("broll-page-open");
  renderBrollPage();
  var back = document.getElementById("broll-page-close");
  if (back) back.focus();
}

/* `andThen` runs once the page is gone and before the focus goes back: a
   jump to a scene, which wants the focus in the script instead. */
export function closeBrollPage(andThen) {
  var page = brollPageEl();
  if (!page || page.hidden) return;
  page.hidden = true;
  document.body.classList.remove("broll-page-open");
  if (pagePanelWasOpen) openBrollPanel();
  if (andThen) { andThen(); return; }
  var back = pageReturnFocus;
  pageReturnFocus = null;
  if (back && document.body.contains(back) && back.offsetParent !== null) back.focus();
  else {
    var btn = document.getElementById(pagePanelWasOpen ? "broll-open-page" : "btn-broll");
    if (btn) btn.focus();
  }
}

function pageSummaryText(entries) {
  var n = filterCounts(entries);
  return n.shot + " of " + n.all + " shot" + (n.flagged ? " · " + n.flagged + " flagged" : "");
}

function pageGroupHeadHtml(g) {
  var done = g.items.filter(function (e) { return e.status === "shot"; }).length;
  var title;
  if (g.kind === "location") {
    title = (g.none ? '' : '<span class="broll-loc-pin" style="--loc:' + catColor("location") + '">' + brollIcon("pin", 15) + '</span>') +
      '<span class="broll-page-group-name">' + escapeHtml(g.label) + '</span>';
  } else if (g.kind === "scene") {
    title = '<span class="broll-page-group-scene">' + escapeHtml(g.label) + '</span>';
  } else if (g.kind === "added") {
    title = '<span class="broll-page-group-name">' + escapeHtml(g.label) + '</span>';
  } else {
    var who = g.none ? null : personById(g.items[0].owner);
    title = (who ? avatarHtml(who) : '') + '<span class="broll-page-group-name">' + escapeHtml(g.label) + '</span>';
  }
  return '<tr class="broll-page-group"><th colspan="7" scope="rowgroup"><span class="broll-page-group-in">' + title +
    '<span class="broll-page-group-count' + (done === g.items.length ? ' is-done' : '') + '">' +
    done + '/' + g.items.length + ' shot</span></span></th></tr>';
}

function pageRowHtml(e) {
  var id = escapeHtml(e.id);
  var ro = reviewMode();
  var props = e.props.map(function (p) { return p.name; }).join(", ");
  return '<tr class="broll-page-row' + (e.status === "shot" ? ' is-shot' : '') + (e.reshoot ? ' is-flagged' : '') +
      '" data-id="' + id + '">' +
    '<td class="broll-page-c-check">' + checkHtml(e) + '</td>' +
    '<td class="broll-page-c-shot" data-label="Shot"><span class="broll-row-name" title="' + escapeHtml(e.name || "Untitled shot") + '">' +
      escapeHtml(e.name || "Untitled shot") + '</span>' + rowStateIconsHtml(Object.assign({}, e, { notes: "", reshoot: false })) + '</td>' +
    '<td class="broll-page-c-scene" data-label="Scene">' + (e.rowId
      ? '<button type="button" class="broll-page-scene" data-action="broll-page-jump" data-id="' + id + '" title="Go to scene ' +
          sceneLabel(e) + '">' + sceneLabel(e) + '</button>'
      : '<span class="broll-muted" title="' + (e.orphaned ? 'No longer in the script' : 'Added here') + '">—</span>') + '</td>' +
    '<td class="broll-page-c-props" data-label="Props" style="--prop:' + catColor("prop") + '">' +
      (props ? '<span class="broll-page-ellipsis" title="' + escapeHtml(propListTitle(e)) + '">' + propListHtml(e) + '</span>' : '<span class="broll-muted">—</span>') + '</td>' +
    '<td class="broll-page-c-cuts" data-label="Cuts against">' +
      (e.audioRef ? '<span class="broll-page-ellipsis broll-page-cuts" title="' + escapeHtml(e.audioRef) + '">' + escapeHtml(e.audioRef) + '</span>' : '<span class="broll-muted">—</span>') + '</td>' +
    '<td class="broll-page-c-owner" data-label="Assigned">' +
      '<select class="broll-owner-select broll-page-owner" data-id="' + id + '" aria-label="' + escapeHtml("Assigned to, " + (e.name || "Untitled shot")) + '"' + (ro ? ' disabled' : '') + '>' +
        '<option value=""' + (e.owner ? '' : ' selected') + '>Unassigned</option>' +
        S.state.people.map(function (p) {
          return '<option value="' + escapeHtml(p.id) + '"' + (p.id === e.owner ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
        }).join("") +
      '</select></td>' +
    '<td class="broll-page-c-note" data-label="Note">' +
      (e.reshoot ? '<span class="broll-flag-ico" title="Flagged" aria-label="Flagged">' + brollIcon("flag", 14) + '</span>' : '') +
      '<input type="text" class="broll-notes-input broll-page-note" data-id="' + id + '" maxlength="2000" ' +
        (ro ? 'readonly ' : 'placeholder="Add a note" ') +
        'aria-label="' + escapeHtml("Note, " + (e.name || "Untitled shot")) + '" value="' + escapeHtml(e.notes) + '"></td>' +
  '</tr>';
}

export function renderBrollPage() {
  var page = brollPageEl();
  if (!page || page.hidden || !S.state) return;
  dropEditingForReview();
  var entries = brollEntries();
  var shown = entries.filter(function (e) { return matchesFilter(e, view.filter); });
  keepingFocus(page, function () {
    document.getElementById("broll-page-summary").textContent = pageSummaryText(entries);
    var sel = document.getElementById("broll-page-group");
    if (sel) sel.value = pageView.group;
    document.getElementById("broll-page-filters").innerHTML = filterChipsHtml(entries);
    document.getElementById("broll-page-table").innerHTML = shown.length
      ? '<table class="broll-page-table">' +
          '<colgroup><col class="broll-page-w-check"><col class="broll-page-w-shot"><col class="broll-page-w-scene">' +
          '<col class="broll-page-w-props"><col class="broll-page-w-cuts"><col class="broll-page-w-owner"><col class="broll-page-w-note"></colgroup>' +
          '<thead><tr><th scope="col"><span class="broll-sr">Shot or to shoot</span></th><th scope="col">Shot</th><th scope="col">Scene</th>' +
            '<th scope="col">Props</th><th scope="col">Cuts against</th><th scope="col">Assigned</th><th scope="col">Note</th></tr></thead>' +
          brollGroups(shown, pageView.group).map(function (g) {
            return '<tbody>' + pageGroupHeadHtml(g) + g.items.map(pageRowHtml).join("") + '</tbody>';
          }).join("") +
        '</table>'
      : emptyListHtml(entries);
  });
}

/* ---- the sheet, as files: a CSV, and a PDF to print ---- */

export function shotRecordForFile(e) {
  var who = personById(e.owner);
  return {
    scene: e.rowId ? sceneLabel(e) : "",
    name: e.name || "Untitled shot",
    status: e.status === "shot" ? "Shot" : "To shoot",
    shot: e.status === "shot",
    flagged: !!e.reshoot,
    location: e.location || "",
    props: e.props.map(function (p) { return p.name; }),
    /* for the printed sheet: "Kettle (sourcing)" */
    propsWithStatus: e.props.map(function (p) {
      var st = tagStatus(p.status);
      return p.name + (st ? " (" + st.label.toLowerCase() + ")" : "");
    }),
    cuts: e.audioRef || "",
    owner: who ? who.name : "",
    note: e.notes || "",
    desc: e.desc || ""
  };
}

/* One row per shot — every shot, in script order, whatever the page is
   filtered to: a spreadsheet filters and sorts itself. Read without
   writing anything (brollEntries(true)), since building a file must not
   be what adds a shot to the list. */
export function buildBrollCsv() {
  var head = ["Scene", "Shot", "Status", "Flagged", "Location", "Props", "Cuts against", "Assigned to", "Note", "Description"];
  var lines = [head.join(",")];
  brollSortedForList(brollEntries(true)).forEach(function (e) {
    var r = shotRecordForFile(e);
    lines.push([r.scene, r.name, r.status, r.flagged ? "yes" : "", r.location, r.props.join("; "),
                r.cuts, r.owner, r.note, r.desc].map(csvEscape).join(","));
  });
  if (lines.length === 1) lines.push(csvEscape("(no b-roll yet)"));
  return "﻿" + lines.join("\r\n");
}

/* What the printed sheet shows: the page as it is — its filter and its
   grouping — so what is printed is what was being looked at. */
export function brollShotListForPrint() {
  var entries = brollEntries(true);
  var shown = entries.filter(function (e) { return matchesFilter(e, view.filter); });
  var filter = FILTERS.filter(function (f) { return f.id === view.filter; })[0];
  var group = PAGE_GROUPS.filter(function (g) { return g.id === pageView.group; })[0];
  return {
    title: S.state.title || "Untitled Script",
    summary: pageSummaryText(entries),
    scope: (filter && filter.id !== "all" ? filter.label + ", " : "") + "by " + group.label.toLowerCase(),
    groups: brollGroups(shown, pageView.group).map(function (g) {
      return {
        label: g.label,
        done: g.items.filter(function (e) { return e.status === "shot"; }).length,
        total: g.items.length,
        items: g.items.map(shotRecordForFile)
      };
    })
  };
}

function onBrollPageAction(action, btn) {
  if (action === "broll-open-page") openBrollPage();
  else if (action === "broll-page-close") closeBrollPage();
  else if (action === "broll-page-jump") {
    var id = btn.getAttribute("data-id");
    closeBrollPage(function () { jumpToBrollShot(id); });
  } else if (action === "broll-page-csv") exportAs("b-roll csv");
  else if (action === "broll-page-print") {
    if (!brollEntries(true).length) { showToast("There is no b-roll to print yet.", "warn"); return; }
    exportAs("b-roll pdf");
  }
}

function wireBrollPage() {
  var page = brollPageEl();
  if (!page) return;
  wireBrollRoot(page);
  /* the grouping is a real <select>: its change is the page's own */
  page.addEventListener("change", function (e) {
    if (e.target.id !== "broll-page-group") return;
    pageView.group = oneOf(PAGE_GROUPS, e.target.value, "location");
    saveView();
    renderBrollPage();
  });
  /* A note typed in the sheet goes in on Enter, like leaving the box. */
  page.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("broll-page-note")) {
      e.preventDefault();
      e.target.blur();
    }
  });
  /* Escape that nothing inside the page took (a menu, a field being
     edited, a selection) closes it. */
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !brollPageOpen() || e.defaultPrevented) return;
    if (document.querySelector(".modal-backdrop:not([hidden])")) return;
    e.preventDefault();
    closeBrollPage();
  });
  /* It owns the focus while it is up: anything that would take the focus
     behind it — a Tab past its last control, a stray click — brings it
     back, except a dialog or a toast opened over it. */
  document.addEventListener("focusin", function (e) {
    if (!brollPageOpen()) return;
    var el = e.target;
    if (!el || !el.closest || el.closest("#broll-page")) return;
    if (el.closest(".modal-backdrop:not([hidden]), .toast")) return;
    var back = document.getElementById("broll-page-close");
    if (back) back.focus();
  });
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  loadView();
  /* For the browser suites: the view as remembered, and the selection. */
  window.__brollTest = {
    view: function () { return JSON.parse(JSON.stringify(Object.assign({}, view, pageViewToSave()))); },
    selected: function () { return Object.keys(selection); },
    csv: buildBrollCsv,
    printData: brollShotListForPrint
  };
}
