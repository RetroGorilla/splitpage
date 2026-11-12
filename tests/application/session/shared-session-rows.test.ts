import { test } from "node:test";
import assert from "node:assert/strict";
import { WHOLE_PROJECTION } from "../../../src/application/session/shared-session.ts";
import type { SessionChange } from "../../../src/application/session/change-set.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { createSharedReplica } from "../../../src/adapters/collab/replica.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { replicas } from "../../adapters/collab/executor-support.ts";
import { nativeText } from "../../adapters/collab/incremental-support.ts";
import { fakeReplica, sharedCommand, sharedHarness } from "./shared-session-support.ts";

const ROWS = { whole: false, added: [], removed: [], moved: [], changed: [], fields: [] };
const WHOLE = { ...ROWS, whole: true };
const SET = { whole: false, cells: [], rowsInserted: [], rowsRemoved: [], rowsMoved: false, runsMoved: false, docFields: [], derive: [], saveNow: false };

function script(parts: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 2, title: "Title", docId: "d1",
    rows: [{ id: "R1", status: "todo", audioText: "ab" }, { id: "R2", status: "todo", audioText: "cd" }, { id: "R3", status: "todo", audioText: "ef" }],
    comments: [], people: [], productionTags: [], brollShots: [], rev: 0,
    ...parts
  };
}

function operation(value: unknown): SharedOperation {
  const read = readOperation(value);
  assert.ok(read);
  return read;
}

const LENGTH = operation({ kind: "scalar", id: "o1", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });

test("the whole projection constant is frozen literal data", () => {
  assert.deepEqual(WHOLE_PROJECTION, WHOLE);
  assert.ok(Object.isFrozen(WHOLE_PROJECTION) && Object.isFrozen(WHOLE_PROJECTION.added) && Object.isFrozen(WHOLE_PROJECTION.changed));
});

test("row subscribers get one report per published change, after the change's own subscribers: whole for the adoption, then exactly the rows", () => {
  const replica = fakeReplica(), h = sharedHarness(replica.port), told: unknown[] = [];
  const stop = h.session.subscribeRows((rows, change) => { told.push([change.kind, change.generation, rows, h.log.at(-1)]); });
  replica.write("hydration", script());
  replica.write("remote", script({ rows: [{ id: "R1", status: "todo", audioText: "ab" }, { id: "R3", status: "ready", audioText: "ef" }, { id: "N1", status: "todo", audioText: "" }] }));
  replica.script(() => {
    replica.write("local-command", script({ title: "Renamed", rows: [{ id: "N1", status: "todo", audioText: "" }, { id: "R1", status: "todo", audioText: "ab" }, { id: "R3", status: "ready", audioText: "ef" }] }));
    return { ok: true };
  });
  assert.equal(h.session.run(sharedCommand("move", [LENGTH])).kind, "applied");
  replica.echo("remote");
  replica.write("hydration", script({ title: "Again" }));
  assert.deepEqual(told.splice(3), [["adopt", 1, WHOLE, "publish:adopt"]]);
  assert.deepEqual(told, [
    ["adopt", 0, WHOLE, "publish:adopt"],
    ["remote", 0, { ...ROWS, added: ["N1"], removed: ["R2"], changed: [{ id: "R3", fields: ["status"] }] }, "publish:remote"],
    ["edit", 1, { ...ROWS, moved: ["N1"], fields: ["title"] }, "publish:edit"]
  ]);
  stop();
  replica.write("remote", script());
  assert.equal(told.length, 3);
  assert.equal(h.published.length, 5);
});

test("after a projection that threw, the next report is the whole document, and the one after it is exact again", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port), told: unknown[] = [];
  h.session.subscribeRows(rows => { told.push(rows); });
  replica.fail(new Error("projection"));
  replica.write("remote", script({ title: "Missed" }));
  replica.fail(null);
  replica.write("remote", script({ title: "Missed", rows: [{ id: "R1", status: "ready", audioText: "ab" }, { id: "R2", status: "todo", audioText: "cd" }, { id: "R3", status: "todo", audioText: "ef" }] }));
  replica.write("remote", script({ title: "Seen" }));
  assert.deepEqual(told, [WHOLE, { ...ROWS, changed: [{ id: "R1", fields: ["status"] }], fields: ["title"] }]);
  assert.deepEqual(h.published.map(change => change.changes), [
    { ...SET, cells: [{ rowId: "R1", field: "status" }], docFields: ["title"] }, { ...SET, cells: [{ rowId: "R1", field: "status" }], docFields: ["title"] }
  ]);
});

test("subscribers added while a change is delivered are told from the next change on, change and row subscribers alike", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port), told: string[] = [];
  const stop = h.session.subscribe(() => {
    stop();
    h.session.subscribe(change => { told.push("change:" + change.kind); });
    h.session.subscribeRows(rows => { told.push("rows:" + rows.fields.join()); });
  });
  replica.write("remote", script({ title: "First" }));
  assert.deepEqual(told, []);
  replica.write("remote", script({ title: "Second" }));
  assert.deepEqual(told, ["change:remote", "rows:title"]);
});

test("a row subscriber that throws is reported and the command is committed with its error; a disposed session tells and registers no one", () => {
  const replica = fakeReplica(script()), h = sharedHarness(replica.port), broken = new Error("row subscriber");
  let calls = 0;
  h.session.subscribeRows(() => { calls++; throw broken; });
  replica.script(() => { replica.write("local-command", script({ title: "Edited" })); return { ok: true }; });
  const outcome = h.session.run(sharedCommand("title", [LENGTH]));
  assert.deepEqual(outcome, { kind: "committed", generation: 1, changes: { ...SET, docFields: ["title"] }, errors: [broken] });
  assert.deepEqual(h.reported, [broken]);
  h.session.dispose();
  h.session.subscribeRows(() => { calls++; });
  replica.write("remote", script());
  assert.equal(calls, 1);
});

test("over the adapter the session's document and report come from the incremental projector: untouched rows are the same frozen objects", () => {
  const run = replicas(2, { title: "Script", rows: [{ id: "R1", audioText: "one" }, { id: "R2", audioText: "two" }, { id: "R3", audioText: "three" }] });
  const work: string[] = [], replica = createSharedReplica(run.a, (kind, key) => work.push(kind + ":" + key));
  const entered: { rows: unknown[] }[] = [];
  const h = sharedHarness({ ...replica, project: () => { const document = replica.project() as { rows: unknown[] }; entered.push(document); return document; } });
  const told: [SessionChange["kind"], unknown][] = [];
  h.session.subscribeRows((rows, change) => { told.push([change.kind, rows]); });
  try {
    assert.equal(h.session.read(doc => doc?.rows.length), 3);
    work.length = 0;
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R2").insert(3, "!"));
    assert.equal(h.session.run(sharedCommand("length", [LENGTH])).kind, "applied");
    transactSharedDocument(run.b, "local-command", () => nativeText(run.b, "b:R3").insert(0, "+"));
    run.queue.flush("dup");
    assert.equal(entered.length, 4);
    assert.ok(entered.every(document => Object.isFrozen(document) && Object.isFrozen(document.rows[0])));
    assert.deepEqual(entered.slice(1).map((document, at) => document.rows.map((row, index) => row === entered[at]?.rows[index])),
      [[true, false, true], [false, true, true], [true, true, false]]);
    assert.deepEqual(work, [
      "segment:b:R2", "group:R2", "cell:[\"R2\",\"audioText\"]", "compare-row:R2", "compare-field:comments",
      "fields:R1", "group:R1", "compare-row:R1", "compare-field:comments",
      "segment:b:R3", "group:R3", "cell:[\"R3\",\"audioText\"]", "compare-row:R3", "compare-field:comments"
    ]);
    assert.deepEqual(told, [
      ["edit", { ...ROWS, changed: [{ id: "R2", fields: ["audioText"] }] }],
      ["edit", { ...ROWS, changed: [{ id: "R1", fields: ["lengthSeconds"] }] }],
      ["remote", { ...ROWS, changed: [{ id: "R3", fields: ["audioText"] }] }]
    ]);
    assert.deepEqual(h.published.slice(-3).map(change => change.changes.cells), [
      [{ rowId: "R2", field: "audioText" }], [{ rowId: "R1", field: "lengthSeconds" }], [{ rowId: "R3", field: "audioText" }]
    ]);
    assert.deepEqual(h.session.read(doc => doc?.rows.map(row => row.audioText)), ["one", "two!", "+three"]);
    assert.equal(h.session.revision(), collabState(run.a).revision);
  } finally { h.session.dispose(); replica.dispose(); run.close(); }
});
