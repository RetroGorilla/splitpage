import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import type { Command } from "../../src/application/session/document-session.ts";
import { NO_CHANGES, cellEdit, changeSet } from "../../src/application/session/change-set.ts";
import type { Capability } from "../../src/application/session/ports.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { judge } from "./raw-inputs.ts";
import { harness, rawScript, runConfined, writesOutside } from "./session-fakes.ts";

function migrateFake(raw: unknown): ValidatedDocument {
  return migrateRows(raw, fakeMigration().ports);
}

function setAudio(rowId: string, text: string): Command {
  return {
    name: "set-audio",
    needs: "edit",
    plan: function (doc) {
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row) return { refused: "no such scene" };
      if (row.audioText === text) return null;
      return {
        changes: cellEdit(rowId, "audioText", ["production"]),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === rowId; });
          if (target) target.audioText = text;
        }
      };
    }
  };
}

function insertRow(id: string): Command {
  return {
    name: "insert-row",
    needs: "edit",
    plan: function () {
      return {
        changes: changeSet({ rowsInserted: [id] }),
        apply: function (live) { live.rows.push({ id: id, visualText: "", audioText: "" }); }
      };
    }
  };
}

function opened(): ReturnType<typeof harness> {
  const h = harness();
  h.session.adopt(rawScript("Harbour"));
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function audioOf(h: ReturnType<typeof harness>, rowId: string): unknown {
  return h.session.read(function (doc) {
    const row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row ? row.audioText : undefined;
  });
}

test("E2: an accepted command makes one generation transition, records undo once and runs one effect pass, in that order", () => {
  const h = opened();
  const out = runConfined(h.session,setAudio("r1", "Every evening."));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: cellEdit("r1", "audioText", ["production"]) });
  assert.equal(h.session.generation(), 1);
  assert.equal(audioOf(h, "r1"), "Every evening.");
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  assert.equal(h.published.length, 1);
  assert.deepEqual([h.published[0]?.kind, h.published[0]?.generation, h.published[0]?.epoch], ["edit", 1, 1]);
  runConfined(h.session,setAudio("r2", "Nets."));
  assert.equal(h.session.generation(), 2, "the next accepted command makes the next transition");
});

test("E2: a one-cell edit does not reconcile anchors; a change that inserts a row reconciles inside the transaction, before undo records it", () => {
  const h = opened();
  runConfined(h.session,setAudio("r1", "Every evening."));
  assert.equal(h.log.includes("reconcile"), false);
  h.log.length = 0;
  runConfined(h.session,insertRow("r3"));
  assert.deepEqual(h.log, ["reconcile", "undo.record", "dirty:2", "draft:2", "save:2", "publish:edit"]);
});

test("removing or moving rows reconciles; a document-field or whole-document change is an edit that does not", () => {
  const cases: [string, Parameters<typeof changeSet>[0], boolean][] = [
    ["remove", { rowsRemoved: ["r2"] }, true],
    ["move", { rowsMoved: true }, true],
    ["runs", { runsMoved: true }, true],
    ["title", { docFields: ["title"] }, false],
    ["whole", { whole: true }, false]
  ];
  cases.forEach(function ([name, parts, reconciles]) {
    const h = opened();
    const command: Command = { name: name, needs: "edit", plan: function () { return { changes: changeSet(parts), apply: function () {} }; } };
    assert.equal(runConfined(h.session,command).kind, "applied", name);
    assert.equal(h.session.generation(), 1, name);
    assert.equal(h.log.includes("reconcile"), reconciles, name);
  });
});

test("a legacy edit that names its changes publishes them and schedules their derivations", () => {
  const h = opened();
  const changes = cellEdit("r1", "audioText", ["production"]);
  h.session.noteEdit(changes);
  assert.equal(h.published[0]?.changes, changes);
  h.clock.advance(180);
  assert.deepEqual(h.refreshes, [["production"]]);
});

test("E3: a no-op, an empty change set, a refusal, a rejected capability, a failure and a missing document have no effects", () => {
  const h = opened();
  const before = h.session.read(function (doc) { return JSON.stringify(doc); });
  const empty: Command = { name: "empty", needs: "edit", plan: function () { return { changes: NO_CHANGES, apply: function () { throw new Error("never applied"); } }; } };
  const failing: Command = { name: "failing", needs: "edit", plan: function () { throw new Error("broken plan"); } };
  assert.deepEqual(runConfined(h.session,setAudio("r1", "Every morning.")), { kind: "noop" });
  assert.deepEqual(runConfined(h.session,empty), { kind: "noop" });
  assert.deepEqual(runConfined(h.session,setAudio("zz", "x")), { kind: "rejected", reason: "no such scene" });
  const failed = runConfined(h.session,failing);
  assert.equal(failed.kind, "failed");
  h.deny("review");
  assert.deepEqual(runConfined(h.session,setAudio("r1", "Changed.")), { kind: "rejected", reason: "review" });
  h.deny(null);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
  assert.equal(h.session.read(function (doc) { return JSON.stringify(doc); }), before, "the document is unchanged");
  assert.equal(h.clock.armed(), 0, "no refresh was scheduled");

  const closed = harness();
  assert.deepEqual(closed.session.run(setAudio("r1", "x")), { kind: "rejected", reason: NO_DOCUMENT });
  assert.deepEqual(closed.log, []);
});

test("E3: a command that only reads skips the capability check", () => {
  const h = opened();
  h.deny("review");
  const reading: Command = { name: "reading", needs: "nothing", plan: function () { return null; } };
  assert.deepEqual(runConfined(h.session,reading), { kind: "noop" });
  assert.deepEqual(runConfined(h.session,setAudio("r1", "x")), { kind: "rejected", reason: "review" });
});

test("a plan is handed the capability port, so a command that needs nothing can still refuse what it may not do", () => {
  const h = opened();
  const seen: Capability[] = [];
  const asking: Command = {
    name: "asking",
    needs: "nothing",
    plan: function (doc, capability) {
      const can = capability.edit();
      seen.push(can);
      return can.allowed ? null : { refused: "asked: " + can.reason };
    }
  };
  assert.deepEqual(runConfined(h.session, asking), { kind: "noop" });
  h.deny("review");
  assert.deepEqual(runConfined(h.session, asking), { kind: "rejected", reason: "asked: review" });
  assert.deepEqual(seen, [{ allowed: true }, { allowed: false, reason: "review" }]);
  assert.deepEqual(h.log, []);
});

test("E4: adoption migrates the raw input, opens a new epoch and records nothing, even for the same document id", () => {
  const h = harness();
  const doc = h.session.adopt(rawScript("Harbour"));
  assert.ok(doc);
  assert.equal(doc.rows[1]?.status, "todo", "the session holds the migrated document");
  assert.equal(h.session.epoch(), 1);
  assert.deepEqual(h.log, ["entry", "undo.adopt:Harbour", "publish:adopt"]);
  runConfined(h.session,setAudio("r1", "Every evening."));
  h.log.length = 0;
  const again = h.session.adopt(rawScript("Harbour"));
  assert.equal(again?.docId, doc.docId, "the same document id");
  assert.equal(h.session.epoch(), 2, "a new epoch all the same");
  assert.equal(h.session.generation(), 1, "adoption is not an edit");
  assert.deepEqual(h.log, ["entry", "undo.adopt:Harbour", "publish:adopt"]);
  h.log.length = 0;
  assert.equal(h.session.adopt(null), null);
  assert.equal(h.session.epoch(), 3);
  assert.deepEqual(h.log, ["undo.adopt:none", "publish:adopt"], "closing the document migrates nothing");
});

test("E4: a server update and a reload keep the epoch, add no generation, record no undo and run no effects", () => {
  const h = opened();
  runConfined(h.session,setAudio("r1", "Mine."));
  h.clock.advance(1000);
  h.log.length = 0;
  h.published.length = 0;
  const merged = h.session.absorbServer(rawScript("Merged"));
  assert.equal(merged?.title, "Merged");
  assert.equal(h.session.read(function (doc) { return doc && doc.title; }), "Merged");
  assert.equal(h.session.absorbReload({ title: "Reloaded", rows: [{ id: "f1", visualText: "Wide", audioText: "Again." }] }), merged);
  assert.equal(h.session.epoch(), 1);
  assert.equal(h.session.generation(), 1);
  assert.deepEqual(h.log, ["entry", "undo.server:Merged", "publish:server", "entry", "undo.reload", "publish:reload"]);
  assert.deepEqual(h.published.map(function (c) { return c.kind; }), ["server", "reload"]);
  assert.equal(h.clock.armed(), 0);
});

test("E4: user edits, server updates, reloads, recoveries and adoptions are published as distinct kinds", () => {
  const h = harness();
  h.session.adopt(rawScript("A"));
  runConfined(h.session,setAudio("r1", "x"));
  h.session.noteEdit();
  h.session.absorbServer(rawScript("B"));
  h.session.absorbReload({ title: "B", rows: [] });
  h.session.absorbRecovery(rawScript("C"));
  assert.deepEqual(h.published.map(function (c) { return c.kind + ":" + c.epoch + ":" + c.generation; }),
    ["adopt:1:0", "edit:1:1", "edit:1:2", "server:1:2", "reload:1:2", "recovery:2:2"]);
});

test("E4: a recovery migrates the raw input, opens a new epoch, keeps the undo stack through the server path, and records and runs nothing", () => {
  const h = opened();
  const doc = h.session.absorbRecovery(rawScript("Recovered"));
  assert.equal(doc?.rows[1]?.status, "todo");
  assert.equal(h.session.epoch(), 2);
  assert.equal(h.session.generation(), 0);
  assert.equal(h.session.read(function (d) { return d; }), doc);
  assert.deepEqual(h.log, ["entry", "undo.server:Recovered", "publish:recovery"]);
  assert.equal(h.clock.armed(), 0);
  const first = harness();
  first.session.absorbRecovery(rawScript("At boot"));
  assert.equal(first.session.epoch(), 1, "the first document can enter as a recovery, with an epoch of its own");
});

function reloadedScenes(): Record<string, unknown>[] {
  return [
    { id: "f1", visualText: "Wide", audioText: "Put the kettle on.", updatedAt: "2026-10-07T09:00:00.000Z" },
    { id: "f2", visualText: "Close", audioText: "Two." }
  ];
}

test("E4: a reload migrates the reloaded title and scenes over the held document in place, keeps its other fields, and leaves a migrateRows fixed point (#411)", () => {
  const h = opened();
  const held = h.session.read(function (d) { return d; });
  assert.ok(held);
  const comments = JSON.stringify(held.comments);
  const docId = held.docId;
  const rows = reloadedScenes();
  const rowsText = JSON.stringify(rows);
  const doc = h.session.absorbReload({ title: "Reloaded", rows: rows });
  assert.equal(doc, held, "reloaded in place");
  assert.equal(h.session.read(function (d) { return d; }), held);
  assert.equal(held.title, "Reloaded");
  assert.deepEqual(held.rows.map(function (r) { return [r.id, r.status, r.imageRef, r.updatedBy]; }), [["f1", "todo", null, null], ["f2", "todo", null, null]]);
  assert.equal(held.rows[0]?.updatedAt, "2026-10-07T09:00:00.000Z");
  assert.equal(JSON.stringify(held.comments), comments);
  assert.equal(held.docId, docId);
  assert.equal(JSON.stringify(rows), rowsText, "the reloaded scenes were not written into");
  assert.notEqual(held.rows[0], rows[0]);
  assert.deepEqual(judge(held, migrateFake), { problems: [], known: [] });
  assert.deepEqual([h.session.epoch(), h.session.generation()], [1, 0]);
  assert.deepEqual(h.log, ["entry", "undo.reload", "publish:reload"]);
});

test("E4: a reload keeps the held document's unchanged fields as the same objects and its key order", () => {
  const h = opened();
  const held = h.session.read(function (d) { return d; });
  assert.ok(held);
  const comments = held.comments;
  const keys = Object.keys(held);
  h.session.absorbReload({ title: "Reloaded", rows: reloadedScenes() });
  assert.equal(held.comments, comments);
  assert.deepEqual(Object.keys(held), keys);
});

test("E4: a reload whose migration throws leaves the held document, the epoch and the generation as they were, and reaches no other port", () => {
  const h = harness(undefined, {
    entry: function (raw) {
      const rows = raw && typeof raw === "object" ? Reflect.get(raw, "rows") : null;
      if (Array.isArray(rows) && rows.length === 1) throw new TypeError("refused");
      return migrateFake(raw);
    }
  });
  const held = h.session.adopt(rawScript("Harbour"));
  assert.ok(held);
  const heldText = JSON.stringify(held);
  h.log.length = 0;
  h.published.length = 0;
  assert.throws(function () { h.session.absorbReload({ title: "Reloaded", rows: [{ id: "f1" }] }); }, TypeError);
  assert.equal(h.session.read(function (d) { return d; }), held);
  assert.equal(JSON.stringify(held), heldText);
  assert.deepEqual([h.session.epoch(), h.session.generation()], [1, 0]);
  assert.deepEqual(h.log, ["entry"]);
});

test("E4: a reload with no document held changes nothing and publishes nothing", () => {
  const h = harness();
  assert.equal(h.session.absorbReload({ title: "Reloaded", rows: reloadedScenes() }), null);
  assert.equal(h.session.read(function (d) { return d; }), null);
  assert.deepEqual([h.session.epoch(), h.session.generation()], [0, 0]);
  assert.deepEqual(h.log, []);
});

test("settling after a merge, reload or recovery runs the edit's effects and undo flush, adds no generation and publishes nothing", () => {
  const h = opened();
  h.session.absorbServer(rawScript("Merged"));
  h.log.length = 0;
  h.published.length = 0;
  h.session.settle("server");
  h.session.settle("reload");
  h.session.settle("recovery");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.published, []);
  assert.deepEqual(h.log, [
    "undo.record", "dirty:0", "draft:0", "save:0",
    "undo.record", "dirty:0", "draft:0", "save:0",
    "undo.record", "dirty:0", "draft:0", "save:0"
  ]);
});

test("an adoption the undo port starts inside a server update or recovery does not leave the session holding the older document", () => {
  ["absorbServer", "absorbRecovery"].forEach(function (entry) {
    const h = harness(undefined, { beforeUndo: function (s) { s.adopt(rawScript("Before the merge")); } });
    const merged = entry === "absorbServer" ? h.session.absorbServer(rawScript("Merged")) : h.session.absorbRecovery(rawScript("Merged"));
    assert.equal(h.session.read(function (d) { return d; }), merged, entry);
    assert.equal(h.session.read(function (d) { return d && d.title; }), "Merged", entry);
    assert.deepEqual(h.published.map(function (c) { return c.kind; }), ["adopt", entry === "absorbServer" ? "server" : "recovery"], entry);
  });
  const h = harness(undefined, { beforeUndo: function (s) { s.adopt(rawScript("Inner")); } });
  const outer = h.session.adopt(rawScript("Outer"));
  assert.equal(h.session.read(function (d) { return d; }), outer, "and an adoption nested in an adoption leaves the outer one held");
});

function writesThenThrows(changes: ReturnType<typeof changeSet>): Command {
  return {
    name: "writes-then-throws",
    needs: "edit",
    plan: function () {
      return {
        changes: changes,
        apply: function (live) {
          const row = live.rows[0];
          if (row) { row.audioText = "half-written"; row.extra = { nested: true }; }
          live.title = "half-written";
          live.added = 1;
          live.rows.splice(1, 1);
          live.rows.push({ id: "r9", visualText: "", audioText: "" });
          throw new Error("apply broke");
        }
      };
    }
  };
}

test("E3: an apply that writes and then throws is rolled back: the document, generation, effects and undo are unchanged", () => {
  const shapes: [string, Parameters<typeof changeSet>[0]][] = [
    ["cells, title and rows", { cells: [{ rowId: "r1", field: "audioText" }, { rowId: "r1", field: "extra" }], docFields: ["title", "added"], rowsInserted: ["r9"], rowsRemoved: ["r2"] }],
    ["the whole document", { whole: true }]
  ];
  shapes.forEach(function ([name, parts]) {
    const h = opened();
    const held = h.session.read(function (d) { return d; });
    const before = JSON.stringify(held);
    const out = runConfined(h.session,writesThenThrows(changeSet(parts)));
    assert.equal(out.kind, "failed", name);
    assert.equal(out.kind === "failed" && out.error instanceof Error ? out.error.message : "", "apply broke", name);
    assert.equal(h.session.read(function (d) { return d; }), held, name + ": the same object");
    assert.equal(JSON.stringify(held), before, name + ": rolled back");
    assert.equal(held !== null && "added" in held, false, name + ": a key the apply added is gone, not left undefined");
    assert.equal(held !== null && held.rows[0] !== undefined && "extra" in held.rows[0], false, name + ": and so is a row field it added");
    assert.equal(h.session.generation(), 0, name);
    assert.deepEqual(h.log, [], name);
    assert.deepEqual(h.published, [], name);
  });
});

test("E3: a field the apply deleted before it threw comes back in its place, so the rolled-back document is byte-identical", () => {
  const h = opened();
  const before = h.session.read(function (d) { return JSON.stringify(d); });
  const deletes: Command = {
    name: "deletes-then-throws",
    needs: "edit",
    plan: function () {
      return {
        changes: changeSet({ cells: [{ rowId: "r1", field: "visualText" }, { rowId: "r1", field: "status" }], docFields: ["title"] }),
        apply: function (live) {
          const row = live.rows[0];
          if (row) { Reflect.deleteProperty(row, "visualText"); Reflect.deleteProperty(row, "status"); }
          Reflect.deleteProperty(live, "title");
          throw new Error("apply broke");
        }
      };
    }
  };
  assert.equal(runConfined(h.session, deletes).kind, "failed");
  assert.equal(h.session.read(function (d) { return JSON.stringify(d); }), before);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);

  const undeclared: Command = {
    name: "deletes-undeclared-then-throws",
    needs: "edit",
    plan: function () {
      return {
        changes: changeSet({ cells: [{ rowId: "r1", field: "visualText" }] }),
        apply: function (live) {
          const row = live.rows[0];
          if (row) { Reflect.deleteProperty(row, "visualText"); Reflect.deleteProperty(row, "audioText"); }
          throw new Error("apply broke");
        }
      };
    }
  };
  assert.equal(h.session.run(undeclared).kind, "failed");
  const row = h.session.read(function (d) { return d && d.rows[0]; });
  assert.equal(row && row.visualText, "Wide", "the declared field comes back");
  assert.equal(row !== null && row !== undefined && "audioText" in row, false, "an undeclared field stays as the apply left it, with no key put back for it");
});

test("runConfined fails a command that writes outside its change set, applied or thrown, which the rollback cannot undo", () => {
  const stamps: Command = {
    name: "stamps-undeclared",
    needs: "edit",
    plan: function () {
      return {
        changes: cellEdit("r1", "status"),
        apply: function (live) {
          const row = live.rows[0];
          if (row) { row.status = "ready"; row.updatedAt = "2026-10-07"; }
          live.comments.push({ id: "c9" });
        }
      };
    }
  };
  assert.throws(function () { runConfined(opened().session, stamps); }, /stamps-undeclared \(applied\) wrote outside its declared change set: rows\[r1\]\.updatedAt, comments/);
  const elsewhere: Command = {
    name: "writes-elsewhere-then-throws",
    needs: "edit",
    plan: function () {
      return {
        changes: changeSet({ rowsInserted: ["r3"] }),
        apply: function (live) {
          const other = live.rows[1];
          if (other) other.audioText = "joined into r2";
          throw new Error("broke");
        }
      };
    }
  };
  assert.throws(function () { runConfined(opened().session, elsewhere); }, /\(failed\) wrote outside its declared change set: rows\[r2\]\.audioText/);
  const declared: Command = {
    name: "stamps-declared",
    needs: "edit",
    plan: function () {
      return {
        changes: changeSet({ cells: [{ rowId: "r1", field: "status" }, { rowId: "r1", field: "updatedAt" }] }),
        apply: function (live) { const row = live.rows[0]; if (row) { row.status = "ready"; row.updatedAt = "2026-10-07"; } }
      };
    }
  };
  assert.equal(runConfined(opened().session, declared).kind, "applied");
});

test("runConfined fails a plan that writes a declared field, since the rollback point is taken after plan and cannot undo it", () => {
  const planWrites: Command = {
    name: "plan-writes-declared",
    needs: "edit",
    plan: function (doc) {
      const live = doc as unknown as { rows: { audioText: string }[] };
      const row = live.rows[0];
      if (row) row.audioText = "written in plan";
      return { changes: cellEdit("r1", "audioText"), apply: function () {} };
    }
  };
  assert.throws(function () { runConfined(opened().session, planWrites); }, /plan-writes-declared planned a write/);
});

test("writesOutside names undeclared document fields, rows, order and comment edits, and allows anchor moves only when the change set reconciles", () => {
  const before = { title: "A", rows: [{ id: "r1", a: 1 }, { id: "r2", a: 2 }], comments: [{ id: "c1", rowId: "r1", field: "audioText" }] };
  const after = { title: "B", extra: 1, rows: [{ id: "r2", a: 2 }, { id: "r3" }], comments: [{ id: "c1", rowId: "r2", field: "audioText" }] };
  assert.deepEqual(writesOutside(before, after, NO_CHANGES), ["title", "extra", "rows[r3] inserted", "rows[r1] removed", "comments"]);
  assert.deepEqual(writesOutside(before, after, changeSet({ docFields: ["title", "extra"], rowsInserted: ["r3"], rowsRemoved: ["r1"] })), []);
  const moved = { title: "A", rows: [{ id: "r2", a: 2 }, { id: "r1", a: 1 }], comments: before.comments };
  assert.deepEqual(writesOutside(before, moved, NO_CHANGES), ["rows order"]);
  assert.deepEqual(writesOutside(before, moved, changeSet({ rowsMoved: true })), []);
  assert.deepEqual(writesOutside(before, after, changeSet({ whole: true })), []);
});

test("E3: a reconciliation that moves anchors and then throws is rolled back with the apply before it", () => {
  const h = harness(undefined, {
    reconcile: function (doc) {
      const c = doc.comments[0];
      if (c) { c.rowId = "r2"; c.field = "visualText"; }
      doc.comments.push({ id: "stray" });
      throw new Error("reconcile broke");
    }
  });
  h.session.adopt(rawScript("Harbour"));
  h.log.length = 0;
  h.published.length = 0;
  const held = h.session.read(function (d) { return d; });
  const before = JSON.stringify(held);
  const out = runConfined(h.session,insertRow("r3"));
  assert.equal(out.kind, "failed");
  assert.equal(JSON.stringify(held), before);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, ["reconcile"]);
  assert.deepEqual(h.published, []);
});

test("a legacy edit of unknown extent is one generation transition, one undo record and one effect pass, and reconciles nothing", () => {
  const h = opened();
  h.session.noteEdit();
  assert.equal(h.session.generation(), 1);
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  assert.equal(h.clock.armed(), 0, "a legacy edit schedules its own refreshes");
  assert.equal(h.published[0]?.changes.whole, true);
});

test("an unsubscribed listener hears nothing more", () => {
  const h = opened();
  const heard: string[] = [];
  const stop = h.session.subscribe(function (c) { heard.push(c.kind); });
  h.session.noteEdit();
  stop();
  stop();
  h.session.noteEdit();
  assert.deepEqual(heard, ["edit"]);
  assert.equal(h.published.length, 2, "other listeners still hear");
});
