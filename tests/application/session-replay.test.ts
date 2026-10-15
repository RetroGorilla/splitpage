import { test } from "node:test";
import assert from "node:assert/strict";
import { DISPOSED, NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import type { DocumentView, Plan, Replay } from "../../src/application/session/document-session.ts";
import { cellEdit, changeSet, combined } from "../../src/application/session/change-set.ts";
import type { ChangeSet } from "../../src/application/session/change-set.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { harness, rawScript } from "./session-fakes.ts";
import type { HarnessHooks } from "./session-fakes.ts";

interface History {
  done: string[];
  undone: string[];
}

function history(): History {
  return { done: ["a"], undone: [] };
}

function rowOf(doc: ValidatedDocument, rowId: string) {
  const row = doc.rows.find(function (r) { return r.id === rowId; });
  if (!row) throw new Error("no scene " + rowId);
  return row;
}

interface ReplayOptions {
  changes?: ChangeSet;
  refuse?: string;
  empty?: boolean;
  failApply?: boolean;
  failSettle?: boolean;
  write?: (doc: ValidatedDocument) => void;
}

function undoAudio(h: History, rowId: string, text: string, opts: ReplayOptions = {}): Replay {
  return {
    name: "undo",
    plan: function (doc) {
      if (opts.empty || !h.done.length) return null;
      if (opts.refuse) return { refused: opts.refuse };
      if (!doc.rows.some(function (r) { return r.id === rowId; })) return { refused: "a scene it changed has gone" };
      return {
        changes: opts.changes ?? changeSet({ cells: [{ rowId: rowId, field: "audioText" }, { rowId: rowId, field: "updatedAt" }] }),
        apply: function (live) {
          const row = rowOf(live, rowId);
          row.audioText = text;
          row.updatedAt = "stamped";
          if (opts.write) opts.write(live);
          if (opts.failApply) throw new Error("replay broke while writing");
        },
        settle: function () {
          if (opts.failSettle) throw new Error("history broke while moving");
          const entry = h.done.pop();
          if (entry) h.undone.push(entry);
        }
      };
    }
  };
}

function opened(hooks: HarnessHooks = {}): ReturnType<typeof harness> {
  const h = harness(undefined, hooks);
  h.session.adopt(rawScript("Harbour"));
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function textOf(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function audioOf(h: ReturnType<typeof harness>, rowId: string): unknown {
  return h.session.read(function (doc) {
    const row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row ? row.audioText : undefined;
  });
}

test("6.2: an accepted replay advances the generation once, publishes once as a replay and records no new undo entry", () => {
  const h = opened();
  const stacks = history();
  const changes = changeSet({ cells: [{ rowId: "r1", field: "audioText" }, { rowId: "r1", field: "updatedAt" }] });
  const out = h.session.replay(undoAudio(stacks, "r1", "Every evening."));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: changes });
  assert.equal(h.session.generation(), 1);
  assert.equal(h.session.epoch(), 1, "a replay is not a new document lifetime");
  assert.equal(audioOf(h, "r1"), "Every evening.");
  assert.deepEqual(h.log, ["dirty:1", "draft:1", "save:1", "publish:replay"], "no undo.record: the replay is not recorded again");
  assert.equal(h.published.length, 1);
  assert.deepEqual([h.published[0]?.kind, h.published[0]?.generation, h.published[0]?.changes], ["replay", 1, changes]);
  assert.deepEqual(stacks, { done: [], undone: ["a"] }, "the history moved exactly one entry");
});

test("6.2: the history moves inside the boundary, before the generation advances and before anyone hears of it", () => {
  const stacks = history();
  const seen: Array<{ generation: number; undone: number; audio: unknown }> = [];
  const h = opened({ effect: function (name) {
    if (name === "dirty") seen.push({ generation: h.session.generation(), undone: stacks.undone.length, audio: audioOf(h, "r1") });
  } });
  h.session.replay(undoAudio(stacks, "r1", "Every evening."));
  assert.deepEqual(seen, [{ generation: 1, undone: 1, audio: "Every evening." }]);
});

test("6.2: an empty replay changes nothing observable", () => {
  const h = opened();
  const before = textOf(h);
  const stacks: History = { done: [], undone: [] };
  assert.deepEqual(h.session.replay(undoAudio(stacks, "r1", "x")), { kind: "noop" });
  assert.equal(h.session.generation(), 0);
  assert.equal(textOf(h), before);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
});

test("6.2: a refused replay changes nothing observable and says why", () => {
  const h = opened();
  const before = textOf(h);
  const stacks = history();
  assert.deepEqual(h.session.replay(undoAudio(stacks, "r9", "x")), { kind: "rejected", reason: "a scene it changed has gone" });
  assert.equal(h.session.generation(), 0);
  assert.equal(textOf(h), before);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
  assert.deepEqual(stacks, { done: ["a"], undone: [] }, "the session leaves the history to the caller on a refusal");
});

test("6.2: a replay whose plan has no changes is empty", () => {
  const h = opened();
  const stacks = history();
  const out = h.session.replay(undoAudio(stacks, "r1", "x", { changes: changeSet({}) }));
  assert.deepEqual(out, { kind: "noop" });
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(stacks, { done: ["a"], undone: [] });
});

test("6.2: a throw while the replay writes leaves the document and the history as before", () => {
  const h = opened();
  const before = textOf(h);
  const stacks = history();
  const out = h.session.replay(undoAudio(stacks, "r1", "Every evening.", { failApply: true }));
  assert.equal(out.kind, "failed");
  assert.equal(out.kind === "failed" && out.error instanceof Error ? out.error.message : "", "replay broke while writing");
  assert.equal(textOf(h), before, "the stamp and the text are rolled back");
  assert.deepEqual(stacks, { done: ["a"], undone: [] });
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
});

test("6.2: a throw while the history moves rolls the document back too", () => {
  const h = opened({ reconcile: function (doc) {
    const c = doc.comments[0];
    if (c) c.rowId = "r2";
    return 1;
  } });
  const before = textOf(h);
  const stacks = history();
  const out = h.session.replay(undoAudio(stacks, "r1", "Every evening.", {
    failSettle: true,
    changes: changeSet({ cells: [{ rowId: "r1", field: "audioText" }, { rowId: "r1", field: "updatedAt" }], runsMoved: true })
  }));
  assert.equal(out.kind, "failed");
  assert.equal(textOf(h), before, "the text, the stamp and the reconciled anchor are all restored");
  assert.deepEqual(stacks, { done: ["a"], undone: [] });
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.published, []);
});

test("6.2: a throw after the commit is reported as committed and the document stays committed", () => {
  const h = opened({ effect: function (name) { if (name === "draft") throw new Error("draft writer broke"); } });
  const stacks = history();
  const out = h.session.replay(undoAudio(stacks, "r1", "Every evening."));
  assert.equal(out.kind, "committed");
  assert.equal(out.kind === "committed" ? out.generation : 0, 1);
  assert.deepEqual(out.kind === "committed" ? out.errors.map(function (e) { return e instanceof Error ? e.message : ""; }) : [], ["draft writer broke"]);
  assert.equal(audioOf(h, "r1"), "Every evening.", "not rolled back");
  assert.deepEqual(stacks, { done: [], undone: ["a"] });
  assert.equal(h.reported.length, 1);
  assert.equal(h.published.length, 1, "still published once");
});

test("6.2: a listener that throws is reported and does not undo the replay", () => {
  const h = opened();
  const stacks = history();
  h.session.subscribe(function () { throw new Error("listener broke"); });
  const out = h.session.replay(undoAudio(stacks, "r1", "Every evening."));
  assert.equal(out.kind, "committed");
  assert.equal(audioOf(h, "r1"), "Every evening.");
  assert.deepEqual(stacks, { done: [], undone: ["a"] });
});

test("6.2: dependent reconciliation runs inside the boundary when the replay moves runs or rows", () => {
  const h = opened();
  const stacks = history();
  h.session.replay(undoAudio(stacks, "r1", "x", { changes: changeSet({ rowsMoved: true, cells: [{ rowId: "r1", field: "audioText" }, { rowId: "r1", field: "updatedAt" }] }) }));
  assert.deepEqual(h.log, ["reconcile", "dirty:1", "draft:1", "save:1", "publish:replay"]);
  const plain = opened();
  plain.session.replay(undoAudio(history(), "r1", "x"));
  assert.equal(plain.log.includes("reconcile"), false);
});

test("6.2: attribution signs a replay as it signs an edit, inside the same transaction", () => {
  const sign: (doc: DocumentView) => Plan | null = function (doc) {
    if (doc.personColors && Reflect.get(doc.personColors, "Ada")) return null;
    return { changes: changeSet({ docFields: ["personColors"] }), apply: function (live) { live.personColors = { Ada: "#123456" }; } };
  };
  const h = opened({ attribute: sign });
  const stacks = history();
  const out = h.session.replay(undoAudio(stacks, "r1", "Every evening."));
  const own = changeSet({ cells: [{ rowId: "r1", field: "audioText" }, { rowId: "r1", field: "updatedAt" }] });
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: combined(own, changeSet({ docFields: ["personColors"] })) });
  const failing = opened({ attribute: sign });
  const before = textOf(failing);
  failing.session.replay(undoAudio(history(), "r1", "x", { failApply: true }));
  assert.equal(textOf(failing), before, "the signature is rolled back with the replay");
});

test("6.2: the published change set names everything the replay wrote, including owner lists the entry did not carry", () => {
  const h = opened();
  const stacks = history();
  const changes = changeSet({ cells: [{ rowId: "r1", field: "audioText" }, { rowId: "r1", field: "updatedAt" }], docFields: ["people", "productionTags", "brollShots"] });
  h.session.replay(undoAudio(stacks, "r1", "x", {
    changes: changes,
    write: function (live) {
      live.people = [{ id: "pM", name: "Ada" }];
      live.productionTags = [];
      live.brollShots = [];
    }
  }));
  assert.deepEqual(h.published[0]?.changes, changes);
  const failing = opened();
  const before = textOf(failing);
  failing.session.replay(undoAudio(history(), "r1", "x", {
    changes: changes, failApply: true,
    write: function (live) { live.people = [{ id: "pM", name: "Ada" }]; live.brollShots = []; }
  }));
  assert.equal(textOf(failing), before, "owner lists are rolled back with the replay");
});

test("6.2: a replay is refused without a document and after dispose, and a plan that throws fails cleanly", () => {
  const h = harness();
  assert.deepEqual(h.session.replay(undoAudio(history(), "r1", "x")), { kind: "rejected", reason: NO_DOCUMENT });
  const o = opened();
  const before = textOf(o);
  const out = o.session.replay({ name: "undo", plan: function () { throw new Error("plan broke"); } });
  assert.equal(out.kind, "failed");
  assert.equal(textOf(o), before);
  assert.equal(o.session.generation(), 0);
  o.session.dispose();
  assert.deepEqual(o.session.replay(undoAudio(history(), "r1", "x")), { kind: "rejected", reason: DISPOSED });
});

test("6.2: an ordinary edit after a replay still records once", () => {
  const h = opened();
  h.session.replay(undoAudio(history(), "r1", "x"));
  h.log.length = 0;
  h.session.noteEdit(cellEdit("r1", "audioText"));
  assert.deepEqual(h.log, ["undo.record", "dirty:2", "draft:2", "save:2", "publish:edit"]);
});
