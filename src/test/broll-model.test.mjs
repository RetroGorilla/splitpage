import "./_dom.mjs";
import "./_export-services-started.mjs";
import { liveDoc, printData } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, migrateRows } from "../js/02-state.js";
import { inertBody, sanitizeHtml } from "../js/04-richtext.js";
import { cellOf, normalizeCell } from "../js/04c-doc-model.js";
import { BROLL_MARKER_RE, __init as brollInit, addBrollProp, brollInCell, brollPropKey, brollPropsInCell, brollShotsByProp, recordPastedBroll, renameBrollInScript } from "../js/08c-broll.js";
import { anchorBrollInRows } from "../adapters/production/broll-anchors.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { randomIds } from "../adapters/identity/ids.ts";
import { removeBrollProp, renameTag } from "../application/commands/production-actions.ts";
import { runDocumentEdit, sessionStamps, currentDocument } from "../legacy/session-bridge.ts";
import { retagRewrites as planRetagRewrites } from "../application/commands/tag-rewrites.ts";
import { sharedPorts } from "../bootstrap/wiring/shared-ports.ts";

const retagText = sharedPorts().text;
const retagRewrites = (tags, toName) => planRetagRewrites(retagText, tags, toName);

import { buildBreakdownCsv, buildBrollCsv } from "../adapters/formats/csv.ts";
import { buildShotListPdf } from "../adapters/formats/pdf.ts";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { sceneFacts } from "../adapters/formats/export-projections.ts";
import { STORED, rng, tagSpan } from "./_stored-cells.mjs";
import { loadTestDocument } from "./_document.mjs";

brollInit();

function brollFieldLines(body) {
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
    var tail = parent.cloneNode(false);
    while (br.nextSibling) tail.appendChild(br.nextSibling);
    parent.removeChild(br);
    var ref = parent.nextSibling;
    grand.insertBefore(br, ref);
    if (tail.childNodes.length) grand.insertBefore(tail, ref);
  }
}
function brollLineText(nodes) {
  return nodes.map(function (n) { return n.textContent || ""; }).join("");
}
function brollLineMarker(nodes) {
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.nodeType === 3 && !(n.nodeValue || "").trim()) continue;
    if (n.nodeType === 1 && n.classList && n.classList.contains("broll-key")) {
      return { id: n.getAttribute("data-broll-id") || "", el: n, rest: nodes.slice(i + 1) };
    }
    break;
  }
  var m = BROLL_MARKER_RE.exec(brollLineText(nodes));
  return m ? { id: "", el: null, rest: null, strip: m[0].length } : null;
}
function oldBrollInField(html) {
  var out = [], open = null;
  brollFieldLines(inertBody(html)).forEach(function (line) {
    var marker = brollLineMarker(line.nodes);
    if (marker) {
      var name = marker.rest
        ? brollLineText(marker.rest)
        : brollLineText(line.nodes).slice(marker.strip);
      open = { id: marker.id, name: name.trim().slice(0, 200), desc: [] };
      out.push(open);
      return;
    }
    if (open) open.desc.push(brollLineText(line.nodes));
  });
  out.forEach(function (item) {
    item.desc = item.desc.join("\n").replace(/\s+$/, "").slice(0, 2000);
  });
  return out;
}
function brollKeyHtml(id, text) {
  return '<span class="broll-key" data-broll-id="' + escapeHtml(id) +
    '" contenteditable="false">' + escapeHtml(text) + '</span>';
}
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
function brollPruneEmpty(el, body) {
  while (el && el !== body && el.parentNode && !el.childNodes.length) {
    var parent = el.parentNode;
    parent.removeChild(el);
    el = parent;
  }
}
function brollWrapLineMarker(body, line, id) {
  var m = BROLL_MARKER_RE.exec(brollLineText(line.nodes));
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
function oldAnchor(html, idFor) {
  var body = inertBody(html);
  var ordinal = -1, n = 0;
  brollFieldLines(body).forEach(function (line) {
    var marker = brollLineMarker(line.nodes);
    if (!marker) return;
    ordinal++;
    if (marker.el) return;
    var id = idFor(ordinal);
    if (id && brollWrapLineMarker(body, line, id)) n++;
  });
  return n ? sanitizeHtml(body.innerHTML) : html;
}
function oldRename(html, ordinalWanted, id, newName) {
  var body = inertBody(html);
  var lines = brollFieldLines(body);
  var ordinal = -1, target = null;
  for (var i = 0; i < lines.length && !target; i++) {
    if (!brollLineMarker(lines[i].nodes)) continue;
    ordinal++;
    if (ordinal === ordinalWanted) target = lines[i];
  }
  if (!target) return null;
  var marker = brollLineMarker(target.nodes);
  var keyText = marker.el ? (marker.el.textContent || "B-roll:") : "B-roll:";
  var holder = document.createElement("div");
  holder.innerHTML = brollKeyHtml(id, keyText) + " " + escapeHtml(newName);
  var anchor = target.br;
  target.nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
  Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
    body.insertBefore(n, anchor);
  });
  return sanitizeHtml(body.innerHTML);
}

const KEY = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;

function brollCell(r) {
  const pieces = ["B-roll:", "b roll -", "  B-Roll — ", "the gulls", " ", "  ", "drone", "B-roll", "x: y", "&nbsp;", "é"];
  let h = "";
  const n = Math.floor(r() * 14);
  for (let i = 0; i < n; i++) {
    const roll = r();
    let p;
    if (roll < 0.2) p = KEY("bs" + Math.floor(r() * 4));
    else if (roll < 0.35) p = "<br>";
    else p = pieces[Math.floor(r() * pieces.length)];
    const w = r();
    if (w < 0.1) p = "<strong>" + p + "</strong>";
    else if (w < 0.15) p = "<em>" + p + "</em>";
    else if (w < 0.2) p = '<span class="cmt-anchor" data-cmt="c1">' + p + "</span>";
    else if (w < 0.23) p = '<a href="https://e.x/">' + p + "</a>";
    else if (w < 0.27 && p.indexOf("broll-key") === -1) p = tagSpan("prop", "It", p);
    h += p;
  }
  return sanitizeHtml(h);
}

const BROLL_CELLS = (() => {
  const r = rng(7);
  const out = [
    "B-roll: the gulls<br>over the pier<br>B-roll — drone",
    "<strong>B-roll:</strong> the gulls",
    "<strong>x<br>B-roll: y</strong>",
    "<strong>x<br>" + KEY("b1") + " y</strong>",
    "  " + KEY("b1") + " gulls<br>desc<br><br>",
    "<strong> </strong>" + KEY("b1") + " gulls",
    '<span class="cmt-anchor" data-cmt="c1">' + KEY("b1") + " gulls</span>",
    '<span class="cmt-anchor" data-cmt="c1">B-roll: gulls and</span> more'
  ].map((h) => sanitizeHtml(h));
  for (let i = 0; i < 2500; i++) out.push(brollCell(r));
  return out;
})();

function commentsAKeyOrBlank(html) {
  return Array.prototype.some.call(inertBody(html).querySelectorAll(".cmt-anchor"),
    (el) => !!el.querySelector(".broll-key") || !(el.textContent || "").trim());
}

function withoutComments(html) {
  const body = inertBody(html);
  body.querySelectorAll(".cmt-anchor").forEach((el) => {
    while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
    el.remove();
  });
  return body.innerHTML;
}

test("reading: every stored cell and every b-roll cell reads exactly as the HTML reader read it", () => {
  let markers = 0, keyed = 0, plain = 0, covered = 0;
  for (const html of STORED.concat(BROLL_CELLS)) {
    const before = oldBrollInField(html);
    const now = brollInCell(cellOf(html));
    if (commentsAKeyOrBlank(html)) {
      const bare = oldBrollInField(withoutComments(html));
      assert.equal(now.length, bare.length, html);
      assert.deepEqual(now, bare, html);
      const keyIds = Array.prototype.map.call(inertBody(html).querySelectorAll(".broll-key"), (el) => el.getAttribute("data-broll-id"));
      now.forEach((b) => assert.ok(!b.id || keyIds.includes(b.id), html));
      covered++;
    } else assert.deepEqual(now, before, html);
    markers += before.length;
    before.forEach((b) => { if (b.id) keyed++; else plain++; });
  }
  assert.ok(keyed > 500 && plain > 500, "the cells exercise both kinds of marker: " + keyed + " keyed, " + plain + " plain");
  assert.ok(markers > 1000);
  assert.ok(covered > 10, "keys under a comment: " + covered);
});

test("reading: where the model reads differently, by design", () => {
  const read = (h) => brollInCell(cellOf(sanitizeHtml(h)));
  assert.deepEqual(oldBrollInField("B-roll: a\nb"), [{ id: "", name: "a\nb", desc: "" }]);
  assert.deepEqual(read("B-roll: a\nb"), [{ id: "", name: "a b", desc: "" }]);
  assert.deepEqual(oldBrollInField("​B-roll: a"), []);
  assert.deepEqual(read("​B-roll: a"), [{ id: "", name: "a", desc: "" }]);
  const empty = sanitizeHtml("<strong></strong>" + KEY("b1") + " gulls");
  assert.deepEqual(oldBrollInField(empty), [{ id: "", name: "gulls", desc: "" }]);
  assert.deepEqual(read(empty), [{ id: "b1", name: "gulls", desc: "" }]);
  const inTag = sanitizeHtml(tagSpan("prop", "It", KEY("b1") + " gulls"));
  assert.deepEqual(oldBrollInField(inTag), [{ id: "", name: "gulls", desc: "" }]);
  assert.deepEqual(read(inTag), [{ id: "b1", name: "gulls", desc: "" }]);
  const commented = '<span class="cmt-anchor" data-cmt="c1">' + KEY("b1") + " gulls</span>";
  assert.deepEqual(oldBrollInField(sanitizeHtml(commented)), [{ id: "", name: "gulls", desc: "" }]);
  assert.deepEqual(read(commented), [{ id: "b1", name: "gulls", desc: "" }]);
});

test("anchoring: a key a comment covers keeps its id and its comment, and a repeated one keeps the comment", () => {
  const commented = sanitizeHtml('<span class="cmt-anchor" data-cmt="c1">' + KEY("bsA") + " the gulls</span>");
  loadTestDocument({
    rows: [
      { id: "r0", visualText: commented, audioText: "" },
      { id: "r1", visualText: "B-roll: drone", audioText: "" }
    ],
    brollShots: [{ id: "bsA", name: "the gulls", desc: "", status: "shot", origin: "script" }],
    productionTags: []
  });
  assert.equal(anchorBrollInRows(currentDocument(), undefined, { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml }), 1);
  assert.equal(currentDocument().rows[0].visualText, commented);
  assert.match(currentDocument().rows[1].visualText, /^<span class="broll-key"/);

  currentDocument().rows.push({ id: "r2", visualText: commented, audioText: "" });
  assert.equal(anchorBrollInRows(currentDocument(), undefined, { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml }), 1);
  assert.equal(currentDocument().rows[0].visualText, commented);
  const after = currentDocument().rows[2].visualText;
  assert.match(after, /data-cmt="c1"/);
  const read = brollInCell(cellOf(after));
  assert.deepEqual(read.map((b) => b.name), ["the gulls"]);
  assert.ok(read[0].id && read[0].id !== "bsA");
  assert.deepEqual(cellOf(after)[0].marks, { cmt: ["c1"] });
});

function bareBreaks(cell) {
  const runs = [];
  for (const r of cell) {
    if (r.atom) { runs.push(r); continue; }
    r.text.split(/(\n)/).forEach((t) => { if (t) runs.push({ text: t, marks: t === "\n" ? {} : r.marks }); });
  }
  return normalizeCell(runs);
}

function withRow(html, fn) {
  loadTestDocument({ rows: [{ id: "r0", visualText: html, audioText: "" }], brollShots: [], productionTags: [] });
  return fn(currentDocument().rows[0], currentDocument());
}

test("anchoring: every unanchored line gets its key where the old pass put it", () => {
  let anchored = 0;
  for (const html of STORED.concat(BROLL_CELLS)) {
    const before = brollInCell(cellOf(html));
    if (!before.some((b) => !b.id)) continue;
    if (repeatsAnId(before) || commentsAKeyOrBlank(html)) continue;
    const after = withRow(html, (row, doc) => {
      const n = anchorBrollInRows(doc, [row], { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml });
      assert.equal(n, before.filter((b) => !b.id).length, html);
      return row.visualText;
    });
    const read = brollInCell(cellOf(after));
    assert.equal(read.length, before.length, html);
    assert.ok(read.every((b) => b.id), "every line now has a key: " + after);
    const old = oldAnchor(html, (k) => read[k].id);
    assert.deepEqual(bareBreaks(cellOf(after)), bareBreaks(cellOf(old)), html);
    assert.deepEqual(read.map((b) => [b.name, b.desc]), before.map((b) => [b.name, b.desc]), "anchoring changes no name: " + html);
    assert.equal(sanitizeHtml(after), after, "written canonical");
    anchored++;
  }
  assert.ok(anchored > 300, "anchored " + anchored);
});

function repeatsAnId(read) {
  const ids = read.filter((b) => b.id).map((b) => b.id);
  return new Set(ids).size !== ids.length;
}

function idsBlanked(cell, at) {
  let pos = 0;
  return cell.map((r) => {
    const here = pos;
    pos += r.atom ? 1 : r.text.length;
    return r.atom && at.includes(here) ? Object.assign({}, r, { id: "" }) : r;
  });
}

test("anchoring: a key repeating an id an earlier line holds gets an id of its own, and nothing else changes", () => {
  let healed = 0;
  for (const html of STORED.concat(BROLL_CELLS)) {
    const before = brollInCell(cellOf(html));
    if (!repeatsAnId(before)) continue;
    const seen = new Set();
    const repeats = [];
    before.forEach((b, k) => {
      if (b.id && seen.has(b.id)) repeats.push(k);
      if (b.id) seen.add(b.id);
    });
    const after = withRow(html, (row, doc) => {
      assert.equal(anchorBrollInRows(doc, [row], { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml }), repeats.length + before.filter((b) => !b.id).length, html);
      return row.visualText;
    });
    const read = brollInCell(cellOf(after));
    assert.deepEqual(read.map((b) => [b.name, b.desc]), before.map((b) => [b.name, b.desc]), html);
    assert.ok(read.every((b) => b.id), "every line has a key: " + after);
    assert.equal(new Set(read.map((b) => b.id)).size, read.length, "every id once: " + after);
    before.forEach((b, k) => {
      if (b.id && !repeats.includes(k)) assert.equal(read[k].id, b.id, "the first line keeps its id: " + html);
    });
    if (before.every((b) => b.id)) {
      const cellBefore = cellOf(html), cellAfter = cellOf(after);
      const at = [];
      let pos = 0;
      cellAfter.forEach((r, i) => {
        if (r.atom && r.id !== cellBefore[i].id) at.push(pos);
        pos += r.atom ? 1 : r.text.length;
      });
      assert.equal(at.length, repeats.length, html);
      assert.deepEqual(idsBlanked(cellAfter, at), idsBlanked(cellBefore, at), html);
    }
    assert.equal(sanitizeHtml(after), after, "written canonical");
    healed++;
  }
  assert.ok(healed > 10, "healed " + healed);

  loadTestDocument({
    rows: [
      { id: "r0", visualText: KEY("bsA") + " the gulls", audioText: "" },
      { id: "r1", visualText: "intro<br>" + KEY("bsA") + " the gulls", audioText: "" }
    ],
    brollShots: [{ id: "bsA", name: "the gulls", desc: "", status: "shot", origin: "script" }],
    productionTags: []
  });
  assert.equal(anchorBrollInRows(currentDocument(), undefined, { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml }), 1);
  const ids = currentDocument().rows.map((r) => brollInCell(cellOf(r.visualText))[0].id);
  assert.equal(ids[0], "bsA");
  assert.ok(ids[1] && ids[1] !== "bsA");
  assert.equal(currentDocument().rows[1].visualText, "intro<br>" + KEY(ids[1]) + " the gulls");
  const card = '<a class="video-embed-card" href="https://youtu.be/x">x</a>';
  currentDocument().rows[1].visualText = sanitizeHtml(card + "<br>" + KEY("bsA") + " the gulls");
  assert.equal(anchorBrollInRows(currentDocument(), undefined, { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml }), 1);
  assert.match(currentDocument().rows[1].visualText, /video-embed-card/);
  const moved = brollInCell(cellOf(currentDocument().rows[1].visualText));
  assert.deepEqual(moved.map((b) => b.name), ["the gulls"]);
  assert.ok(moved[0].id && moved[0].id !== "bsA");
});

test("anchoring: an unanchored line never takes the record a keyed line further down holds", () => {
  loadTestDocument({
    rows: [
      { id: "r0", visualText: "B-roll: the gulls", audioText: "" },
      { id: "r1", visualText: KEY("bsA") + " the gulls", audioText: "" }
    ],
    brollShots: [{ id: "bsA", name: "the gulls", desc: "", status: "shot", origin: "script" }],
    productionTags: []
  });
  assert.equal(anchorBrollInRows(currentDocument(), undefined, { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml }), 1);
  const id = brollInCell(cellOf(currentDocument().rows[0].visualText))[0].id;
  assert.ok(id && id !== "bsA", "a new id, not the keyed line's: " + id);
  assert.equal(currentDocument().rows[1].visualText, KEY("bsA") + " the gulls");
});

test("renaming: the line becomes the key and the new name, as the old rename wrote it", () => {
  let renamed = 0;
  for (const html of STORED.concat(BROLL_CELLS)) {
    const before = brollInCell(cellOf(html));
    if (commentsAKeyOrBlank(html)) continue;
    before.forEach((b, ordinal) => {
      const id = b.id || "bsNew";
      const after = withRow(html, () => {
        assert.ok(renameBrollInScript({ rowId: "r0", ordinal, id }, "a new <name> & more"));
        return currentDocument().rows[0].visualText;
      });
      assert.deepEqual(bareBreaks(cellOf(after)), bareBreaks(cellOf(oldRename(html, ordinal, id, "a new <name> & more"))), html);
      const read = brollInCell(cellOf(after));
      assert.equal(read.length, before.length);
      assert.deepEqual(read[ordinal], { id, name: "a new <name> & more", desc: b.desc });
      renamed++;
    });
  }
  assert.ok(renamed > 1000, "renamed " + renamed);
  withRow("no markers", () => {
    assert.equal(renameBrollInScript({ rowId: "r0", ordinal: 0, id: "x" }, "n"), false);
    assert.equal(renameBrollInScript({ rowId: "r0", ordinal: -1, id: "x" }, "n"), false);
  });
});

test("anchoring and renaming in a cell still holding a video card keep the card", () => {
  const card = '<a class="video-embed-card" href="https://youtu.be/x">x</a>';
  const html = sanitizeHtml("intro " + card + "<br><strong>B-roll:</strong> the gulls<br>" + KEY("b9") + " drone");
  withRow(html, (row, doc) => {
    assert.equal(anchorBrollInRows(doc, [row], { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml }), 1);
    assert.match(row.visualText, /video-embed-card/);
    const read = brollInCell(cellOf(row.visualText));
    assert.deepEqual(read.map((b) => b.name), ["the gulls", "drone"]);
    assert.ok(read[0].id && read[1].id === "b9");
    assert.ok(renameBrollInScript({ rowId: "r0", ordinal: 1, id: "b9" }, "high drone"));
    assert.match(row.visualText, /video-embed-card/);
    assert.deepEqual(brollInCell(cellOf(row.visualText)).map((b) => [b.id, b.name]), [[read[0].id, "the gulls"], ["b9", "high drone"]]);
  });
});

test("a pasted key's record is a new shot seeded from its scene; a moved one keeps the record it had", () => {
  const moved = { id: "bsMoved", name: "old name", desc: "", status: "shot", reshoot: false, notes: "got it", owner: "", audioRef: "", location: "", origin: "script" };
  const doc = {
    rows: [{
      id: "r0",
      visualText: KEY("bsNew") + " the gulls<br>over the pier<br>" + KEY("bsMoved") + " drone<br>mid-line " + KEY("bsLoose"),
      audioText: "Waves on the " + tagSpan("location", "Pier", "pier")
    }],
    brollShots: [moved],
    productionTags: []
  };
  loadTestDocument(doc);
  recordPastedBroll(doc, "r0", cellOf(doc.rows[0].visualText), ["bsNew", "bsMoved", "bsLoose"]);
  assert.deepEqual(currentDocument().brollShots.map((r) => r.id), ["bsMoved", "bsNew"]);
  assert.equal(currentDocument().brollShots[0], moved);
  assert.equal(moved.status, "shot");
  assert.equal(moved.notes, "got it");
  const rec = currentDocument().brollShots[1];
  assert.equal(rec.name, "the gulls");
  assert.equal(rec.desc, "over the pier");
  assert.equal(rec.status, "unshot");
  assert.equal(rec.notes, "");
  assert.equal(rec.origin, "script");
  assert.equal(rec.audioRef, "Waves on the pier");
  assert.equal(rec.location, "Pier");
});

test("brollPropsInCell: the prop tags on each item's own lines, one array per item, lined up with brollInCell", () => {
  const html = sanitizeHtml(
    "Open on the " + tagSpan("prop", "Kettle", "kettle") + "<br>" +
    KEY("b1") + " the " + tagSpan("prop", "Red mug", "red mug") + " on the sill<br>" +
    "with the " + tagSpan("prop", "Tea towel", "towel") + " and a " + tagSpan("location", "Kitchen", "kitchen") +
      " and the " + tagSpan("prop", "Red mug", "mug") + " again<br>" +
    "<strong>B-roll:</strong> steam, <strong>" + tagSpan("prop", "Kettle", "kettle") + "</strong><br>" +
    KEY("b3") + " nothing needed");
  const cell = cellOf(html);
  assert.deepEqual(brollInCell(cell).map((b) => b.name), ["the red mug on the sill", "steam, kettle", "nothing needed"]);
  assert.deepEqual(brollPropsInCell(cell), [["Red mug", "Tea towel"], ["Kettle"], []]);
  assert.deepEqual(brollPropsInCell(cellOf("no markers " + tagSpan("prop", "Kettle", "kettle"))), []);
});

function propsDoc() {
  loadTestDocument(migrateRows({
    schema: 2,
    rows: [
      { id: "r0", visualText: KEY("b1") + " the " + tagSpan("prop", "Red mug", "red mug") + " on the sill", audioText: "Morning." },
      { id: "r1", visualText: KEY("b2") + " drone over the pier", audioText: "" }
    ],
    productionTags: [{ cat: "prop", name: "Red mug", status: "have" }, { cat: "prop", name: "Kettle" }],
    brollShots: [{ id: "b1", name: "the red mug on the sill" }, { id: "b2", name: "drone over the pier" }]
  }));
  return currentDocument();
}
const shotsBy = () => {
  const out = {};
  const by = brollShotsByProp();
  Object.keys(by).forEach((k) => { out[k] = by[k]; });
  return out;
};

test("addBrollProp: an existing prop by any spelling, or a new registry entry for a new name", () => {
  const s = propsDoc();
  const kettle = s.productionTags.find((t) => t.name === "Kettle");
  assert.equal(addBrollProp("b2", "  KETTLE "), true);
  assert.deepEqual(s.brollShots[1].props, [{ id: kettle.id, name: "Kettle" }]);
  assert.equal(addBrollProp("b2", "kettle"), false, "already there");
  assert.equal(addBrollProp("b2", "Drone batteries"), true);
  const added = s.productionTags.find((t) => t.name === "Drone batteries");
  assert.ok(added && added.cat === "prop" && added.id, "registered as a prop, the way the Gear box registers a line");
  assert.deepEqual(s.brollShots[1].props.map((p) => p.id), [kettle.id, added.id]);
  assert.equal(addBrollProp("b2", "   "), false);
  assert.equal(addBrollProp("nope", "Kettle"), false);
});

test("removeBrollProp takes a hand-added prop off by its key and leaves the breakdown alone", () => {
  const s = propsDoc();
  addBrollProp("b2", "Kettle");
  const key = brollPropKey(s.brollShots[1].props[0].id, "Kettle");
  assert.equal(removeBrollProp("b2", key, { run: runDocumentEdit }), true);
  assert.deepEqual(s.brollShots[1].props, []);
  assert.ok(s.productionTags.some((t) => t.name === "Kettle"));
  assert.equal(removeBrollProp("b2", key, { run: runDocumentEdit }), false);
});

test("the shots a prop is needed by: tagged on the line or added by hand, each once", () => {
  propsDoc();
  addBrollProp("b1", "red mug");
  addBrollProp("b2", "Red mug");
  addBrollProp("b2", "Kettle");
  assert.deepEqual(shotsBy(), {
    "prop red mug": ["the red mug on the sill", "drone over the pier"],
    "prop kettle": ["drone over the pier"]
  });
});

test("renaming a prop in the breakdown carries through to the shots that need it", () => {
  const s = propsDoc();
  addBrollProp("b2", "Kettle");
  const id = s.brollShots[1].props[0].id;
  assert.ok(renameTag("prop", "Kettle", "Whistling kettle", { run: runDocumentEdit, rewrites: retagRewrites, stamps: sessionStamps }));
  assert.deepEqual(s.brollShots[1].props, [{ id: id, name: "Whistling kettle" }]);
  assert.deepEqual(shotsBy()["prop whistling kettle"], ["drone over the pier"]);
});

test("renaming a prop onto another's name re-points the shots at the one it folded into", () => {
  const s = propsDoc();
  addBrollProp("b2", "Kettle");
  const mug = s.productionTags.find((t) => t.name === "Red mug");
  renameTag("prop", "Kettle", "red mug", { run: runDocumentEdit, rewrites: retagRewrites, stamps: sessionStamps });
  assert.equal(s.productionTags.filter((t) => t.cat === "prop").length, 1);
  assert.deepEqual(s.brollShots[1].props, [{ id: mug.id, name: "Red mug" }]);
});

test("a prop deleted from the breakdown still shows on the shot by its name, with no status", () => {
  const s = propsDoc();
  addBrollProp("b2", "Kettle");
  s.productionTags = s.productionTags.filter((t) => t.name !== "Kettle");
  assert.deepEqual(shotsBy()["prop kettle"], ["drone over the pier"]);
});

test("a pasted copy of a shot's line gets none of its hand-added props", () => {
  const s = propsDoc();
  addBrollProp("b1", "Kettle");
  s.rows[1].visualText = KEY("bsPasted") + " the " + tagSpan("prop", "Red mug", "red mug") + " on the sill";
  recordPastedBroll(s, "r1", cellOf(s.rows[1].visualText), ["bsPasted"]);
  const rec = s.brollShots.find((r) => r.id === "bsPasted");
  assert.ok(rec);
  assert.deepEqual(rec.props, []);
  assert.equal(s.brollShots[0].props.length, 1, "the original keeps its own");
});

test("the breakdown CSV names the b-roll shots each prop is needed for, after the old columns", () => {
  propsDoc();
  addBrollProp("b2", "Kettle");
  const lines = buildBreakdownCsv(liveDoc()).replace(/^\uFEFF/, "").split("\r\n");
  assert.equal(lines[0], "Category,Item,Status,Assigned to,Mentions,Scenes,In script,Notes,B-roll shots,First scene at,Group");
  const kettle = lines.find((l) => l.startsWith("Prop,Kettle,"));
  assert.ok(kettle.endsWith(",drone over the pier,,Props & set dressing"), kettle);
  const mug = lines.find((l) => l.startsWith("Prop,Red mug,"));
  assert.ok(mug.endsWith(",the red mug on the sill,00:00,Props & set dressing"), mug);
});

test("the shot list CSV: one row per shot in script order, with a Props column, nothing written", () => {
  const s = propsDoc();
  addBrollProp("b2", "Kettle");
  s.brollShots[1].notes = "wide, then \"tight\"";
  s.brollShots[1].reshoot = true;
  s.rows.push({ id: "r2", visualText: "B-roll: an unanchored line", audioText: "" });
  const before = JSON.stringify(s.brollShots);
  const lines = buildBrollCsv(liveDoc()).replace(/^\uFEFF/, "").split("\r\n");
  assert.equal(JSON.stringify(s.brollShots), before, "building the file adds no record");
  assert.equal(lines[0], "Scene,Shot,Status,Flagged,Location,Props,Cuts against,Assigned to,Note,Description,Scene start");
  assert.equal(lines.length, 4);
  const at = (i) => sceneFacts(exportDocumentOf(currentDocument()))[i].start;
  assert.equal(lines[1], "01,the red mug on the sill,To shoot,,,Red mug,,,,,00:00");
  assert.equal(lines[2], '02,drone over the pier,To shoot,yes,,Kettle,,,"wide, then ""tight""",,' + at(1));
  assert.equal(lines[3], "03,an unanchored line,To shoot,,,,,,,," + at(2));
});

test("the printed shot list is a PDF of the shots as shown, flagged ones marked", () => {
  const s = propsDoc();
  s.brollShots[1].reshoot = true;
  s.brollShots[1].notes = "too dark";
  const text = Buffer.from(buildShotListPdf(liveDoc(), printData())).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.includes("(the red mug on the sill) Tj"));
  assert.ok(text.includes("(drone over the pier) Tj"));
  assert.ok(text.includes("0.769 0.188 0.165 rg BT /F2 8.5 Tf") && text.includes("(Flagged) Tj"), "Flagged, bold and red");
  assert.ok(text.includes("(too dark) Tj"), "the reason under it");
  assert.ok(!text.includes("FLAGGED"));
  assert.ok(text.includes("(Red mug \\(have it\\)) Tj"), "each prop with its status in words");
  assert.match(text, /\/Count 1 >>/);
  assert.match(text, /\/MediaBox \[0 0 792 612\]/);
});
