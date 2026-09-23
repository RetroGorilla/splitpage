import { S } from "./_state.js";
import { escapeHtml, makeId } from "./02-state.js";
import { findRowIndex } from "./03-sync.js";
import {
  ensureTrailingCaretSpot,
  inertBody,
  plainText,
  sanitizeHtml
} from "./04-richtext.js";
import {
  cellOf,
  deleteRange,
  insertBrollKey,
  insertText,
  projection,
  replaceWithBrollKey,
  tagNameOf,
  toHtml
} from "./04c-doc-model.js";
import { render } from "./05-render.js";
import { domToPos, editCell } from "./05b-cell-edit.js";
import {
  TAG_STATUSES,
  contentMemo,
  isInsideTagOrLink,
  isTagId,
  normalizeTagName,
  registerProductionTag,
  registryEntry,
  scheduleIdleRefresh,
  tagStatus,
  tagsInField
} from "./07-production-tags.js";
import { renderBrollViews } from "./08d-broll-panel.js";
import { markDirty } from "./12-dirty-toast.js";
import { htmlToPlainText } from "./14-export.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
var brollInField;       /* built on first use: see brollField() */
var brollPropsInField;  /* the same */
var brollAnchorDeclined;

/* ================= the b-roll list =================

   A separate system from production tags, deliberately. A tag wraps words
   inside a sentence and is identified BY those words, so two mentions of
   "gaffer tape" are one item. B-roll is the opposite on both counts: it
   owns a whole block rather than a phrase, and two identical shots really
   are two shots to go and get. Sharing TAG_CATEGORIES would have meant
   bending both of those rules, plus running a second status vocabulary
   through a breakdown sheet whose Status column has to mean one thing.

   What the script holds is only the marker — a "B-roll:" starting a line
   in a visual cell. Everything a shooter needs that the script can't
   carry (shot or not, a reshoot note, who's getting it, the line of audio
   it cuts against, where it is) lives on a record in state.brollShots,
   tied to the marker by an id the marker carries. */

export var BROLL_STATUSES = [
  /* "To shoot" rather than "Not shot" (#148): it is a list of work to do,
     and the word says what is left rather than what is missing. The id is
     unchanged, so every file keeps reading. */
  { id: "unshot", label: "To shoot", color: "var(--text-dim)" },
  /* The same word scenes already use for their own status, on purpose: a
     scene being Shot and a B-roll item being Shot are differently sized
     claims, but "shot" is the word anyone on a set actually says. */
  { id: "shot",   label: "Shot",     color: "var(--ok)" }
];

export function brollStatus(id) {
  for (var i = 0; i < BROLL_STATUSES.length; i++) {
    if (BROLL_STATUSES[i].id === id) return BROLL_STATUSES[i];
  }
  return null;
}

/* Every spelling anybody actually types, closed by a colon, hyphen, en or
   em dash. Anchored: a marker has to START its line, so "cut to B-roll:
   the bin" mid-sentence is prose and stays prose. */
export var BROLL_MARKER_RE = /^[ \t]*(b[ \t]?-?[ \t]?roll)[ \t]*([:—–-])[ \t]*/i;
var BROLL_CLOSERS = ":—–-";

export var BROLL_NAME_MAX = 200;
export var BROLL_TEXT_MAX = 2000;
/* A shot's hand-added props (#149): as long as a registry name may be, and
   more of them than any one shot has ever needed — a cap only so a hostile
   or broken file cannot hand the panel ten thousand chips. */
var BROLL_PROP_NAME_MAX = 80;
export var BROLL_PROPS_MAX = 40;

/* ---- reading the markers back out of the script ----

   A line is what sits between two line breaks. A marker line opens an
   item; every line after it belongs to that item until the next marker or
   the end of the cell. The first line is the item's name — what the list
   and the printed sheet show — and the rest is its description.

   Read from the cell's model (cellOf, 04c-doc-model.js, #85 step 3), never
   by parsing the HTML: the cell's parse is cached by its HTML and shared
   with every other reader of it. A line is a list of pieces — {text,
   marks} and the b-roll key's atom {atom, text, marks} — each with `pos`,
   its offset in the cell's projection, and the line has `start` and `end`
   (its own line break not included), for the edits below.

   What the model reads differently from the HTML walk this replaced, on
   purpose and like every other reader of it (readers.test.mjs): a line
   feed inside a text node is the space it shows as, and a zero-width space
   is nothing. And on two shapes no version of the app writes — a key
   inside a tag span, or after an empty formatting element — the key is
   read as the key it is rather than as a marker to match by name
   (broll-model.test.mjs has the comparison). */
function brollCellLines(cell) {
  var lines = [{ start: 0, end: 0, items: [] }];
  var pos = 0;
  cell.forEach(function (r) {
    if (r.atom) {
      lines[lines.length - 1].items.push({ atom: r, text: r.text, marks: r.marks, pos: pos });
      pos++;
      return;
    }
    r.text.split("\n").forEach(function (part, i) {
      if (i > 0) {
        lines[lines.length - 1].end = pos;
        pos++;
        lines.push({ start: pos, end: pos, items: [] });
      }
      if (part) {
        lines[lines.length - 1].items.push({ text: part, marks: r.marks, pos: pos });
        pos += part.length;
      }
    });
  });
  lines[lines.length - 1].end = pos;
  return lines;
}

function brollLineText(items) {
  return items.map(function (it) { return it.text; }).join("");
}

function hasNoMarks(marks) {
  return !marks || !Object.keys(marks).length;
}

/* Is this line a marker, and if so what opens it? Returns the key when
   the marker has already been made one (and therefore carries an id), or
   a plain text match when it hasn't — a line written before this
   existed, pasted in, or round-tripped through Markdown, which drops the
   span and leaves the words behind. Those still count: they are matched
   back to their record by name until an edit gives them an id.

   A key counts only where it starts its line with nothing around it —
   only blank, unformatted text before it, and no formatting, link or
   comment of its own. That is the shape typing and the anchoring pass
   both give one; a key inside <strong> or a comment is read by its words,
   as a marker to match by name, and the anchoring pass then puts a key of
   the right shape in its place. */
function brollLineMarker(items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it.atom && hasNoMarks(it.marks) && !it.text.trim()) continue;
    if (it.atom && hasNoMarks(it.marks)) return { id: it.atom.id || "", key: it, rest: items.slice(i + 1) };
    break;
  }
  var m = BROLL_MARKER_RE.exec(brollLineText(items));
  return m ? { id: "", key: null, rest: null, strip: m[0].length } : null;
}

/* Every marker in one cell, in order, as {id, name, desc}. Pure, and
   exported for the tests: the app reads it through brollInField, cached
   by the field's HTML. */
export function brollInCell(cell) {
  var out = [], open = null;
  brollCellLines(cell).forEach(function (line) {
    var marker = brollLineMarker(line.items);
    if (marker) {
      var name = marker.rest
        ? brollLineText(marker.rest)
        : brollLineText(line.items).slice(marker.strip);
      open = { id: marker.id, name: name.trim().slice(0, BROLL_NAME_MAX), desc: [] };
      out.push(open);
      return;
    }
    if (open) open.desc.push(brollLineText(line.items));
  });
  out.forEach(function (item) {
    item.desc = item.desc.join("\n").replace(/\s+$/, "").slice(0, BROLL_TEXT_MAX);
  });
  return out;
}

/* The props each marker in a cell needs, read off the script (#149): every
   prop tag on the item's own lines — its "B-roll:" line and the lines of
   description under it, up to the next marker — in the order they appear,
   one per name. One array per item, in brollInCell's order, so the two
   line up by index. A separate reader rather than a field on brollInCell's
   items: that one is pinned against the old HTML reader shape for shape
   (broll-model.test.mjs), and nothing about which words a line holds
   changes with the tags on them. Read from the model like everything else
   here: a tag is its mark, named "t:<cat>:<name>" by cellOf. */
export function brollPropsInCell(cell) {
  var out = [], open = null, seen = null;
  brollCellLines(cell).forEach(function (line) {
    if (brollLineMarker(line.items)) {
      open = [];
      seen = Object.create(null);
      out.push(open);
    }
    if (!open) return;
    line.items.forEach(function (it) {
      var t = !it.atom && it.marks && it.marks.tag ? tagNameOf(it.marks.tag) : null;
      if (!t || t.cat !== "prop") return;
      var name = t.name.trim().slice(0, BROLL_PROP_NAME_MAX);
      var key = normalizeTagName(name);
      if (!name || seen[key]) return;
      seen[key] = true;
      open.push(name);
    });
  });
  return out;
}

/* The marker lines of a cell, in order: the line (its index among all of
   the cell's lines too) and its marker. An item's ordinal is its place in
   this list, which is how the rename and the anchoring pass below find the
   line an item was read from. */
function brollMarkerLines(cell) {
  var out = [];
  brollCellLines(cell).forEach(function (line, index) {
    var marker = brollLineMarker(line.items);
    if (marker) out.push({ line: line, index: index, marker: marker });
  });
  return out;
}

/* A cell still holding a picture or a video card (pasted before design D7
   kept them out of script text; the load-time move empties them) is not
   written through the model, which has no place for either — writing it
   back would delete them. The rename and the anchoring pass edit such a
   cell's HTML instead, on the same line the model found: a <br> is a line
   break to both, so the model's nth line is the nth line of the HTML once
   every <br> is a child of the field itself. */
function holdsMedia(html) {
  return /<img[\s>]|video-embed-card/i.test(html || "");
}

/* The field's lines as the HTML has them, for that exception only:
   {nodes, br} — the field's own children between two <br>s. */
function brollHtmlLines(body) {
  hoistNestedBrs(body);
  var kids = Array.prototype.slice.call(body.childNodes);
  var lines = [], start = 0;
  kids.forEach(function (n, i) {
    if (n.nodeType === 1 && n.tagName === "BR") {
      lines.push({ nodes: kids.slice(start, i), br: n });
      start = i + 1;
    }
  });
  lines.push({ nodes: kids.slice(start), br: null });
  return lines;
}

/* A <br> is not always a child of the field: a real Enter pressed while
   the caret is still inside a run of bold (or italic, underline…) leaves
   the browser's own <br> a CHILD of that formatting element. Splitting the
   formatting element in two around the <br> — the same shape a plain Enter
   with no formatting active already produces — makes every <br> a child
   of the field, so its children split into lines. Runs on the disposable
   body inertBody() just parsed, so mutating it in place costs nothing and
   touches nothing live. */
function hoistNestedBrs(body) {
  var guard = 0;
  while (guard++ < 1000) {
    var brs = body.getElementsByTagName("br");
    var br = null;
    for (var i = 0; i < brs.length; i++) {
      if (brs[i].parentNode !== body) { br = brs[i]; break; }
    }
    if (!br) return;
    var parent = br.parentNode;
    var grand = parent.parentNode;
    if (!grand) return;
    var tail = parent.cloneNode(false); // same tag AND attributes, no children
    while (br.nextSibling) tail.appendChild(br.nextSibling);
    parent.removeChild(br);
    var ref = parent.nextSibling;
    grand.insertBefore(br, ref);
    if (tail.childNodes.length) grand.insertBefore(tail, ref);
  }
}

function brollHtmlLineText(nodes) {
  return nodes.map(function (n) { return n.textContent || ""; }).join("");
}

/* Visual cells only — the audio column is what gets read aloud, and a
   shot list has no business in it.

   A key is one shot, so its id is one line's. A second key carrying an id
   an earlier line (in document order) already has — a copy pasted by a
   version of the app from before a paste gave it an id of its own
   (05c-clipboard.js), or two copies of a document merged into one — is
   read as the unanchored marker it has in effect become: matched by name,
   never walking off with the first line's record, and given an id of its
   own by the anchoring pass below. */
function collectBrollFromRows(rows) {
  var out = [];
  var seen = Object.create(null);
  (rows || []).forEach(function (row, rowIndex) {
    var props = brollPropsField(row.visualText);
    brollField(row.visualText).forEach(function (found, ordinal) {
      var id = found.id && !seen[found.id] ? found.id : "";
      if (id) seen[id] = true;
      out.push({
        id: id, name: found.name, desc: found.desc,
        rowId: row.id, rowIndex: rowIndex, ordinal: ordinal,
        autoProps: props[ordinal] || []
      });
    });
  });
  return out;
}

/* The two memoised readers: what brollInCell and brollPropsInCell say
   about one field. SHARED with every other caller for the same field
   content — read it, never mutate it. Same contract, and the same reason,
   as tagsInField. Keyed on the field's HTML, so typing in one field
   re-reads only that one, and its parse is cellOf's, shared with the other
   readers. Built the first time they are asked for rather than in
   __init(): an export that lists shots (breakdownRows, #149) runs in the
   unit tests with no __init() behind it, which is also why tagsInField is
   built where it is declared (07-production-tags.js). */
function brollField(html) {
  if (!brollInField) brollInField = contentMemo(function (h) { return brollInCell(cellOf(h)); });
  return brollInField(html);
}

function brollPropsField(html) {
  if (!brollPropsInField) brollPropsInField = contentMemo(function (h) { return brollPropsInCell(cellOf(h)); });
  return brollPropsInField(html);
}

function brollRow(rowId) {
  var i = rowId ? findRowIndex(rowId) : -1;
  return i === -1 ? null : S.state.rows[i];
}

/* ---- what a new item inherits from the scene it was written in ----

   Both of these are seeded ONCE, here, and are the item's own from then
   on. Rewriting the scene's audio later doesn't reach back into a
   reference somebody has since corrected, and a shot that gets moved to
   another location doesn't snap back to the scene's tag every time the
   list re-reads the script. The cost is that a seeded reference can go
   stale; that is the trade that makes it editable at all. */
function brollSeedRef(row) {
  return row ? htmlToPlainText(row.audioText).trim().slice(0, BROLL_TEXT_MAX) : "";
}

function brollSeedLocation(row) {
  if (!row) return "";
  var found = "";
  ["visualText", "audioText"].forEach(function (field) {
    tagsInField(row[field]).forEach(function (t) {
      if (!found && t.catId === "location") found = t.name;
    });
  });
  return found.slice(0, 80);
}

/* ---- the registry ---- */

export function brollRecord(id) {
  if (!id) return null;
  for (var i = 0; i < S.state.brollShots.length; i++) {
    if (S.state.brollShots[i].id === id) return S.state.brollShots[i];
  }
  return null;
}

export function newBrollRecord(fields) {
  var rec = {
    id: makeId("bs"),
    name: "", desc: "",
    status: BROLL_STATUSES[0].id,
    reshoot: false,
    notes: "",
    owner: "",
    audioRef: "",
    location: "",
    /* The props added by hand (#149); the ones tagged on its lines are
       read off the script every time and never stored. */
    props: [],
    /* A "script" item can go orphaned when its line is deleted — that is
       a surprise worth flagging. One typed straight into the list never
       had a line to lose, so it just sits there as itself. */
    origin: "script"
  };
  Object.keys(fields || {}).forEach(function (k) { rec[k] = fields[k]; });
  S.state.brollShots.push(rec);
  return rec;
}

/* The records for the keys a paste or a drop has just put into a visual
   cell (05c-clipboard.js), made inside the paste's own edit — for the
   reason maybeCaptureBroll makes a typed key's there: made by the next
   read of the list, a record would be an undo entry of its own, and the
   first Ctrl+Z would take back a record nobody can see instead of the
   paste. `cell` is the cell as the paste leaves it and `ids` the pasted
   keys' ids; only a key that starts its line (a marker the list reads)
   gets one, and only when no record has its id already — a cut moved
   here keeps the record it had.

   A new record is a new shot, seeded from the scene it landed in exactly
   as a typed one is, and none of the copied line's own status, notes,
   owner or location: see freshBrollIds (05c-clipboard.js). */
export function recordPastedBroll(rowId, cell, ids) {
  if (!S.state || !ids || !ids.length) return;
  var row = brollRow(rowId);
  brollInCell(cell).forEach(function (found) {
    if (!found.id || ids.indexOf(found.id) === -1 || brollRecord(found.id)) return;
    newBrollRecord({
      id: found.id, name: found.name, desc: found.desc,
      audioRef: brollSeedRef(row), location: brollSeedLocation(row)
    });
  });
}

export function deleteBrollRecord(id) {
  var before = S.state.brollShots.length;
  S.state.brollShots = S.state.brollShots.filter(function (r) { return r.id !== id; });
  return before !== S.state.brollShots.length;
}

/* Every tracked shot, reconciled against what the script says right now.

   Matching is by id first — that is what makes renaming a marker keep its
   status and notes, and what keeps two identical lines two items. A
   marker with no id (see brollLineMarker) falls back to matching an
   unclaimed record by name, so a Markdown round-trip recovers the item
   rather than orphaning it and minting a duplicate beside it. */
/* The id-then-name question asked of one marker, pulled out so the
   anchoring pass below can ask it in exactly the same order and get
   exactly the same answer. `claimed` is the caller's running note of
   which records are already spoken for; this only reads it. `held` is
   every id a key in the script carries (brollHeldIds): a name match never
   takes a record some line further down still holds by its key, or that
   line would find its own record gone and mint a second one with the
   same id. */
function brollMatchRecord(found, claimed, byId, held) {
  var rec = found.id ? byId[found.id] : null;
  if (rec && !claimed[rec.id]) return rec;
  var norm = normalizeTagName(found.name);
  for (var i = 0; i < S.state.brollShots.length && norm; i++) {
    var cand = S.state.brollShots[i];
    if (claimed[cand.id] || held[cand.id]) continue;
    if (normalizeTagName(cand.name) !== norm) continue;
    return cand;
  }
  return null;
}

function brollHeldIds(live) {
  var held = Object.create(null);
  live.forEach(function (found) { if (found.id) held[found.id] = true; });
  return held;
}

/* `readOnly` (#149) is for an export that lists shots — the breakdown's
   B-roll column, the packing list: the same answer, with nothing written.
   A line with no record yet gets a stand-in shaped like the one the panel
   would make, and no record's words are refreshed; saving a file must not
   be what adds a shot to the list. */
export function brollEntries(readOnly) {
  var live = collectBrollFromRows(S.state.rows);
  var claimed = Object.create(null);
  var byId = Object.create(null);
  var held = brollHeldIds(live);
  S.state.brollShots.forEach(function (r) { byId[r.id] = r; });
  var out = [];

  live.forEach(function (found) {
    var rec = brollMatchRecord(found, claimed, byId, held);
    if (!rec) {
      var row = brollRow(found.rowId);
      var fields = {
        id: found.id || makeId("bs"),
        name: found.name,
        desc: found.desc,
        audioRef: brollSeedRef(row),
        location: brollSeedLocation(row)
      };
      rec = readOnly ? Object.assign({ status: BROLL_STATUSES[0].id, props: [], origin: "script" }, fields)
        : newBrollRecord(fields);
    }
    claimed[rec.id] = true;
    /* While a marker is live the script owns the words; the record keeps
       its own copy only so the item still reads like something once the
       line is gone. */
    if (!readOnly) {
      rec.name = found.name;
      rec.desc = found.desc;
    }
    out.push(brollEntryFrom(rec, found));
  });

  S.state.brollShots.forEach(function (rec) {
    if (!claimed[rec.id]) out.push(brollEntryFrom(rec, null));
  });

  return out;
}

function brollEntryFrom(rec, found) {
  return {
    rec: rec,
    id: rec.id,
    name: found ? found.name : rec.name,
    desc: found ? found.desc : (rec.desc || ""),
    rowId: found ? found.rowId : null,
    rowIndex: found ? found.rowIndex : -1,
    ordinal: found ? found.ordinal : -1,
    markerless: !!found && !found.id,
    orphaned: !found && rec.origin === "script",
    status: brollStatus(rec.status) ? rec.status : BROLL_STATUSES[0].id,
    reshoot: !!rec.reshoot,
    notes: rec.notes || "",
    owner: rec.owner || "",
    audioRef: rec.audioRef || "",
    location: rec.location || "",
    props: brollEntryProps(rec, found),
    origin: rec.origin
  };
}

/* ---- the props a shot needs (#149) ----

   Two sources, one list. A prop tagged on the shot's own lines counts by
   itself (brollPropsInCell) — the script already says so, and saying it
   again on the record would be a second copy to fall out of step. One the
   script does not mention is added by hand in the shot's detail, and that
   one IS stored: `props` on the record, [{id, name}].

   `id` is the production registry entry's id (07-production-tags.js), the
   one thing about a tag that survives a rename — so renaming the prop in
   the breakdown carries through with nothing to update (renameTag keeps an
   entry's id; the one rename that does not, folding onto another entry's
   name, re-points these through brollPropsRenamed). `name` is kept beside
   it as the fallback: an entry deleted from the breakdown, or folded away
   by a merge, still reads as the prop it was, and a record from a file
   whose registry never had it still says what it asked for. migrateRows
   refreshes `name` from the entry whenever the id resolves. */

/* Normalises a stored `props` list: garbage tolerated rather than thrown
   on, a bare string read as a name, an id kept only if it is a registry id,
   an unknown name kept (the registry may gain it in a merge, and the shot
   still needs it either way), duplicates by id — or by name for one with
   no id — dropped, and the list capped. Pure: `registry` is the document's
   productionTags, passed in so migrateRows can hand over the one it has
   just normalised. */
export function normalizeBrollProps(list, registry) {
  var byId = Object.create(null), byName = Object.create(null);
  (registry || []).forEach(function (t) {
    if (!t || !t.id || !t.name) return;
    byId[t.id] = t;
    if (t.cat === "prop" && !byName[normalizeTagName(t.name)]) byName[normalizeTagName(t.name)] = t;
  });
  var out = [], seen = Object.create(null);
  (Array.isArray(list) ? list : []).forEach(function (p) {
    if (out.length >= BROLL_PROPS_MAX) return;
    if (typeof p === "string") p = { name: p };
    if (!p || typeof p !== "object") return;
    var id = isTagId(p.id) ? p.id : "";
    var name = typeof p.name === "string" || typeof p.name === "number" ? plainText(p.name).trim() : "";
    /* one known only by name takes the id of the prop of that name, so it
       and a copy that has the id are one prop, not two */
    if (!id && name && byName[normalizeTagName(name)]) id = byName[normalizeTagName(name)].id;
    if (id && byId[id]) name = byId[id].name;
    name = name.slice(0, BROLL_PROP_NAME_MAX);
    if (!name) return;
    var key = brollPropKey(id, name);
    if (seen[key]) return;
    seen[key] = true;
    out.push({ id: id, name: name });
  });
  return out;
}

/* What identifies one prop in a shot's list — the registry id, or the name
   for one with none. The merge (mergeBrollShots, 03-sync.js) keys by this
   too. */
export function brollPropKey(id, name) {
  return id ? id : "n:" + normalizeTagName(name);
}

/* The registry entry a hand-added prop names: by id first, then by name
   among the props, so a prop re-added after being deleted from the
   breakdown (a new entry, maybe a new id) finds its entry again. */
function brollPropEntry(p) {
  if (!S.state) return null;
  if (p.id) {
    for (var i = 0; i < S.state.productionTags.length; i++) {
      if (S.state.productionTags[i].id === p.id) return S.state.productionTags[i];
    }
  }
  return registryEntry("prop", p.name);
}

/* Every prop a shot needs, as the panel, the full page and the exports
   show it: {key, id, name, status, auto, hand, tracked}. The script's own
   first, in the order its lines name them, then the hand-added ones it
   does not already name. `auto` ones are removed by editing the script;
   `hand` ones from the shot. `tracked` is false for a hand-added prop the
   breakdown no longer has — it shows by its stored name, with no status. */
function brollEntryProps(rec, found) {
  var out = [], byKey = Object.create(null);
  /* `ref` is the stored key of a hand-added one — what removeBrollProp
     takes — and "" for one the script names */
  function add(entry, name, ref) {
    var shown = entry ? entry.name : name;
    var key = entry ? "t:" + entry.id : "n:" + normalizeTagName(shown);
    var had = byKey[key];
    if (had) {
      if (ref) { had.hand = true; had.ref = had.ref || ref; } else had.auto = true;
      return;
    }
    byKey[key] = {
      key: key, id: entry ? entry.id : "", name: shown,
      status: entry ? (tagStatus(entry.status) || TAG_STATUSES[0]).id : "",
      auto: !ref, hand: !!ref, tracked: !!entry, ref: ref
    };
    out.push(byKey[key]);
  }
  ((found && found.autoProps) || []).forEach(function (name) {
    add(registryEntry("prop", name), name, "");
  });
  (rec.props || []).forEach(function (p) {
    if (p && p.name) add(brollPropEntry(p), p.name, brollPropKey(p.id, p.name));
  });
  return out;
}

/* Hand-adds a prop to a shot by name: the breakdown's own entry when it has
   one (any spelling of the name), or a new Prop entry in the registry the
   way the Gear box adds a line nobody has tagged (applyGearQuickAdd,
   08-production-panels.js) — tracked, with no mention in the script, until
   somebody tags it or deletes it. Returns true when the shot changed. */
export function addBrollProp(shotId, rawName) {
  var rec = brollRecord(shotId);
  var name = plainText(rawName).trim().slice(0, BROLL_PROP_NAME_MAX);
  if (!rec || !name) return false;
  var entry = registryEntry("prop", name);
  if (!entry) {
    registerProductionTag("prop", name);
    entry = registryEntry("prop", name);
  }
  if (!entry) return false;
  rec.props = normalizeBrollProps(rec.props, S.state.productionTags);
  var key = brollPropKey(entry.id, entry.name);
  var already = rec.props.some(function (p) {
    return brollPropKey(p.id, p.name) === key || (!p.id && normalizeTagName(p.name) === normalizeTagName(entry.name));
  });
  if (already || rec.props.length >= BROLL_PROPS_MAX) return false;
  rec.props.push({ id: entry.id, name: entry.name });
  return true;
}

/* Takes a hand-added prop back off a shot, by the key brollEntryProps gave
   it (`ref`). The breakdown keeps the entry: whether the prop is still
   wanted at all is the breakdown's question, not this shot's. */
export function removeBrollProp(shotId, ref) {
  var rec = brollRecord(shotId);
  if (!rec || !ref || !Array.isArray(rec.props)) return false;
  var before = rec.props.length;
  rec.props = rec.props.filter(function (p) { return brollPropKey(p.id, p.name) !== ref; });
  return rec.props.length !== before;
}

/* A registry entry renamed (renameTag, 07-production-tags.js): the shots
   naming it by id follow it with nothing to do, but their stored names are
   brought up to date so the fallback stays true, and a rename that folded
   the entry into another one (its id gone) re-points them at the survivor.
   A prop stored by name alone that matched the old name moves too (the
   caller passes the old name only for a Prop). Part of the rename's own
   edit, so one undo takes both back. */
export function brollPropsRenamed(fromId, oldName, toId, toName) {
  if (!S.state || !Array.isArray(S.state.brollShots)) return;
  var oldNorm = normalizeTagName(oldName);
  S.state.brollShots.forEach(function (rec) {
    if (!Array.isArray(rec.props) || !rec.props.length) return;
    var changed = false;
    rec.props.forEach(function (p) {
      if (!p) return;
      if ((fromId && p.id === fromId) || (oldNorm && !p.id && normalizeTagName(p.name) === oldNorm)) {
        p.id = toId || p.id;
        p.name = toName;
        changed = true;
      }
    });
    if (changed) rec.props = normalizeBrollProps(rec.props, S.state.productionTags);
  });
}

/* For the breakdown exports (breakdownRows, 08-production-panels.js): the
   b-roll shots that need each prop, by registry key — "prop <name>" —
   in list order. */
export function brollShotsByProp() {
  var out = Object.create(null);
  if (!S.state || !S.state.brollShots) return out;
  brollSortedForList(brollEntries(true)).forEach(function (e) {
    e.props.forEach(function (p) {
      var k = "prop " + normalizeTagName(p.name);
      if (!out[k]) out[k] = [];
      out[k].push(e.name || "Untitled shot");
    });
  });
  return out;
}

function brollUnshotCount() {
  if (!S.state || !S.state.brollShots) return 0;
  return brollEntries().filter(function (e) { return e.status !== "shot"; }).length;
}

/* ---- capturing a marker as it is typed ----

   Same shape as maybeAutoTagShortcut: only ever fires on live typing of
   the closing character, and goes in as an edit of the cell's model (#85,
   design §5), an undo entry of its own after the typing's, so one Ctrl+Z
   takes the marker back off and leaves the words "B-roll:" behind — the
   escape hatch for anyone who meant to write that literally. */
function brollAtLineStart(node) {
  /* A text node that begins the field, or that follows a <br>, IS the
     start of a line — bold, italic, underline and the rest are styling,
     not position, so a line can start INSIDE one of those same as in
     plain text. What is mid-line by definition is text after a tag or
     inside a link: isInsideTagOrLink() is the guard for that, checked
     separately by the caller, so this only has to walk up through plain
     inline formatting to find out whether anything with content sits
     before the caret. */
  if (node.nodeType !== 3) return false;
  var cell = node.parentNode && node.parentNode.closest
    ? node.parentNode.closest(".cell-editable") : null;
  if (!cell) return false;

  var n = node;
  while (true) {
    var prev = n.previousSibling;
    while (prev && prev.nodeType === 3 && !(prev.nodeValue || "").trim()) prev = prev.previousSibling;
    if (prev) return prev.nodeType === 1 && prev.tagName === "BR";
    var parent = n.parentNode;
    if (parent === cell) return true;
    if (!parent || parent.nodeType !== 1) return false;
    n = parent;
  }
}

export function maybeCaptureBroll(e, cellEl) {
  if (e.inputType !== "insertText" || !e.data) return;
  if (cellEl.getAttribute("data-field") !== "visualText") return;
  if (BROLL_CLOSERS.indexOf(e.data.charAt(e.data.length - 1)) === -1) return;
  var sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  var node = range.startContainer;
  var offset = range.startOffset;
  if (!brollAtLineStart(node)) return;
  if (isInsideTagOrLink(node.parentNode)) return;
  var head = node.data.slice(0, offset);
  var m = BROLL_MARKER_RE.exec(head);
  /* Everything typed on the line so far has to BE the marker; if there
     were words in front of it, this is prose that happens to end in a
     colon. */
  if (!m || m[0].length !== head.length) return;

  /* The words typed so far on the line — the caret's text node from its
     start, indentation and all — become the key, and the caret goes just
     after it, outside the contenteditable="false" span (inside it, every
     character of the shot's description would be typed into something that
     refuses to take it). The model has to read the same words there, or it
     is not used. */
  var id = makeId("bs"), keyText = m[1] + m[2];
  editCell(cellEl, function (cell) {
    var from = domToPos(cellEl, node, 0), to = domToPos(cellEl, node, offset);
    if (from === null || to === null) return null;
    if (projection(cell).slice(from, to) !== head.replace(/\u200B/g, "")) return null;
    var r = replaceWithBrollKey(cell, from, to, id, keyText);
    /* The shot's record, made here rather than left to the next read of
       the list (brollEntries makes it for any key it has no record for,
       with the same fields): made there, it would be an undo entry of its
       own after this one, and the first Ctrl+Z would take back a record
       nobody can see instead of the key. The name and description are the
       line's, filled in by that same read. */
    var row = brollRow(cellEl.getAttribute("data-id"));
    newBrollRecord({ id: id, audioRef: brollSeedRef(row), location: brollSeedLocation(row) });
    return { cell: r.cell, sel: { from: r.end, to: r.end } };
  });
  /* Not taken: the model did not read the same words there, and the line
     stays plain words. Nothing goes into the DOM behind the model's back
     (a cell holding a picture, which editCell declines, no longer exists:
     design D7). */
  scheduleBrollRefresh();
}

/* contenteditable="false" for the same reason a tag is atomic: the caret
   can never land inside the marker and grow or shrink it into no longer
   being one, whichever way it is approached. */
function brollKeyHtml(id, text) {
  return '<span class="broll-key" data-broll-id="' + escapeHtml(id) +
    '" contenteditable="false">' + escapeHtml(text) + '</span>';
}

/* ---- anchoring a marker that never came from typing ----

   maybeCaptureBroll() only fires on a live keystroke, so a marker that
   arrived any other way — imported, pasted, opened from .md or .docx, or
   written before markers existed — carried no id and was tied to its
   record by name alone (see brollLineMarker). Reword that line and the
   name match breaks: the status, notes, owner and audio reference are
   left behind on an orphan and the line comes back as a new, unshot item.

   This pass gives those lines the same key a typed one gets. One id per
   LINE, never per name — two identical B-roll lines are two shots to go
   and get (see the note at the top of this file) — and it adds, removes
   and reorders nothing, so renameBrollInScript() still counts the same
   marker lines in the same order.

   An edit of the cell's model (#85, docs/DOCUMENT-MODEL.md §4), like the
   typed key's: the marker's words go and the key goes in their place,
   through replaceWithBrollKey, and the cell is written with toHtml(). */

/* Swaps the marker's words for the key and one space at the start of the
   line. Those words can be spread over several pieces — a line can open
   "<strong>B-roll:</strong> the gulls", or with a key that sits inside
   formatting and so reads as words — so they are measured along the
   line's text, a key by its letters. Any indentation in front of them goes
   with them, exactly as it does when the marker is typed (maybeCaptureBroll
   takes the caret's text node from its start, leading whitespace
   included). The key and its space carry no marks: that is the shape
   brollLineMarker knows as a key. Returns the new cell, or null if the
   words end inside a key (they never do: a key's letters are a whole
   marker of their own). */
function brollAnchorLine(cell, line, id) {
  var m = BROLL_MARKER_RE.exec(brollLineText(line.items));
  if (!m) return null;
  var left = m[0].length, to = line.start;
  for (var i = 0; i < line.items.length && left > 0; i++) {
    var it = line.items[i];
    if (it.atom) {
      if (it.text.length > left) return null;
      left -= it.text.length;
      to = it.pos + 1;
    } else {
      var take = Math.min(left, it.text.length);
      left -= take;
      to = it.pos + take;
    }
  }
  var r = replaceWithBrollKey(cell, line.start, to, id, m[1] + m[2]);
  return insertText(r.cell, r.end, " ", {});
}

/* The same in a cell's HTML, for a cell the model cannot write
   (holdsMedia): the marker's words are consumed along the line's text
   nodes, and the key goes in front of whatever of the line survived. */
function brollLineTextNodes(nodes) {
  var out = [];
  (function walk(list) {
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.nodeType === 3) out.push(n);
      else if (n.nodeType === 1) walk(n.childNodes);
    }
  })(nodes);
  return out;
}

/* A formatting element whose whole content was the marker's own words is
   holding nothing once they are gone. */
function brollPruneEmpty(el, body) {
  while (el && el !== body && el.parentNode && !el.childNodes.length) {
    var parent = el.parentNode;
    parent.removeChild(el);
    el = parent;
  }
}

function brollWrapHtmlLine(body, line, id) {
  var m = BROLL_MARKER_RE.exec(brollHtmlLineText(line.nodes));
  if (!m) return false;
  var left = m[0].length;
  brollLineTextNodes(line.nodes).forEach(function (t) {
    if (left <= 0) return;
    var val = t.nodeValue || "";
    if (val.length > left) { t.nodeValue = val.slice(left); left = 0; return; }
    left -= val.length;
    var parent = t.parentNode;
    if (!parent) return;
    parent.removeChild(t);
    brollPruneEmpty(parent, body);
  });

  /* Whatever of the line survived the strip still sits between the same
     two <br>s, so the marker goes in front of the first of it — or, on a
     line that was nothing but the marker, in front of the line's own
     <br> (null for the last line, which appends). */
  var ref = null;
  for (var i = 0; i < line.nodes.length && !ref; i++) {
    if (line.nodes[i].parentNode === body) ref = line.nodes[i];
  }
  if (!ref) ref = line.br;
  var holder = document.createElement("div");
  holder.innerHTML = brollKeyHtml(id, m[1] + m[2]) + " ";
  Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
    body.insertBefore(n, ref);
  });
  return true;
}

/* A line whose key repeats an id an earlier line holds: the same key, the
   planned id. Nothing else on the line moves. */
function brollRekeyLine(cell, key, id) {
  var next = deleteRange(cell, key.pos, key.pos + 1);
  return insertBrollKey(next, key.pos, id, key.text, {});
}

/* The same in a cell's HTML (holdsMedia): the line's first key — the one
   the model read as its marker, since that key has no formatting round
   it — gets the planned id. */
function brollRekeyHtmlLine(line, id) {
  for (var i = 0; i < line.nodes.length; i++) {
    var n = line.nodes[i];
    if (n.nodeType !== 1) continue;
    var key = n.classList.contains("broll-key") ? n : n.querySelector(".broll-key");
    if (key) { key.setAttribute("data-broll-id", id); return true; }
  }
  return false;
}

/* Which id each unanchored line should be given.

   brollEntries() has already decided which record every marker belongs
   to; minting a fresh id here would hand the line an id that record has
   never heard of and leave the name match as the only thing still
   holding the two together — the very state this is meant to end. So the
   pass asks brollMatchRecord() the same question in the same order and
   writes the answer into the script: a line already matched to a record
   takes that record's id, and only a line with no record of its own gets
   a new one. Keyed by row and ordinal, because that is what identifies a
   line rather than a name. A line whose key repeats an id an earlier line
   holds is in the plan too (collectBrollFromRows reads it as unanchored),
   and gets its key's id swapped for the one planned. */
function brollAnchorPlan() {
  var claimed = Object.create(null);
  var byId = Object.create(null);
  S.state.brollShots.forEach(function (r) { byId[r.id] = r; });
  var plan = Object.create(null);
  var live = collectBrollFromRows(S.state.rows);
  var held = brollHeldIds(live);
  live.forEach(function (found) {
    var rec = brollMatchRecord(found, claimed, byId, held);
    if (rec) claimed[rec.id] = true;
    if (!found.id) plan[brollLineKey(found.rowId, found.ordinal)] = rec ? rec.id : makeId("bs");
  });
  return plan;
}

function brollLineKey(rowId, ordinal) {
  /* A separator no row id or ordinal can contain. Written as an escape,
     not as a raw NUL byte: the app ships inside a <script> in one HTML
     file, and the HTML parser rewrites a literal NUL in script data to
     U+FFFD — so the byte on disk and the character that ran were never
     the same thing, and the CSP hash of this script (#65) is computed
     over what is on disk. */
  return rowId + "\u0000" + ordinal;
}

export function declineBrollAnchoring(rows) {
  (rows || []).forEach(function (row) { brollAnchorDeclined[row.id] = true; });
}

/* `rows` is which rows to rewrite; the plan is always read from the whole
   document, so a line brought into a script that already tracks a shot of
   the same name cannot walk off with that shot's record. Callers that
   anchor a subset (the import scan, 11-import.js) put those rows into
   state.rows first for that reason. Returns how many lines were anchored.
   A row with nothing to anchor is not written at all. */
export function anchorBrollInRows(rows) {
  if (!S.state || !rows || !rows.length) return 0;
  var plan = brollAnchorPlan();
  var total = 0;
  rows.forEach(function (row) {
    if (brollAnchorDeclined[row.id]) return;
    var html = row.visualText;
    var cell = cellOf(html);
    var todo = [];
    /* in the plan: a line with no key, or one whose key repeats an id */
    brollMarkerLines(cell).forEach(function (found, ordinal) {
      var id = plan[brollLineKey(row.id, ordinal)];
      if (id) todo.push({ found: found, id: id });
    });
    if (!todo.length) return;
    var n = 0;
    if (holdsMedia(html)) {
      var body = inertBody(html);
      var htmlLines = brollHtmlLines(body);
      todo.forEach(function (t) {
        var line = htmlLines[t.found.index];
        if (!line) return;
        if (t.found.marker.key ? brollRekeyHtmlLine(line, t.id) : brollWrapHtmlLine(body, line, t.id)) n++;
      });
      if (n) row.visualText = sanitizeHtml(body.innerHTML);
    } else {
      /* last line first, so every earlier line is still where it was */
      for (var i = todo.length - 1; i >= 0; i--) {
        var t = todo[i];
        var next = t.found.marker.key
          ? brollRekeyLine(cell, t.found.marker.key, t.id)
          : brollAnchorLine(cell, t.found.line, t.id);
        if (next) { cell = next; n++; }
      }
      if (n) row.visualText = toHtml(cell);
    }
    total += n;
  });
  return total;
}

/* Only ever at a moment when nothing is being edited. Rewriting a field
   the caret is sitting in would cost that caret on the render() below,
   and a marker halfway through being typed is not yet a marker — which
   is also why this hangs off scheduleBrollRefresh()'s debounce rather
   than the input handler. Everything that changes the document ends in a
   render(), and render() schedules that refresh, so an import, an open,
   a paste the writer has since stepped away from, and a merge landing
   from the server all arrive here with the field safely left alone. */
function brollAnchoringIdle() {
  var el = document.activeElement;
  return !(el && el.isContentEditable);
}

function maybeAnchorBroll() {
  if (!S.state || !brollAnchoringIdle()) return 0;
  var n = anchorBrollInRows(S.state.rows);
  if (!n) return 0;
  markDirty();
  render();
  return n;
}

/* The one field that has just been left, anchored on its own. Nothing
   holds a caret in it any more, so its markup can be refreshed in place —
   which is what makes stepping away from a pasted line enough, without a
   render of the whole document that could take the caret of whichever
   field was clicked into next. */
export function anchorBrollInLeftCell(cellEl) {
  if (!S.state || cellEl.getAttribute("data-field") !== "visualText") return 0;
  var row = brollRow(cellEl.getAttribute("data-id"));
  if (!row) return 0;
  var n = anchorBrollInRows([row]);
  if (!n) return 0;
  cellEl.innerHTML = row.visualText;
  ensureTrailingCaretSpot(cellEl);
  markDirty();
  scheduleBrollRefresh();
  return n;
}

/* ---- writing an edit back into the script ----

   The list is not a second document. Renaming a shot there rewrites its
   marker line, so there is one set of words and they live where they were
   written. An item whose marker never carried an id gets one here, which
   is also how a pasted or round-tripped line rejoins its record for good.

   The whole line goes — everything between the previous line break and
   its own — and the key, a space and the new name take its place, none of
   them formatted: an edit of the cell's model, written with toHtml(). */
export function renameBrollInScript(entry, newName) {
  var row = brollRow(entry.rowId);
  if (!row) return false;
  var html = row.visualText;
  var target = entry.ordinal >= 0 ? brollMarkerLines(cellOf(html))[entry.ordinal] : null;
  if (!target) return false;
  var keyText = target.marker.key ? (target.marker.key.text || "B-roll:") : "B-roll:";

  if (holdsMedia(html)) {
    var body = inertBody(html);
    var line = brollHtmlLines(body)[target.index];
    if (!line) return false;
    var holder = document.createElement("div");
    holder.innerHTML = brollKeyHtml(entry.id, keyText) + " " + escapeHtml(newName);
    line.nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
      body.insertBefore(n, line.br);
    });
    row.visualText = sanitizeHtml(body.innerHTML);
    return true;
  }

  var at = target.line.start;
  var cell = deleteRange(cellOf(html), at, target.line.end);
  cell = insertBrollKey(cell, at, entry.id, keyText, {});
  cell = insertText(cell, at + 1, " " + newName, {});
  row.visualText = toHtml(cell);
  return true;
}

/* ---- the badge, and the refresh that keeps the list current ----

   The panel and the full-page shot list that show this list are
   08d-broll-panel.js; this file is the list itself. */

/* Script order, because that is shooting order as far as the script knows.
   Anything with no line of its own — added in the panel, or orphaned by a
   deleted line — sits at the end rather than at the top, where a rowIndex
   of -1 would otherwise put it. */
export function brollSortedForList(entries) {
  return entries.slice().sort(function (a, b) {
    var an = a.rowIndex === -1, bn = b.rowIndex === -1;
    if (an !== bn) return an ? 1 : -1;
    if (an) return (a.name || "").localeCompare(b.name || "");
    if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex;
    return a.ordinal - b.ordinal;
  });
}

export function updateBrollBadge() {
  var badge = document.getElementById("broll-badge");
  if (!badge || !S.state) return;
  var n = brollUnshotCount();
  if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  else badge.hidden = true;
}

/* Reading the markers back means parsing every visual field in the script:
   cheap once, wasteful on every keystroke. Same coalescing the production
   panel uses — the one idle refresh in 07-production-tags.js — and for the
   same reason. */
export function scheduleBrollRefresh() {
  scheduleIdleRefresh("broll");
}

/* What the idle refresh runs for b-roll. Anchoring first, because it can
   rewrite the very markers the badge and the views are about to read back. */
export function runBrollRefresh() {
  maybeAnchorBroll();
  updateBrollBadge();
  renderBrollViews();
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* Rows an import was asked NOT to scan (11-import.js). Browser state, never
     the document's: the answer was about that import, and an import that says
     no has to leave the text exactly as it was handed over — including
     against this pass, which would otherwise rewrite it a moment later. Ids
     of replaced rows are left behind here; they are a session's worth of
     strings and can never match a row again. */
  brollAnchorDeclined = Object.create(null);
}
