import { normalizeTagName } from "../core/document/tags.ts";
import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { inertBody, sanitizeHtml } from "../js/04-richtext.js";
import { cellOf } from "../legacy/richtext.ts";
import { projection, tagNameOf } from "../core/text/runs.ts";
import { toHtml } from "../core/text/html.ts";
import { tagFieldOccurrences, tagOccurrences, tagsInField } from "../js/07-production-tags.js";
import { removeTag, renameTag } from "../application/commands/production-actions.ts";
import { runDocumentEdit, sessionStamps, readSession, currentDocument } from "../legacy/session-bridge.ts";
import { retagRewrites as planRetagRewrites, retagMentions as countRetagMentions } from "../application/commands/tag-rewrites.ts";
import { sharedPorts } from "../bootstrap/wiring/shared-ports.ts";

const retagText = sharedPorts().text;
const retagRewrites = (tags, toName) => planRetagRewrites(retagText, tags, toName);
const retagMentions = (doc, tags) => countRetagMentions(retagText, doc, tags);
import { domProjection } from "../js/09-find-replace.js";
import { STORED, rng, tagSpan } from "./_stored-cells.mjs";
import { loadTestDocument } from "./_document.mjs";

function isInsideTagOrLink(el) {
  return !!(el && el.closest && el.closest(".tag-anchor, a"));
}

function oldTagFieldOccurrences(html, phrase, cat, name, countOnly, onlyOccurrence) {
  var body = inertBody(html);
  var doc = body.ownerDocument;
  var needle = phrase.toLowerCase();
  var hits = 0;
  var matchIndex = 0;
  function walk(node) {
    var kids = Array.prototype.slice.call(node.childNodes);
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.nodeType === 1) {
        if (!isInsideTagOrLink(child)) walk(child);
        continue;
      }
      if (child.nodeType !== 3) continue;
      if (isInsideTagOrLink(child.parentNode)) continue;
      var text = child.nodeValue || "";
      var hay = text.toLowerCase();
      var frag = doc.createDocumentFragment();
      var cursor = 0, at = hay.indexOf(needle), matched = false;
      while (at !== -1) {
        var before = at === 0 ? "" : text.charAt(at - 1);
        var after = text.charAt(at + phrase.length);
        if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) {
          var wrapThisOne = !countOnly && (onlyOccurrence === undefined || onlyOccurrence === matchIndex);
          if (wrapThisOne) {
            hits++;
            matched = true;
            if (at > cursor) frag.appendChild(doc.createTextNode(text.slice(cursor, at)));
            var span = doc.createElement("span");
            span.className = "tag-anchor";
            span.setAttribute("data-tag-cat", cat);
            span.setAttribute("data-tag-name", name);
            span.appendChild(doc.createTextNode(text.substr(at, phrase.length)));
            frag.appendChild(span);
            cursor = at + phrase.length;
          } else if (countOnly) {
            hits++;
          }
          matchIndex++;
        }
        at = hay.indexOf(needle, at + phrase.length);
      }
      if (matched) {
        if (cursor < text.length) frag.appendChild(doc.createTextNode(text.slice(cursor)));
        child.parentNode.replaceChild(frag, child);
      }
    }
  }
  walk(body);
  return { hits: hits, html: body.innerHTML };
}

function oldEachTagSpan(html, cat, name, fn) {
  var target = normalizeTagName(name);
  var body = inertBody(html);
  var changed = 0;
  Array.prototype.forEach.call(body.querySelectorAll(".tag-anchor"), function (el) {
    if (el.getAttribute("data-tag-cat") !== cat) return;
    if (normalizeTagName(el.getAttribute("data-tag-name")) !== target) return;
    fn(el);
    changed++;
  });
  return { changed: changed, html: changed ? sanitizeHtml(body.innerHTML) : html };
}

const oldRename = (html, cat, from, to) => oldEachTagSpan(html, cat, from, (el) => el.setAttribute("data-tag-name", to));
const oldRemove = (html, cat, name) => oldEachTagSpan(html, cat, name, (el) => {
  while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
  el.parentNode.removeChild(el);
});

const MARK = "t:prop:Zz";

function tagStretches(cell, id) {
  const out = [];
  let pos = 0, open = null;
  for (const r of cell) {
    const len = r.atom ? 1 : r.text.length;
    const on = !r.atom && r.marks.tag === id;
    if (on && open === null) open = pos;
    if (!on && open !== null) { out.push(open + ":" + pos); open = null; }
    pos += len;
  }
  if (open !== null) out.push(open + ":" + pos);
  return out;
}

function spanRanges(html) {
  const spans = new Map();
  domProjection(inertBody(html)).forEach((c, i) => {
    const node = c.sc.nodeType === 1 ? c.sc : c.sc.parentNode;
    const el = node.closest('.tag-anchor[data-tag-name="Zz"]');
    if (!el) return;
    if (!spans.has(el)) spans.set(el, [i, i + 1]);
    spans.get(el)[1] = i + 1;
  });
  return [...spans.values()].map(([a, b]) => a + ":" + b);
}

function withoutMark(cell) {
  return JSON.stringify(cell.map((r) => {
    if (r.atom || r.marks.tag !== MARK) return r;
    const m = Object.assign({}, r.marks);
    delete m.tag;
    return { text: r.text, marks: m };
  }).reduce((out, r) => {
    const last = out[out.length - 1];
    if (last && !last.atom && !r.atom && JSON.stringify(last.marks) === JSON.stringify(r.marks)) last.text += r.text;
    else out.push(Object.assign({}, r));
    return out;
  }, []));
}

const WORD = /[\p{L}\p{N}]/u;
const PHRASES = ["red", "mug", "the", "red mug", "bo", "ld", "é", "two", "lines", "'s", "q", "tab", "x"];

function phraseCells() {
  const r = rng(4242);
  const out = [];
  const pieces = ["red", "mug", " ", "red mug", "Red Mug", "the", "bo", "ld", ", ", "\n", "RED",
    "red <em>mug</em>", "<strong>Red</strong> mug", "the <u>red</u> mug"];
  for (let i = 0; i < 250; i++) {
    let h = "";
    const n = 1 + Math.floor(r() * 10);
    for (let k = 0; k < n; k++) {
      let p = pieces[Math.floor(r() * pieces.length)].replace(/\n/g, "<br>");
      const roll = r();
      if (roll < 0.15) p = "<strong>" + p + "</strong>";
      else if (roll < 0.22) p = '<span class="cmt-anchor" data-cmt="c1">' + p + "</span>";
      else if (roll < 0.27) p = '<a href="https://e.x/">' + p + "</a>";
      else if (roll < 0.33) p = tagSpan("prop", "Other", p);
      else if (roll < 0.36) p = '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span>';
      h += p;
    }
    out.push(sanitizeHtml(h));
  }
  return out;
}

const CELLS = STORED.slice(0, STORED.length - 900).concat(phraseCells());

test("tagging: every occurrence the old walk tagged is tagged, but for a neighbour across a formatting edge", () => {
  let crossed = 0, neighbour = 0, compared = 0;
  for (const html of CELLS) {
    const text = projection(cellOf(html));
    const dom = domProjection(inertBody(html));
    assert.equal(dom.map((c) => c.text).join(""), text, html);
    for (const phrase of PHRASES) {
      compared++;
      if (text.toLowerCase().indexOf(phrase) === -1) {
        assert.deepEqual(tagOccurrences(cellOf(html), phrase), []);
        continue;
      }
      const before = oldTagFieldOccurrences(html, phrase, "prop", "Zz", false);
      const oldRanges = before.hits ? spanRanges(sanitizeHtml(before.html)) : [];
      const found = tagOccurrences(cellOf(html), phrase);
      const newRanges = found.map((m) => m.from + ":" + m.to);
      for (const r of oldRanges) {
        if (newRanges.includes(r)) continue;
        const [a, b] = r.split(":").map(Number);
        assert.ok(WORD.test(text.charAt(a - 1)) || WORD.test(text.charAt(b)), JSON.stringify({ html, phrase, r, newRanges }));
        neighbour++;
      }
      for (const r of newRanges) {
        if (oldRanges.includes(r)) continue;
        const [a, b] = r.split(":").map(Number);
        const nodes = new Set(dom.slice(a, b).map((c) => c.sc));
        assert.ok(nodes.size > 1, JSON.stringify({ html, phrase, r, oldRanges }));
        crossed++;
      }
      const res = tagFieldOccurrences(html, phrase, "prop", "Zz", false);
      assert.equal(res.hits, found.length);
      if (!res.hits) { assert.equal(res.html, html); continue; }
      const after = cellOf(res.html);
      assert.deepEqual(tagStretches(after, MARK), newRanges, html);
      assert.equal(withoutMark(after), withoutMark(cellOf(html)), html);
      assert.equal(sanitizeHtml(res.html), res.html, "written canonical");
    }
  }
  assert.ok(compared > 10000);
  assert.ok(crossed > 0 && neighbour > 0, "the cells exercise both differences: " + crossed + ", " + neighbour);
});

test("tagging: the rules, one by one", () => {
  const tagged = (html, phrase, only) => tagStretches(cellOf(tagFieldOccurrences(html, phrase, "prop", "Zz", false, only).html), MARK);
  assert.equal(tagFieldOccurrences("A Red Mug.", "red mug", "prop", "Zz", false).html,
    'A <span class="tag-anchor" data-tag-cat="prop" data-tag-name="Zz" contenteditable="false">Red Mug</span>.');
  assert.deepEqual(tagged("Ana Anaïs ana", "ana"), ["0:3", "10:13"]);
  assert.deepEqual(tagged(tagSpan("prop", "Mug", "mug") + " mug", "mug"), ["4:7"]);
  assert.deepEqual(tagged('<a href="https://e.x/">mug</a> mug', "mug"), ["4:7"]);
  assert.deepEqual(tagged("red<br>mug red mug", "red mug"), ["8:15"]);
  assert.deepEqual(tagged('red <span class="broll-key" data-broll-id="b1" contenteditable="false">B-roll:</span> mug', "b-roll"), []);
  assert.deepEqual(tagged("red <strong>mug</strong>", "red mug"), ["0:7"]);
  assert.deepEqual(tagged('red <span class="cmt-anchor" data-cmt="c1">mug</span>', "red mug"), []);
  assert.deepEqual(tagged('<span class="cmt-anchor" data-cmt="c1">a red mug</span>', "red mug"), ["2:9"]);
  assert.deepEqual(tagged("mug, mug, mug", "mug", 1), ["5:8"]);
  assert.deepEqual(tagged("mug, mug, mug", "mug", 3), []);
  assert.deepEqual(tagFieldOccurrences("mug, mug", "mug", "prop", "Zz", true), { hits: 2, html: "mug, mug" });
});

test("tagging: a cell still holding a video card is tagged in place, the card kept", () => {
  const html = sanitizeHtml('a red <strong>mug</strong> <a class="video-embed-card" href="https://youtu.be/x">x</a> mug');
  assert.match(html, /video-embed-card/);
  const res = tagFieldOccurrences(html, "red mug", "prop", "Zz", false);
  assert.equal(res.hits, 1);
  assert.match(res.html, /video-embed-card/);
  assert.deepEqual(tagStretches(cellOf(res.html), MARK), ["2:9"]);
  assert.equal(sanitizeHtml(res.html), res.html);
});

function withRows(cells, fn) {
  loadTestDocument({ rows: cells.map((html, i) => ({ id: "r" + i, visualText: html, audioText: "" })), productionTags: [], brollShots: [], comments: [], people: [] });
  return fn();
}

test("rename and remove leave every stored cell reading as the old code left it, and count its mentions", () => {
  let renamed = 0, joined = 0;
  for (const html of CELLS) {
    const names = [...new Set(tagsInField(html).map((t) => t.catId + "\u0000" + t.name))];
    for (const key of names) {
      const [cat, name] = key.split("\u0000");
      const target = name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase();
      const was = oldRename(html, cat, name, target);
      const n = withRows([html], () => { renameTag(cat, name, target, { run: runDocumentEdit, rewrites: retagRewrites, stamps: sessionStamps }); return currentDocument().rows[0].visualText; });
      assert.deepEqual(cellOf(n), cellOf(was.html), JSON.stringify({ html, name }));
      assert.equal(sanitizeHtml(n), n);

      const gone = oldRemove(html, cat, name);
      let count = 0;
      const m = withRows([html], () => { count = removeTag(cat, name, { run: runDocumentEdit, read: readSession, mentions: retagMentions, rewrites: retagRewrites, stamps: sessionStamps }); return currentDocument().rows[0].visualText; });
      assert.equal(count, modelMentions(html, cat, name), html);
      assert.ok(count <= gone.changed, html);
      if (count < gone.changed) joined++;
      assert.deepEqual(cellOf(m), cellOf(gone.html), JSON.stringify({ html, name }));
      renamed++;
    }
  }
  assert.ok(renamed > 100, "enough tagged cells: " + renamed);
  assert.ok(joined > 0, "the cells do exercise two spans of one tag side by side");
});

test("rename: other tags keep their exact spelling; a cell without the tag is not touched", () => {
  const cellA = tagSpan("prop", "mug", "the mug") + " and " + tagSpan("prop", "Kettle", "kettle") + " <em><strong>x</strong></em>";
  const plain = "<em><strong>untouched</strong></em>";
  withRows([cellA, plain], () => {
    assert.ok(renameTag("prop", "MUG", "Cup", { run: runDocumentEdit, rewrites: retagRewrites, stamps: sessionStamps }));
    assert.equal(currentDocument().rows[0].visualText,
      '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Cup" contenteditable="false">the mug</span> and ' +
      '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Kettle" contenteditable="false">kettle</span> <strong><em>x</em></strong>');
    assert.equal(currentDocument().rows[1].visualText, plain);
    assert.equal(removeTag("prop", "cup", { run: runDocumentEdit, read: readSession, mentions: retagMentions, rewrites: retagRewrites, stamps: sessionStamps }), 1);
    assert.equal(currentDocument().rows[0].visualText,
      'the mug and <span class="tag-anchor" data-tag-cat="prop" data-tag-name="Kettle" contenteditable="false">kettle</span> <strong><em>x</em></strong>');
  });
});

test("rename and remove: two spans of one tag side by side are one mention, as the panel counts them", () => {
  const html = tagSpan("prop", "Mug", "a") + tagSpan("prop", "Mug", "b");
  withRows([html], () => {
    assert.equal(removeTag("prop", "mug", { run: runDocumentEdit, read: readSession, mentions: retagMentions, rewrites: retagRewrites, stamps: sessionStamps }), 1);
    assert.equal(currentDocument().rows[0].visualText, "ab");
  });
});

test("rename and remove in a cell still holding a video card keep the card", () => {
  const html = sanitizeHtml(tagSpan("prop", "Mug", "mug") + ' <a class="video-embed-card" href="https://youtu.be/x">x</a>');
  withRows([html], () => {
    assert.ok(renameTag("prop", "Mug", "Cup", { run: runDocumentEdit, rewrites: retagRewrites, stamps: sessionStamps }));
    assert.match(currentDocument().rows[0].visualText, /data-tag-name="Cup"/);
    assert.match(currentDocument().rows[0].visualText, /video-embed-card/);
    assert.equal(removeTag("prop", "Cup", { run: runDocumentEdit, read: readSession, mentions: retagMentions, rewrites: retagRewrites, stamps: sessionStamps }), 1);
    assert.doesNotMatch(currentDocument().rows[0].visualText, /tag-anchor/);
    assert.match(currentDocument().rows[0].visualText, /video-embed-card/);
  });
});

function modelMentions(html, cat, name) {
  const want = normalizeTagName(name);
  let n = 0, last = null;
  for (const r of cellOf(html)) {
    const id = r.atom ? null : r.marks.tag || null;
    if (id && id !== last) {
      const t = tagNameOf(id);
      if (t && t.cat === cat && normalizeTagName(t.name) === want) n++;
    }
    last = id;
  }
  return n;
}

function spanCount(html) {
  return [...inertBody(html).querySelectorAll(".tag-anchor")]
    .filter((el) => el.getAttribute("data-tag-cat") && (el.getAttribute("data-tag-name") || "").trim()).length;
}

test("tagsInField: on the shapes where spans and the model disagree, it counts what the cell keeps", () => {
  const broll = '<span class="broll-key" data-broll-id="b1" contenteditable="false">B-roll:</span>';
  const cases = [
    [tagSpan("prop", "Mug", "mug") + tagSpan("prop", "Mug", "mug"), 2, [["Mug", "mugmug"]]],
    [tagSpan("prop", "Mug", "a " + tagSpan("prop", "Cup", "b") + " c"), 2, [["Mug", "a"], ["Cup", "b"], ["Mug", "c"]]],
    ["x" + tagSpan("prop", "Mug", "") + "y", 1, []],
    [tagSpan("prop", "Mug", "a" + broll + "b"), 1, [["Mug", "a"], ["Mug", "b"]]]
  ];
  for (const [raw, spans, mentions] of cases) {
    const html = sanitizeHtml(raw);
    assert.equal(spanCount(html), spans, html);
    assert.deepEqual(tagsInField(html).map((t) => [t.name, t.text]), mentions, html);
    const written = toHtml(cellOf(html));
    assert.equal(spanCount(written), mentions.length, written);
    assert.deepEqual(tagsInField(written), tagsInField(html), written);
  }
});

test("tagsInField: a mention is one stretch of one tag, whatever formatting or comments cross it", () => {
  const html = sanitizeHtml(
    tagSpan("prop", "Mug", "the <strong>red</strong> mug") + " and " +
    '<span class="cmt-anchor" data-cmt="c1">' + tagSpan("cast", "Ann", "Ann") + "</span>" +
    tagSpan("prop", "Mug", "mug") + "<br>" + tagSpan("prop", "  ", "no name"));
  assert.deepEqual(tagsInField(html), [
    { catId: "prop", name: "Mug", text: "the red mug" },
    { catId: "cast", name: "Ann", text: "Ann" },
    { catId: "prop", name: "Mug", text: "mug" }
  ]);
});
