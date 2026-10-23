import "./_dom.mjs";
import "./_export-services-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import "./_preferences-started.mjs";
import { preferences } from "../legacy/preferences-bridge.ts";
import { __init as initSceneStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { mountBrollRecordsFeature as initBroll } from "../bootstrap/wiring/broll.ts";
import { exportComments } from "../adapters/formats/export-kit.ts";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import {
  breakdownRows,
  breakdownTable,
  brollGroups,
  brollShotListForPrint,
  brollTable,
  commentBodyText,
  commentEntries,
  sceneFacts
} from "../adapters/formats/export-projections.ts";
import { LONG_DEMO } from "../js/_starters.js";
import { loadTestDocument } from "./_document.mjs";

initSceneStatus();
initTags();
initBroll();

const copy = (o) => JSON.parse(JSON.stringify(o));
const demo = () => { loadTestDocument(migrateRows(copy(LONG_DEMO.state))); };

function projections(doc) {
  return {
    scenes: sceneFacts(doc),
    breakdown: breakdownRows(doc),
    breakdownTable: breakdownTable(doc),
    brollTable: brollTable(doc),
    shotList: brollShotListForPrint(doc, { filter: "all", group: "scene" }),
    comments: commentEntries(doc, { pieces: true, clockMode: "24" })
  };
}

test("the projections give the same answer after the live document changes, because they read the captured one", () => {
  demo();
  const doc = exportDocumentOf(currentDocument());
  const before = projections(doc);
  assert.ok(before.breakdown.length > 0, "the demo has labelled items");
  assert.ok(before.brollTable.rows.length > 0, "the demo has b-roll");
  assert.ok(before.comments.length > 0, "the demo has comments");

  currentDocument().rows = currentDocument().rows.slice(0, 2);
  currentDocument().comments = [];
  currentDocument().brollShots = [];
  currentDocument().productionTags = [];
  currentDocument().people = [];
  currentDocument().title = "Changed after the capture";

  assert.deepEqual(projections(doc), before);
});

test("a comment's time is formatted with the clock the caller names, not the stored preference", () => {
  demo();
  preferences().setClock("12");
  try {
    const doc = exportDocumentOf(currentDocument());
    const stamped = (opts) => commentEntries(doc, opts).map((c) => c.when);
    const twentyFour = stamped({ clockMode: "24" });
    const twelve = stamped({ clockMode: "12" });
    assert.ok(twentyFour.length > 0);
    assert.ok(twentyFour.every((w) => !/\b[AP]M\b/i.test(w)), twentyFour.join(" | "));
    assert.ok(twelve.every((w) => /\b[AP]M\b/i.test(w)), twelve.join(" | "));
    const system = stamped({ clockMode: "system" });
    assert.deepEqual(stamped({}), system, "with no clock named, the projection uses the system clock and reads no preference");
    preferences().setClock("24");
    assert.deepEqual(stamped({}), system, "changing the stored preference does not reach the projection");
    assert.deepEqual(exportComments(doc).map((c) => c.when), twelve, "the writers use the clock captured with the document");
    assert.deepEqual(stamped({ clockMode: "12" }), twelve, "a clock named by the caller ignores the stored preference");
  } finally {
    preferences().setClock("system");
  }
});

test("b-roll groups come from the rows and people they are given, not from the open document", () => {
  demo();
  const doc = exportDocumentOf(currentDocument());
  const from = { rows: doc.scenes, people: doc.people };
  const grouped = brollGroups(doc.broll, "scene", from);
  loadTestDocument(null);
  assert.deepEqual(brollGroups(doc.broll, "scene", from), grouped);
  assert.ok(grouped.some((g) => g.kind === "scene" && g.row));
});

test("an image in a comment reads as [image] in the plain-text body", () => {
  const entry = { body: "text", pieces: [{ text: "before" }, { image: "a".repeat(64) }, { text: "after" }] };
  assert.equal(commentBodyText(entry), "before\n[image]\nafter");
  assert.equal(commentBodyText({ body: "plain", pieces: [{ text: "plain" }] }), "plain");
});
