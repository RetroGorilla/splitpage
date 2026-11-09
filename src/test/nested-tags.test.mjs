import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fromHtml, sanitizeHtml } from "../bootstrap/richtext.ts";
import { toHtml } from "../core/text/html.ts";
import { normalizeCell, sameCell, tagIds, tagStack } from "../core/text/runs.ts";
import { addComment, retag, setMark, typingMarks } from "../core/text/edits.ts";
import { mergeCells } from "../core/merge/cells.ts";
import { toPlainText } from "../core/text/projections.ts";
import { splitCell, joinCells, sliceCell } from "../core/text/edits.ts";
import { explode, implode, replaceText, replaceWithTag } from "../core/text/edits.ts";
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

test("wrapping complete tag occurrences retains them beneath the new label", () => {
  const html = "before " + tag("prop", "Umbrella", "<strong>umbrella</strong>") + " after";
  assert.equal(toHtml(setMark(fromHtml(html), 0, 21, "tag", outer)), tag("sound", "Rain on umbrella", html));
  assert.equal(toHtml(setMark(fromHtml(nested), 8, 16, "tag", "t:gear:Parasol")),
    tag("sound", "Rain on umbrella", "rain on " + tag("gear", "Parasol", tag("prop", "Umbrella", "umbrella"))));
});

test("a new label wholly inside an existing occurrence keeps every enclosing label", () => {
  assert.equal(toHtml(setMark(fromHtml(nested), 10, 14, "tag", "t:gear:Parasol")),
    tag("sound", "Rain on umbrella", "rain on " + tag("prop", "Umbrella", "um" + tag("gear", "Parasol", "brel") + "la")));
});

test("a label crossing either edge of an occurrence is refused without changing any text or marks", () => {
  const html = "before " + tag("prop", "Umbrella", "<strong>umbrella</strong>") + " after";
  const cell = fromHtml(html), saved = structuredClone(cell);
  for (const [from, to] of [[0, 10], [10, 0], [10, 21], [21, 10]]) {
    assert.deepEqual(setMark(cell, from, to, "tag", outer), saved);
    assert.deepEqual(cell, saved);
  }
  assert.deepEqual(setMark(fromHtml(nested), 0, 11, "tag", "t:gear:Parasol"), fromHtml(nested));
});

test("replaceWithTag preserves complete enclosed labels and refuses partial or destructive replacements", () => {
  const cell = fromHtml(nested);
  assert.equal(toHtml(replaceWithTag(cell, 0, 16, "rain on umbrella", "t:location:Park").cell), tag("location", "Park", nested));
  assert.deepEqual(replaceWithTag(cell, 0, 11, "replacement", "t:location:Park").cell, cell);
  assert.deepEqual(replaceWithTag(cell, 0, 16, "replacement", "t:location:Park").cell, cell);
});

test("clearing a partial outer label or setting an invalid label changes nothing; a full removal keeps children", () => {
  const cell = fromHtml(nested);
  assert.deepEqual(setMark(cell, 10, 14, "tag", false), cell);
  assert.deepEqual(setMark(cell, 0, 16, "tag", true), cell);
  assert.deepEqual(setMark(cell, 0, 16, "tag", ""), cell);
  assert.equal(toHtml(setMark(cell, 0, 16, "tag", false)), "rain on " + tag("prop", "Umbrella", "umbrella"));
});

test("every range preserves existing labels and accepts exactly disjoint or fully contained tag placement", () => {
  const cell = fromHtml("x " + nested + " y"), chars = explode(cell);
  const spans = [{ from: 2, to: 18 }, { from: 10, to: 18 }];
  for (let from = 0; from <= chars.length; from++) for (let to = from; to <= chars.length; to++) {
    const crossing = from !== to && spans.some(span => from < span.to && to > span.from &&
      !(from <= span.from && to >= span.to) && !(from >= span.from && to <= span.to));
    const actual = setMark(cell, from, to, "tag", "t:gear:Parasol");
    if (crossing) { assert.deepEqual(actual, cell, `${from}..${to}`); continue; }
    const after = explode(actual);
    assert.equal(after.length, chars.length);
    for (let pos = 0; pos < after.length; pos++) {
      const ids = tagStack(after[pos].marks);
      assert.ok(tagStack(chars[pos].marks).every(id => ids.includes(id)), `${from}..${to} at ${pos}`);
      assert.equal(ids.includes("t:gear:Parasol"), pos >= from && pos < to);
    }
  }
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
  const legacyMark = (cell, from, to, name, value) => {
    const chars = explode(cell);
    for (let at = from; at < Math.min(to, chars.length); at++) {
      const c = chars[at];
      if (c.atom) continue;
      const marks = { ...c.marks };
      if (value === false) delete marks[name];
      else marks[name] = value;
      chars[at] = { ch: c.ch, marks };
    }
    return implode(chars);
  };
  for (let i = 0; i < 500; i++) {
    let base = fromHtml("one two three four five");
    let mark = random(4);
    base = setMark(base, 4, 7, names[mark], values[mark]);
    const edit = () => {
      let side = base;
      const start = [0, 4, 8, 14, 19][random(5)];
      if (random(2)) side = replaceText(side, start, start + 3, random(2) ? "new" : "changed");
      mark = random(4);
      return legacyMark(side, start, start + 3, names[mark], random(3) ? values[mark] : false);
    };
    const mine = edit(), theirs = edit();
    assert.ok([...base, ...mine, ...theirs].every(r => !r.marks.innerTags));
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
