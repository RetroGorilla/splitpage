import { test } from "node:test";
import assert from "node:assert/strict";
import { DISPOSED, NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import type { Command, DocumentView, Plan } from "../../src/application/session/document-session.ts";
import { NO_CHANGES, WHOLE_DOCUMENT, cellEdit, changeSet, combined } from "../../src/application/session/change-set.ts";
import { createEffectScheduler } from "../../src/application/session/effects.ts";
import { fakeClock, harness, rawScript, runConfined } from "./session-fakes.ts";
import type { HarnessHooks } from "./session-fakes.ts";

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

function throwing(message: string): () => never {
  return function () { throw new Error(message); };
}

function opened(hooks: HarnessHooks = {}): ReturnType<typeof harness> {
  const h = harness(undefined, hooks);
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

function textOf(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function messages(errors: readonly unknown[]): string[] {
  return errors.map(function (e) { return e instanceof Error ? e.message : String(e); });
}

function myColor(name: string, color: string): (doc: DocumentView) => Plan | null {
  return function (doc) {
    const had = doc.personColors && typeof doc.personColors === "object" ? doc.personColors : {};
    if (Reflect.get(had, name) === color) return null;
    const next = { ...had, [name]: color };
    return {
      changes: changeSet({ docFields: ["personColors"] }),
      apply: function (live) { live.personColors = next; }
    };
  };
}

function colorsOf(h: ReturnType<typeof harness>): unknown {
  return h.session.read(function (doc) { return doc ? JSON.parse(JSON.stringify(doc.personColors ?? null)) : null; });
}

test("a throw in undo recording after the commit gives a committed outcome: the change stays, every effect and listener still runs, and the error is reported", () => {
  const h = opened({ record: throwing("undo broke") });
  const out = runConfined(h.session, setAudio("r1", "Every evening."));
  assert.equal(out.kind, "committed");
  if (out.kind !== "committed") return;
  assert.equal(out.generation, 1);
  assert.deepEqual(out.changes, cellEdit("r1", "audioText", ["production"]));
  assert.deepEqual(messages(out.errors), ["undo broke"]);
  assert.equal(audioOf(h, "r1"), "Every evening.", "never rolled back");
  assert.equal(h.session.generation(), 1);
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit", "report"]);
  assert.deepEqual(messages(h.reported), ["undo broke"]);
});

for (const name of ["dirty", "draft", "save"] as const) {
  test("a throw in the " + name + " effect leaves the other effects, the refresh request and the publication running, and is reported", () => {
    const h = opened({ effect: function (which) { if (which === name) throw new Error(name + " broke"); } });
    const out = h.session.run(setAudio("r1", "Every evening."));
    assert.equal(out.kind, "committed");
    if (out.kind !== "committed") return;
    assert.deepEqual(messages(out.errors), [name + " broke"]);
    assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit", "report"]);
    h.clock.advance(1000);
    assert.deepEqual(h.refreshes, [["production"]], "the change set's derivation still runs");
    assert.equal(audioOf(h, "r1"), "Every evening.");
  });
}

test("a throw in one listener does not keep the change from the listeners after it", () => {
  const h = opened();
  const later: number[] = [];
  h.session.subscribe(throwing("listener broke"));
  h.session.subscribe(function (c) { later.push(c.generation); });
  const out = h.session.run(setAudio("r1", "Every evening."));
  assert.equal(out.kind, "committed");
  if (out.kind !== "committed") return;
  assert.deepEqual(messages(out.errors), ["listener broke"]);
  assert.deepEqual(later, [1]);
  assert.equal(h.published.length, 1);
});

test("every throw after one commit is carried and reported, in the order the steps ran", () => {
  const h = opened({ record: throwing("undo broke"), effect: function (which) { if (which !== "draft") throw new Error(which + " broke"); } });
  h.session.subscribe(throwing("listener broke"));
  const out = h.session.run(setAudio("r1", "Every evening."));
  assert.equal(out.kind, "committed");
  if (out.kind !== "committed") return;
  const order = ["undo broke", "dirty broke", "save broke", "listener broke"];
  assert.deepEqual(messages(out.errors), order);
  assert.deepEqual(messages(h.reported), order);
});

test("after a committed outcome the session carries on from the committed document", () => {
  let broken = true;
  const h = opened({ record: function () { if (broken) throw new Error("undo broke"); } });
  assert.equal(h.session.run(setAudio("r1", "Every evening.")).kind, "committed");
  broken = false;
  const next = runConfined(h.session, setAudio("r2", "Nets at dusk."));
  assert.deepEqual(next, { kind: "applied", generation: 2, changes: cellEdit("r2", "audioText", ["production"]) });
  assert.equal(audioOf(h, "r1"), "Every evening.");
  assert.deepEqual(messages(h.reported), ["undo broke"]);
});

test("a legacy edit whose undo recording or effect throws is reported, not thrown, and still marks every effect", () => {
  const h = opened({ record: throwing("undo broke"), effect: function (which) { if (which === "dirty") throw new Error("dirty broke"); } });
  assert.doesNotThrow(function () { h.session.noteEdit(); });
  assert.equal(h.session.generation(), 1);
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit", "report", "report"]);
  assert.deepEqual(messages(h.reported), ["undo broke", "dirty broke"]);
});

test("settling an absorbed change whose undo recording throws still runs its effect pass and reports", () => {
  const h = opened({ record: throwing("undo broke") });
  assert.doesNotThrow(function () { h.session.settle("server"); });
  assert.deepEqual(h.log, ["undo.record", "dirty:0", "draft:0", "save:0", "report"]);
  assert.deepEqual(messages(h.reported), ["undo broke"]);
});

test("a listener that throws during an adoption is reported and the adoption stands", () => {
  const h = harness();
  const later: string[] = [];
  h.session.subscribe(throwing("listener broke"));
  h.session.subscribe(function (c) { later.push(c.kind); });
  const doc = h.session.adopt(rawScript("Harbour"));
  assert.ok(doc);
  assert.equal(h.session.epoch(), 1);
  assert.deepEqual(later, ["adopt"]);
  assert.deepEqual(messages(h.reported), ["listener broke"]);
});

test("a command that fails before its commit is still failed and reports nothing", () => {
  const h = opened();
  const out = h.session.run({ name: "broken", needs: "edit", plan: throwing("plan broke") });
  assert.equal(out.kind, "failed");
  assert.deepEqual(h.reported, []);
  assert.deepEqual(h.log, []);
});

test("the editor's colour is written inside the transaction, declared in the change set, before undo records it", () => {
  const h = opened({ attribute: myColor("Sam", "#123456") });
  const before = textOf(h);
  const out = runConfined(h.session, setAudio("r1", "Every evening."));
  assert.equal(out.kind, "applied");
  if (out.kind !== "applied") return;
  assert.deepEqual(out.changes, changeSet({ cells: [{ rowId: "r1", field: "audioText" }], docFields: ["personColors"], derive: ["production"] }));
  assert.deepEqual(colorsOf(h), { Sam: "#123456" });
  assert.deepEqual(h.log, ["attribute", "undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  assert.deepEqual(h.published[0]?.changes, out.changes, "the published change set names the colour too");
  assert.notEqual(textOf(h), before);
});

test("once the colour is recorded, the next command declares only its own change", () => {
  const h = opened({ attribute: myColor("Sam", "#123456") });
  runConfined(h.session, setAudio("r1", "Every evening."));
  const out = runConfined(h.session, setAudio("r2", "Nets at dusk."));
  assert.deepEqual(out, { kind: "applied", generation: 2, changes: cellEdit("r2", "audioText", ["production"]) });
});

test("a no-op, a refusal, a capability refusal and a failed plan ask for no attribution and write no colour", () => {
  const h = opened({ attribute: myColor("Sam", "#123456") });
  assert.equal(h.session.run(setAudio("r1", "Every morning.")).kind, "noop");
  assert.equal(h.session.run(setAudio("gone", "x")).kind, "rejected");
  h.deny("review");
  assert.equal(h.session.run(setAudio("r1", "x")).kind, "rejected");
  h.deny(null);
  assert.equal(h.session.run({ name: "broken", needs: "edit", plan: throwing("plan broke") }).kind, "failed");
  assert.equal(h.log.includes("attribute"), false);
  assert.equal(colorsOf(h), null);
});

test("an attribution that throws fails the command before anything is written or recorded", () => {
  const h = opened({ attribute: throwing("attribution broke") });
  const before = textOf(h);
  const out = runConfined(h.session, setAudio("r1", "Every evening."));
  assert.equal(out.kind, "failed");
  assert.equal(textOf(h), before);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, ["attribute"]);
});

test("an attribution whose write throws rolls back the command's write and its own, byte for byte", () => {
  const h = opened({
    attribute: function () {
      return {
        changes: changeSet({ docFields: ["personColors"] }),
        apply: function (live) { live.personColors = { Sam: "#123456" }; throw new Error("write broke"); }
      };
    }
  });
  const before = textOf(h);
  const out = runConfined(h.session, setAudio("r1", "Every evening."));
  assert.equal(out.kind, "failed");
  assert.equal(textOf(h), before);
  assert.deepEqual(h.log, ["attribute"]);
});

test("a reconciliation that throws after the colour was written puts the colour back too", () => {
  const h = opened({ attribute: myColor("Sam", "#123456"), reconcile: throwing("reconcile broke") });
  const before = textOf(h);
  const out = runConfined(h.session, {
    name: "insert-row",
    needs: "edit",
    plan: function () {
      return { changes: changeSet({ rowsInserted: ["r9"] }), apply: function (live) { live.rows.push({ id: "r9", visualText: "", audioText: "" }); } };
    }
  });
  assert.equal(out.kind, "failed");
  assert.equal(textOf(h), before);
});

test("an attribution with an empty change set is ignored and the command's own change set is published as it is", () => {
  const h = opened({ attribute: function () { return { changes: NO_CHANGES, apply: throwing("never applied") }; } });
  const command = setAudio("r1", "Every evening.");
  const out = h.session.run(command);
  assert.equal(out.kind, "applied");
  if (out.kind !== "applied") return;
  assert.deepEqual(out.changes, cellEdit("r1", "audioText", ["production"]));
});

test("combined keeps the first set's order and adds what the second declares once", () => {
  const first = changeSet({ cells: [{ rowId: "r1", field: "audioText" }], docFields: ["title"], derive: ["production"], rowsInserted: ["r3"] });
  const second = changeSet({
    cells: [{ rowId: "r1", field: "audioText" }, { rowId: "r2", field: "status" }, { rowId: "r2", field: "status" }],
    docFields: ["personColors", "title"],
    derive: ["broll", "production"],
    rowsRemoved: ["r4"],
    rowsMoved: true,
    saveNow: true
  });
  assert.deepEqual(combined(first, second), changeSet({
    cells: [{ rowId: "r1", field: "audioText" }, { rowId: "r2", field: "status" }],
    docFields: ["title", "personColors"],
    derive: ["production", "broll"],
    rowsInserted: ["r3"],
    rowsRemoved: ["r4"],
    rowsMoved: true,
    saveNow: true
  }));
  assert.equal(combined(NO_CHANGES, WHOLE_DOCUMENT).whole, true);
  assert.equal(combined(WHOLE_DOCUMENT, changeSet({ runsMoved: true })).runsMoved, true);
  assert.ok(Object.isFrozen(combined(first, second)));
});

test("dispose stops the armed refresh: no timer is left and advancing the clock runs nothing", () => {
  const h = opened();
  h.session.run(setAudio("r1", "Every evening."));
  h.session.refresh("broll");
  assert.equal(h.clock.armed(), 1);
  h.session.dispose();
  assert.equal(h.clock.armed(), 0);
  h.clock.advance(10000);
  assert.deepEqual(h.refreshes, []);
  h.session.refresh("production");
  assert.equal(h.clock.armed(), 0, "a refresh asked for after dispose arms nothing");
});

test("dispose drops every listener and the document; a later subscription registers nothing", () => {
  const h = opened();
  const late: string[] = [];
  h.session.dispose();
  const off = h.session.subscribe(function (c) { late.push(c.kind); });
  off();
  assert.equal(h.session.read(function (doc) { return doc; }), null);
  assert.equal(h.session.adopt(rawScript("Another")), null);
  assert.deepEqual(h.published, []);
  assert.deepEqual(late, []);
});

test("after dispose the session refuses commands and every entry does nothing, without calling a port", () => {
  const h = opened({ attribute: myColor("Sam", "#123456") });
  const epoch = h.session.epoch();
  h.session.dispose();
  assert.deepEqual(h.session.run(setAudio("r1", "Every evening.")), { kind: "rejected", reason: DISPOSED });
  h.session.noteEdit();
  h.session.settle("server");
  assert.equal(h.session.adopt(rawScript("Another")), null);
  assert.equal(h.session.absorbServer(rawScript("Theirs")), null);
  assert.equal(h.session.absorbRecovery(rawScript("Recovered")), null);
  assert.equal(h.session.absorbReload({ title: "Reloaded", rows: [] }), null);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
  assert.equal(h.session.generation(), 0);
  assert.equal(h.session.epoch(), epoch);
  assert.notEqual(DISPOSED, NO_DOCUMENT);
});

test("dispose twice is the same as once", () => {
  const h = opened();
  h.session.refresh("broll");
  h.session.dispose();
  h.session.dispose();
  assert.equal(h.clock.armed(), 0);
  assert.deepEqual(h.session.run(setAudio("r1", "x")), { kind: "rejected", reason: DISPOSED });
});

test("the scheduler's pass returns each effect's throw and runs the rest; its dispose stops the timer and refuses later requests", () => {
  const clock = fakeClock();
  const ran: string[] = [];
  const scheduler = createEffectScheduler({
    dirty: throwing("dirty broke"),
    draft: function () { ran.push("draft"); },
    save: throwing("save broke"),
    refresh: function (jobs) { ran.push("refresh:" + Array.from(jobs).join(",")); }
  }, clock);
  const errors = scheduler.pass({ kind: "edit", epoch: 1, generation: 1, changes: changeSet({ derive: ["production"] }) });
  assert.deepEqual(messages(errors), ["dirty broke", "save broke"]);
  assert.deepEqual(ran, ["draft"]);
  assert.deepEqual(scheduler.pending(), ["production"]);
  scheduler.dispose();
  assert.deepEqual(scheduler.pending(), []);
  assert.equal(clock.armed(), 0);
  scheduler.refresh("broll");
  assert.deepEqual(scheduler.pass({ kind: "edit", epoch: 1, generation: 2, changes: changeSet({ derive: ["broll"] }) }), []);
  clock.advance(5000);
  assert.deepEqual(ran, ["draft"]);
  assert.equal(clock.armed(), 0);
});
