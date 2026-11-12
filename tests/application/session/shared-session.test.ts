import { test } from "node:test";
import assert from "node:assert/strict";
import { NOT_SHARED, ORIGIN_KINDS, REENTERED } from "../../../src/application/session/shared-session.ts";
import type { ReplicaOrigin } from "../../../src/application/session/shared-session.ts";
import { DISPOSED, NO_DOCUMENT } from "../../../src/application/session/document-session.ts";
import type { Command, CommandOutcome } from "../../../src/application/session/document-session.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import type { FlowSelectionPair } from "../../../src/core/flow/flow.ts";
import { fakeReplica, sharedCommand, sharedHarness } from "./shared-session-support.ts";

const NOTHING = { whole: false, cells: [], rowsInserted: [], rowsRemoved: [], rowsMoved: false, runsMoved: false, docFields: [], derive: [], saveNow: false };
const LENGTH_CELL = { ...NOTHING, cells: [{ rowId: "R1", field: "lengthSeconds" }] };

function script(parts: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 2, title: "Title", docId: "d1",
    rows: [{ id: "R1", status: "todo", audioText: "ab" }, { id: "R2", status: "todo", audioText: "cd" }],
    comments: [], people: [], productionTags: [], brollShots: [], rev: 0,
    ...parts
  };
}

function timed(seconds: number): Record<string, unknown> {
  return script({ rows: [{ id: "R1", status: "todo", audioText: "ab", lengthSeconds: seconds }, { id: "R2", status: "todo", audioText: "cd" }] });
}

function operation(value: unknown): SharedOperation {
  const read = readOperation(value);
  assert.ok(read);
  return read;
}

const LENGTH = operation({ kind: "scalar", id: "o1", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });

test("before anything is applied the session holds no document and refuses a command without calling the replica", () => {
  const replica = fakeReplica(), h = sharedHarness(replica.port);
  assert.equal(h.session.read(doc => doc), null);
  assert.deepEqual([h.session.epoch(), h.session.generation(), h.session.revision()], [0, 0, 0]);
  assert.deepEqual(h.session.run(sharedCommand("length", [LENGTH])), { kind: "rejected", reason: NO_DOCUMENT });
  assert.deepEqual(h.log, []);
  assert.equal(NO_DOCUMENT, "no document");
});

test("a plan that asks the comment capability gets the same answer as an edit: allowed it runs, denied it is rejected with the reason and nothing reaches the replica", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  const answers: unknown[] = [];
  const command: Command = {
    name: "comment", needs: "nothing",
    plan: (_doc, capability) => {
      const can = capability.comment();
      answers.push(can);
      return can.allowed ? { changes: changeSet({ whole: true }), apply: () => { throw new Error("A shared session applied a standalone plan"); }, shared: { operations: [LENGTH] } } : { refused: can.reason };
    }
  };
  replica.script(() => { replica.write("local-command", timed(7)); return { ok: true }; });
  assert.deepEqual(h.session.run(command), { kind: "applied", generation: 1, changes: LENGTH_CELL });
  h.deny("read only");
  assert.deepEqual(h.session.run(command), { kind: "rejected", reason: "read only" });
  assert.deepEqual(h.session.run(sharedCommand("length", [LENGTH])), { kind: "rejected", reason: "read only" });
  assert.deepEqual(answers, [{ allowed: true }, { allowed: false, reason: "read only" }]);
  assert.equal(h.executed.length, 1);
});

test("each transaction that advances the replica becomes exactly one change, its kind set by the origin; one that advances nothing becomes none", () => {
  const replica = fakeReplica(), h = sharedHarness(replica.port);
  replica.write("hydration", script());
  replica.write("local-command", timed(7));
  replica.write("local-undo", script());
  replica.write("remote", script({ title: "Theirs" }));
  replica.write("cleanup", script({ title: "Theirs" }));
  replica.write("remote", script({ title: "Theirs", people: [{ id: "P1", name: "Ann" }] }));
  replica.echo("remote");
  replica.echo("local-command");
  replica.echo("hydration");
  assert.deepEqual(h.published, [
    { kind: "adopt", epoch: 1, generation: 0, changes: { ...NOTHING, whole: true } },
    { kind: "edit", epoch: 1, generation: 1, changes: LENGTH_CELL },
    { kind: "replay", epoch: 1, generation: 2, changes: LENGTH_CELL },
    { kind: "remote", epoch: 1, generation: 2, changes: { ...NOTHING, docFields: ["title"] } },
    { kind: "remote", epoch: 1, generation: 2, changes: NOTHING },
    { kind: "remote", epoch: 1, generation: 2, changes: { ...NOTHING, docFields: ["people"] } }
  ]);
  assert.deepEqual(h.log, [
    "project", "publish:adopt",
    "project", "undo.record", "dirty:1", "draft:1", "save:1", "publish:edit",
    "project", "dirty:2", "draft:2", "save:2", "publish:replay",
    "project", "publish:remote",
    "project", "publish:remote",
    "project", "publish:remote"
  ]);
  assert.ok(h.published.every(change => Object.isFrozen(change) && Object.isFrozen(change.changes)));
  assert.deepEqual([h.session.epoch(), h.session.generation(), h.session.revision()], [1, 2, 6]);
});

test("a remote change records no undo entry, runs no effect, arms no refresh, issues no operation and leaves the generation", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  replica.write("remote", timed(7));
  replica.write("remote", timed(9));
  replica.write("remote", script({ title: "Theirs" }));
  assert.deepEqual(h.published.map(change => change.kind), ["remote", "remote", "remote"]);
  assert.deepEqual(h.published.map(change => change.changes), [LENGTH_CELL, LENGTH_CELL, { ...NOTHING, cells: [{ rowId: "R1", field: "lengthSeconds" }], docFields: ["title"] }]);
  assert.deepEqual(h.undo, []);
  assert.deepEqual(h.executed, []);
  assert.deepEqual(h.log, ["project", "project", "publish:remote", "project", "publish:remote", "project", "publish:remote"]);
  assert.equal(h.clock.armed(), 0);
  assert.equal(h.session.generation(), 0);
});

test("the kind of every origin the port names is literal data; any other origin is reported and published as remote, with no undo entry or effect", () => {
  assert.deepEqual(ORIGIN_KINDS, { "hydration": "adopt", "local-command": "edit", "local-undo": "replay", "remote": "remote", "cleanup": "remote" });
  assert.ok(Object.isFrozen(ORIGIN_KINDS));
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  replica.write(null, timed(7));
  replica.write("presence" as ReplicaOrigin, timed(9));
  replica.write("toString" as ReplicaOrigin, script());
  assert.deepEqual(h.published, [
    { kind: "remote", epoch: 1, generation: 0, changes: LENGTH_CELL },
    { kind: "remote", epoch: 1, generation: 0, changes: LENGTH_CELL },
    { kind: "remote", epoch: 1, generation: 0, changes: LENGTH_CELL }
  ]);
  assert.deepEqual(h.reported.map(error => (error as Error).message), [
    "A shared transaction had an origin the session does not recognise: null",
    "A shared transaction had an origin the session does not recognise: presence",
    "A shared transaction had an origin the session does not recognise: toString"
  ]);
  assert.deepEqual(h.log, ["project", "project", "report", "publish:remote", "project", "report", "publish:remote", "project", "report", "publish:remote"]);
  assert.deepEqual([h.undo, h.executed, h.session.generation(), h.clock.armed()], [[], [], 0, 0]);
  const empty = fakeReplica(), first = sharedHarness(empty.port);
  empty.write(null, script());
  assert.deepEqual(first.published, [{ kind: "adopt", epoch: 1, generation: 0, changes: { ...NOTHING, whole: true } }]);
  assert.deepEqual(first.log, ["project", "report", "publish:adopt"]);
});

test("a remote change to the title, the comments, the headings or a record names that document field and no cell", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  const sections = [{ id: "H1", name: "Scene", firstSceneId: "R1" }], people = [{ id: "P1", name: "Ann" }];
  replica.write("remote", script({ title: "Theirs" }));
  replica.write("remote", script({ title: "Theirs", sections }));
  replica.write("remote", script({ title: "Theirs", sections, people }));
  replica.write("remote", script({ title: "Theirs", sections, people, comments: [{ id: "c1", rowId: "R1", field: "audioText", body: "Why", author: "Ann" }] }));
  assert.deepEqual(h.published.map(change => [change.kind, change.changes]), [
    ["remote", { ...NOTHING, docFields: ["title"] }],
    ["remote", { ...NOTHING, docFields: ["sections"] }],
    ["remote", { ...NOTHING, docFields: ["people"] }],
    ["remote", { ...NOTHING, docFields: ["comments"] }]
  ]);
  assert.equal(h.session.read(doc => doc?.comments.length), 1);
  assert.deepEqual(h.reported, []);
});

test("the first document to arrive is an adoption whatever its origin, and a hydration is one too", () => {
  for (const origin of ["remote", "hydration", "local-command", "local-undo", "cleanup"] as const) {
    const replica = fakeReplica(), h = sharedHarness(replica.port);
    replica.write(origin, script());
    assert.deepEqual(h.published, [{ kind: "adopt", epoch: 1, generation: 0, changes: { ...NOTHING, whole: true } }], String(origin));
    assert.deepEqual(h.log, ["project", "publish:adopt"], String(origin));
  }
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  replica.write("hydration", script({ title: "Again" }));
  assert.deepEqual(h.published, [{ kind: "adopt", epoch: 2, generation: 0, changes: { ...NOTHING, whole: true } }]);
});

test("a session made over a loaded replica holds its document at a new epoch and publishes nothing; counters continue", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port, { after: { epoch: 4, generation: 9 } });
  assert.deepEqual([h.session.epoch(), h.session.generation(), h.session.revision()], [5, 9, 1]);
  assert.equal(h.session.read(doc => doc?.title), "Title");
  assert.deepEqual(h.published, []);
  assert.deepEqual(h.log, ["project"]);
  replica.write("local-command", timed(7));
  assert.deepEqual(h.published, [{ kind: "edit", epoch: 5, generation: 10, changes: LENGTH_CELL }]);
});

test("a local command is one execute at the held revision, one transaction and one edit; the plan's derive, saveNow and selection ride along", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port, undefined);
  replica.script(() => { replica.write("local-command", timed(7)); return { ok: true }; });
  const selection: FlowSelectionPair = {
    before: { anchor: { kind: "beat", rowId: "R1", offset: 0 }, head: { kind: "beat", rowId: "R1", offset: 0 } },
    after: { anchor: { kind: "beat", rowId: "R1", offset: 1 }, head: { kind: "beat", rowId: "R1", offset: 1 } }
  };
  const changes = { ...LENGTH_CELL, derive: ["production"], saveNow: true };
  assert.deepEqual(h.session.run(sharedCommand("length", [LENGTH], { derive: ["production"], saveNow: true, selection })), { kind: "applied", generation: 1, changes });
  assert.deepEqual(h.executed, [{ operations: [LENGTH], base: 1 }]);
  assert.deepEqual(h.published, [{ kind: "edit", epoch: 1, generation: 1, changes }]);
  assert.deepEqual(h.undo, [{ changes, selection }]);
  assert.deepEqual(h.log, ["project", "execute", "project", "undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  assert.equal(h.session.read(doc => doc?.rows[0]?.["lengthSeconds"]), 7);
  h.clock.advance(180);
  assert.deepEqual(h.refreshes, [["production"]]);
});

test("a command the replica refuses, on a stale base or by a handler, makes no change and calls no subscriber, undo or effect", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  replica.write("remote", timed(3));
  h.log.length = 0;
  h.published.length = 0;
  assert.deepEqual(h.session.run(sharedCommand("stale", [LENGTH], { base: 1 })), { kind: "rejected", reason: "stale-base" });
  replica.script(() => ({ ok: false, reason: "missing-target" }));
  assert.deepEqual(h.session.run(sharedCommand("refused", [LENGTH])), { kind: "rejected", reason: "missing-target" });
  assert.deepEqual(h.executed, [{ operations: [LENGTH], base: 1 }, { operations: [LENGTH], base: 2 }]);
  assert.deepEqual(h.published, []);
  assert.deepEqual(h.undo, []);
  assert.deepEqual(h.log, ["execute", "execute"]);
  assert.deepEqual([h.session.generation(), h.session.revision(), h.clock.armed()], [0, 2, 0]);
  assert.equal(h.session.read(doc => doc?.rows[0]?.["lengthSeconds"]), 3);
});

test("a command whose plan has no shared part is rejected as not shared: its apply never runs and nothing reaches the replica, undo, effects or subscribers", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  let applied = 0;
  const plain: Command = { name: "plain", needs: "edit", plan: () => ({ changes: changeSet({ cells: [{ rowId: "R1", field: "lengthSeconds" }] }), apply: doc => { applied++; doc.title = "Written"; } }) };
  assert.deepEqual(h.session.run(plain), { kind: "rejected", reason: "not shared" });
  assert.equal(NOT_SHARED, "not shared");
  assert.equal(applied, 0);
  assert.deepEqual(h.log, ["project"]);
  assert.deepEqual([h.published, h.undo, h.executed, h.reported], [[], [], [], []]);
  assert.deepEqual([h.session.read(doc => doc?.title), h.session.generation(), h.session.revision()], ["Title", 0, 1]);
});

test("commands that never reach the replica: no plan, a refusal, no capability, a throw, no shared part, no operations", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  const boom = new Error("plan");
  const plain: Command = { name: "plain", needs: "edit", plan: () => ({ changes: changeSet({ whole: true }), apply: () => { throw new Error("applied"); } }) };
  const outcomes: CommandOutcome[] = [
    h.session.run({ name: "none", needs: "edit", plan: () => null }),
    h.session.run({ name: "refuses", needs: "edit", plan: () => ({ refused: "not here" }) }),
    h.session.run({ name: "throws", needs: "edit", plan: () => { throw boom; } }),
    h.session.run(plain),
    h.session.run(sharedCommand("empty", []))
  ];
  h.deny("read only");
  outcomes.push(h.session.run(sharedCommand("denied", [LENGTH])));
  let asked = false;
  outcomes.push(h.session.run({ name: "asks", needs: "nothing", plan: (_doc, capability) => { asked = !capability.edit().allowed; return null; } }));
  assert.deepEqual(outcomes, [
    { kind: "noop" },
    { kind: "rejected", reason: "not here" },
    { kind: "failed", error: boom },
    { kind: "rejected", reason: NOT_SHARED },
    { kind: "noop" },
    { kind: "rejected", reason: "read only" },
    { kind: "noop" }
  ]);
  assert.equal(asked, true);
  assert.equal(NOT_SHARED, "not shared");
  assert.deepEqual(h.log, ["project"]);
  assert.deepEqual(h.published, []);
});

test("an accepted list that writes nothing is a no-op", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  assert.deepEqual(h.session.run(sharedCommand("same", [LENGTH])), { kind: "noop" });
  assert.deepEqual(h.log, ["project", "execute"]);
  assert.equal(h.session.generation(), 0);
});

for (const during of ["edit", "remote"] as const) {
  test(`re-entry: a command issued while a ${during} change is delivered is rejected as reentered and reaches no replica`, () => {
    const replica = fakeReplica(script()), h = sharedHarness(replica.port);
    replica.script(() => { replica.write("local-command", timed(7)); return { ok: true }; });
    const nested: CommandOutcome[] = [];
    const stop = h.session.subscribe(() => { nested.push(h.session.run(sharedCommand("nested", [LENGTH]))); });
    if (during === "edit") assert.deepEqual(h.session.run(sharedCommand("outer", [LENGTH])).kind, "applied");
    else replica.write("remote", timed(5));
    assert.deepEqual(nested, [{ kind: "rejected", reason: REENTERED }]);
    assert.equal(h.executed.length, during === "edit" ? 1 : 0);
    assert.equal(h.published.length, 1);
    stop();
    assert.equal(h.session.run(sharedCommand("after", [LENGTH])).kind, "applied");
    assert.equal(REENTERED, "reentered");
  });
}

test("re-entry: a command issued while another is planning or being asked for capability is rejected as reentered, and the outer command applies alone", () => {
  const replica = fakeReplica(script()), inner: CommandOutcome[] = [];
  let ask = false;
  const h = sharedHarness(replica.port, { asked: () => { if (ask) inner.push(h.session.run(sharedCommand("asked", [LENGTH]))); } });
  replica.script(() => { replica.write("local-command", timed(7)); return { ok: true }; });
  const outer: Command = {
    name: "outer", needs: "edit",
    plan: () => {
      inner.push(h.session.run(sharedCommand("planned", [LENGTH])));
      return { changes: changeSet({ whole: true }), apply: () => { throw new Error("applied"); }, shared: { operations: [LENGTH] } };
    }
  };
  ask = true;
  assert.deepEqual(h.session.run(outer), { kind: "applied", generation: 1, changes: LENGTH_CELL });
  ask = false;
  assert.deepEqual(inner, [{ kind: "rejected", reason: "reentered" }, { kind: "rejected", reason: "reentered" }]);
  assert.deepEqual(h.executed, [{ operations: [LENGTH], base: 1 }]);
  assert.deepEqual(h.published, [{ kind: "edit", epoch: 1, generation: 1, changes: LENGTH_CELL }]);
  assert.deepEqual([h.undo.length, h.session.generation(), h.session.revision()], [1, 1, 2]);
  assert.deepEqual(h.log, ["project", "execute", "project", "undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  const boom = new Error("plan");
  assert.deepEqual(h.session.run({ name: "throws", needs: "edit", plan: () => { throw boom; } }), { kind: "failed", error: boom });
  replica.script(() => ({ ok: true }));
  assert.deepEqual(h.session.run(sharedCommand("after", [LENGTH])), { kind: "noop" });
});

test("re-entry: a command issued from undo recording, an effect or a handler inside execute is rejected the same way", () => {
  const replica = fakeReplica(script()), nested: CommandOutcome[] = [];
  const again = (): void => { nested.push(h.session.run(sharedCommand("nested", [LENGTH]))); };
  const h = sharedHarness(replica.port, { record: again, effect: name => { if (name === "save") again(); } });
  replica.script(() => { again(); replica.write("local-command", timed(7)); return { ok: true }; });
  assert.equal(h.session.run(sharedCommand("outer", [LENGTH])).kind, "applied");
  assert.deepEqual(nested, [{ kind: "rejected", reason: REENTERED }, { kind: "rejected", reason: REENTERED }, { kind: "rejected", reason: REENTERED }]);
  assert.equal(h.executed.length, 1);
});

test("a subscriber reads the new projection and revision during its notification", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  const seen: unknown[] = [];
  h.session.subscribe(() => { seen.push([h.session.revision(), h.session.read(doc => doc?.title), h.session.readAt((doc, revision) => [revision, doc?.title])]); });
  replica.write("remote", script({ title: "Theirs" }));
  assert.deepEqual(seen, [[2, "Theirs", [2, "Theirs"]]]);
});

test("readAt gives the held document with the revision it was projected at, in one call: an observer told before the session still gets the old pair", () => {
  const replica = fakeReplica();
  const early: unknown[] = [];
  let read: () => unknown = () => "no session";
  replica.port.observe(() => { early.push([replica.port.revision(), read()]); });
  const h = sharedHarness(replica.port);
  read = () => h.session.readAt((doc, revision) => [revision, doc ? doc.title : null]);
  assert.deepEqual(read(), [0, null]);
  replica.write("hydration", script());
  replica.write("remote", script({ title: "Theirs" }));
  replica.echo("remote");
  assert.deepEqual(early, [[1, [0, null]], [2, [1, "Title"]], [2, [2, "Theirs"]]]);
  assert.deepEqual(read(), [2, "Theirs"]);
  replica.fail(new Error("projection"));
  replica.write("remote", script({ title: "Unseen" }));
  assert.deepEqual([replica.port.revision(), read()], [3, [2, "Theirs"]]);
});

test("a throw in undo recording, an effect or a subscriber is reported once, the later steps still run and the command is committed", () => {
  const replica = fakeReplica(script());
  const undo = new Error("undo"), draft = new Error("draft"), listener = new Error("listener");
  const h = sharedHarness(replica.port, { record: () => { throw undo; }, effect: name => { if (name === "draft") throw draft; } });
  h.session.subscribe(() => { throw listener; });
  replica.script(() => { replica.write("local-command", timed(7)); return { ok: true }; });
  assert.deepEqual(h.session.run(sharedCommand("length", [LENGTH])), { kind: "committed", generation: 1, changes: LENGTH_CELL, errors: [undo, draft, listener] });
  assert.deepEqual(h.reported, [undo, draft, listener]);
  assert.deepEqual(h.log, ["project", "execute", "project", "undo.record", "dirty:1", "draft:1", "save:1", "publish:edit", "report", "report", "report"]);
  replica.write("remote", script());
  assert.deepEqual(h.reported, [undo, draft, listener, listener]);
});

test("a replica that throws before its transaction fails the command; one that throws after it leaves the change committed", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  const early = new Error("early"), late = new Error("late");
  replica.script(() => { throw early; });
  assert.deepEqual(h.session.run(sharedCommand("early", [LENGTH])), { kind: "failed", error: early });
  assert.deepEqual([h.published.length, h.reported.length, h.session.generation()], [0, 0, 0]);
  replica.script(() => { replica.write("local-command", timed(7)); throw late; });
  assert.deepEqual(h.session.run(sharedCommand("late", [LENGTH])), { kind: "committed", generation: 1, changes: LENGTH_CELL, errors: [late] });
  assert.deepEqual(h.reported, [late]);
  assert.deepEqual(h.published, [{ kind: "edit", epoch: 1, generation: 1, changes: LENGTH_CELL }]);
  replica.script(() => ({ ok: true }));
  assert.deepEqual(h.session.run(sharedCommand("after", [LENGTH])), { kind: "noop" });
});

test("a projection that throws is reported, publishes nothing and keeps the held document; the next one reports everything since", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  const broken = new Error("projection");
  replica.fail(broken);
  replica.write("remote", timed(7));
  assert.deepEqual(h.reported, [broken]);
  assert.deepEqual(h.published, []);
  assert.deepEqual([h.session.revision(), h.session.read(doc => doc?.rows[0]?.["lengthSeconds"])], [1, undefined]);
  assert.deepEqual(h.session.run(sharedCommand("behind", [LENGTH])), { kind: "rejected", reason: "stale-base" });
  replica.script(() => { replica.write("local-command", timed(8)); return { ok: true }; });
  assert.deepEqual(h.session.run(sharedCommand("lost", [LENGTH], { base: 2 })), { kind: "failed", error: broken });
  assert.deepEqual(h.reported, [broken, broken]);
  assert.deepEqual([h.published.length, h.undo.length, h.session.generation()], [0, 0, 0]);
  replica.fail(null);
  replica.write("remote", script({ rows: [{ id: "R1", status: "todo", audioText: "ab", lengthSeconds: 8 }, { id: "R2", status: "ready", audioText: "cd" }] }));
  assert.deepEqual(h.published, [{ kind: "remote", epoch: 1, generation: 0, changes: { ...NOTHING, cells: [{ rowId: "R1", field: "lengthSeconds" }, { rowId: "R2", field: "status" }] } }]);
  assert.equal(h.session.revision(), 4);
});

test("dispose stops observing the replica, drops the document and subscribers, and rejects commands", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  h.session.refresh("production");
  assert.deepEqual([replica.observers(), h.clock.armed()], [1, 1]);
  h.session.dispose();
  h.session.dispose();
  assert.deepEqual([replica.observers(), h.clock.armed()], [0, 0]);
  replica.write("remote", timed(7));
  h.session.refresh("production");
  let heard = 0;
  h.session.subscribe(() => { heard++; })();
  replica.write("remote", timed(8));
  assert.deepEqual(h.session.run(sharedCommand("late", [LENGTH])), { kind: "rejected", reason: DISPOSED });
  assert.deepEqual([h.published.length, heard, h.clock.armed(), h.session.read(doc => doc)], [0, 0, 0, null]);
  assert.deepEqual(h.log, ["project"]);
});

test("refresh jobs coalesce in the idle window and can be cancelled, as in a standalone session", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port);
  h.session.refresh("production");
  h.session.refresh("broll");
  h.session.cancelRefresh(["broll"]);
  h.clock.advance(180);
  assert.deepEqual(h.refreshes, [["production"]]);
});
