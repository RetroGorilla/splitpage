import "./_dom.mjs";
import "./_export-services-started.mjs";
import "./_project-file-services-started.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../js/02-state.js";
import { intern } from "../adapters/storage/02c-blobs.js";
import {
  ANNOTATION_COLORS, annotateGallerySlot, moveGallerySlot, normalizeMarks, removeGallerySlot, replaceGalleryPicture, rowSlots, slotOriginal
} from "../adapters/storage/02d-gallery.js";
import { mergeStates } from "../js/03-sync.js";
import { currentDocument } from "../legacy/session-bridge.ts";
import { applyMarkdownProject, buildMarkdownProject, buildSplitpageFile, parseMarkdownProject } from "../adapters/formats/project-file.ts";
import { refsIn } from "../../shared/blob-policy.js";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { parseSplitpageFile } from "../adapters/formats/splitpage-file.ts";
import { loadTestDocument } from "./_document.mjs";

const jpegBytes = (w, h, salt) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt || 0, 0xFF, 0xD9]);
const O1 = intern(jpegBytes(300, 200, 11));
const O2 = intern(jpegBytes(200, 300, 12));
const F1 = intern(jpegBytes(300, 200, 21));
const F2 = intern(jpegBytes(200, 300, 22));
const F1b = intern(jpegBytes(300, 200, 23));
const P3 = intern(jpegBytes(100, 100, 3));

const RED = ANNOTATION_COLORS[0];
const YELLOW = ANNOTATION_COLORS[1];
const PEN = { kind: "pen", color: RED, width: 0.008, points: [0.1, 0.1, 0.5, 0.5] };
const TEXT = { kind: "text", color: YELLOW, size: 0.045, x: 0.2, y: 0.3, text: "Swap this <prop>\nfor the red one" };

function doc(rows) {
  return migrateRows({ schema: 2, title: "Annotate", comments: [], rows: rows.map((r, i) => Object.assign({ id: "r" + i, visualText: "", audioText: "", status: "todo" }, r)) });
}
const clone = (v) => JSON.parse(JSON.stringify(v));

test("normalizeMarks keeps well-formed marks and nothing else", () => {
  assert.deepEqual(normalizeMarks([PEN, TEXT]), [PEN, TEXT], "text keeps its < and its line break");
  assert.deepEqual(normalizeMarks(null), []);
  const hl = normalizeMarks([{ kind: "highlight", color: "#FFB703", width: 0.03, points: [0.123456, 1.4, -2, 0.5], extra: "x" }]);
  assert.deepEqual(hl, [{ kind: "highlight", color: YELLOW, width: 0.03, points: [0.1235, 1, 0, 0.5] }], "colour lower-cased, points clamped and rounded, nothing extra");
  assert.deepEqual(normalizeMarks([
    { kind: "pen", color: "#123456", width: 0.01, points: [0, 0] },
    { kind: "pen", color: RED, width: 0.01, points: [0] },
    { kind: "pen", color: RED, width: "big", points: [0, 0] },
    { kind: "pen", color: RED, width: 0.01, points: [0, "x"] },
    { kind: "text", color: RED, size: 0.05, x: 0, y: 0, text: "   " },
    { kind: "text", color: RED, size: 0.05, x: 0, y: 0 },
    { kind: "circle", color: RED },
    "pen", null, [PEN]
  ]), []);
  const t = normalizeMarks([{ kind: "text", color: RED, size: 9, x: 0.5, y: 0.5, text: "a\u0000b\r\nc\td" + "z".repeat(600) }])[0];
  assert.equal(t.size, 0.3, "a size clamped to the largest");
  assert.equal(t.text.slice(0, 7), "a b\nc d", "controls a space, CRLF one break");
  assert.equal(t.text.length, 500);
  const many = normalizeMarks(Array.from({ length: 600 }, () => PEN));
  assert.equal(many.length, 500);
  const long = normalizeMarks([{ kind: "pen", color: RED, width: 0.01, points: Array.from({ length: 5000 }, () => 0.5) }])[0];
  assert.equal(long.points.length, 4000);
});

test("annotateGallerySlot: the drawn-on picture shown, the original and marks beside it, and back", () => {
  const s = doc([{ imageRef: O1, imageName: "set.jpg", imageLinks: [{ href: "https://youtu.be/a" }], moreImages: [{ imageRef: O2, name: "prop.jpg" }] }]);
  const row = s.rows[0];
  assert.equal(annotateGallerySlot(row, 0, F1, O1, [PEN]), true);
  assert.equal(row.imageRef.sha256, F1.sha256);
  assert.deepEqual(row.imageAnnotation, { imageRef: O1, marks: [PEN] });
  assert.equal(row.imageName, "set.jpg", "its name and caption stay");
  assert.deepEqual(row.imageLinks, [{ href: "https://youtu.be/a" }]);
  assert.equal(annotateGallerySlot(row, 1, F2, O2, [TEXT]), true);
  assert.deepEqual(row.moreImages, [{ imageRef: F2, name: "prop.jpg", annotation: { imageRef: O2, marks: [TEXT] } }]);
  const slots = rowSlots(row);
  assert.equal(slotOriginal(slots[0]).sha256, O1.sha256);
  assert.equal(slotOriginal(slots[1]).sha256, O2.sha256);
  assert.deepEqual(slots[1].annotation.marks, [TEXT]);
  assert.equal(annotateGallerySlot(row, 0, F1b, slotOriginal(rowSlots(row)[0]), [PEN, TEXT]), true);
  assert.equal(row.imageRef.sha256, F1b.sha256);
  assert.equal(row.imageAnnotation.imageRef.sha256, O1.sha256);
  assert.equal(row.imageAnnotation.marks.length, 2);
  assert.equal(annotateGallerySlot(row, 0, null, O1, []), true);
  assert.equal(row.imageRef.sha256, O1.sha256);
  assert.ok(!("imageAnnotation" in row));
  assert.equal(rowSlots(row)[0].annotation, null);
  assert.equal(annotateGallerySlot(row, 5, F1, O1, [PEN]), false);
  assert.equal(annotateGallerySlot(row, 0, O1, O1, [PEN]), false);
  assert.equal(annotateGallerySlot(row, 0, F2, O1, [PEN]), false);
  const v = doc([{ imageRef: P3, moreImages: [{ links: [{ href: "https://vimeo.com/9", poster: true }] }] }]).rows[0];
  assert.equal(annotateGallerySlot(v, 1, F1, O1, [PEN]), false);
  assert.equal(annotateGallerySlot(v, 0, F1, P3, [{ kind: "pen", color: "#000001", width: 0.01, points: [0, 0] }]), true, "no valid marks: nothing to keep");
  assert.equal(v.imageRef.sha256, P3.sha256);
  assert.ok(!("imageAnnotation" in v));
});

test("the slot operations carry an annotation with its picture, and a new picture drops it", () => {
  const s = doc([{ imageRef: O1, moreImages: [{ imageRef: P3 }] }]);
  const row = s.rows[0];
  annotateGallerySlot(row, 0, F1, O1, [PEN]);
  moveGallerySlot(row, 0, 1);
  assert.equal(row.imageRef.sha256, P3.sha256);
  assert.ok(!("imageAnnotation" in row));
  assert.deepEqual(row.moreImages, [{ imageRef: F1, annotation: { imageRef: O1, marks: [PEN] } }]);
  moveGallerySlot(row, 1, 0);
  assert.deepEqual(row.imageAnnotation, { imageRef: O1, marks: [PEN] });
  const r2 = clone(row);
  removeGallerySlot(r2, 0);
  assert.equal(r2.imageRef.sha256, P3.sha256);
  assert.ok(!("imageAnnotation" in r2));
  replaceGalleryPicture(row, 0, O2, "new.jpg");
  assert.equal(row.imageRef.sha256, O2.sha256);
  assert.ok(!("imageAnnotation" in row));
});

test("migrateRows makes an annotation safe or drops it", () => {
  const s = doc([
    { imageRef: F1, imageAnnotation: { imageRef: O1, marks: [PEN, { kind: "bad" }], junk: 1 } },
    { imageRef: F1, imageAnnotation: { imageRef: O1, marks: [{ kind: "bad" }] } },
    { imageRef: F1, imageAnnotation: { imageRef: F1, marks: [PEN] } },
    { imageRef: F1, imageAnnotation: { imageRef: { sha256: "nope" }, marks: [PEN] } },
    { imageRef: null, imageAnnotation: { imageRef: O1, marks: [PEN] } },
    { imageRef: P3, moreImages: [{ imageRef: F2, annotation: { imageRef: O2, marks: [TEXT] } }, { imageRef: F1, annotation: "x" }] },
    { imageRef: null, moreImages: [{ imageRef: F2, annotation: { imageRef: O2, marks: [TEXT] } }] }
  ]);
  assert.deepEqual(s.rows[0].imageAnnotation, { imageRef: O1, marks: [PEN] });
  for (const i of [1, 2, 3, 4]) assert.ok(!("imageAnnotation" in s.rows[i]), "row " + i);
  assert.deepEqual(s.rows[5].moreImages, [{ imageRef: F2, annotation: { imageRef: O2, marks: [TEXT] } }, { imageRef: F1 }]);
  assert.equal(s.rows[6].imageRef.sha256, F2.sha256);
  assert.deepEqual(s.rows[6].imageAnnotation, { imageRef: O2, marks: [TEXT] });
});

test("refsIn names the originals, so their bytes are kept", () => {
  const s = doc([{ imageRef: F1, imageAnnotation: { imageRef: O1, marks: [PEN] }, moreImages: [{ imageRef: F2, annotation: { imageRef: O2, marks: [TEXT] } }] }]);
  assert.deepEqual(refsIn(s).sort(), [F1.sha256, O1.sha256, F2.sha256, O2.sha256].sort());
});

test("a .splitpage file carries the originals inline and reads back the same annotations", () => {
  const s = doc([{ imageRef: F1, imageAnnotation: { imageRef: O1, marks: [PEN, TEXT] }, moreImages: [{ imageRef: F2, name: "p.jpg", annotation: { imageRef: O2, marks: [TEXT] } }] }]);
  const text = buildSplitpageFile(exportDocumentOf(s));
  const raw = JSON.parse(text);
  assert.ok(raw.rows[0].imageAnnotation.visualImage.indexOf("data:image/jpeg;base64,") === 0);
  assert.ok(!("imageRef" in raw.rows[0].imageAnnotation));
  assert.ok(raw.rows[0].moreImages[0].annotation.visualImage.indexOf("data:image/jpeg;base64,") === 0);
  const back = migrateRows(parseSplitpageFile(text));
  assert.deepEqual(back.rows[0].imageAnnotation, s.rows[0].imageAnnotation);
  assert.deepEqual(back.rows[0].moreImages, s.rows[0].moreImages);
  assert.equal(back.rows[0].imageRef.sha256, F1.sha256);
});

test(".md: an untouched file keeps the annotation; another picture put in the cell by hand drops it", async () => {
  const s = doc([{ imageRef: F1, imageAnnotation: { imageRef: O1, marks: [PEN] } }]);
  const was = currentDocument();
  loadTestDocument(s);
  try {
    const md = buildMarkdownProject(exportDocumentOf(s));
    const same = await applyMarkdownProject(parseMarkdownProject(md), { noAsk: true });
    assert.equal(same.rows[0].imageRef.sha256, F1.sha256);
    assert.deepEqual(same.rows[0].imageAnnotation, { imageRef: O1, marks: [PEN] });
    const url = (b) => "data:image/jpeg;base64," + Buffer.from(b).toString("base64");
    const at = md.indexOf(url(jpegBytes(300, 200, 21)));
    assert.ok(at !== -1 && at < md.indexOf("~~~"), "the picture is in the table");
    const edited = md.slice(0, at) + url(jpegBytes(100, 100, 3)) + md.slice(at + url(jpegBytes(300, 200, 21)).length);
    const back = await applyMarkdownProject(parseMarkdownProject(edited), { noAsk: true });
    assert.equal(back.rows[0].imageRef.sha256, P3.sha256);
    assert.ok(!("imageAnnotation" in back.rows[0]));
  } finally {
    loadTestDocument(was);
  }
});

test("the merge: my annotation of the cover goes with my picture; an item's with its item", () => {
  const base = doc([{ visualText: "v", imageRef: O1, moreImages: [{ imageRef: O2 }] }]);
  const mine = clone(base);
  const theirs = clone(base);
  annotateGallerySlot(mine.rows[0], 0, F1, O1, [PEN]);
  annotateGallerySlot(mine.rows[0], 1, F2, O2, [TEXT]);
  theirs.rows[0].visualText = "v, theirs";
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.rows[0].imageRef.sha256, F1.sha256);
  assert.deepEqual(out.rows[0].imageAnnotation, { imageRef: O1, marks: [PEN] });
  assert.deepEqual(out.rows[0].moreImages, [{ imageRef: F2, annotation: { imageRef: O2, marks: [TEXT] } }]);
  assert.equal(out.comments.length, 0);
  const theirs2 = clone(base);
  annotateGallerySlot(theirs2.rows[0], 0, F1b, O1, [TEXT]);
  const out2 = mergeStates(base, clone(base), theirs2).merged;
  assert.equal(out2.rows[0].imageRef.sha256, F1b.sha256);
  assert.deepEqual(out2.rows[0].imageAnnotation.marks, [TEXT]);
  const res = mergeStates(base, mine, theirs2);
  assert.equal(res.merged.rows[0].imageRef.sha256, F1b.sha256);
  assert.deepEqual(res.merged.rows[0].imageAnnotation.marks, [TEXT]);
  assert.equal(res.merged.comments.length, 1);
});
