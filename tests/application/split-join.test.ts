import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import { bothScenesHaveVisual, cellHtml, joinScenesCommand, splitSceneCommand, textCut } from "../../src/application/commands/split-join.ts";
import type { JoinPorts } from "../../src/application/commands/split-join.ts";
import { syncCommentAnchors } from "../../src/core/text/anchors.ts";
import { clampRange } from "../../src/core/text/edits.ts";
import { createRichText } from "../../src/adapters/richtext/richtext.ts";
import { toHtml } from "../../src/core/text/html.ts";
import { normalizeCell, projection } from "../../src/core/text/runs.ts";
import type { Marks, Run } from "../../src/core/text/runs.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { createImageIngestion } from "../../src/core/document/media.ts";
import { jsdomParser } from "../adapters/richtext/jsdom.mjs";
import { countingIds, migratedThenSet } from "../core/migrate-ports.ts";
import { harness, runConfined } from "./session-fakes.ts";

const STAMP = "2026-10-08T12:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";
const LINKS = [{ href: "https://youtu.be/abc" }];
const CARD = '<a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>';
const VIDEO: Run = { atom: "video", href: "https://youtu.be/abc", host: "youtu.be", text: "", marks: {} };
const STORED_CARD = toHtml([VIDEO]);

const rt = createRichText({ DOMParser: jsdomParser(), images: createImageIngestion(function () { return null; }), ids: countingIds() });
const cellsOf = rt.createCellReader(deepFreeze, { media: true });

function html(runs: readonly Run[]): string {
  return toHtml(normalizeCell(runs));
}

function plainText(h: string | null | undefined): string {
  if (!h) return "";
  return (rt.inertBody(String(h).replace(/<br\s*\/?>/gi, "\n")).textContent || "").split(String.fromCharCode(0xa0)).join(" ").trim();
}

function run(text: string, marks: Marks = {}): Run {
  return { text: text, marks: marks };
}

interface Counting extends JoinPorts {
  asked: () => number;
}

function ports(name = "Adam", failOn = 0): Counting {
  let asked = 0;
  return {
    asked: function () { return asked; },
    clock: {
      nowIso: function () {
        asked++;
        if (failOn && asked === failOn) throw new Error("clock stopped");
        return STAMP;
      }
    },
    editor: { name: function () { return name; } },
    cells: cellsOf,
    plainText: plainText
  };
}

const COMMENTED = html([run("Alpha "), run("bravo charlie", { cmt: ["c1"] }), run(" delta")]);
const PLAIN = html([run("Every morning.")]);

type Fixture = { title: string; docId: string; rows: Record<string, unknown>[]; comments: Record<string, unknown>[] };

function fixture(): Fixture {
  return {
    title: "Harbour",
    docId: "d" + "1".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: PLAIN, status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r2", visualText: "Close", audioText: COMMENTED, status: "ready", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r3", visualText: "", audioText: "Third.", status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r4", visualText: "", audioText: "Fourth.", status: "shot", updatedAt: OLD, updatedBy: "Sam" }
    ],
    comments: [{ id: "c1", anchorId: "c1", kind: "anchor", rowId: "r2", field: "audioText", body: "Tighter", replies: [] }]
  };
}

function reconciling(doc: Parameters<typeof syncCommentAnchors>[0]): number {
  return syncCommentAnchors(doc, cellsOf);
}

type Opened = ReturnType<typeof harness> & { left: () => number };

function opened(make: () => Fixture = fixture): Opened {
  let held: ValidatedDocument | null = null;
  const h = harness(undefined, {
    entry: function () { held = migratedThenSet(make()); return held; },
    reconcile: reconciling
  });
  h.session.adopt({});
  h.log.length = 0;
  h.published.length = 0;
  return Object.assign(h, { left: function () { return held ? reconciling(held) : -1; } });
}

type Row = Record<string, unknown>;

function rowOf(h: ReturnType<typeof harness>, rowId: string): Row | null {
  return h.session.read(function (doc) {
    const row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row ? JSON.parse(JSON.stringify(row)) as Row : null;
  });
}

function idsOf(h: ReturnType<typeof harness>): string[] {
  return h.session.read(function (doc) { return doc ? doc.rows.map(function (r) { return r.id; }) : []; });
}

function snapshot(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function places(h: ReturnType<typeof harness>): string[] {
  return h.session.read(function (doc) {
    return doc ? doc.comments.map(function (c) { return c.id + "@" + String(c.rowId) + "/" + String(c.field); }) : [];
  });
}

const COMMIT = ["reconcile", "undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"];

test("E2: a split is one generation, one reconciliation, one undo record and one effect pass; the scene after it is a fresh todo scene", () => {
  const h = opened();
  const p = ports();
  const out = runConfined(h.session, splitSceneCommand("r1", "audioText", textCut(5, 5), "new1", p));
  assert.deepEqual(out, {
    kind: "applied",
    generation: 1,
    changes: changeSet({
      cells: [{ rowId: "r1", field: "audioText" }, { rowId: "r1", field: "updatedAt" }, { rowId: "r1", field: "updatedBy" }],
      rowsInserted: ["new1"],
      derive: ["production", "broll"]
    })
  });
  assert.deepEqual(h.log, COMMIT);
  assert.deepEqual(idsOf(h), ["r1", "new1", "r2", "r3", "r4"]);
  assert.equal(rowOf(h, "r1")?.audioText, "Every");
  assert.equal(rowOf(h, "r1")?.updatedAt, STAMP);
  assert.equal(rowOf(h, "r1")?.updatedBy, "Adam");
  assert.equal(rowOf(h, "r1")?.visualText, "Wide", "the other field is left alone");
  const made = rowOf(h, "new1");
  assert.deepEqual(made, {
    id: "new1", visualText: "", imageRef: null, audioText: " morning.", status: "todo", updatedAt: STAMP, updatedBy: "Adam"
  });
  assert.deepEqual(Object.keys(made || {}), ["id", "visualText", "imageRef", "audioText", "status", "updatedAt", "updatedBy"]);
  assert.equal(rowOf(h, "r2")?.updatedAt, OLD, "no other scene is stamped");
  assert.equal(h.published[0]?.changes.saveNow, false);
  h.clock.advance(180);
  assert.deepEqual(h.refreshes, [["broll", "production"]], "the derivations run once, on the idle refresh");
  assert.equal(h.clock.armed(), 0);
});

test("a split in the visual field puts the second half in the new scene's visual field", () => {
  const h = opened();
  assert.equal(runConfined(h.session, splitSceneCommand("r1", "visualText", textCut(2, 2), "new1", ports())).kind, "applied");
  assert.equal(rowOf(h, "r1")?.visualText, "Wi");
  assert.equal(rowOf(h, "r1")?.audioText, PLAIN);
  assert.equal(rowOf(h, "new1")?.visualText, "de");
  assert.equal(rowOf(h, "new1")?.audioText, "");
});

test("a cut deletes its selection first and clamps to the cell; a cut of the whole text leaves two empty halves", () => {
  const h = opened();
  const p = ports();
  assert.equal(runConfined(h.session, splitSceneCommand("r3", "audioText", textCut(2, 4), "a", p)).kind, "applied");
  assert.equal(rowOf(h, "r3")?.audioText, "Th");
  assert.equal(rowOf(h, "a")?.audioText, "d.");
  assert.equal(runConfined(h.session, splitSceneCommand("r4", "audioText", textCut(-5, 999), "b", p)).kind, "applied");
  assert.equal(rowOf(h, "r4")?.audioText, "");
  assert.equal(rowOf(h, "b")?.audioText, "");
  assert.equal(runConfined(h.session, splitSceneCommand("r1", "audioText", textCut(9, 3), "c", p)).kind, "applied");
  assert.equal(rowOf(h, "r1")?.audioText, "Eve");
  assert.equal(rowOf(h, "c")?.audioText, "ning.", "a backwards selection is the same range");
});

test("a cut never lands inside a surrogate pair", () => {
  const doc = fixture();
  doc.rows[2] = { id: "r3", visualText: "", audioText: html([run("a\u{1F600}b")]), status: "todo" };
  const h = opened(() => doc);
  assert.equal(runConfined(h.session, splitSceneCommand("r3", "audioText", textCut(2, 2), "n", ports())).kind, "applied");
  assert.equal(rowOf(h, "r3")?.audioText, "a\u{1F600}");
  assert.equal(rowOf(h, "n")?.audioText, "b");
});

test("a split of a cell holding media cuts its runs: a card counts as one place and goes whole to one side", () => {
  const mediaDoc = function (): Fixture {
    const doc = fixture();
    doc.rows[0] = { id: "r1", visualText: "Wide", audioText: "Before " + CARD + " after", status: "todo", updatedAt: OLD, updatedBy: "Sam" };
    return doc;
  };
  const h = opened(mediaDoc);
  const p = ports();
  const out = runConfined(h.session, splitSceneCommand("r1", "audioText", textCut(8, 8), "m", p));
  assert.equal(out.kind, "applied");
  assert.equal(rowOf(h, "r1")?.audioText, "Before " + STORED_CARD);
  assert.equal(rowOf(h, "m")?.audioText, " after");
  assert.deepEqual(h.log, COMMIT);
  const again = opened(mediaDoc);
  assert.equal(runConfined(again.session, splitSceneCommand("r1", "audioText", textCut(7, 7), "n", ports())).kind, "applied");
  assert.equal(rowOf(again, "r1")?.audioText, "Before ");
  assert.equal(rowOf(again, "n")?.audioText, STORED_CARD + " after");
});

test("E3: a scene that is gone, a field that is not a script field, and no document change nothing", () => {
  const h = opened();
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, splitSceneCommand("gone", "audioText", textCut(1, 1), "n", ports())), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, splitSceneCommand("r1", "status", textCut(1, 1), "n", ports())), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, splitSceneCommand("r1", "__proto__", textCut(1, 1), "n", ports())), { kind: "noop" });
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
  assert.equal(h.session.generation(), 0);
  const empty = harness();
  assert.deepEqual(runConfined(empty.session, splitSceneCommand("r1", "audioText", textCut(1, 1), "n", ports())), { kind: "rejected", reason: NO_DOCUMENT });
  assert.deepEqual(runConfined(empty.session, joinScenesCommand("r1", ports())), { kind: "rejected", reason: NO_DOCUMENT });
});

test("both commands ask for edit capability: a denied session rejects them before they plan and changes nothing", () => {
  const h = opened();
  const before = snapshot(h);
  h.deny("review");
  assert.deepEqual(runConfined(h.session, splitSceneCommand("r3", "audioText", textCut(2, 2), "n", ports())), { kind: "rejected", reason: "review" });
  assert.deepEqual(runConfined(h.session, joinScenesCommand("r3", ports())), { kind: "rejected", reason: "review" });
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
  assert.equal(h.session.generation(), 0);
  h.deny(null);
  assert.equal(runConfined(h.session, splitSceneCommand("r3", "audioText", textCut(2, 2), "n", ports())).kind, "applied");
  assert.equal(runConfined(h.session, joinScenesCommand("r3", ports())).kind, "applied");
});

test("E3: a stamp that throws part-way fails the split, takes the inserted scene out again and leaves the document byte-identical", () => {
  const h = opened();
  const before = snapshot(h);
  [1, 2].forEach(function (failOn) {
    const out = runConfined(h.session, splitSceneCommand("r2", "audioText", textCut(3, 3), "n", ports("Adam", failOn)));
    assert.equal(out.kind, "failed", "clock call " + failOn);
    assert.equal(snapshot(h), before, "clock call " + failOn);
  });
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.equal(h.clock.armed(), 0);
});

test("E9: a split before a commented phrase moves its comment inside the transaction, in one undo record", () => {
  const h = opened();
  const out = runConfined(h.session, splitSceneCommand("r2", "audioText", textCut(6, 6), "n", ports()));
  assert.equal(out.kind, "applied");
  assert.deepEqual(places(h), ["c1@n/audioText"]);
  assert.deepEqual(h.log, COMMIT);
  assert.equal(h.log.filter(function (l) { return l === "undo.record"; }).length, 1);
  assert.equal(h.left(), 0, "nothing is left for a later reconciliation to move");
});

test("E9: a split through a commented phrase leaves the comment on the first half; one over all of it leaves it where it was", () => {
  const through = opened();
  assert.equal(runConfined(through.session, splitSceneCommand("r2", "audioText", textCut(12, 12), "n", ports())).kind, "applied");
  assert.deepEqual(places(through), ["c1@r2/audioText"]);
  assert.equal(rowOf(through, "r2")?.audioText, html([run("Alpha "), run("bravo ", { cmt: ["c1"] })]));
  assert.equal(rowOf(through, "n")?.audioText, html([run("charlie", { cmt: ["c1"] }), run(" delta")]));
  const over = opened();
  assert.equal(runConfined(over.session, splitSceneCommand("r2", "audioText", textCut(6, 19), "n", ports())).kind, "applied");
  assert.deepEqual(places(over), ["c1@r2/audioText"]);
});

function joinOf(a: Row, b: Row): Fixture {
  const doc = fixture();
  doc.rows = [a, b, { id: "z", visualText: "", audioText: "Last.", status: "todo" }];
  doc.comments = [];
  return doc;
}

function scene(id: string, audio: string, extra: Row = {}): Row {
  return Object.assign({ id: id, visualText: "", audioText: audio, status: "todo", updatedAt: OLD, updatedBy: "Sam" }, extra);
}

test("E2: a join is one generation, one reconciliation, one undo record and one effect pass; the earlier scene is stamped and the later one is gone", () => {
  const h = opened(() => joinOf(scene("a", "One."), scene("b", "Two.", { status: "ready" })));
  const p = ports();
  const out = runConfined(h.session, joinScenesCommand("a", p));
  assert.deepEqual(out, {
    kind: "applied",
    generation: 1,
    changes: changeSet({
      cells: [
        { rowId: "a", field: "audioText" }, { rowId: "a", field: "updatedAt" }, { rowId: "a", field: "updatedBy" }, { rowId: "a", field: "status" }
      ],
      rowsRemoved: ["b"],
      derive: ["production", "broll"]
    })
  });
  assert.deepEqual(h.log, COMMIT);
  assert.deepEqual(idsOf(h), ["a", "z"]);
  assert.equal(rowOf(h, "a")?.audioText, "One. Two.");
  assert.equal(rowOf(h, "a")?.status, "ready");
  assert.equal(rowOf(h, "a")?.updatedAt, STAMP);
  assert.equal(rowOf(h, "a")?.updatedBy, "Adam");
  assert.equal(rowOf(h, "z")?.updatedAt, undefined);
  assert.equal(h.published[0]?.changes.saveNow, false);
  h.clock.advance(180);
  assert.deepEqual(h.refreshes, [["broll", "production"]], "the derivations run once, on the idle refresh");
  assert.equal(h.clock.armed(), 0);
});

test("a join keeps the further status by rank, and a status outside the ranks counts as the lowest", () => {
  const statuses = ["todo", "ready", "shot", "bespoke", undefined];
  const rank = (s: unknown) => s === "ready" ? 1 : s === "shot" ? 2 : 0;
  statuses.forEach(function (a) {
    statuses.forEach(function (b) {
      const first = scene("a", "One.");
      const second = scene("b", "Two.");
      if (a === undefined) delete first.status; else first.status = a;
      if (b === undefined) delete second.status; else second.status = b;
      const h = opened(() => joinOf(first, second));
      assert.equal(runConfined(h.session, joinScenesCommand("a", ports())).kind, "applied", String(a) + " + " + String(b));
      assert.equal(rowOf(h, "a")?.status, rank(b) > rank(a) ? b : a, String(a) + " + " + String(b));
    });
  });
});

test("a join glues with a space only when both sides have text and the earlier one does not end in a space", () => {
  const cases: [string, string, string][] = [
    ["One.", "Two.", "One. Two."],
    ["One. ", "Two.", "One. Two."],
    ["", "Two.", "Two."],
    ["One.", "", "One."],
    ["", "", ""]
  ];
  cases.forEach(function (c) {
    const h = opened(() => joinOf(scene("a", c[0]), scene("b", c[1])));
    assert.equal(runConfined(h.session, joinScenesCommand("a", ports())).kind, "applied");
    assert.equal(rowOf(h, "a")?.audioText, c[2], JSON.stringify(c));
  });
});

test("a join glues a space inside a commented phrase the cut split, so the phrase is one anchor again", () => {
  const first = html([run("Alpha "), run("bra", { cmt: ["c1"] })]);
  const second = html([run("vo charlie", { cmt: ["c1"] }), run(" delta")]);
  const h = opened(() => joinOf(scene("a", first), scene("b", second)));
  assert.equal(runConfined(h.session, joinScenesCommand("a", ports())).kind, "applied");
  assert.equal(rowOf(h, "a")?.audioText, html([run("Alpha "), run("bra vo charlie", { cmt: ["c1"] }), run(" delta")]));
});

test("a join where either audio holds media joins the runs, with a space unless the earlier one ends in a space or a line break", () => {
  const cases: [string, string, string][] = [
    ["See", CARD, "See " + STORED_CARD],
    ["See ", CARD, "See " + STORED_CARD],
    ["See<br>", CARD, "See<br>" + STORED_CARD],
    ["", CARD, STORED_CARD],
    [CARD, "after", STORED_CARD + " after"],
    ["<strong>Bold </strong>", "<strong>more</strong> " + CARD, "<strong>Bold more</strong> " + STORED_CARD]
  ];
  cases.forEach(function (c) {
    const h = opened(() => joinOf(scene("a", c[0]), scene("b", c[1])));
    assert.equal(runConfined(h.session, joinScenesCommand("a", ports())).kind, "applied");
    assert.equal(rowOf(h, "a")?.audioText, c[2], JSON.stringify(c));
  });
});

test("a join into a scene with no visual takes the later scene's visual text and gallery slot, and declares every field the slot can write", () => {
  const h = opened(() => joinOf(scene("a", "One."), scene("b", "Two.", { visualText: "Drone", imageLinks: LINKS, imageName: "gone", visualImage: "old" })));
  const out = runConfined(h.session, joinScenesCommand("a", ports()));
  assert.equal(out.kind, "applied");
  const a = rowOf(h, "a");
  assert.equal(a?.visualText, "Drone");
  assert.deepEqual(a?.imageLinks, LINKS);
  assert.equal(a?.imageRef, null);
  assert.equal(a?.visualImage, undefined);
  assert.equal(a?.imageName, undefined, "a name belongs to a picture, and this slot has none");
  const fields = out.kind === "applied" ? out.changes.cells.map(function (c) { return c.field; }) : [];
  ["visualText", "visualImage", "imageRef", "imageName", "imageLinks", "imageAnnotation", "moreImages"].forEach(function (f) {
    assert.ok(fields.indexOf(f) !== -1, f);
  });
});

test("a join takes a whole gallery of pictures: the first picture, its name and annotation, and the further ones", () => {
  const ref = (c: string) => ({ sha256: c.repeat(64), width: 10, height: 8, mime: "image/png" });
  const marks = [{ kind: "arrow" }];
  const h = opened(() => joinOf(scene("a", "One."), scene("b", "Two.", {
    imageRef: ref("a"), imageName: "first", imageAnnotation: { imageRef: ref("c"), marks: marks },
    moreImages: [{ imageRef: ref("b"), name: "second" }]
  })));
  const out = runConfined(h.session, joinScenesCommand("a", ports()));
  assert.equal(out.kind, "applied");
  const a = rowOf(h, "a");
  assert.deepEqual(a?.imageRef, ref("a"));
  assert.equal(a?.imageName, "first");
  assert.deepEqual(a?.imageAnnotation, { imageRef: ref("c"), marks: marks });
  assert.deepEqual(a?.moreImages, [{ imageRef: ref("b"), name: "second" }]);
});

test("a join into a scene that has the visual keeps it, and does not declare the visual cells", () => {
  const h = opened(() => joinOf(scene("a", "One.", { visualText: "Keep", imageLinks: LINKS }), scene("b", "Two.")));
  const out = runConfined(h.session, joinScenesCommand("a", ports()));
  assert.equal(out.kind, "applied");
  assert.equal(rowOf(h, "a")?.visualText, "Keep");
  assert.deepEqual(rowOf(h, "a")?.imageLinks, LINKS);
  const fields = out.kind === "applied" ? out.changes.cells.map(function (c) { return c.field; }) : [];
  assert.deepEqual(fields, ["audioText", "updatedAt", "updatedBy"]);
});

test("a visual of only a line break or space is not a visual; a gallery slot alone is", () => {
  const p = ports();
  const none = opened(() => joinOf(scene("a", "One.", { visualText: "One" }), scene("b", "Two.", { visualText: " " })));
  assert.equal(none.session.read(bothScenesHaveVisual("a", p.plainText)), false);
  const gallery = opened(() => joinOf(scene("a", "One.", { imageLinks: LINKS }), scene("b", "Two.", { visualText: "Two" })));
  assert.equal(gallery.session.read(bothScenesHaveVisual("a", p.plainText)), true);
  assert.equal(gallery.session.read(bothScenesHaveVisual("b", p.plainText)), false, "the last scene has no later one to join");
  assert.equal(gallery.session.read(bothScenesHaveVisual("gone", p.plainText)), false);
  assert.equal(harness().session.read(bothScenesHaveVisual("a", p.plainText)), false);
});

test("E3: two scenes with visuals are refused with no effect at all, whatever the visuals are made of", () => {
  const shapes: [string, Row, Row][] = [
    ["text and text", { visualText: "One" }, { visualText: "Two" }],
    ["gallery and text", { imageLinks: LINKS }, { visualText: "Two" }],
    ["text and gallery", { visualText: "One" }, { imageLinks: LINKS }],
    ["gallery and gallery", { imageLinks: LINKS }, { imageLinks: LINKS }]
  ];
  shapes.forEach(function (s) {
    const h = opened(() => joinOf(scene("a", "One.", s[1]), scene("b", "Two.", s[2])));
    const before = snapshot(h);
    const p = ports();
    assert.deepEqual(runConfined(h.session, joinScenesCommand("a", p)), { kind: "rejected", reason: "both scenes have a visual" }, s[0]);
    assert.equal(snapshot(h), before, s[0]);
    assert.equal(p.asked(), 0, s[0]);
    assert.deepEqual(h.log, [], s[0]);
    assert.equal(h.session.generation(), 0, s[0]);
    assert.equal(h.clock.armed(), 0, s[0]);
  });
});

test("E3: joining the last scene, an unknown scene or a scene with no one after it is a no-op", () => {
  const h = opened();
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, joinScenesCommand("r4", ports())), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, joinScenesCommand("gone", ports())), { kind: "noop" });
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
});

test("E3: a stamp that throws part-way fails the join and puts the later scene, the earlier text, status and visual back in place", () => {
  const make = () => joinOf(
    scene("a", "One.", { imageName: "keep-me" }),
    scene("b", "Two.", { status: "shot", visualText: "Drone", imageLinks: LINKS, visualImage: "old" })
  );
  const h = opened(make);
  const before = snapshot(h);
  assert.equal(runConfined(h.session, joinScenesCommand("a", ports("Adam", 1))).kind, "failed");
  assert.equal(snapshot(h), before);
  const broken: JoinPorts = { ...ports(), editor: { name: function () { throw new Error("no editor"); } } };
  assert.equal(runConfined(h.session, joinScenesCommand("a", broken)).kind, "failed");
  assert.equal(snapshot(h), before);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
});

test("E9: a join brings the later scene's comments to the earlier scene inside the transaction, in one undo record", () => {
  const doc = fixture();
  doc.rows = [
    scene("a", "One."),
    scene("b", html([run("Two "), run("words", { cmt: ["c2"] })]), { visualText: html([run("Drone "), run("over", { cmt: ["c3"] })]) }),
    scene("z", "Last.")
  ];
  doc.comments = [
    { id: "c2", anchorId: "c2", kind: "anchor", rowId: "b", field: "audioText", body: "", replies: [] },
    { id: "c3", anchorId: "c3", kind: "anchor", rowId: "b", field: "visualText", body: "", replies: [] }
  ];
  const h = opened(() => doc);
  assert.equal(runConfined(h.session, joinScenesCommand("a", ports())).kind, "applied");
  assert.deepEqual(places(h), ["c2@a/audioText", "c3@a/visualText"]);
  assert.deepEqual(h.log, COMMIT);
  assert.equal(h.log.filter(function (l) { return l === "undo.record"; }).length, 1);
});

type Random = () => number;

function seeded(seed: number): Random {
  let s = (Math.imul(seed, 2654435761) >>> 0) || 1;
  return function () {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) / 16777216;
  };
}

function pick<T>(r: Random, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)] as T;
}

const IDS = ["c1", "c2", "c3", "c4"];
const WORDS = ["a", "bc", "def", " x", "y ", "\u{1F600}"];
const STATUSES = ["todo", "ready", "shot"];

function randomRuns(r: Random, most: number): Run[] {
  const runs: Run[] = [];
  const n = Math.floor(r() * (most + 1));
  for (let i = 0; i < n; i++) {
    const marks: Marks = {};
    if (r() < 0.4) marks.cmt = [pick(r, IDS)];
    if (r() < 0.2) marks.b = true;
    runs.push({ text: pick(r, WORDS), marks: marks });
  }
  return normalizeCell(runs);
}

function randomDoc(r: Random, seed: number): Fixture {
  const rows: Row[] = [];
  const count = 2 + Math.floor(r() * 5);
  for (let i = 0; i < count; i++) {
    rows.push({
      id: "r" + i, status: pick(r, STATUSES), updatedAt: OLD, updatedBy: "Sam",
      visualText: r() < 0.5 ? "" : html(randomRuns(r, 2)),
      audioText: html(randomRuns(r, 4))
    });
  }
  const comments = IDS.map(function (id) {
    return { id: id, anchorId: id, kind: "anchor", rowId: "r0", field: pick(r, ["visualText", "audioText"]), body: "", replies: [] };
  });
  const doc = { title: "Fuzz " + seed, docId: "d" + "1".repeat(32), rows: rows, comments: comments };
  syncCommentAnchors(migratedThenSet(doc), cellsOf);
  return doc;
}

test("E9 (seeded): split and join leave every comment where reconciliation would put it, in one undo record", () => {
  let splits = 0, joins = 0, refused = 0, moved = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = seeded(seed);
    const doc = randomDoc(r, seed);
    const h = opened(() => doc);
    for (let step = 0; step < 8; step++) {
      const ids = idsOf(h);
      const records = h.log.filter(function (l) { return l === "undo.record"; }).length;
      const was = places(h);
      let command;
      if (r() < 0.55) {
        const id = pick(r, ids);
        const field = pick(r, ["visualText", "audioText"]);
        const text = String(rowOf(h, id)?.[field] ?? "");
        const length = projection(cellsOf(text)).length;
        const from = Math.floor(r() * (length + 2)), to = r() < 0.5 ? from : Math.floor(r() * (length + 2));
        command = splitSceneCommand(id, field, textCut(from, to), "n" + seed + "-" + step, ports());
      } else {
        command = joinScenesCommand(pick(r, ids), ports());
      }
      const out = runConfined(h.session, command);
      const after = h.log.filter(function (l) { return l === "undo.record"; }).length;
      if (out.kind === "applied") {
        assert.equal(after, records + 1, "seed " + seed + " step " + step + ": one undo record");
        assert.equal(h.left(), 0, "seed " + seed + " step " + step + ": no anchor left to move");
        if (command.name === "split-scene") splits++; else joins++;
        if (places(h).join() !== was.join()) moved++;
      } else {
        assert.equal(after, records, "seed " + seed + " step " + step + ": nothing recorded");
        if (out.kind === "rejected") refused++;
        assert.notEqual(out.kind, "failed");
      }
    }
  }
  assert.ok(splits > 300, "splits: " + splits);
  assert.ok(joins > 200, "joins: " + joins);
  assert.ok(refused > 20, "refusals: " + refused);
  assert.ok(moved > 50, "and a good share of them move a comment: " + moved);
});

test("the halves a text cut makes are exactly the cell split at the cut with its selection removed (seeded)", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = seeded(seed);
    const runs = randomRuns(r, 5);
    const stored = html(runs);
    const doc = Object.assign(fixture(), { rows: [scene("a", stored)], comments: [] });
    const h = opened(() => doc);
    const text = projection(runs);
    const from = Math.floor(r() * (text.length + 3)) - 1, to = from + Math.floor(r() * 4) - 1;
    const cut = clampRange(runs, from, to);
    assert.equal(runConfined(h.session, splitSceneCommand("a", "audioText", textCut(from, to), "n", ports())).kind, "applied");
    assert.equal(projection(cellsOf(String(rowOf(h, "a")?.audioText))), text.slice(0, cut.from), "seed " + seed + ": the first half");
    assert.equal(projection(cellsOf(String(rowOf(h, "n")?.audioText))), text.slice(cut.to), "seed " + seed + ": the second half");
  }
});

test("cellHtml reads the stored HTML of a scene's field, or null when the scene is gone", () => {
  const h = opened();
  assert.equal(h.session.read(cellHtml("r1", "audioText")), PLAIN);
  assert.equal(h.session.read(cellHtml("r3", "nothing")), "");
  assert.equal(h.session.read(cellHtml("gone", "audioText")), null);
  assert.equal(harness().session.read(cellHtml("r1", "audioText")), null);
});
