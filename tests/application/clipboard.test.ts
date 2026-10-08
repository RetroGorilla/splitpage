import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import { CELL_TEXT_DERIVES } from "../../src/application/commands/cell-text.ts";
import {
  GALLERY_FIELDS, attachToGallery, cutCommand, freshBrollIds, pasteCommand, takenBrollIds
} from "../../src/application/commands/clipboard.ts";
import type { Attachment, ClipboardPorts, PasteRequest, Pasted, TextRange } from "../../src/application/commands/clipboard.ts";
import type { CellTextPorts } from "../../src/application/session/ports.ts";
import { createRichText } from "../../src/adapters/richtext/richtext.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import { createImageIngestion } from "../../src/core/document/media.ts";
import type { ImageRef } from "../../src/core/document/ports.ts";
import { syncCommentAnchors } from "../../src/core/text/anchors.ts";
import { toHtml } from "../../src/core/text/html.ts";
import { cellLength, commentIds, normalizeCell, projection } from "../../src/core/text/runs.ts";
import type { Run } from "../../src/core/text/runs.ts";
import { jsdomParser } from "../adapters/richtext/jsdom.mjs";
import { countingIds, migratedThenSet } from "../core/migrate-ports.ts";
import { chance, pick, seeded, upTo } from "./raw-inputs.ts";
import type { Random } from "./raw-inputs.ts";
import { harness, runConfined } from "./session-fakes.ts";

const STAMP = "2026-10-08T12:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

const rt = createRichText({ DOMParser: jsdomParser(), images: createImageIngestion(function () { return null; }), ids: countingIds() });
const cells = rt.createCellReader(deepFreeze);

const cmt = (id: string, inner: string): string => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const KEY = (id: string): string => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const PIC: ImageRef = { sha256: "a".repeat(64), width: 4, height: 3, mime: "image/png" };
const PIC2: ImageRef = { sha256: "b".repeat(64), width: 5, height: 3, mime: "image/png" };

interface Counting extends ClipboardPorts {
  minted: string[];
  stamps: () => number;
}

function ports(name = "Adam", taken: readonly string[] = []): Counting {
  const minted: string[] = [];
  let stamps = 0;
  return {
    minted: minted,
    stamps: function () { return stamps; },
    clock: { nowIso: function () { stamps++; return STAMP; } },
    editor: { name: function () { stamps++; return name; } },
    cells: cells,
    ids: {
      id: function (prefix) {
        const id = prefix + "Minted" + String(taken.length + minted.length + 1);
        minted.push(id);
        return id;
      }
    },
    brollSeed: function (row) {
      return { audioRef: "seed:" + String(row.audioText), location: "loc:" + row.id };
    }
  };
}

function fixture() {
  return {
    title: "Harbour",
    docId: "d" + "1".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r2", visualText: "Close", audioText: "Alpha " + cmt("c1", "bravo charlie") + " delta", status: "ready", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r3", visualText: KEY("bsA") + " gulls", audioText: "Three.", status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r4", visualText: "", audioText: "Four " + cmt("c2", "words") + ".", status: "shot", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r5", visualText: "Fifth", audioText: "Five.", status: "todo" }
    ],
    comments: [
      { id: "c1", anchorId: "c1", kind: "anchor", rowId: "r2", field: "audioText", body: "Tighter", replies: [] },
      { id: "c2", anchorId: "c2", kind: "anchor", rowId: "r4", field: "audioText", body: "Which?", replies: [] }
    ],
    brollShots: [{ id: "bsA", name: "gulls", desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "Three.", location: "", props: [], origin: "script" }]
  };
}

function opened(reconciles = true): ReturnType<typeof harness> {
  const entry = function () { return migratedThenSet(fixture()); };
  const reconcile = reconciles ? function (doc: Parameters<typeof syncCommentAnchors>[0]) { return syncCommentAnchors(doc, cells); } : undefined;
  const h = harness(undefined, reconcile ? { entry: entry, reconcile: reconcile } : { entry: entry });
  h.session.adopt({});
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

type Held = ReturnType<typeof harness>;

function rowOf(h: Held, rowId: string): Record<string, unknown> | null {
  return h.session.read(function (doc) {
    const row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row ? JSON.parse(JSON.stringify(row)) as Record<string, unknown> : null;
  });
}

function shotIds(h: Held): string[] {
  return h.session.read(function (doc) { return doc ? doc.brollShots.map(function (s) { return s.id; }) : []; });
}

function snapshot(h: Held): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function anchorsOf(h: Held): unknown[] {
  return h.session.read(function (doc) { return doc ? doc.comments.map(function (c) { return [c.id, c.rowId, c.field]; }) : []; });
}

function cell(html: string): Pasted {
  return { kind: "cell", runs: rt.decode(html) };
}

function text(value: string): Pasted {
  return { kind: "text", text: value };
}

function request(rowId: string, field: string, range: TextRange | null, pasted: Pasted | null, extra: Partial<PasteRequest> = {}): PasteRequest {
  return { rowId: rowId, field: field, range: range, pasted: pasted, fromCut: false, comments: [], attach: [], ...extra };
}

function pasteChanges(rowId: string, field: string, extra: { gallery?: boolean; shots?: boolean; moved?: boolean; text?: boolean } = {}) {
  const cellsDeclared = [];
  if (extra.text !== false) cellsDeclared.push({ rowId: rowId, field: field });
  if (extra.gallery) GALLERY_FIELDS.forEach(function (key) { cellsDeclared.push({ rowId: rowId, field: key }); });
  cellsDeclared.push({ rowId: rowId, field: "updatedAt" }, { rowId: rowId, field: "updatedBy" });
  return changeSet({
    cells: cellsDeclared,
    docFields: extra.shots ? ["brollShots"] : [],
    runsMoved: !!extra.moved,
    derive: CELL_TEXT_DERIVES
  });
}

test("E2: a paste over a selection is one generation, one undo record and one effect pass; it stamps through the ports and derives production and broll", () => {
  const h = opened();
  const p = ports();
  const paste = pasteCommand(request("r1", "audioText", { from: 6, to: 11 }, cell("<strong>friends</strong>")), p);
  const out = runConfined(h.session, paste.command);
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: pasteChanges("r1", "audioText") });
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  const row = rowOf(h, "r1");
  assert.equal(row?.audioText, "Hello <strong>friends</strong>");
  assert.equal(row?.updatedAt, STAMP);
  assert.equal(row?.updatedBy, "Adam");
  assert.equal(rowOf(h, "r2")?.updatedAt, OLD);
  assert.equal(h.published[0]?.changes.saveNow, false);
  assert.deepEqual(paste.report(), { attached: null, caret: 6 + "friends".length });
  assert.equal(p.stamps(), 2, "the clock and the editor are asked once each");
  h.clock.advance(180);
  assert.deepEqual(h.refreshes, [["broll", "production"]]);
});

test("pasted text is typed in with the marks at the caret; no range pastes at the end", () => {
  const h = opened();
  assert.equal(runConfined(h.session, pasteCommand(request("r1", "audioText", { from: 11, to: 11 }, text("!")), ports()).command).kind, "applied");
  assert.equal(rowOf(h, "r1")?.audioText, "Hello there!");
  const end = pasteCommand(request("r3", "audioText", null, text(" Four.")), ports());
  assert.equal(runConfined(h.session, end.command).kind, "applied");
  assert.equal(rowOf(h, "r3")?.audioText, "Three. Four.");
  assert.equal(end.report().caret, "Three. Four.".length);
});

test("a range is clamped to the cell and a reversed range is read the right way round", () => {
  const h = opened();
  const out = runConfined(h.session, pasteCommand(request("r1", "audioText", { from: 99, to: 6 }, text("X")), ports()).command);
  assert.equal(out.kind, "applied");
  assert.equal(rowOf(h, "r1")?.audioText, "Hello X");
});

test("E3: a paste that changes nothing is a no-op: no write, no stamp, no effects", () => {
  const h = opened();
  const before = snapshot(h);
  const p = ports();
  assert.deepEqual(runConfined(h.session, pasteCommand(request("r1", "audioText", { from: 3, to: 3 }, text("")), p).command), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, pasteCommand(request("gone", "audioText", null, text("x")), p).command), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, pasteCommand(request("r1", "audioText", null, null), p).command), { kind: "noop" });
  const nameless: Attachment = { kind: "videoFile", name: "", size: 3 };
  assert.deepEqual(runConfined(h.session, pasteCommand(request("r1", "audioText", null, null, { attach: [nameless] }), p).command), { kind: "noop" });
  assert.equal(p.stamps(), 0);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.equal(h.clock.armed(), 0);
  assert.equal(snapshot(h), before);
});

test("no document and review mode: both commands are refused with nothing written", () => {
  const empty = harness();
  assert.deepEqual(runConfined(empty.session, pasteCommand(request("r1", "audioText", null, text("x")), ports()).command), { kind: "rejected", reason: NO_DOCUMENT });
  assert.deepEqual(runConfined(empty.session, cutCommand("r1", "audioText", { from: 0, to: 2 }, ports()).command), { kind: "rejected", reason: NO_DOCUMENT });
  const h = opened();
  h.deny("review");
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, pasteCommand(request("r1", "audioText", null, text("x")), ports()).command), { kind: "rejected", reason: "review" });
  assert.deepEqual(runConfined(h.session, cutCommand("r1", "audioText", { from: 0, to: 2 }, ports()).command), { kind: "rejected", reason: "review" });
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
});

test("a paste carrying a cut's comments reconciles in the transaction, before the undo record, and the anchor follows its words", () => {
  const h = opened();
  const moved = request("r3", "audioText", { from: 6, to: 6 }, cell(cmt("c1", "bravo charlie")), { fromCut: true, comments: ["c1"] });
  const out = runConfined(h.session, pasteCommand(moved, ports()).command);
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: pasteChanges("r3", "audioText", { moved: true }) });
  assert.deepEqual(h.log, ["reconcile", "undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  assert.equal(rowOf(h, "r3")?.audioText, "Three." + cmt("c1", "bravo charlie"));
  assert.deepEqual(anchorsOf(h), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]], "r2 still holds c1 first, so the anchor stays there");
});

test("a paste that is not from a cut declares no moved runs and never reconciles, even over a commented range", () => {
  const h = opened();
  const out = runConfined(h.session, pasteCommand(request("r2", "audioText", { from: 6, to: 19 }, text("kilo")), ports()).command);
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: pasteChanges("r2", "audioText") });
  assert.equal(h.log.indexOf("reconcile"), -1);
  assert.equal(rowOf(h, "r2")?.audioText, "Alpha kilo delta");
  assert.deepEqual(anchorsOf(h), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
});

test("a copied b-roll key whose id is taken gets a fresh id and a shot record seeded from the scene; the record is a declared effect", () => {
  const h = opened();
  const p = ports();
  const paste = pasteCommand(request("r4", "visualText", null, cell(KEY("bsA") + " gulls")), p);
  const out = runConfined(h.session, paste.command);
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: pasteChanges("r4", "visualText", { shots: true }) });
  assert.deepEqual(p.minted, ["bsMinted1"]);
  assert.equal(rowOf(h, "r4")?.visualText, KEY("bsMinted1") + " gulls");
  assert.deepEqual(shotIds(h), ["bsA", "bsMinted1"]);
  const shot = h.session.read(function (doc) { return doc && JSON.parse(JSON.stringify(doc.brollShots[1])) as Record<string, unknown>; });
  assert.deepEqual(shot, {
    id: "bsMinted1", name: "gulls", desc: "", status: "unshot", reshoot: false, notes: "", owner: "",
    audioRef: "seed:Four " + cmt("c2", "words") + ".", location: "loc:r4", props: [], origin: "script"
  });
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
});

test("a cut b-roll key pasted back keeps its id and makes no second record; a key whose id is free is recorded under its own id", () => {
  const h = opened();
  const p = ports();
  assert.equal(runConfined(h.session, cutCommand("r3", "visualText", { from: 0, to: 99 }, p).command).kind, "applied");
  assert.equal(rowOf(h, "r3")?.visualText, "");
  const moved = request("r4", "visualText", null, cell(KEY("bsA") + " gulls"), { fromCut: true });
  const out = runConfined(h.session, pasteCommand(moved, p).command);
  assert.deepEqual(out, { kind: "applied", generation: 2, changes: pasteChanges("r4", "visualText") });
  assert.deepEqual(p.minted, []);
  assert.deepEqual(shotIds(h), ["bsA"]);
  const fresh = runConfined(h.session, pasteCommand(request("r1", "visualText", { from: 0, to: 0 }, cell(KEY("bsNew") + " drone")), p).command);
  assert.deepEqual(fresh, { kind: "applied", generation: 3, changes: pasteChanges("r1", "visualText", { shots: true }) });
  assert.deepEqual(shotIds(h), ["bsA", "bsNew"]);
  assert.equal(rowOf(h, "r1")?.visualText, KEY("bsNew") + " droneWide");
});

test("a key the paste repeats gets its own fresh id each time, and a minted id that is already taken is skipped", () => {
  const h = opened();
  const clash: Counting = { ...ports(), ids: { id: (function () {
    const queue = ["bsA", "bsB", "bsB", "bsC", "bsD"];
    return function () { return queue.shift() as string; };
  })() } };
  const piece = cell(KEY("bsZ") + " one<br>" + KEY("bsZ") + " two<br>" + KEY("bsA") + " three");
  assert.equal(runConfined(h.session, pasteCommand(request("r4", "visualText", null, piece), clash).command).kind, "applied");
  const html = String(rowOf(h, "r4")?.visualText);
  const found = Array.from(html.matchAll(/data-broll-id="([^"]+)"/g), (m) => m[1]);
  assert.deepEqual(found, ["bsZ", "bsB", "bsC"]);
  assert.deepEqual(shotIds(h), ["bsA", "bsZ", "bsB", "bsC"]);
});

test("only the pasted keys get records: a key already in the cell with no record is left alone", () => {
  const doc = fixture();
  const first = doc.rows[0];
  if (first) first.visualText = KEY("bsOld") + " old line<br>";
  const h = harness(undefined, { entry: function () { return migratedThenSet(doc); } });
  h.session.adopt({});
  const out = runConfined(h.session, pasteCommand(request("r1", "visualText", null, cell(KEY("bsNew") + " new line")), ports()).command);
  assert.equal(out.kind, "applied");
  assert.deepEqual(shotIds(h), ["bsA", "bsNew"]);
});
test("pasting into the audio cell never records a shot, even for a key", () => {
  const h = opened();
  const out = runConfined(h.session, pasteCommand(request("r1", "audioText", null, cell(KEY("bsNew") + " drone")), ports()).command);
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: pasteChanges("r1", "audioText") });
  assert.deepEqual(shotIds(h), ["bsA"]);
});

test("attached pictures and videos are the command's gallery effect: every gallery field is declared, the stamp moves once", () => {
  const h = opened();
  const p = ports();
  const attach: Attachment[] = [{ kind: "image", ref: PIC, name: "a.png" }, { kind: "video", href: "https://vimeo.com/1" }];
  const paste = pasteCommand(request("r1", "audioText", { from: 11, to: 11 }, text(" now"), { attach: attach }), p);
  const out = runConfined(h.session, paste.command);
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: pasteChanges("r1", "audioText", { gallery: true }) });
  assert.deepEqual(paste.report().attached, { pictures: 1, videos: 1, links: ["https://vimeo.com/1"] });
  const row = rowOf(h, "r1");
  assert.deepEqual(row?.imageRef, PIC);
  assert.equal(row?.imageName, "a.png");
  assert.deepEqual(row?.moreImages, [{ links: [{ href: "https://vimeo.com/1", poster: true }] }]);
  assert.equal(row?.audioText, "Hello there now");
  assert.equal(p.stamps(), 2);
  assert.deepEqual(Object.keys(row || {}), ["id", "visualText", "audioText", "status", "updatedAt", "updatedBy", "imageRef", "imageName", "moreImages"]);
});

test("an attach with no words leaves the cell alone and still stamps; a picture already there changes only the stamp", () => {
  const h = opened();
  const first = pasteCommand(request("r3", "audioText", null, null, { attach: [{ kind: "image", ref: PIC }] }), ports());
  assert.deepEqual(runConfined(h.session, first.command), { kind: "applied", generation: 1, changes: pasteChanges("r3", "audioText", { gallery: true, text: false }) });
  assert.equal(rowOf(h, "r3")?.audioText, "Three.");
  const bare = pasteCommand(request("r5", "audioText", null, null, { attach: [{ kind: "image", ref: PIC }] }), ports());
  assert.equal(runConfined(h.session, bare.command).kind, "applied");
  assert.deepEqual(Object.keys(rowOf(h, "r5") || {}), ["id", "visualText", "audioText", "status", "imageRef", "updatedAt", "updatedBy"], "gallery first, then the stamp");
  const worded = pasteCommand(request("r5", "visualText", null, text("!"), { attach: [{ kind: "image", ref: PIC2 }] }), ports());
  assert.equal(runConfined(h.session, worded.command).kind, "applied");
  assert.deepEqual(Object.keys(rowOf(h, "r5") || {}), ["id", "visualText", "audioText", "status", "imageRef", "updatedAt", "updatedBy", "moreImages"]);
  const again = pasteCommand(request("r3", "audioText", null, null, { attach: [{ kind: "image", ref: PIC }, { kind: "image", ref: PIC2 }] }), ports());
  assert.equal(runConfined(h.session, again.command).kind, "applied");
  assert.deepEqual(again.report().attached, { pictures: 2, videos: 0, links: [] });
  assert.deepEqual(rowOf(h, "r3")?.moreImages, [{ imageRef: PIC2 }]);
  const dup = pasteCommand(request("r3", "audioText", null, null, { attach: [{ kind: "image", ref: PIC }] }), ports());
  assert.equal(runConfined(h.session, dup.command).kind, "applied");
  assert.deepEqual(rowOf(h, "r3")?.moreImages, [{ imageRef: PIC2 }]);
});

test("attachToGallery adds each item once, counts what it was given and reports the video links", () => {
  const row: Record<string, unknown> = { id: "r1", imageRef: null };
  const got = attachToGallery(row, [
    { kind: "video", href: "https://youtu.be/abc" },
    { kind: "videoFile", name: "<b>take</b>.mp4", size: 3 },
    { kind: "videoFile", name: "", size: 3 },
    { kind: "image", ref: PIC, name: "p" }
  ]);
  assert.deepEqual(got, { pictures: 1, videos: 2, links: ["https://youtu.be/abc"] });
  assert.equal(row.imageRef, null);
  assert.deepEqual(row.imageLinks, [{ href: "https://youtu.be/abc", poster: true }]);
  assert.deepEqual(row.moreImages, [{ links: [{ name: "take.mp4", size: 3, poster: true }] }, { imageRef: PIC, name: "p" }]);
});

test("in a visual cell the pasted directions and cues are flattened; an audio cell keeps them", () => {
  const h = opened();
  const piece = "drone <span class=\"stage-dir\">pans</span> <span class=\"audio-cue\">hum</span>";
  assert.equal(runConfined(h.session, pasteCommand(request("r4", "visualText", null, cell(piece)), ports()).command).kind, "applied");
  assert.equal(rowOf(h, "r4")?.visualText, "drone (pans) hum");
  assert.equal(runConfined(h.session, pasteCommand(request("r1", "audioText", null, cell(piece)), ports()).command).kind, "applied");
  assert.match(String(rowOf(h, "r1")?.audioText), /stage-dir/);
});

test("E3: a stamp port that throws rolls the paste back whole: text, gallery, shot records and stamp are as they were", () => {
  const h = opened();
  const before = snapshot(h);
  const broken: Counting = { ...ports(), editor: { name: function () { throw new Error("no editor"); } } };
  const everything = request("r4", "visualText", null, cell(KEY("bsA") + " gulls"), { attach: [{ kind: "image", ref: PIC }] });
  const out = runConfined(h.session, pasteCommand(everything, broken).command);
  assert.equal(out.kind, "failed");
  assert.equal(out.kind === "failed" && out.error instanceof Error ? out.error.message : "", "no editor");
  assert.equal(snapshot(h), before);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  const failing = pasteCommand(request("r1", "audioText", null, null, { attach: [{ kind: "image", ref: PIC }] }), broken);
  assert.equal(runConfined(h.session, failing.command).kind, "failed");
  assert.equal(snapshot(h), before, "a gallery field the row did not have is gone again");
  assert.equal(failing.report().attached, null, "a rolled-back attach reports nothing attached");
});

test("a cut removes the range, stamps the scene and reports the caret at the range's start; it never reconciles", () => {
  const h = opened();
  const p = ports();
  const cut = cutCommand("r2", "audioText", { from: 6, to: 19 }, p);
  const out = runConfined(h.session, cut.command);
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: pasteChanges("r2", "audioText") });
  assert.equal(rowOf(h, "r2")?.audioText, "Alpha  delta");
  assert.equal(rowOf(h, "r2")?.updatedAt, STAMP);
  assert.deepEqual(cut.report(), { attached: null, caret: 6 });
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"], "the comment keeps its place until its words land again");
  assert.deepEqual(anchorsOf(h), [["c1", "r2", "audioText"], ["c2", "r4", "audioText"]]);
  h.clock.advance(180);
  assert.deepEqual(h.refreshes, [["broll", "production"]]);
});

test("a cut of nothing, of a scene that is gone, or of a range that deletes nothing is a no-op", () => {
  const h = opened();
  const before = snapshot(h);
  const p = ports();
  assert.deepEqual(runConfined(h.session, cutCommand("r1", "audioText", { from: 3, to: 3 }, p).command), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, cutCommand("gone", "audioText", { from: 0, to: 3 }, p).command), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, cutCommand("r1", "audioText", { from: 50, to: 60 }, p).command), { kind: "noop" });
  assert.equal(p.stamps(), 0);
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
});

test("E3: a cut whose stamp port throws leaves the cell as it was", () => {
  const h = opened();
  const before = snapshot(h);
  const broken: CellTextPorts = { clock: { nowIso: function () { throw new Error("no clock"); } }, editor: { name: function () { return "x"; } }, cells: cells };
  assert.equal(runConfined(h.session, cutCommand("r1", "audioText", { from: 0, to: 6 }, broken).command).kind, "failed");
  assert.equal(snapshot(h), before);
});

test("E9: a cut and the paste of it are one generation and one undo record each", () => {
  const h = opened();
  const cut = runConfined(h.session, cutCommand("r2", "audioText", { from: 6, to: 19 }, ports()).command);
  assert.equal(cut.kind === "applied" ? cut.generation : -1, 1);
  const paste = runConfined(h.session, pasteCommand(request("r4", "audioText", { from: 11, to: 11 }, cell(cmt("c1", "bravo charlie")), { fromCut: true, comments: ["c1"] }), ports()).command);
  assert.equal(paste.kind === "applied" ? paste.generation : -1, 2);
  assert.equal(h.log.filter((l) => l === "undo.record").length, 2);
  assert.equal(h.log.filter((l) => l.startsWith("dirty:")).length, 2);
  assert.deepEqual(anchorsOf(h), [["c1", "r4", "audioText"], ["c2", "r4", "audioText"]]);
  assert.equal(rowOf(h, "r4")?.audioText, "Four " + cmt("c2", "words") + "." + cmt("c1", "bravo charlie"));
});

test("takenBrollIds counts every key in the script and the records unless a cut is moving them; freshBrollIds spends a taken id only once", () => {
  const scope = {
    rows: [
      { id: "r1", visualText: KEY("bsA") + " one", audioText: "said " + KEY("bsC") },
      { id: "r2", visualText: "two", audioText: "" }
    ],
    brollShots: [{ id: "bsA" }, { id: "bsGone" }]
  };
  const ids = (t: Record<string, true>): string[] => Object.keys(t).sort();
  assert.deepEqual(ids(takenBrollIds(scope, "r2", "visualText", rt.decode("two"), false, cells)), ["bsA", "bsC", "bsGone"]);
  assert.deepEqual(ids(takenBrollIds(scope, "r2", "visualText", rt.decode("two"), true, cells)), ["bsA", "bsC"]);
  assert.deepEqual(ids(takenBrollIds(scope, "r1", "visualText", rt.decode(KEY("bsA")), true, cells)), ["bsA", "bsC"]);
  let n = 0;
  const out = freshBrollIds(rt.decode(KEY("bsA") + KEY("bsZ") + KEY("bsZ")), { bsA: true }, () => "m" + String(++n));
  assert.deepEqual(out.minted, ["m1", "m2"]);
  assert.deepEqual(out.cell.filter((r) => r.atom).map((r) => r.atom && r.id), ["m1", "bsZ", "m2"]);
});


const PRIOR = ["", "a", "ab", "ab cd", "Hello there", "x y z", "one<br>two"];
const WORDS = ["", "q", "kilo", "kilo lima", "two words", "a b c d e", "tail."];
const KEY_POOL = ["bsA", "bsB", "bsC", "bsD", "bsE"];
const ZERO_WIDTH = String.fromCharCode(0x200b);

function randomCell(r: Random, ids: readonly string[]): string {
  let html = "";
  const parts = 1 + upTo(r, 3);
  for (let i = 0; i < parts; i++) {
    const kind = upTo(r, 5);
    if (kind === 0) html += "<strong>" + pick(r, WORDS) + "</strong>";
    else if (kind === 1) html += cmt(pick(r, ["c1", "c2"]), pick(r, WORDS));
    else if (kind === 2 && ids.length) html += KEY(pick(r, ids)) + " " + pick(r, WORDS);
    else html += pick(r, PRIOR);
  }
  return html;
}

function randomFixture(r: Random): ReturnType<typeof fixture> {
  const base = fixture();
  const rows = base.rows.map(function (row, i) {
    const keyed = chance(r, 0.5);
    return { ...row, visualText: keyed ? KEY(KEY_POOL[i] as string) + " " + pick(r, WORDS) : pick(r, PRIOR), audioText: randomCell(r, []) };
  });
  const kept = new Set(rows.map((row, i) => (row.visualText.indexOf("broll-key") === -1 ? "" : KEY_POOL[i] as string)));
  const shot = base.brollShots[0] as (typeof base.brollShots)[number];
  return { ...base, rows: rows, brollShots: KEY_POOL.filter((id) => kept.has(id)).map((id) => ({ ...shot, id: id })) };
}

const SEEDS = Number(process.env.SPLITPAGE_FUZZ_SEEDS) || 300;
const STEPS = 6;

function typed(r: Random): string {
  return pick(r, WORDS) + (chance(r, 0.3) ? "\n" : "") + (chance(r, 0.2) ? ZERO_WIDTH : "");
}

function keysIn(html: string): string[] {
  return Array.from(html.matchAll(/data-broll-id="([^"]+)"/g), (m) => m[1] as string);
}

function scriptHtml(h: Held): string {
  return h.session.read(function (doc) { return doc ? doc.rows.map((x) => String(x.visualText) + String(x.audioText)).join("") : ""; });
}

test("seeded: pastes and cuts at random ranges keep the writes confined, count one generation, move the caret and edit the projection exactly", () => {
  const failures: string[] = [];
  const broken: ClipboardPorts = { ...ports(), editor: { name: function () { throw new Error("no editor"); } } };
  for (let seed = 1; seed <= SEEDS && !failures.length; seed++) {
    const r = seeded(0x3140000 + seed);
    const doc = randomFixture(r);
    const h = harness(undefined, { entry: function () { return migratedThenSet(doc); }, reconcile: function (d) { return syncCommentAnchors(d, cells); } });
    h.session.adopt({});
    for (let step = 0; step < STEPS && !failures.length; step++) {
      const label = String(seed) + "/" + String(step);
      const row = pick(r, doc.rows.map((x) => x.id));
      const field = pick(r, ["visualText", "audioText"]);
      const prior = projection(cells(String(rowOf(h, row)?.[field] ?? "")));
      const a = upTo(r, prior.length + 2), b = upTo(r, prior.length + 2);
      const range = chance(r, 0.15) ? null : { from: Math.min(a, b), to: Math.max(a, b) };
      const at = range ? Math.min(range.from, prior.length) : prior.length;
      const end = range ? Math.min(range.to, prior.length) : prior.length;
      const generation = h.session.generation();
      const comments = JSON.stringify(h.session.read((d) => d && d.comments.map((c) => c.id)));
      const useBroken = chance(r, 0.15);
      const shotsBefore = shotIds(h);
      let spec: ReturnType<typeof cutCommand>;
      let expected: string;
      let caret: number | null;
      let fromCut = false;
      if (chance(r, 0.3)) {
        const cutRange = range || { from: 0, to: 0 };
        spec = cutCommand(row, field, cutRange, useBroken ? broken : ports());
        expected = cutRange.from === cutRange.to ? prior : prior.slice(0, at) + prior.slice(end);
        caret = cutRange.from === cutRange.to ? null : at;
      } else {
        const piece = chance(r, 0.5) ? cell(randomCell(r, ["bsA", "bsZ", "bsY"])) : text(typed(r));
        const attach: Attachment[] = chance(r, 0.25) ? [{ kind: "image", ref: chance(r, 0.5) ? PIC : PIC2 }] : [];
        fromCut = piece.kind === "cell" && chance(r, 0.3);
        const given = request(row, field, range, piece, { attach: attach, fromCut: fromCut, comments: piece.kind === "cell" && fromCut ? commentIds(piece.runs) : [] });
        spec = pasteCommand(given, useBroken ? broken : ports("Adam", ["bsA"]));
        const inserted = piece.kind === "text" ? projection(normalizeCell([{ text: piece.text, marks: {} }])) : projection(piece.runs);
        expected = prior.slice(0, at) + inserted + prior.slice(end);
        caret = at + inserted.length;
      }
      try {
        const out = runConfined(h.session, spec.command);
        const now = projection(cells(String(rowOf(h, row)?.[field] ?? "")));
        if (out.kind === "failed") {
          if (!useBroken) failures.push(label + " failed " + (out.error instanceof Error ? out.error.message : ""));
        } else if (useBroken && out.kind === "applied") {
          failures.push(label + " applied through a stamp port that throws");
        } else if (now !== expected) {
          failures.push(label + " projection " + JSON.stringify([prior, now, expected, range]));
        } else if (spec.report().caret !== caret) {
          failures.push(label + " caret " + String(spec.report().caret) + " not " + String(caret));
        }
        if (h.session.generation() !== generation + (out.kind === "applied" ? 1 : 0)) failures.push(label + " generation");
        if (JSON.stringify(h.session.read((d) => d && d.comments.map((c) => c.id))) !== comments) failures.push(label + " comment list changed");
        const added = shotIds(h).filter((id) => shotsBefore.indexOf(id) === -1);
        if (new Set(shotIds(h)).size !== shotIds(h).length) failures.push(label + " duplicate record");
        if (added.some((id) => keysIn(scriptHtml(h)).indexOf(id) === -1)) failures.push(label + " a record with no key");
        if (!fromCut && h.session.read((d) => d && d.comments.some((c) => c.rowId !== (doc.comments.find((x) => x.id === c.id) as { rowId: string }).rowId))) {
          failures.push(label + " an anchor moved without a cut");
        }
      } catch (error) {
        failures.push(label + " threw " + (error instanceof Error ? error.message : String(error)));
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("seeded: a pasted copy never leaves two keys with one id in the script", () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= SEEDS && !failures.length; seed++) {
    const r = seeded(0x3141000 + seed);
    const doc = randomFixture(r);
    const h = harness(undefined, { entry: function () { return migratedThenSet(doc); } });
    h.session.adopt({});
    for (let step = 0; step < 4; step++) {
      const row = pick(r, doc.rows.map((x) => x.id));
      const piece = cell(randomCell(r, ["bsA", "bsB", "bsZ", "bsZ"]));
      const out = runConfined(h.session, pasteCommand(request(row, "visualText", null, piece), ports("Adam", ["bsA"])).command);
      const ids = keysIn(scriptHtml(h));
      if (out.kind === "failed") failures.push(String(seed) + " failed");
      else if (new Set(ids).size !== ids.length) failures.push(String(seed) + "/" + String(step) + " duplicate " + ids.join());
    }
  }
  assert.deepEqual(failures, []);
});

test("cellLength and projection agree on what a position is", () => {
  const runs: Run[] = rt.decode("a" + KEY("bsA") + "b");
  assert.equal(cellLength(runs), projection(runs).length);
  assert.equal(toHtml(runs), "a" + KEY("bsA") + "b");
});