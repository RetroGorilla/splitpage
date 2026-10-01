import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { STATE_FIELDS, migrateRows } from "../js/02-state.js";
import { changedBetween, flushEdits, lastUndoEntry, noteEdit, trackDocument, undo, undoSizes } from "../js/12a-undo.js";
import { assertGolden, goldenNames, jsonCopy } from "./golden-helpers.mjs";

const at = (day) => "2026-04-" + String(day).padStart(2, "0") + "T09:00:00.000Z";

function fresh() {
  return migrateRows({
    schema: 2, title: "Undo", docId: "d" + "5".repeat(32), rev: 3, lastEditedBy: "Sam", lastEditedAt: at(1),
    wordsPerMinute: 150, personColors: { Sam: "#80BDFB" }, targetSeconds: 300,
    rows: [{ id: "r1", status: "todo", visualText: "Wide.", audioText: "Hello there.", updatedAt: at(1), updatedBy: "Sam" }],
    comments: [], people: [{ id: "p1", name: "Sam" }],
    productionTags: [{ id: "t_kettle", cat: "prop", name: "Kettle", owner: "", notes: "", status: "needed" }],
    brollShots: []
  });
}

const EDITS = [
  ["title", "changed", (s) => { s.title = "Undo, edited"; }],
  ["docId", "changed", (s) => { s.docId = "d" + "6".repeat(32); }],
  ["rows", "a cell changed", (s) => { s.rows[0].audioText = "Hello again."; }],
  ["rows", "a row added", (s) => { s.rows.push({ id: "r2", status: "todo", visualText: "", audioText: "New.", imageRef: null, updatedAt: "", updatedBy: null }); }],
  ["comments", "one added", (s) => {
    s.comments.push({
      id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "", author: "Sam", body: "Look", resolved: false,
      resolvedBy: null, resolvedAt: null, assignee: "", createdAt: at(2), updatedAt: at(2), kind: "anchor", replies: []
    });
  }],
  ["people", "one added", (s) => { s.people.push({ id: "p2", name: "Ada" }); }],
  ["productionTags", "a status changed", (s) => { s.productionTags[0].status = "have"; }],
  ["brollShots", "one added", (s) => {
    s.brollShots.push({
      id: "bs_new", name: "Gulls", desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "",
      location: "", props: [], origin: "list"
    });
  }],
  ["wordsPerMinute", "changed", (s) => { s.wordsPerMinute = 180; }],
  ["rev", "changed", (s) => { s.rev = 4; }],
  ["lastEditedBy", "changed", (s) => { s.lastEditedBy = "Ada"; }],
  ["lastEditedAt", "changed", (s) => { s.lastEditedAt = at(3); }],
  ["personColors", "a colour changed", (s) => { s.personColors.Sam = "#F9B64F"; }],
  ["personColors", "removed", (s) => { delete s.personColors; }],
  ["targetSeconds", "changed", (s) => { s.targetSeconds = 420; }],
  ["targetSeconds", "removed", (s) => { delete s.targetSeconds; }],
  ["schema", "changed", (s) => { s.schema = 3; }]
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test("undo golden: state-fields", () => {
  const out = EDITS.map(([key, label, edit]) => {
    S.state = fresh();
    trackDocument();
    const before = jsonCopy(S.state);
    edit(S.state);
    const touched = changedBetween(before, S.state);
    noteEdit();
    flushEdits();
    const entry = lastUndoEntry();
    const entries = undoSizes().undo;
    const r = undo();
    return {
      key, edit: label, undoEntries: entries,
      steps: entry ? entry.steps.map((s) => s.op + (s.key ? ":" + s.key : "")) : [],
      undo: r.ok ? "applied" : r.empty ? "nothing to undo" : "refused: " + r.reason,
      restored: same(S.state[key], before[key]),
      changedBetween: { doc: Object.keys(touched.doc), rowFields: Object.keys(touched.rowFields), structure: touched.structure }
    };
  });
  const keys = STATE_FIELDS.map((f) => f.key);
  assert.deepEqual(keys.filter((k) => !EDITS.some((e) => e[0] === k)), [], "every STATE_FIELDS key has an edit");
  assertGolden("undo-state-fields", {
    undone: [...new Set(out.filter((o) => o.undoEntries).map((o) => o.key))],
    notUndone: [...new Set(out.filter((o) => !o.undoEntries).map((o) => o.key))],
    edits: out
  });
});

test("every undo fixture belongs to a test", () => {
  assert.deepEqual(goldenNames("undo-"), ["undo-state-fields"]);
});
