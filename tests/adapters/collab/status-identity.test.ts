import assert from "node:assert/strict";
import { test } from "node:test";
import { applySharedUpdate, encodeSharedState, encodeSharedStateVector, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { isStableSharedIdentity } from "../../../src/adapters/collab/identity.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedStatus, readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { agree, execute, operation, ref, replicas } from "./executor-support.ts";

const target = { scope: "beat" as const, record: ref("R1") };
function event(id: string, extra: Record<string, unknown> = {}) {
  return { kind: "status", id, by: "Writer", target, value: "ready", parents: [], ...extra };
}
function reading(handle: SharedDocumentHandle) {
  return { status: readSharedStatus(handle, target), heads: readSharedStatusHeads(handle, target) };
}

test("stable shared identities reject lone surrogates and deliberate replacement characters", () => {
  for (const [value, expected] of [["", true], ["ordinary", true], ["😀", true], ["\\ud800", true],
    ["x\ud800", false], ["x\udc00", false], ["x\ufffd", false]] as const) assert.equal(isStableSharedIdentity(value), expected);
});

test("malformed stored key and id are absent before sync, after sync and after reload; empty parents author identically", () => {
  const run = replicas();
  try {
    transactSharedDocument(run.a, "remote", () => collabState(run.a).roots.statusEvents.set("malformed\ud800", event("malformed\ud800")));
    const before = encodeSharedState(run.a);
    for (const handle of [run.b, run.c]) assert.ok(applySharedUpdate(handle, before).ok);
    agree("unstable event is absent", "D1", [run.a, run.b, run.c], reading, { status: "todo", heads: [] });
    assert.deepEqual(encodeSharedState(run.a), before);
    assert.ok(collabState(run.a).roots.statusEvents.has("malformed\ud800"));
    for (const handle of [run.a, run.b, run.c]) execute(handle, event("after", { value: "shot" }));
    agree("empty parents ignore unstable event", "D1", [run.a, run.b, run.c], handle => readSharedStatus(handle, target), "shot");
  } finally { run.close(); }
});

for (const order of deliveryOrders) for (const writers of [[1, 2], [2, 1]]) test(`colliding unstable keys are absent with writers ${writers.join("/")} ${order}`, () => {
  const run = replicas();
  try {
    for (const [index, handle] of [run.a, run.b].entries()) {
      collabState(handle).doc.clientID = writers[index] as number;
      const id = index ? "x\udc00" : "x\ud800";
      transactSharedDocument(handle, "local-command", () => collabState(handle).roots.statusEvents.set(id, event(id)));
      assert.deepEqual(reading(handle), { status: "todo", heads: [] });
    }
    run.queue.flush(order);
    agree("colliding unstable keys", order, [run.a, run.b], reading, { status: "todo", heads: [] });
    assert.ok(applySharedUpdate(run.c, encodeSharedState(run.a)).ok);
    assert.deepEqual(reading(run.c), { status: "todo", heads: [] });
  } finally { run.close(); }
});

test("unstable authored id, parent, target and writer are refused without writes", () => {
  const run = replicas();
  try {
    for (const unstable of ["bad\ud800", "bad\udc00", "bad\ufffd"]) for (const change of [
      { id: unstable }, { parents: [unstable] }, { target: { ...target, record: unstable } }, { by: unstable }
    ]) {
      const command = operation(event("new", change)), before = encodeSharedState(run.a), vector = encodeSharedStateVector(run.a);
      assert.deepEqual(executeSharedOperations(run.a, [command]), { ok: false, index: 0, operation: command, reason: "unstable-identity" });
      assert.deepEqual(encodeSharedState(run.a), before);
      assert.deepEqual(encodeSharedStateVector(run.a), vector);
    }
  } finally { run.close(); }
});

test("stored unstable value identities, including deliberate U+FFFD, are absent on every copy", () => {
  const run = replicas();
  try {
    transactSharedDocument(run.a, "remote", () => {
      for (const [index, change] of [{ id: "bad\ufffd" }, { parents: ["bad\ud800"] },
        { target: { ...target, record: "bad\udc00" } }, { by: "bad\ufffd" }].entries()) {
        const id = `invalid${index}`;
        collabState(run.a).roots.statusEvents.set(id, event(id, change));
      }
      collabState(run.a).roots.statusEvents.set("deliberate\ufffd", event("deliberate\ufffd"));
    });
    for (const handle of [run.b, run.c]) assert.ok(applySharedUpdate(handle, encodeSharedState(run.a)).ok);
    agree("unstable value identities", "D1", [run.a, run.b, run.c], reading, { status: "todo", heads: [] });
    for (const handle of [run.a, run.b, run.c]) {
      assert.equal(readSharedStatus(handle, { ...target, record: ref("bad\udc00") }), "todo");
      assert.deepEqual(readSharedStatusHeads(handle, { ...target, record: ref("bad\udc00") }), []);
    }
  } finally { run.close(); }
});

test("a stable child naming an invalid parent retains its display and refuses incomplete ancestry", () => {
  const run = replicas();
  try {
    transactSharedDocument(run.a, "remote", () => {
      collabState(run.a).roots.statusEvents.set("invalid", event("invalid", { by: "bad\ufffd" }));
      collabState(run.a).roots.statusEvents.set("child", event("child", { parents: ["invalid"] }));
    });
    for (const handle of [run.b, run.c]) assert.ok(applySharedUpdate(handle, encodeSharedState(run.a)).ok);
    agree("missing invalid ancestry", "D1", [run.a, run.b, run.c], reading, { status: "ready", heads: ["child"] });
    for (const handle of [run.a, run.b, run.c]) {
      const command = operation(event("next", { parents: ["child"], value: "shot" })), before = encodeSharedState(handle);
      assert.deepEqual(executeSharedOperations(handle, [command]), { ok: false, index: 0, operation: command, reason: "incomplete-status-ancestry" });
      assert.deepEqual(encodeSharedState(handle), before);
    }
  } finally { run.close(); }
});
