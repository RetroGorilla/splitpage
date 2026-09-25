import { S } from "./_state.js";
import { SCHEMA_VERSION } from "./00-prelude.js";
import { makeId, migrateRows } from "./02-state.js";
import { dataUrlForSync, internDataUrl, queuePersist } from "./02c-blobs.js";
import { isSha256Hex, refsIn } from "../../shared/blob-policy.js";
import { inertBody } from "./04-richtext.js";
import { cellOf, commentIds, fromHtml, normalizeCell, syncCommentAnchors, toHtml, toPlainText } from "./04c-doc-model.js";
import { brollIdsTaken, clipboardOfCell, freshBrollIds } from "./05c-clipboard.js";
import { collectTagsFromRows, mintTagId, normalizeTagName, registryKey } from "./07-production-tags.js";
import { normalizeBrollProps, recordPastedBroll } from "./08c-broll.js";

/* ================= whole scenes on the clipboard (#204) =================

   A drag out of a script cell selects whole scenes (05h-scene-select.js);
   this file is what those scenes are on the clipboard and what a paste of
   them does to a document. No DOM here beyond the sanitiser's parser: it
   is unit-tested in src/test/scene-clip.test.mjs.

   THE PAYLOAD. A copy or a cut puts three flavours on the clipboard:

   - SCENES_MIME ("application/x-splitpage-scenes"), JSON: the scenes as
     the document holds them, EVERYTHING in them (Adam, #204): both
     columns, status, a length set by hand, the gallery (picture, further
     pictures, video links, captions), and beside them the records the
     scenes name — every comment on them (replies, resolved, assignee), the
     b-roll list's records for their keys, the breakdown's entries for
     their tags, and the people those two name as owners. And the picture
     BYTES, as data: URIs keyed by sha, up to SCENE_BLOB_CAP in all, so a
     paste into another tab, window or origin gets them without a store it
     may not share. A picture the cap leaves out (or whose bytes this page
     does not hold at the moment of the copy) travels by reference only and
     is named in `blobsLeftOut`: the paste asks its own store and server
     for it (ensureBytes), and says so when nobody has it — the scene still
     comes, with "Image unavailable" in its place, as for any picture whose
     bytes are gone.

         { format: "splitpage-scenes", version: 1,
           source: { docId, title }, cut: "<nonce>" (a cut only),
           rows: [...], comments: [...], people: [...],
           productionTags: [...], brollShots: [...],
           blobs: { "<sha>": "data:image/…;base64,…" }, blobsLeftOut: ["<sha>"] }

   - text/html: a two-column table (Visual | Audio) for a word processor or
     a sheet, the words with their formatting and no comment marks. The
     table also carries the payload WITHOUT its picture bytes in a
     `data-splitpage-scenes` attribute, for a browser or a clipboard tool
     that drops custom types: a Splitpage paste reading only that still
     rebuilds the scenes, its pictures by reference.
   - text/plain: "Visual: …" / "Audio: …" per scene, a blank line between —
     readable anywhere, and what File ▸ Paste a script… reads back as two
     columns (11-import.js's labelled form).

   THE PASTE (insertScenes) is new scenes after the scene the caret is in,
   one undo entry. Everything comes in through migrateRows() first (the
   one door, HANDOFF §3.2): the payload is untrusted, whoever wrote it.
   Ids, so nothing pasted claims something the document already has:

   - rows, comments and replies get fresh ids; a comment's anchor spans in
     the pasted cells are renamed with it, so the copy is its own
     conversation about its own words;
   - a b-roll key keeps its id only when the document has no key and no
     record with it (freshBrollIds, 05c-clipboard.js — HANDOFF invariant
     #54). A key that keeps its id brings its record (status, notes, owner,
     props): pasting into a new script keeps the shot list. A key given a
     new id is a new shot to go and get, seeded from its scene as a pasted
     line's is (recordPastedBroll) and with none of the old record;
   - a breakdown entry the document lacks is added (a fresh registry id,
     its status, notes and owner); one it has already is left as it is;
   - an owner is matched to the document's crew by name, else added.

   A CUT then its paste in the same tab and the same document is a MOVE
   (the live cut, below): the rows keep their ids where they are free, the
   comments — which a cut leaves in the document, as deleting a scene does
   — are not copied again but follow their anchors back to the words, and
   the b-roll keys keep their ids and find their records. A second paste of
   the same cut is a copy. */

export var SCENES_MIME = "application/x-splitpage-scenes";
export var SCENES_ATTR = "data-splitpage-scenes";
var FORMAT = "splitpage-scenes";
var VERSION = 1;

/* The most picture bytes one copy carries: 16 MiB, which is also the
   largest single picture any store takes (desktop/blob-store.js), so a
   copy of one scene always carries its pictures. Past it the rest go by
   reference (above). The clipboard holds text: 16 MiB of pictures is about
   22 MB of base64, which Chromium and the OS clipboard take in their
   stride; much more makes every copy slow for a paste that usually lands
   in a tab of this same app, whose store already has them. */
export var SCENE_BLOB_CAP = 16 * 1024 * 1024;

/* ---- this tab's live cut ---- */

var liveCut = null;   /* {nonce, docId} */

export function setLiveCut(nonce, docId) { liveCut = nonce ? { nonce: String(nonce), docId: docId || null } : null; }
export function liveCutNonce() { return liveCut ? liveCut.nonce : null; }

/* Whether a paste of `clip` into the document `state` is the move the
   live cut began: the same cut, into the document it was cut from. */
export function isMove(clip, state) {
  return !!(liveCut && clip && clip.cut && clip.cut === liveCut.nonce && state && state.docId === liveCut.docId);
}

/* ---- building the payload ---- */

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function cellIdsOf(rows, pick) {
  var out = Object.create(null);
  rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (f) { pick(cellOf(row[f] || ""), out); });
  });
  return out;
}

/* What the scenes `rowIds` (in document order, whatever order they are
   given in) put on the clipboard, from `state`:
     {payload, json, html, text, rows, leftOut}
   opts.cut: this tab's cut nonce (a cut). opts.dataUrl(sha): the bytes
   as a data: URI, or null (default: the registry's, dataUrlForSync).
   opts.cap: SCENE_BLOB_CAP. `leftOut` lists the pictures that travel by
   reference only. */
export function buildScenePayload(state, rowIds, opts) {
  opts = opts || {};
  var want = Object.create(null);
  (rowIds || []).forEach(function (id) { want[id] = true; });
  var rows = (state.rows || []).filter(function (r) { return r && want[r.id]; }).map(clone);
  var rowSet = Object.create(null);
  rows.forEach(function (r) { rowSet[r.id] = true; });

  /* the comments on these scenes: by the row they point at, or by a mark
     in their words (a comment split across a scene boundary) */
  var marked = cellIdsOf(rows, function (cell, out) {
    commentIds(cell).forEach(function (id) { out[id] = true; });
  });
  var comments = (state.comments || []).filter(function (c) {
    if (!c || c.field === "title") return false;
    return rowSet[c.rowId] || marked[c.anchorId || c.id];
  }).map(clone);

  /* the breakdown's entries for their tags, and for the props their b-roll
     records name */
  var tagKeys = Object.create(null);
  collectTagsFromRows(rows).forEach(function (t) { tagKeys[registryKey(t.cat.id, t.name)] = true; });
  var keyIds = cellIdsOf(rows, function (cell, out) {
    cell.forEach(function (r) { if (r.atom && r.id) out[r.id] = true; });
  });
  var brollShots = (state.brollShots || []).filter(function (b) { return b && keyIds[b.id]; }).map(clone);
  var propIds = Object.create(null);
  brollShots.forEach(function (b) { (b.props || []).forEach(function (p) { if (p && p.id) propIds[p.id] = true; }); });
  var productionTags = (state.productionTags || []).filter(function (t) {
    return t && (tagKeys[registryKey(t.cat, t.name)] || propIds[t.id]);
  }).map(clone);

  /* the people those name as owners */
  var owners = Object.create(null);
  productionTags.concat(brollShots).forEach(function (x) { if (x.owner) owners[x.owner] = true; });
  var people = (state.people || []).filter(function (p) { return p && owners[p.id]; }).map(clone);

  /* the pictures: bytes up to the cap, the rest by reference */
  var dataUrl = opts.dataUrl || dataUrlForSync;
  var cap = typeof opts.cap === "number" ? opts.cap : SCENE_BLOB_CAP;
  var blobs = {}, leftOut = [], used = 0;
  refsIn({ rows: rows, comments: comments }).forEach(function (sha) {
    var uri = dataUrl(sha);
    var size = uri ? Math.floor((uri.length - uri.indexOf(",") - 1) * 3 / 4) : 0;
    if (!uri || used + size > cap) { leftOut.push(sha); return; }
    used += size;
    blobs[sha] = uri;
  });

  var payload = {
    format: FORMAT, version: VERSION,
    source: { docId: state.docId || null, title: state.title || "" },
    rows: rows, comments: comments, people: people,
    productionTags: productionTags, brollShots: brollShots,
    blobs: blobs, blobsLeftOut: leftOut
  };
  if (opts.cut) payload.cut = String(opts.cut);
  return {
    payload: payload,
    json: JSON.stringify(payload),
    html: scenesTableHtml(rows, payload),
    text: scenesPlainText(rows),
    rows: rows.length,
    leftOut: leftOut
  };
}

/* a no-break space as a space, for another program */
var NBSP_RE = new RegExp(String.fromCharCode(160), "g");

function plainOf(html) {
  return toPlainText(cellOf(html || "")).replace(NBSP_RE, " ");
}

/* "Visual: …" / "Audio: …" per scene, a blank line between. */
export function scenesPlainText(rows) {
  return rows.map(function (r) {
    return "Visual: " + plainOf(r.visualText) + "\nAudio: " + plainOf(r.audioText);
  }).join("\n\n");
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* The table another program gets; the payload without its bytes rides on
   it for a Splitpage paste that finds no custom type. */
export function scenesTableHtml(rows, payload) {
  var marker = "";
  if (payload) {
    var lean = Object.assign({}, payload, {
      blobs: {},
      blobsLeftOut: Object.keys(payload.blobs || {}).concat(payload.blobsLeftOut || [])
    });
    marker = " " + SCENES_ATTR + '="' + escAttr(JSON.stringify(lean)) + '"';
  }
  var cell = function (html) { return clipboardOfCell(cellOf(html || "")).html; };
  return '<table border="1" cellpadding="6" style="border-collapse:collapse"' + marker + ">" +
    "<thead><tr><th>Visual</th><th>Audio</th></tr></thead><tbody>" +
    rows.map(function (r) {
      return '<tr><td style="vertical-align:top">' + cell(r.visualText) + '</td><td style="vertical-align:top">' + cell(r.audioText) + "</td></tr>";
    }).join("") +
    "</tbody></table>";
}

/* ---- reading it back ---- */

/* The scenes on a clipboard, from getData(type) (a DataTransfer's, bound),
   or null when it holds none. */
function readType(getData, type) {
  try { return String(getData(type) || ""); } catch (e) { return ""; }
}

export function scenesOnClipboard(getData) {
  var json = readType(getData, SCENES_MIME);
  if (json) {
    var clip = parseScenePayload(json);
    if (clip) return clip;
  }
  var html = readType(getData, "text/html");
  if (html.indexOf(SCENES_ATTR) === -1) return null;
  var el = inertBody(html).querySelector("[" + SCENES_ATTR + "]");
  return el ? parseScenePayload(el.getAttribute(SCENES_ATTR)) : null;
}

/* The payload's JSON as scenes ready to insert, or null when it is not
   ours. Its pictures' bytes are interned (each checked against the sha it
   is filed under) and queued to be stored; everything else goes through
   migrateRows(), which sanitises every cell, comment and record.
     {rows, comments, people, productionTags, brollShots, cut, source,
      carried: [sha], refs: [sha]}
   refs is every picture the scenes name; carried the ones whose bytes
   came with them. */
export function parseScenePayload(json) {
  var p;
  try { p = typeof json === "string" ? JSON.parse(json) : json; } catch (e) { return null; }
  if (!p || typeof p !== "object" || p.format !== FORMAT || typeof p.version !== "number" || p.version < 1) return null;
  if (!Array.isArray(p.rows) || !p.rows.length) return null;
  var carried = [];
  var blobs = p.blobs && typeof p.blobs === "object" ? p.blobs : {};
  Object.keys(blobs).forEach(function (sha) {
    if (!isSha256Hex(sha) || typeof blobs[sha] !== "string") return;
    var rec = internDataUrl(blobs[sha]);
    if (rec && rec.sha256 === sha) carried.push(sha);
  });
  if (carried.length) queuePersist(carried);
  var list = function (v) { return Array.isArray(v) ? clone(v) : []; };
  var doc = migrateRows({
    schema: SCHEMA_VERSION,
    title: "",
    rows: list(p.rows),
    comments: list(p.comments),
    people: list(p.people),
    productionTags: list(p.productionTags),
    brollShots: list(p.brollShots)
  });
  if (!doc.rows.length) return null;
  var source = p.source && typeof p.source === "object" ? p.source : {};
  return {
    rows: doc.rows,
    comments: doc.comments,
    people: doc.people,
    productionTags: doc.productionTags,
    brollShots: doc.brollShots,
    cut: typeof p.cut === "string" && /^[A-Za-z0-9]{1,64}$/.test(p.cut) ? p.cut : null,
    source: {
      docId: typeof source.docId === "string" ? source.docId : null,
      title: typeof source.title === "string" ? source.title.slice(0, 300) : ""
    },
    carried: carried,
    refs: refsIn(doc)
  };
}

/* ---- the paste ---- */

/* Whether a scene is empty enough for a paste to take its place: no
   words in either column, no picture or gallery, no length set by hand,
   and no comment on it. A new script's one blank scene is the case. */
export function isBlankScene(state, row) {
  if (!row) return false;
  if (plainOf(row.visualText).trim() || plainOf(row.audioText).trim()) return false;
  if (row.imageRef || (row.moreImages && row.moreImages.length) || (row.imageLinks && row.imageLinks.length)) return false;
  if (typeof row.lengthSeconds === "number") return false;
  return !(state.comments || []).some(function (c) { return c && c.rowId === row.id; });
}

function mintFree(prefix, taken, mint) {
  var id, guard = 0;
  do { id = mint(prefix); } while (taken[id] && ++guard < 100);
  taken[id] = true;
  return id;
}

/* The scenes of `clip` (parseScenePayload) put into S.state — the open
   document — after the scene `opts.afterRowId` (at the end when it is
   missing or not given); opts.replaceRowId, a blank scene the paste takes
   the place of (isBlankScene). opts.move: this is the live cut's move
   (isMove). opts.holdComments: do not add the comments, return them
   instead — a server document's comments are sent the moment they are
   added and never undone (12a-undo.js, design D5), so the caller adds
   them as a second step and the scenes stay one undo entry of their own.
   opts.mint(prefix): a new id (makeId); opts.stamp(row): stampRow.

   Changes the document in place and marks nothing: the caller's one
   markDirty() makes it one undo entry. Returns
     {rowIds, comments, held, broll: {kept, minted}} */
export function insertScenes(clip, opts) {
  opts = opts || {};
  var state = S.state;
  var mint = opts.mint || makeId;
  var move = !!opts.move;
  var list = function (k) { if (!Array.isArray(state[k])) state[k] = []; return state[k]; };

  /* rows */
  var rowTaken = Object.create(null);
  state.rows.forEach(function (r) { rowTaken[r.id] = true; });
  var rowMap = Object.create(null);
  clip.rows.forEach(function (r) {
    if (move && !rowTaken[r.id]) { rowTaken[r.id] = true; rowMap[r.id] = r.id; }
    else rowMap[r.id] = mintFree("r", rowTaken, mint);
  });
  var firstRowId = rowMap[clip.rows[0].id];

  /* comments: which the document keeps (a move), which come as copies */
  var comments = list("comments");
  var cmtTaken = Object.create(null);
  comments.forEach(function (c) { if (c) { cmtTaken[c.id] = true; if (c.anchorId) cmtTaken[c.anchorId] = true; } });
  var liveRows = Object.create(null);
  state.rows.forEach(function (r) { liveRows[r.id] = true; });
  var anchorMap = Object.create(null);
  var added = [];
  var rpTaken = Object.create(null);
  clip.comments.forEach(function (c) {
    var anchor = c.anchorId || c.id;
    if (move) {
      var here = comments.filter(function (x) { return x && x.id === c.id; })[0];
      if (here) {
        anchorMap[anchor] = here.anchorId || here.id;
        /* orphaned by the cut: back with its scene (a marked one follows its
           words below, whatever this says) */
        if (!liveRows[here.rowId] && rowMap[c.rowId]) here.rowId = rowMap[c.rowId];
        return;
      }
      if (!cmtTaken[c.id] && !cmtTaken[anchor]) {
        cmtTaken[c.id] = true;
        anchorMap[anchor] = anchor;
        added.push(Object.assign(clone(c), { rowId: rowMap[c.rowId] || firstRowId }));
        return;
      }
    }
    var id = mintFree("c", cmtTaken, mint);
    anchorMap[anchor] = id;
    var copy = clone(c);
    copy.id = id;
    copy.anchorId = id;
    copy.rowId = rowMap[c.rowId] || firstRowId;
    copy.replies = (copy.replies || []).map(function (rep) {
      return Object.assign(rep, { id: mintFree("rp", rpTaken, mint) });
    });
    added.push(copy);
  });

  /* the cells: comment marks renamed, b-roll keys given ids of their own */
  var takenKeys = brollIdsTaken(state, null, null, null, move);
  var kept = [], minted = [];
  var mintedByRow = Object.create(null);
  var rows = clip.rows.map(function (r) {
    var row = clone(r);
    row.id = rowMap[r.id];
    ["visualText", "audioText"].forEach(function (f) {
      var cell = fromHtml(row[f] || "").map(function (run) {
        if (!run.marks || !run.marks.cmt) return run;
        var marks = Object.assign({}, run.marks);
        marks.cmt = marks.cmt.map(function (id) { return anchorMap[id]; }).filter(Boolean);
        return Object.assign({}, run, { marks: marks });
      });
      var fresh = freshBrollIds(normalizeCell(cell), takenKeys, function () { return mint("bs"); });
      fresh.cell.forEach(function (run) {
        if (!run.atom || !run.id) return;
        takenKeys[run.id] = true;
        if (fresh.minted.indexOf(run.id) === -1) kept.push(run.id);
      });
      minted = minted.concat(fresh.minted);
      if (f === "visualText" && fresh.minted.length) mintedByRow[row.id] = { cell: fresh.cell, ids: fresh.minted };
      row[f] = toHtml(fresh.cell);
    });
    if (opts.stamp) opts.stamp(row);
    return row;
  });

  /* into the scene list */
  var at = state.rows.length;
  var replaceAt = opts.replaceRowId ? state.rows.findIndex(function (r) { return r.id === opts.replaceRowId; }) : -1;
  if (replaceAt !== -1) {
    at = replaceAt;
    state.rows.splice(replaceAt, 1);
  } else if (opts.afterRowId) {
    var after = state.rows.findIndex(function (r) { return r.id === opts.afterRowId; });
    if (after !== -1) at = after + 1;
  }
  Array.prototype.splice.apply(state.rows, [at, 0].concat(rows));

  /* the crew, matched by name, added only when something names them */
  var people = list("people");
  var personMap = Object.create(null);
  var peopleTaken = Object.create(null);
  people.forEach(function (p) { peopleTaken[p.id] = true; });
  function ownerFor(id) {
    if (!id) return "";
    if (personMap[id] !== undefined) return personMap[id];
    var theirs = clip.people.filter(function (p) { return p.id === id; })[0];
    if (!theirs) return (personMap[id] = "");
    var norm = normalizeTagName(theirs.name);
    var mine = people.filter(function (p) { return normalizeTagName(p.name) === norm; })[0];
    if (!mine) {
      mine = { id: peopleTaken[theirs.id] ? mintFree("p", peopleTaken, mint) : theirs.id, name: theirs.name };
      peopleTaken[mine.id] = true;
      people.push(mine);
    }
    return (personMap[id] = mine.id);
  }

  /* the breakdown: an entry the document lacks comes with its details */
  var registry = list("productionTags");
  var haveTag = Object.create(null);
  registry.forEach(function (t) { haveTag[registryKey(t.cat, t.name)] = true; });
  clip.productionTags.forEach(function (t) {
    var key = registryKey(t.cat, t.name);
    if (haveTag[key]) return;
    haveTag[key] = true;
    registry.push({ id: mintTagId(t.cat, t.name, registry), cat: t.cat, name: t.name,
                    owner: ownerFor(t.owner), notes: t.notes || "", status: t.status });
  });

  /* the b-roll list: a key that kept its id brings its record, unless the
     document still has one (a move finds its own); a new id is a new shot */
  var shots = list("brollShots");
  var haveShot = Object.create(null);
  shots.forEach(function (b) { haveShot[b.id] = true; });
  var keptSet = Object.create(null);
  kept.forEach(function (id) { keptSet[id] = true; });
  clip.brollShots.forEach(function (b) {
    if (!keptSet[b.id] || haveShot[b.id]) return;
    haveShot[b.id] = true;
    var rec = clone(b);
    rec.owner = ownerFor(b.owner);
    rec.props = normalizeBrollProps((b.props || []).map(function (p) { return { id: "", name: p.name }; }), registry);
    shots.push(rec);
  });
  Object.keys(mintedByRow).forEach(function (rowId) {
    recordPastedBroll(rowId, mintedByRow[rowId].cell, mintedByRow[rowId].ids);
  });

  /* the comments, and every marked one pointed at its words */
  if (!opts.holdComments) added.forEach(function (c) { comments.push(c); });
  syncCommentAnchors(state);

  return {
    rowIds: rows.map(function (r) { return r.id; }),
    comments: opts.holdComments ? 0 : added.length,
    held: opts.holdComments ? added : [],
    broll: { kept: kept, minted: minted }
  };
}

/* The scenes `rowIds` out of S.state, in place; how many went. A cut and a
   delete take the scenes only: their comments stay in the document, as
   deleting one scene from its menu leaves them (detached until a move's
   paste brings their words back). */
export function removeScenes(rowIds) {
  var gone = Object.create(null);
  (rowIds || []).forEach(function (id) { gone[id] = true; });
  /* in place: the app holds references into S.state.rows (12a-undo.js) */
  var n = 0;
  for (var i = S.state.rows.length - 1; i >= 0; i--) {
    if (gone[S.state.rows[i].id]) { S.state.rows.splice(i, 1); n++; }
  }
  return n;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order. */
export function __init() {}
