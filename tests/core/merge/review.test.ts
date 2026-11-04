import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MERGE_DIFF_TOKEN_CAP,
  mergeDiffOps,
  mergeDiffPairHtml,
  mergeDiffTokenize,
  mergeFieldOutcome,
  mergeGallerySummary,
  mergeItemSummary,
  mergeListEntries,
  mergeRowFate
} from "../../../src/core/merge/review.ts";

test("field outcome: the side that changed wins, both changed or no base is a conflict, equal sides are nothing", () => {
  assert.equal(mergeFieldOutcome("b", "same", "same"), null);
  assert.equal(mergeFieldOutcome("b", "b", "t"), "theirs");
  assert.equal(mergeFieldOutcome("b", "m", "b"), "mine");
  assert.equal(mergeFieldOutcome("b", "m", "t"), "conflict");
  assert.equal(mergeFieldOutcome(null, "m", "t"), "conflict");
  assert.equal(mergeFieldOutcome(null, null, "t"), "conflict", "no base never reads as unchanged");
});

test("row fate: a scene on one side only says what happens to it, by whether it changed since the base", () => {
  const base = { id: "r1", audioText: "a", visualText: "", status: "todo" };
  const changed = { id: "r1", audioText: "changed", visualText: "", status: "todo" };
  assert.equal(mergeRowFate(base, base, base), null);
  assert.equal(mergeRowFate(base, base, null), "Deleted in the file on disk — it goes.");
  assert.equal(mergeRowFate(base, changed, null), "Deleted in the file on disk, but you changed it — your version stays.");
  assert.equal(mergeRowFate(null, changed, null), "A beat you added — it stays.");
  assert.equal(mergeRowFate(base, null, base), "You deleted this beat — it stays deleted.");
  assert.equal(mergeRowFate(base, null, changed), "You deleted this beat, but it changed on disk — it comes back.");
  assert.equal(mergeRowFate(null, null, changed), "A new beat from the file on disk.");
});

test("item summary: empty bits are left out and the rest joined with a middle dot", () => {
  assert.equal(mergeItemSummary(["Tape", "", null, "Sam", undefined, 0, "notes"]), "Tape · Sam · notes");
  assert.equal(mergeItemSummary([]), "");
});

test("word diff: whitespace is kept as its own token and each side marks only its own words", () => {
  assert.deepEqual(mergeDiffTokenize("a  b\nc"), ["a", "  ", "b", "\n", "c"]);
  assert.deepEqual(mergeDiffTokenize(null), []);
  assert.deepEqual(mergeDiffOps(["a", " ", "b"], ["a", " ", "c"]), [
    { op: "same", text: "a" }, { op: "same", text: " " }, { op: "del", text: "b" }, { op: "add", text: "c" }
  ]);
  assert.deepEqual(mergeDiffPairHtml("the cat", "the dog"), {
    mine: 'the <span class="diff-del">cat</span>',
    theirs: 'the <span class="diff-add">dog</span>'
  });
  assert.deepEqual(mergeDiffPairHtml("<b>&", "<b>& x"), {
    mine: "&lt;b&gt;&amp;",
    theirs: '&lt;b&gt;&amp;<span class="diff-add"> </span><span class="diff-add">x</span>'
  });
  assert.deepEqual(mergeDiffPairHtml("same", ""), {
    mine: '<span class="diff-del">same</span>',
    theirs: '<em class="diff-empty">(empty)</em>'
  });
});

test("word diff: past the token cap each side is marked whole instead", () => {
  const words = Array.from({ length: MERGE_DIFF_TOKEN_CAP }, (_, i) => "w" + i).join(" ");
  assert.equal(mergeDiffOps(mergeDiffTokenize(words), ["x"]), null);
  assert.deepEqual(mergeDiffPairHtml(words, "x"), {
    mine: '<span class="diff-del">' + words + "</span>",
    theirs: '<span class="diff-add">x</span>'
  });
  assert.deepEqual(mergeDiffPairHtml(words, ""), {
    mine: '<span class="diff-del">' + words + "</span>",
    theirs: '<em class="diff-empty">(empty)</em>'
  });
});

test("gallery summary: video links by label, more pictures by count and their links", () => {
  assert.equal(mergeGallerySummary({ imageLinks: [{ href: "https://www.example.com/clip/" }, { name: "take.mp4", size: 3 }] }, "imageLinks"),
    "example.com/clip, take.mp4");
  assert.equal(mergeGallerySummary({ images: [] }, "images"), "");
  assert.equal(mergeGallerySummary({ images: [{ links: [{ name: "a.mp4" }] }, {}] }, "images"), "2 pictures · a.mp4");
  assert.equal(mergeGallerySummary({ images: [{ links: null }] }, "images"), "1 picture");
  assert.equal(mergeGallerySummary(null, "imageLinks"), "");
  assert.equal(mergeGallerySummary({ imageLinks: "not a list" }, "imageLinks"), "");
});

test("list entries: theirs first then mine, one entry per item whose summary differs, odd keys kept as keys", () => {
  type Person = { id: string; name: string; notes?: string };
  const mine: (Person | null)[] = [{ id: "p1", name: "Sam", notes: "x" }, null, { id: "constructor", name: "Con" }];
  const theirs: Person[] = [{ id: "__proto__", name: "Proto" }, { id: "p1", name: "Sam", notes: "y" }];
  const entries = mergeListEntries("Crew", mine, theirs,
    (p) => p.id, (p) => p.name, (p) => p.name + " " + (p.notes || ""));
  assert.deepEqual(entries.map((e) => e.label), ["Crew: Proto", "Crew: Sam", "Crew: Con"]);
  assert.ok(entries.every((e) => e.outcome === "both"));
  assert.deepEqual(entries[1], {
    label: "Crew: Sam",
    outcome: "both",
    mineHtml: 'Sam <span class="diff-del">x</span>',
    theirsHtml: 'Sam <span class="diff-add">y</span>'
  });
  assert.equal(entries[0]?.mineHtml, '<em class="diff-empty">(empty)</em>');
  assert.deepEqual(mergeListEntries("Crew", null, undefined, (p: Person) => p.id, (p) => p.name, (p) => p.name), []);
  assert.deepEqual(mergeListEntries("Crew", mine, mine, (p) => p.id, (p) => p.name, (p) => p.name), []);
});

test("word diff: a side with only blanks of its own reads as empty, and the token cap is inclusive", () => {
  assert.deepEqual(mergeDiffPairHtml(" ", "x"), {
    mine: '<em class="diff-empty">(empty)</em>',
    theirs: '<span class="diff-add">x</span>'
  });
  const atCap = Array.from({ length: MERGE_DIFF_TOKEN_CAP }, (_, i) => "w" + i);
  assert.equal(mergeDiffOps(atCap, ["x"])?.length, MERGE_DIFF_TOKEN_CAP + 1);
  assert.equal(mergeDiffOps(["x"], atCap)?.length, MERGE_DIFF_TOKEN_CAP + 1);
  assert.equal(mergeDiffOps(atCap.concat("one more"), ["x"]), null);
});

test("list entries: an item only theirs holds, with an empty summary, makes no entry", () => {
  type Person = { id: string; name: string; notes?: string };
  const theirs: Person[] = [{ id: "p9", name: "Zed" }];
  assert.deepEqual(mergeListEntries("Crew", [], theirs, (p) => p.id, (p) => p.name, (p) => p.notes || ""), []);
  assert.deepEqual(mergeListEntries("Crew", theirs, [], (p) => p.id, (p) => p.name, (p) => p.notes || ""), []);
});
