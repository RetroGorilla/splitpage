import { S } from "./_state.js";
import { makeId, migrateRows } from "./02-state.js";
import { dataUrlForSync, internDataUrl, queuePersist } from "./02c-blobs.js";
import { isSha256Hex, refsIn } from "../../shared/blob-policy.js";
import { cellOf, commentIds, fromHtml, normalizeCell, syncCommentAnchors, toHtml, toPlainText } from "./04c-doc-model.js";
import { brollIdsTaken, clipboardOfCell, freshBrollIds } from "./05c-clipboard.js";
import { collectTagsFromRows, mintTagId, normalizeTagName, registryKey } from "./07-production-tags.js";
import { normalizeBrollProps, recordPastedBroll } from "./08c-broll.js";
import { SCHEMA_VERSION } from "../core/document/fields.ts";
import { inertBody } from "../legacy/richtext.ts";

export var SCENES_MIME = "application/x-splitpage-scenes";
export var SCENES_ATTR = "data-splitpage-scenes";
var FORMAT = "splitpage-scenes";
var VERSION = 1;

export var SCENE_BLOB_CAP = 16 * 1024 * 1024;

var liveCut = null;

export function setLiveCut(nonce, docId) { liveCut = nonce ? { nonce: String(nonce), docId: docId || null } : null; }
export function liveCutNonce() { return liveCut ? liveCut.nonce : null; }

export function isMove(clip, state) {
  return !!(liveCut && clip && clip.cut && clip.cut === liveCut.nonce && state && state.docId === liveCut.docId) &&
    scenesAway(clip, state);
}

function scenesAway(clip, state) {
  var here = Object.create(null);
  (state.rows || []).forEach(function (r) { if (r) here[r.id] = true; });
  return !clip.rows.some(function (r) { return here[r.id]; });
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function cellIdsOf(rows, pick) {
  var out = Object.create(null);
  rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (f) { pick(cellOf(row[f] || ""), out); });
  });
  return out;
}

export function buildScenePayload(state, rowIds, opts) {
  opts = opts || {};
  var want = Object.create(null);
  (rowIds || []).forEach(function (id) { want[id] = true; });
  var rows = (state.rows || []).filter(function (r) { return r && want[r.id]; }).map(clone);
  var rowSet = Object.create(null);
  rows.forEach(function (r) { rowSet[r.id] = true; });

  var marked = cellIdsOf(rows, function (cell, out) {
    commentIds(cell).forEach(function (id) { out[id] = true; });
  });
  var comments = (state.comments || []).filter(function (c) {
    if (!c || c.field === "title") return false;
    return rowSet[c.rowId] || marked[c.anchorId || c.id];
  }).map(clone);

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

  var owners = Object.create(null);
  productionTags.concat(brollShots).forEach(function (x) { if (x.owner) owners[x.owner] = true; });
  var people = (state.people || []).filter(function (p) { return p && owners[p.id]; }).map(clone);

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

var NBSP_RE = new RegExp(String.fromCharCode(160), "g");

function plainOf(html) {
  return toPlainText(cellOf(html || "")).replace(NBSP_RE, " ");
}

export function scenesPlainText(rows) {
  return rows.map(function (r) {
    return "Visual: " + plainOf(r.visualText) + "\nAudio: " + plainOf(r.audioText);
  }).join("\n\n");
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

export function insertScenes(clip, opts) {
  opts = opts || {};
  var state = S.state;
  var mint = opts.mint || makeId;
  var move = !!opts.move && scenesAway(clip, state);
  var list = function (k) { if (!Array.isArray(state[k])) state[k] = []; return state[k]; };

  var rowTaken = Object.create(null);
  state.rows.forEach(function (r) { rowTaken[r.id] = true; });
  var rowMap = Object.create(null);
  clip.rows.forEach(function (r) {
    if (move && !rowTaken[r.id]) { rowTaken[r.id] = true; rowMap[r.id] = r.id; }
    else rowMap[r.id] = mintFree("r", rowTaken, mint);
  });
  var firstRowId = rowMap[clip.rows[0].id];

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

  if (!opts.holdComments) added.forEach(function (c) { comments.push(c); });
  syncCommentAnchors(state);

  return {
    rowIds: rows.map(function (r) { return r.id; }),
    comments: opts.holdComments ? 0 : added.length,
    held: opts.holdComments ? added : [],
    broll: { kept: kept, minted: minted }
  };
}

export function removeScenes(rowIds) {
  var gone = Object.create(null);
  (rowIds || []).forEach(function (id) { gone[id] = true; });
  var n = 0;
  for (var i = S.state.rows.length - 1; i >= 0; i--) {
    if (gone[S.state.rows[i].id]) { S.state.rows.splice(i, 1); n++; }
  }
  if (n) syncCommentAnchors(S.state);
  return n;
}

export function __init() {}
