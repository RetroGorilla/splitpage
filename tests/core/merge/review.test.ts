import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MERGE_DIFF_TOKEN_CAP,
  mergeDiffOps,
  mergeDiffPairHtml,
  mergeDiffTokenize,
  mergeFieldOutcome,
  mergeGalleryMoves,
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

const AT = (path: string) => ({ kind: "path" as const, path });
const IN = (name: string) => ({ kind: "bundled" as const, name });
const take = (location?: ReturnType<typeof AT> | ReturnType<typeof IN>) =>
  location ? { name: "take.mp4", size: 3, location } : { name: "take.mp4", size: 3 };

test("gallery moves (#1252): a video only in another folder names both folders and the one the merge keeps", () => {
  const here = { imageLinks: [take(AT("C:\\Footage\\Day 2\\take.mp4")), { href: "https://youtu.be/abc" }] };
  const disk = { imageLinks: [take(AT("D:\\Archive\\take.mp4")), { href: "https://youtu.be/abc" }] };
  const moves = mergeGalleryMoves("imageLinks", null, here, disk);
  assert.deepEqual({ ...moves, keys: [...moves.keys] }, { keys: ["f:take.mp4:3"], kept: "theirs", bundled: false, only: true });
  assert.equal(mergeGallerySummary(here, "imageLinks", moves.keys), "take.mp4 (C:\\Footage\\Day 2), youtu.be/abc");
  assert.equal(mergeGallerySummary(disk, "imageLinks", moves.keys), "take.mp4 (D:\\Archive), youtu.be/abc");
  assert.equal(mergeGallerySummary(disk, "imageLinks"), "take.mp4, youtu.be/abc", "without moves the summary is as before");
  assert.equal(mergeGalleryMoves("imageLinks", disk, here, disk).kept, "mine", "only mine moved it");
});

test("gallery moves (#1252): a copy beside the script is kept over a path, and every place reads as a folder", () => {
  const bundled = { imageLinks: [take(IN("take.mp4"))] }, byPath = { imageLinks: [take(AT("/Users/adam/take.mp4"))] };
  for (const [m, t, kept] of [[bundled, byPath, "mine"], [byPath, bundled, "theirs"]] as const) {
    const moves = mergeGalleryMoves("imageLinks", null, m, t);
    assert.deepEqual([moves.kept, moves.bundled, moves.only], [kept, true, true]);
  }
  const keys = mergeGalleryMoves("imageLinks", null, bundled, byPath).keys;
  assert.equal(mergeGallerySummary(bundled, "imageLinks", keys), "take.mp4 (beside the script)");
  assert.equal(mergeGallerySummary(byPath, "imageLinks", keys), "take.mp4 (/Users/adam)");
  assert.equal(mergeGallerySummary({ imageLinks: [take(IN("take (2).mp4"))] }, "imageLinks", keys), "take.mp4 (beside the script as take (2).mp4)");
  assert.equal(mergeGallerySummary({ imageLinks: [take(AT("C:\\take.mp4"))] }, "imageLinks", keys), "take.mp4 (C:\\)");
  assert.equal(mergeGallerySummary({ imageLinks: [take(AT("/take.mp4"))] }, "imageLinks", keys), "take.mp4 (/)");
  assert.equal(mergeGallerySummary({ imageLinks: [take(AT("C:\\x\\other.mp4"))] }, "imageLinks", keys), "take.mp4 (C:\\x\\other.mp4)");
  assert.equal(mergeGallerySummary({ imageLinks: [take()] }, "imageLinks", keys), "take.mp4", "no location: just the name");
});

test("gallery moves (#1252): a further picture's video, a mixed outcome, and a move beside another change", () => {
  const item = (location: ReturnType<typeof AT>) => ({ links: [{ ...take(location), poster: true }] });
  const here = { moreImages: [item(AT("C:\\A\\take.mp4"))] }, disk = { moreImages: [item(AT("C:\\B\\take.mp4"))] };
  const moves = mergeGalleryMoves("moreImages", null, here, disk);
  assert.deepEqual([moves.kept, moves.only], ["theirs", true]);
  assert.equal(mergeGallerySummary(here, "moreImages", moves.keys), "1 picture · take.mp4 (C:\\A)");
  const two = (a: string, b: string) => ({ imageLinks: [take(AT(a + "\\take.mp4")), { name: "b.mp4", size: 1, location: AT(b + "\\b.mp4") }] });
  assert.equal(mergeGalleryMoves("imageLinks", two("C:\\A", "C:\\A"), two("C:\\A", "C:\\B"), two("C:\\C", "C:\\A")).kept, "mixed");
  const more = mergeGalleryMoves("imageLinks", null, { imageLinks: [take(AT("C:\\A\\take.mp4"))] },
    { imageLinks: [take(AT("C:\\B\\take.mp4")), { href: "https://youtu.be/abc" }] });
  assert.deepEqual([more.kept, more.only], ["theirs", false], "a link added too: the move is shown, the entry keeps both");
  assert.deepEqual(mergeGalleryMoves("imageLinks", null, { imageLinks: [take()] }, { imageLinks: [{ href: "https://youtu.be/abc" }] }),
    { keys: new Set(), kept: null, bundled: false, only: false });
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
