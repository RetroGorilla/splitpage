import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { encodeSharedState, observeSharedTransactions, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedScalars } from "../../../src/adapters/collab/scalar-reader.ts";
import { readSharedStatus, readSharedStatusHeads, readSharedStatusNotices } from "../../../src/adapters/collab/status.ts";
import { markOracles } from "../../collab/oracles/marks/oracles.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { agree, execute, operation, ref, replicas } from "./executor-support.ts";

const target = Object.freeze({ scope: "beat" as const, record: ref("R1") });
function status(id: string, value: string, parents: readonly string[] = [], by = "Alice", address = target): unknown {
  return { kind: "status", id, by, target: address, value, parents };
}
function scalar(id: string, scope: string, record: string, field: string, value: unknown): unknown {
  return { kind: "scalar", id, by: "Alice", target: { scope, record }, field, value };
}

test("ordered dispatch stages dependencies, commits once as local-command, and leaves refused state byte-identical", () => {
  const run = replicas();
  try {
    const origins: unknown[] = [], detach = observeSharedTransactions(run.a, origin => origins.push(origin));
    const first = scalar("one", "beat", "R1", "lengthSeconds", 4);
    for (const refused of [scalar("bad", "beat", "missing", "lengthSeconds", 7), scalar("bad", "beat", "R1", "status", "shot"),
      { kind: "record-delete", id: "bad", by: "Alice", target: { collection: "people", record: "P" } }]) {
      const before = encodeSharedState(run.a), result = executeSharedOperations(run.a, [operation(first), operation(refused)]);
      assert.ok(!result.ok); assert.equal(result.index, 1); assert.equal(result.operation.id, "bad");
      assert.deepEqual(encodeSharedState(run.a), before);
    }
    assert.deepEqual(origins, []);
    execute(run.a, first, status("a", "ready"), status("b", "shot", ["a"]));
    assert.deepEqual(origins, ["local-command"]); assert.equal(readSharedStatus(run.a, target), "shot");
    detach();
    registerSharedOperationHandlers(run.a, { "record-delete": (handle, command) => {
      collabState(handle).roots.people.set(command.target.record, "staged"); return "refused-after-write";
    } });
    const before = encodeSharedState(run.a);
    assert.equal(executeSharedOperations(run.a, [operation({ kind: "record-delete", id: "r", by: "A",
      target: { collection: "people", record: "P" } })]).ok, false);
    assert.deepEqual(encodeSharedState(run.a), before);
    assert.throws(() => registerSharedOperationHandlers(run.a, { "record-delete": () => null }));
  } finally { run.close(); }
});

test("hydrated scalar roots retain literal values, grouped fields and cleared presence", () => {
  const run = replicas();
  try {
    const document = String(collabState(run.a).roots.meta.get("docId"));
    execute(run.a, scalar("f", "document", document, "fileTitle", { titleOrigin: "user", titleVersion: "v2" }),
      scalar("w", "document", document, "wordsPerMinute", 180), scalar("t", "document", document, "targetSeconds", 90),
      scalar("p", "document", document, "paragraphsDecided", true), scalar("l", "beat", "R1", "lengthSeconds", 8),
      scalar("b", "beat", "R1", "paragraphStart", true), scalar("s", "beat", "R1", "stamp", { at: "2026-11-10T00:00:00Z", by: "Alice" }),
      scalar("h", "heading", "H1", "extra", '{"future":1}'));
    run.queue.flush("D1");
    agree("document scalars", "D1", [run.a, run.b], handle => readSharedScalars(handle, { scope: "document", record: ref(document) }),
      { fileTitle: { titleOrigin: "user", titleVersion: "v2" }, wordsPerMinute: 180, targetSeconds: 90, paragraphsDecided: true, extra: "{}" });
    agree("beat scalars", "D1", [run.a, run.b], handle => readSharedScalars(handle, target),
      { lengthSeconds: 8, paragraphStart: true, stamp: { at: "2026-11-10T00:00:00Z", by: "Alice" }, extra: "{}" });
    agree("heading scalars", "D1", [run.a, run.b], handle => readSharedScalars(handle, { scope: "heading", record: ref("H1") }), { extra: '{"future":1}' });
    execute(run.a, { kind: "scalar", id: "clear", by: "Alice", target, field: "lengthSeconds", clear: true });
    assert.equal(Object.hasOwn(readSharedScalars(run.a, target) ?? {}, "lengthSeconds"), false);
    for (const field of ["id", "audioText", "title", "docId", "schema", "rev", "lastEditedBy", "capture"]) {
      assert.equal(executeSharedOperations(run.a, [operation(scalar("blocked", "document", document, field, "x"))]).ok, false);
    }
  } finally { run.close(); }
});

for (const order of deliveryOrders) test(`T21 scalar status portion and identical/deeper branches: ${order}`, () => {
  const run = replicas();
  try {
    execute(run.a, status("a", "ready")); execute(run.b, status("b", "shot", [], "Bob")); run.queue.flush(order);
    const oracle = markOracles["T21 scalar"]; assert.ok(oracle);
    agree("T21 scalar status", order, [run.a, run.b], handle => ({ status: readSharedStatus(handle, target), notices: readSharedStatusNotices(handle, target) }),
      { status: oracle.rows[0]?.status, notices: oracle.notices });
    execute(run.a, status("c", "ready", ["a", "b"])); run.queue.flush(order);
    execute(run.a, status("d", "shot", ["c"])); execute(run.b, status("e", "todo", ["c"], "Bob")); run.queue.flush(order);
    agree("common ready ancestor", order, [run.a, run.b], handle => readSharedStatus(handle, target), "ready");
    execute(run.a, status("f", "shot", ["d", "e"])); execute(run.b, status("g", "shot", ["e", "d"], "Bob")); run.queue.flush(order);
    agree("identical changes", order, [run.a, run.b], handle => readSharedStatus(handle, target), "shot");
    assert.deepEqual(readSharedStatusHeads(run.a, target), ["f", "g"]);
  } finally { run.close(); }
});

for (const order of deliveryOrders) test(`four-event common-root regression and tag/shot domains: ${order}`, () => {
  const run = replicas();
  try {
    execute(run.a, status("a", "ready"), status("c", "shot", ["a"]));
    execute(run.b, status("b", "shot", [], "Bob"), status("d", "ready", ["b"], "Bob")); run.queue.flush(order);
    agree("four-event literal", order, [run.a, run.b], handle => readSharedStatus(handle, target), "todo");
    for (const [scope, record, values, expected] of [["tag", "t_1", ["have", "returned"], "needed"], ["shot", "S1", ["shot", "unshot"], "unshot"]] as const) {
      const address = { scope, record: ref(record) };
      for (const [index, handle] of [run.a, run.b].entries()) execute(handle, { kind: "status", id: `${scope}${index}`, by: "writer", target: address, value: values[index], parents: [] });
      run.queue.flush(order);
      agree(`${scope} literal`, order, [run.a, run.b], handle => readSharedStatus(handle, address), expected);
    }
  } finally { run.close(); }
});

test("status writer refuses stale cuts and incomplete ancestry without altering encoded state", () => {
  const run = replicas();
  try {
    execute(run.a, status("a", "ready"));
    const before = encodeSharedState(run.a);
    assert.equal(executeSharedOperations(run.a, [operation(status("b", "shot"))]).ok, false);
    assert.deepEqual(encodeSharedState(run.a), before);
    transactSharedDocument(run.a, "remote", () => collabState(run.a).roots.statusEvents.set("x", operation(status("x", "shot", ["missing"]))));
    const incomplete = encodeSharedState(run.a);
    const result = executeSharedOperations(run.a, [operation(status("b", "shot", ["a", "x"]))]);
    assert.ok(!result.ok); assert.equal(result.reason, "incomplete-status-ancestry");
    assert.deepEqual(encodeSharedState(run.a), incomplete);
  } finally { run.close(); }
});

test("seeded malformed status records and scalar values read equally after wire reload, cycles terminate", () => {
  const run = replicas();
  const values: unknown[] = [null, undefined, false, 0, NaN, Infinity, "\ud800", 2n, new Uint8Array([1]), [], new Array(2), {},
    { kind: "status", id: "x", by: "writer", target, value: "ready", parents: ["x"] },
    { kind: "status", id: "x", by: {}, target, value: "ready", parents: [] },
    { kind: "status", id: "x", by: "writer", target, value: "ready", parents: new Array(2) }];
  try {
    let seed = 1414, checks = 0;
    for (let index = 0; index < 120; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      transactSharedDocument(run.a, "remote", () => {
        collabState(run.a).roots.statusEvents.set("x", values[seed % values.length]);
        const beat = collabState(run.a).roots.beats.get("R1"); assert.ok(beat instanceof Y.Map);
        beat.set("lengthSeconds", values[(seed >>> 8) % values.length]);
      });
      agree("wrong shape", "rev", [run.a], handle => ({ status: readSharedStatus(handle, target), heads: readSharedStatusHeads(handle, target),
        notices: readSharedStatusNotices(handle, target), scalars: readSharedScalars(handle, target) })); checks++;
    }
    assert.equal(checks, 120);
  } finally { run.close(); }
});
