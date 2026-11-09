import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCells } from "../../../src/core/merge/cells.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { spokenText, toDocxRuns, toMarkdown, toPlainText } from "../../../src/core/text/projections.ts";
import { atomId, cellLength, normalizeCell, projection, whoName } from "../../../src/core/text/runs.ts";
import type { Run, WhoRun } from "../../../src/core/text/runs.ts";
import { findInCell } from "../../../src/core/text/search.ts";
import { deleteRange, insertText } from "../../../src/core/text/edits.ts";
import { insertWho, startsWho, whoSentences, withoutWho } from "../../../src/core/text/who.ts";
import { OBJ, T } from "./cells.ts";

function who(name: string, marks = {}): WhoRun {
  return { atom: "who", name: name, text: "@" + name, marks: marks };
}

const KETTLE = T("kettle", { tag: "t:prop:Kettle" });
const MUG = T("mug", { tag: "t:prop:Mug" });

test("the @ trigger counts at the start of a line and after whitespace or punctuation, never inside a word", () => {
  for (const before of ["", "Ask ", "line\n", "(", "Hi,", "end.", "say “", "tab\t", "a ", "—"]) {
    assert.equal(startsWho(before), true, JSON.stringify(before));
  }
  for (const before of ["adam", "x2", "café", "A"]) assert.equal(startsWho(before), false, JSON.stringify(before));
});

test("a who run is one position whose text is @ and the name; a blank name leaves no run", () => {
  const cell = normalizeCell([T("Ask "), { atom: "who", name: "  @@Sam   Lee ", marks: { b: true, tag: "t:prop:X" } }, T(" now"),
    { atom: "who", name: "  @ ", marks: {} }]);
  assert.deepEqual(cell, [T("Ask "), who("Sam Lee", { b: true }), T(" now")]);
  assert.equal(cellLength(cell), 9);
  assert.equal(projection(cell), "Ask " + OBJ + " now");
  assert.equal(atomId(cell[1] as WhoRun), "who:Sam Lee");
  assert.equal(whoName("x".repeat(70)), "x".repeat(60));
});

test("toHtml writes the chip as an uneditable span that carries the name", () => {
  assert.equal(toHtml([T("Ask "), who("A&B \"Q\"")]),
    'Ask <span class="who-anchor" data-who="A&amp;B &quot;Q&quot;" contenteditable="false">@A&amp;B "Q"</span>');
});

test("insertWho replaces the typed @name with one chip and puts the caret after it", () => {
  const cell = [T("Ask @sa now")];
  const out = insertWho(cell, 4, 7, "Sam");
  assert.ok(out);
  assert.deepEqual(out.cell, [T("Ask "), who("Sam"), T(" now")]);
  assert.equal(out.end, 5);
  assert.equal(insertWho(cell, 4, 7, "  @ "), null);
});

test("deleting the chip's one position removes the whole chip", () => {
  const cell = normalizeCell([T("Ask "), who("Sam"), T(" now")]);
  assert.deepEqual(deleteRange(cell, 4, 5), [T("Ask  now")]);
  assert.deepEqual(insertText(cell, 5, "!"), [T("Ask "), who("Sam"), T("! now")]);
});

test("withoutWho drops the chip and the space it leaves behind", () => {
  const cases: [Run[], Run[]][] = [
    [[T("Ask "), who("Sam"), T(" now")], [T("Ask now")]],
    [[T("Ask "), who("Sam"), T(".")], [T("Ask.")]],
    [[T("Ask "), who("Sam")], [T("Ask")]],
    [[who("Sam"), T(" opens.")], [T("opens.")]],
    [[T("one\n"), who("Sam"), T(" two")], [T("one\ntwo")]],
    [[T("Ask "), who("Sam"), T(" and "), who("Ann"), T(".")], [T("Ask and.")]],
    [[KETTLE, T(" "), who("Sam")], [KETTLE]],
    [[T("x"), who("Sam"), T("y")], [T("xy")]],
    [[T("plain")], [T("plain")]]
  ];
  for (const [cell, want] of cases) assert.deepEqual(withoutWho(cell), want, JSON.stringify(cell));
});

test("every text projection skips the chip: plain text, spoken text, markdown and docx runs", () => {
  const cell = [T("Fill the "), KETTLE, T(" "), who("Sam"), T(". "), T("Bold", { b: true }), T(" "), who("Ann", { b: true }), T(" end")];
  assert.equal(toPlainText(cell), "Fill the kettle. Bold end");
  assert.equal(spokenText(cell), "Fill the kettle. Bold end");
  assert.equal(toMarkdown(cell), "Fill the kettle. **Bold** end");
  assert.equal(toDocxRuns(cell).map((r) => r.text).join(""), "Fill the kettle. Bold end");
});

test("whoSentences pairs each sentence's names with that sentence's tags only", () => {
  const cell = [
    T("Fill the "), KETTLE, T(" and "), MUG, T(" "), who("Sam"), T(". Then "), MUG, T(" again!\n"),
    who("Ann"), T(" brings the "), KETTLE, T(" (“now.”) Later "), MUG, T(".")
  ];
  assert.deepEqual(whoSentences(cell), [
    { tags: ["t:prop:Kettle", "t:prop:Mug"], names: ["Sam"] },
    { tags: ["t:prop:Kettle"], names: ["Ann"] }
  ]);
  assert.deepEqual(whoSentences([KETTLE, T(" for "), who("Sam")]), [{ tags: ["t:prop:Kettle"], names: ["Sam"] }]);
  assert.deepEqual(whoSentences([T("v1.2 "), who("Sam"), T(" "), KETTLE]), [{ tags: ["t:prop:Kettle"], names: ["Sam"] }]);
  assert.deepEqual(whoSentences([KETTLE, T(" only")]), []);
});

test("whoSentences associates a person with every nested label", () => {
  assert.deepEqual(whoSentences([who("Sam"), T(" "), T("umbrella", {
    tag: "t:sound:Rain", innerTags: ["t:prop:Umbrella"]
  })]), [{ tags: ["t:sound:Rain", "t:prop:Umbrella"], names: ["Sam"] }]);
});

test("find skips the chip, so a search for its name or the @ never matches inside it", () => {
  const cell = normalizeCell([T("Sam says "), who("Sam"), T(" @ home")]);
  assert.deepEqual(findInCell(cell, "Sam", false).length, 1);
  assert.deepEqual(findInCell(cell, "@", false).length, 1);
});

function chipped(cell: readonly Run[], from: number, to: number, name: string): Run[] {
  const out = insertWho(cell, from, to, name);
  assert.ok(out);
  return out.cell;
}

test("merge: chips each side adds both land, and a chip one side deletes is gone", () => {
  const o = normalizeCell([T("Fill the kettle. Wash the mug.")]);
  const mine = chipped(insertText(o, 15, " "), 16, 16, "Sam");
  const theirs = chipped(insertText(o, 29, " "), 30, 30, "Ann");
  const both = mergeCells(o, mine, theirs);
  assert.equal(both.conflict, false);
  assert.deepEqual(both.cell, [T("Fill the kettle "), who("Sam"), T(". Wash the mug "), who("Ann"), T(".")]);
  const removed = deleteRange(both.cell, 16, 17);
  const deleted = mergeCells(both.cell, removed, both.cell);
  assert.deepEqual(deleted.cell, [T("Fill the kettle . Wash the mug "), who("Ann"), T(".")]);
  const swapped = mergeCells(both.cell, removed, chipped(both.cell, 16, 17, "Lee"));
  assert.equal(swapped.cell.some((r) => r.atom === "who" && r.name === "Sam"), false);
});
