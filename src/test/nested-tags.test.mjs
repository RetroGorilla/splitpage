import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fromHtml, sanitizeHtml } from "../bootstrap/richtext.ts";
import { toHtml } from "../core/text/html.ts";
import { normalizeCell, sameCell, tagIds } from "../core/text/runs.ts";
import { addComment, retag, setMark, typingMarks } from "../core/text/edits.ts";
import { mergeCells } from "../core/merge/cells.ts";
import { toPlainText } from "../core/text/projections.ts";
import { splitCell, joinCells, sliceCell } from "../core/text/edits.ts";
import { replaceText } from "../core/text/edits.ts";
import { mergeCells as beforeMergeCells } from "../../tests/core/text/before-nested-merge.ts";

const tag = (cat, name, inner) => `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${inner}</span>`;
const outer = "t:sound:Rain on umbrella";
const inner = "t:prop:Umbrella";
const nested = tag("sound", "Rain on umbrella", "rain on " + tag("prop", "Umbrella", "umbrella"));

test("nested HTML retains every enclosing label and its canonical containment", () => {
  const cell = fromHtml(nested);
  assert.deepEqual(cell, [
    { text: "rain on ", marks: { tag: outer } },
    { text: "umbrella", marks: { tag: outer, innerTags: [inner] } }
  ]);
  assert.equal(toHtml(cell), nested);
  assert.equal(sanitizeHtml(toHtml(cell)), nested);
  assert.deepEqual(fromHtml(toHtml(cell)), cell);
  assert.deepEqual(tagIds(cell), [outer, inner]);
});

test("removing or rewriting either label keeps the other label and all words", () => {
  const cell = fromHtml(nested);
  assert.equal(toHtml(retag(cell, outer, null)), "rain on " + tag("prop", "Umbrella", "umbrella"));
  assert.equal(toHtml(retag(cell, inner, null)), tag("sound", "Rain on umbrella", "rain on umbrella"));
  assert.equal(toHtml(retag(cell, inner, "t:gear:Parasol")), tag("sound", "Rain on umbrella", "rain on " + tag("gear", "Parasol", "umbrella")));
  assert.deepEqual(typingMarks(cell, 12), {});
});

test("normalization keeps ordered depths, filters missing records and protects the whole outer tag", () => {
  const cell = fromHtml(nested);
  const withComment = addComment(cell, 10, 12, "c1");
  assert.ok(withComment.every(r => r.marks.cmt?.includes("c1")));
  assert.equal(toHtml(normalizeCell(cell, { hasTag: id => id === inner })), "rain on " + tag("prop", "Umbrella", "umbrella"));
  assert.equal(sameCell(cell, fromHtml(tag("prop", "Umbrella", tag("sound", "Rain on umbrella", "rain on umbrella")))), false);
  assert.deepEqual(normalizeCell(cell), normalizeCell(normalizeCell(cell)));
});

test("merge retains an inner-label edit alongside independent formatting and reports competing nesting", () => {
  const base = fromHtml(tag("sound", "Rain on umbrella", "rain on umbrella"));
  const mine = fromHtml(nested);
  const theirs = setMark(base, 0, 16, "b", true);
  const merged = mergeCells(base, mine, theirs);
  assert.equal(merged.conflict, false);
  assert.equal(merged.markConflicts, 0);
  assert.deepEqual(tagIds(merged.cell), [outer, inner]);
  assert.ok(merged.cell.every(r => r.marks.b));
  const rival = fromHtml(tag("sound", "Rain on umbrella", "rain on " + tag("gear", "Parasol", "umbrella")));
  const conflict = mergeCells(base, mine, rival);
  assert.ok(conflict.markConflicts > 0);
  assert.deepEqual(conflict.cell, rival);
});

test("deep containment, repeated records, siblings and formatting survive cuts at every model position", () => {
  const html = tag("location", "Park", "at " + tag("sound", "Rain", "rain on " + tag("prop", "Umbrella", "<em>umbrella</em>")) +
    " by " + tag("prop", "Umbrella", tag("prop", "Umbrella", "another umbrella"))) + " end";
  const cell = fromHtml(html);
  assert.equal(toHtml(cell), html);
  assert.equal(toPlainText(cell), "at rain on umbrella by another umbrella end");
  for (let pos = 0; pos <= 42; pos++) {
    const [left, right] = splitCell(cell, pos);
    assert.deepEqual(joinCells(fromHtml(toHtml(left)), fromHtml(toHtml(right))), cell);
  }
  assert.equal(toHtml(sliceCell(cell, 11, 19)), tag("location", "Park", tag("sound", "Rain", tag("prop", "Umbrella", "<em>umbrella</em>"))));
  assert.equal(toHtml(retag(cell, "t:location:Park", null)), "at " + tag("sound", "Rain", "rain on " + tag("prop", "Umbrella", "<em>umbrella</em>")) +
    " by " + tag("prop", "Umbrella", tag("prop", "Umbrella", "another umbrella")) + " end");
});

test("missing render records unwrap only their own label and invalid marks never leak into atoms", () => {
  const html = toHtml(fromHtml(nested), { tagOf: id => id === inner ? { cat: "prop", name: "Umbrella" } : null });
  assert.equal(html, "rain on " + tag("prop", "Umbrella", "umbrella"));
  assert.deepEqual(normalizeCell([
    { text: "x", marks: { tag: outer, innerTags: [null, "", inner, 4] } },
    { atom: "broll", id: "bs1", text: "B-roll:", marks: { tag: outer, innerTags: [inner] } }
  ]), [
    { text: "x", marks: { tag: outer, innerTags: [inner] } },
    { atom: "broll", id: "bs1", text: "B-roll:", marks: {} }
  ]);
});

test("a concurrent rewrite of newly nested words reports a conflict instead of silently dropping the inner label", () => {
  const base = fromHtml(tag("sound", "Rain on umbrella", "rain on umbrella"));
  const mine = fromHtml(nested);
  const theirs = fromHtml(tag("sound", "Rain on umbrella", "rain on roof"));
  const result = mergeCells(base, mine, theirs);
  assert.equal(result.conflict, true);
  assert.equal(mergeCells(base, theirs, mine).conflict, true);
});

test("seeded old-format merges equal the pre-nesting algorithm, including conflicts and independent marks", () => {
  let seed = 1201;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const values = [true, "t:prop:Umbrella", "https://example.com/", ["c1"]];
  const names = ["b", "tag", "href", "cmt"];
  for (let i = 0; i < 500; i++) {
    let base = fromHtml("one two three four five");
    let mark = random(4);
    base = setMark(base, 4, 7, names[mark], values[mark]);
    const edit = () => {
      let side = base;
      const start = [0, 4, 8, 14, 19][random(5)];
      if (random(2)) side = replaceText(side, start, start + 3, random(2) ? "new" : "changed");
      mark = random(4);
      return setMark(side, start, start + 3, names[mark], random(3) ? values[mark] : false);
    };
    const mine = edit(), theirs = edit();
    assert.deepEqual(mergeCells(base, mine, theirs), beforeMergeCells(base, mine, theirs), `case ${i}`);
  }
});

test("seeded nested HTML is a sanitiser fixed point and keeps every enclosing label after a round trip", () => {
  let seed = 1201001;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 160; i++) {
    let html = random(2) ? "<strong>inside</strong>" : "inside";
    const depth = 1 + random(6);
    const expected = [];
    for (let d = 0; d < depth; d++) {
      const cat = ["prop", "sound", "gear", "location"][random(4)];
      const name = "Label " + d;
      expected.unshift(`t:${cat}:${name}`);
      html = tag(cat, name, (random(2) ? "before " : "") + html + (random(2) ? " after" : ""));
    }
    const cell = fromHtml(html);
    assert.deepEqual(tagIds(cell), expected);
    assert.equal(toHtml(cell), html);
    assert.equal(sanitizeHtml(toHtml(cell)), html);
    assert.deepEqual(fromHtml(toHtml(cell)), cell);
  }
});
