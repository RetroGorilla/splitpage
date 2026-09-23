/* The b-roll list on the document model (#85, docs/DOCUMENT-MODEL.md §10
 * steps 3 and 4): reading the "B-roll:" lines out of a visual cell, giving
 * an unanchored line its key, and renaming a shot's line (08c-broll.js).
 *
 * All three used to parse the stored HTML. The old code is kept here
 * verbatim as the reference, and the new one is checked against it over
 * stored-shaped cells (_stored-cells.mjs) and cells written the way b-roll
 * lines come in — typed keys, pasted and imported plain-text markers, keys
 * and markers inside formatting, comments and links. The reader must give
 * exactly what it gave; the edits must leave the cell reading exactly as
 * the old ones left it.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { escapeHtml } from "../js/02-state.js";
import { inertBody, sanitizeHtml } from "../js/04-richtext.js";
import { cellOf, normalizeCell } from "../js/04c-doc-model.js";
import {
  BROLL_MARKER_RE, __init as brollInit, anchorBrollInRows, brollInCell, renameBrollInScript
} from "../js/08c-broll.js";
import { STORED, rng, tagSpan } from "./_stored-cells.mjs";

brollInit();

/* ---- the old code, verbatim but for its imports ---- */

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
/* anchorBrollInRows for one cell, the id for each unanchored ordinal given */
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

/* ---- cells ---- */

const KEY = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;

/* Visual cells the way b-roll lines arrive: typed keys, plain-text markers
   in every spelling (pasted, imported, round-tripped through Markdown),
   indentation, and any of it inside formatting, comments, links and tags. */
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

/* ---- reading ---- */

test("reading: every stored cell and every b-roll cell reads exactly as the HTML reader read it", () => {
  let markers = 0, keyed = 0, plain = 0;
  for (const html of STORED.concat(BROLL_CELLS)) {
    const before = oldBrollInField(html);
    assert.deepEqual(brollInCell(cellOf(html)), before, html);
    markers += before.length;
    before.forEach((b) => { if (b.id) keyed++; else plain++; });
  }
  assert.ok(keyed > 500 && plain > 500, "the cells exercise both kinds of marker: " + keyed + " keyed, " + plain + " plain");
  assert.ok(markers > 1000);
});

test("reading: where the model reads differently, by design", () => {
  const read = (h) => brollInCell(cellOf(sanitizeHtml(h)));
  /* a line feed inside a text node shows as a space (white-space: normal),
     and a zero-width space is a caret spot, never content — as for every
     reader of the model (readers.test.mjs) */
  assert.deepEqual(oldBrollInField("B-roll: a\nb"), [{ id: "", name: "a\nb", desc: "" }]);
  assert.deepEqual(read("B-roll: a\nb"), [{ id: "", name: "a b", desc: "" }]);
  assert.deepEqual(oldBrollInField("​B-roll: a"), []);
  assert.deepEqual(read("​B-roll: a"), [{ id: "", name: "a", desc: "" }]);
  /* two shapes no version of the app writes (a typed key and an anchored
     one both start their line bare): a key after an empty formatting
     element, or inside a tag, is the key it is — the HTML reader took its
     words for a plain marker, which the anchoring pass then replaced with
     a key of its own */
  const empty = sanitizeHtml("<strong></strong>" + KEY("b1") + " gulls");
  assert.deepEqual(oldBrollInField(empty), [{ id: "", name: "gulls", desc: "" }]);
  assert.deepEqual(read(empty), [{ id: "b1", name: "gulls", desc: "" }]);
  const inTag = sanitizeHtml(tagSpan("prop", "It", KEY("b1") + " gulls"));
  assert.deepEqual(oldBrollInField(inTag), [{ id: "", name: "gulls", desc: "" }]);
  assert.deepEqual(read(inTag), [{ id: "b1", name: "gulls", desc: "" }]);
});

/* ---- anchoring and renaming ----

   The old edits split every formatting element, tag and comment round a
   line break into two before they began (hoistNestedBrs), all over the
   cell, whichever line they were editing: a comment over two lines came
   out as two anchors with the line break between them outside both, and a
   tag with a line break in it as two tags. The model's edits touch only the
   line they edit. So the cells are compared with every line break's own
   marks taken off — the one difference, and one no reader can see but the
   comment's anchor and the tag's mention count, which the old edit broke. */
function bareBreaks(cell) {
  const runs = [];
  for (const r of cell) {
    if (r.atom) { runs.push(r); continue; }
    r.text.split(/(\n)/).forEach((t) => { if (t) runs.push({ text: t, marks: t === "\n" ? {} : r.marks }); });
  }
  return normalizeCell(runs);
}

function withRow(html, fn) {
  S.state = { rows: [{ id: "r0", visualText: html, audioText: "" }], brollShots: [], productionTags: [] };
  return fn(S.state.rows[0]);
}

test("anchoring: every unanchored line gets its key where the old pass put it", () => {
  let anchored = 0;
  for (const html of STORED.concat(BROLL_CELLS)) {
    const before = brollInCell(cellOf(html));
    if (!before.some((b) => !b.id)) continue;
    const after = withRow(html, (row) => {
      const n = anchorBrollInRows([row]);
      assert.equal(n, before.filter((b) => !b.id).length, html);
      return row.visualText;
    });
    /* the ids the pass minted, by ordinal, handed to the old pass */
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

test("renaming: the line becomes the key and the new name, as the old rename wrote it", () => {
  let renamed = 0;
  for (const html of STORED.concat(BROLL_CELLS)) {
    const before = brollInCell(cellOf(html));
    before.forEach((b, ordinal) => {
      const id = b.id || "bsNew";
      const after = withRow(html, () => {
        assert.ok(renameBrollInScript({ rowId: "r0", ordinal, id }, "a new <name> & more"));
        return S.state.rows[0].visualText;
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
  withRow(html, (row) => {
    assert.equal(anchorBrollInRows([row]), 1);
    assert.match(row.visualText, /video-embed-card/);
    const read = brollInCell(cellOf(row.visualText));
    assert.deepEqual(read.map((b) => b.name), ["the gulls", "drone"]);
    assert.ok(read[0].id && read[1].id === "b9");
    assert.ok(renameBrollInScript({ rowId: "r0", ordinal: 1, id: "b9" }, "high drone"));
    assert.match(row.visualText, /video-embed-card/);
    assert.deepEqual(brollInCell(cellOf(row.visualText)).map((b) => [b.id, b.name]), [[read[0].id, "the gulls"], ["b9", "high drone"]]);
  });
});
