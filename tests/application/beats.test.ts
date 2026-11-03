import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSet } from "../../src/application/session/change-set.ts";
import { CELL_TEXT_DERIVES } from "../../src/application/commands/cell-text.ts";
import {
  BEAT_PASTE_FIELDS, pasteBeatsCommand, removeBeatsCommand
} from "../../src/application/commands/beats.ts";
import type { BeatPaste, BeatPastePlan } from "../../src/application/commands/beats.ts";
import type { DocumentRow, ValidatedDocument } from "../../src/core/document/validated.ts";
import { harness, runConfined } from "./session-fakes.ts";

function script(): Record<string, unknown> {
  return {
    title: "Scenes",
    docId: "d" + "3".repeat(32),
    rows: ["r1", "r2", "r3"].map(function (id, i) {
      return { id: id, visualText: "V" + (i + 1), audioText: "A" + (i + 1), status: "todo" };
    }),
    comments: [{ id: "c1", rowId: "r2", field: "audioText", body: "Tighter", replies: [] }]
  };
}

function opened(): ReturnType<typeof harness> {
  const h = harness();
  h.session.adopt(script());
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function order(h: ReturnType<typeof harness>): string[] {
  return h.session.read(function (doc) { return doc ? doc.rows.map(function (r) { return r.id; }) : []; });
}

function snapshot(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function beat(id: string): DocumentRow {
  return { id: id, visualText: "Pasted " + id, audioText: "", status: "todo" };
}

function fakePaste(planned: BeatPastePlan | null, write?: (live: ValidatedDocument) => void): BeatPaste & { planned: number } {
  const out = {
    planned: 0,
    plan: function () { out.planned++; return planned; },
    apply: function (live: ValidatedDocument) {
      if (write) { write(live); return; }
      if (!planned) return;
      const at = planned.replaced ? live.rows.findIndex(function (r) { return r.id === planned.replaced; }) : live.rows.length;
      live.rows.splice(at, planned.replaced ? 1 : 0, ...planned.inserted.map(beat));
      live.people = [{ id: "p1", name: "Jordan" }];
    }
  };
  return out;
}

const ONE_EDIT = ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"];

test("scenes: a paste is one transaction that declares the inserted scenes and the records that come with them", () => {
  const h = opened();
  const paste = fakePaste({ inserted: ["n1", "n2"], replaced: null, title: false, saveNow: true });
  const out = runConfined(h.session, pasteBeatsCommand(paste));
  assert.deepEqual(out, {
    kind: "applied", generation: 1,
    changes: changeSet({ rowsInserted: ["n1", "n2"], docFields: BEAT_PASTE_FIELDS, derive: CELL_TEXT_DERIVES, saveNow: true })
  });
  assert.deepEqual(h.log, ["reconcile"].concat(ONE_EDIT));
  assert.deepEqual(order(h), ["r1", "r2", "r3", "n1", "n2"]);
  assert.equal(paste.planned, 1);
});

test("scenes: a paste onto a blank scene declares that scene removed, and a new script's title is declared", () => {
  const h = opened();
  const out = runConfined(h.session, pasteBeatsCommand(fakePaste({ inserted: ["n1"], replaced: "r3", title: true, saveNow: false })));
  assert.equal(out.kind, "applied");
  assert.deepEqual(out.kind === "applied" ? out.changes : null, changeSet({
    rowsInserted: ["n1"], rowsRemoved: ["r3"], docFields: BEAT_PASTE_FIELDS.concat(["title"]), derive: CELL_TEXT_DERIVES
  }));
  assert.deepEqual(order(h), ["r1", "r2", "n1"]);
  assert.equal(h.published[0]?.changes.saveNow, false, "a paste whose comments follow in a second step leaves the save to that step");
});

test("scenes: a paste with nothing to insert is a no-op that writes nothing", () => {
  const h = opened();
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, pasteBeatsCommand(fakePaste(null))), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, pasteBeatsCommand(fakePaste({ inserted: [], replaced: null, title: false, saveNow: true }))), { kind: "noop" });
  assert.deepEqual(h.log, []);
  assert.equal(snapshot(h), before);
});

test("scenes: a paste whose scenes did not land, or that throws part way, is rolled back with nothing published", () => {
  const h = opened();
  const before = snapshot(h);
  const short = fakePaste({ inserted: ["n1", "n2"], replaced: null, title: false, saveNow: true }, function (live) {
    live.rows.push(beat("n1"));
    live.people = [{ id: "p9", name: "Half" }];
  });
  const out = runConfined(h.session, pasteBeatsCommand(short));
  assert.equal(out.kind, "failed");
  assert.match(String(out.kind === "failed" ? out.error : ""), /n2 is not in the document/);
  assert.equal(snapshot(h), before);
  const broken = fakePaste({ inserted: ["n1"], replaced: "r1", title: true, saveNow: true }, function (live) {
    live.rows.splice(0, 1, beat("n1"));
    live.title = "Half";
    live.comments.push({ id: "c2", rowId: "n1", field: "audioText", body: "" });
    throw new Error("no clock");
  });
  assert.equal(runConfined(h.session, pasteBeatsCommand(broken)).kind, "failed");
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
});

test("scenes: a refused session pastes nothing and plans nothing", () => {
  const h = opened();
  h.deny("review");
  const paste = fakePaste({ inserted: ["n1"], replaced: null, title: false, saveNow: true });
  assert.deepEqual(runConfined(h.session, pasteBeatsCommand(paste)), { kind: "rejected", reason: "review" });
  assert.equal(paste.planned, 0);
  assert.deepEqual(runConfined(h.session, removeBeatsCommand(["r1"])), { kind: "rejected", reason: "review" });
  assert.deepEqual(order(h), ["r1", "r2", "r3"]);
  assert.deepEqual(h.log, []);
});

test("scenes: a cut or delete removes the scenes still there in one transaction, saves at once and re-points comments", () => {
  const h = opened();
  const out = runConfined(h.session, removeBeatsCommand(["r3", "gone", "r1", "r3"]));
  assert.deepEqual(out, {
    kind: "applied", generation: 1,
    changes: changeSet({ rowsRemoved: ["r3", "r1"], derive: CELL_TEXT_DERIVES, saveNow: true })
  });
  assert.deepEqual(h.log, ["reconcile"].concat(ONE_EDIT));
  assert.deepEqual(order(h), ["r2"]);
});

test("scenes: removing scenes that have all gone is a no-op", () => {
  const h = opened();
  assert.deepEqual(runConfined(h.session, removeBeatsCommand(["gone"])), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, removeBeatsCommand([])), { kind: "noop" });
  assert.deepEqual(h.log, []);
});

