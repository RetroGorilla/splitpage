import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { createSharedAnchor, readSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { createSharedDocument, applySharedUpdate, encodeSharedState, transactSharedDocument, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { ReplicaReading } from "../../collab/agreement.ts";
import { DeliveryQueue } from "../../collab/delivery.ts";
import { deliveryReplica, validatedFixture, readRoots } from "./helpers.ts";

function textOf(handle: SharedDocumentHandle): Y.Text {
  const segment = collabState(handle).roots.segments.get("b:R1");
  assert.ok(segment instanceof Y.Map);
  const text: unknown = segment.get("text");
  assert.ok(text instanceof Y.Text);
  return text;
}

function seeded(text = "abcd"): SharedDocumentHandle {
  const handle = createSharedDocument();
  hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: text }] }));
  return handle;
}

test("an anchor follows the same character across reversed and duplicated delivery and an encoded late join", () => {
  const source = seeded();
  const initial = encodeSharedState(source);
  const reference = createSharedAnchor(source, "b:R1", 1, "after");
  assert.equal(typeof reference, "string");
  assert.equal(readSharedAnchor(JSON.parse(JSON.stringify(reference))), reference);
  const readings: ReplicaReading<unknown>[] = [];
  for (const order of ["D1", "rev", "dup"] as const) {
    const a = createSharedDocument(), b = createSharedDocument(), c = createSharedDocument();
    assert.deepEqual(applySharedUpdate(a, initial), { ok: true });
    assert.deepEqual(applySharedUpdate(b, initial), { ok: true });
    const queue = new DeliveryQueue<Uint8Array>(update => update.slice(), update => `${update.length} bytes`);
    queue.addReplica("A", deliveryReplica(a));
    queue.addReplica("B", deliveryReplica(b));
    transactSharedDocument(a, "local-command", () => textOf(a).insert(0, "X", {}));
    transactSharedDocument(a, "local-command", () => textOf(a).insert(textOf(a).length, "!", {}));
    transactSharedDocument(b, "local-command", () => textOf(b).insert(4, "Y", {}));
    transactSharedDocument(b, "local-command", () => textOf(b).insert(4, "Z", {}));
    queue.flush(order);
    queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a));
    for (const [name, handle] of [["A", a], ["B", b], ["C", c]] as const) {
      const resolved = resolveSharedAnchor(handle, reference);
      assert.deepEqual(resolved, { segment: "b:R1", offset: 2 });
      assert.equal(textOf(handle).toString().charAt(resolved.offset), "b");
      readings.push({ order: name === "C" ? "late-C" : order, replica: name, output: resolved });
    }
    queue.destroy();
    for (const handle of [a, b, c]) destroySharedDocument(handle);
  }
  assertReplicasAgree("anchor", readings);
  destroySharedDocument(source);
});

test("before and after affinity choose opposite sides of an insertion at the same gap", () => {
  for (const initial of ["ab", ""]) {
    const handle = seeded(initial);
    const offset = initial ? 1 : 0;
    const before = createSharedAnchor(handle, "b:R1", offset, "before");
    const after = createSharedAnchor(handle, "b:R1", offset, "after");
    transactSharedDocument(handle, "local-command", () => textOf(handle).insert(offset, "X", {}));
    assert.deepEqual(resolveSharedAnchor(handle, before), { segment: "b:R1", offset });
    assert.deepEqual(resolveSharedAnchor(handle, after), { segment: "b:R1", offset: offset + 1 });
    destroySharedDocument(handle);
  }
});

test("anchor offsets count UTF-16 units, including a position between surrogate halves", () => {
  const handle = seeded("a😀b");
  const character = createSharedAnchor(handle, "b:R1", 3, "after");
  const middle = createSharedAnchor(handle, "b:R1", 2, "after");
  transactSharedDocument(handle, "local-command", () => textOf(handle).insert(0, "𝄞", {}));
  assert.deepEqual(resolveSharedAnchor(handle, character), { segment: "b:R1", offset: 5 });
  assert.deepEqual(resolveSharedAnchor(handle, middle), { segment: "b:R1", offset: 4 });
  for (const offset of [-1, 99, 0.5, NaN, Infinity]) assert.equal(createSharedAnchor(handle, "b:R1", offset, "after"), null);
  assert.equal(createSharedAnchor(handle, "missing", 0, "after"), null);
  destroySharedDocument(handle);
});

test("an anchor is gone when its segment or text is removed or replaced, on the writer and a late joiner", () => {
  for (const remove of [
    (handle: SharedDocumentHandle) => collabState(handle).roots.segments.delete("b:R1"),
    (handle: SharedDocumentHandle) => (collabState(handle).roots.segments.get("b:R1") as Y.Map<unknown>).delete("text"),
    (handle: SharedDocumentHandle) => (collabState(handle).roots.segments.get("b:R1") as Y.Map<unknown>).set("text", new Y.Text("replacement"))
  ]) {
    const a = seeded(), c = createSharedDocument();
    const reference = createSharedAnchor(a, "b:R1", 1, "after");
    transactSharedDocument(a, "local-command", () => { remove(a); });
    assert.deepEqual(applySharedUpdate(c, encodeSharedState(a)), { ok: true });
    assert.equal(resolveSharedAnchor(a, reference), "gone");
    assert.equal(resolveSharedAnchor(c, reference), "gone");
    assertReplicasAgree("removed anchor", [{ order: "D1", replica: "A", output: resolveSharedAnchor(a, reference) }, { order: "late-C", replica: "C", output: resolveSharedAnchor(c, reference) }]);
    destroySharedDocument(a);
    destroySharedDocument(c);
  }
});

test("stored anchors refuse wrong shapes, wrong versions, invalid bytes and noncanonical relative positions", () => {
  const handle = seeded();
  const reference = createSharedAnchor(handle, "b:R1", 1, "after");
  assert.ok(reference);
  const valid = JSON.parse(reference) as { v: number; segment: string; relative: number[] };
  const rootPosition = [...Y.encodeRelativePosition(Y.createRelativePositionFromJSON({ tname: "undeclared-root", assoc: 0 }))];
  const wrong: unknown[] = [null, {}, [], 1, true, "", "null", "[]", "{}", "invalid", reference.slice(0, -1),
    JSON.stringify({ ...valid, v: 2 }), JSON.stringify({ ...valid, segment: 1 }), JSON.stringify({ ...valid, segment: "\ud800" }),
    JSON.stringify({ ...valid, relative: [] }), JSON.stringify({ ...valid, relative: [0] }), JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, relative: [...valid.relative, 0] }), JSON.stringify({ ...valid, relative: [256] }),
    JSON.stringify({ ...valid, relative: [0.5] }), JSON.stringify({ ...valid, relative: [null] }),
    JSON.stringify({ ...valid, relative: rootPosition })];
  const before = encodeSharedState(handle);
  const roots = [...collabState(handle).doc.share.keys()];
  for (const raw of wrong) {
    assert.equal(readSharedAnchor(raw), null, JSON.stringify(raw));
    assert.equal(resolveSharedAnchor(handle, raw), "gone");
  }
  assert.equal(readSharedAnchor(JSON.stringify({ relative: valid.relative, segment: valid.segment, v: 1 })), reference);
  assert.deepEqual(encodeSharedState(handle), before);
  assert.deepEqual([...collabState(handle).doc.share.keys()], roots);
  destroySharedDocument(handle);
});

test("seeded arbitrary relative-position bytes cannot throw or declare roots while resolving", () => {
  const a = seeded(), c = createSharedDocument();
  assert.deepEqual(applySharedUpdate(c, encodeSharedState(a)), { ok: true });
  let seed = 0xa51414;
  for (let sample = 0; sample < 512; sample++) {
    const bytes = Array.from({ length: sample % 25 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; });
    const raw = JSON.stringify({ v: 1, segment: "b:R1", relative: bytes });
    const aBefore = encodeSharedState(a), cBefore = encodeSharedState(c);
    const rootNames = [...collabState(a).doc.share.keys()];
    assertReplicasAgree(`relative bytes ${sample}`, [{ order: "D1", replica: "A", output: resolveSharedAnchor(a, raw) }, { order: "late-C", replica: "C", output: resolveSharedAnchor(c, raw) }]);
    assert.deepEqual(encodeSharedState(a), aBefore);
    assert.deepEqual(encodeSharedState(c), cBefore);
    assert.deepEqual([...collabState(a).doc.share.keys()], rootNames);
  }
  destroySharedDocument(a);
  destroySharedDocument(c);
});

test("seeded malformed segment records and references resolve identically after encoded transfer", () => {
  let seed = 0x5a1414;
  const values: unknown[] = [null, true, 7, "cycle", [], { text: "not-shared-text" }, { head: { b: "loop" }, text: { into: "loop" } }, { extra: "not-json" }];
  for (let sample = 0; sample < 128; sample++) {
    const a = seeded(), c = createSharedDocument();
    const reference = createSharedAnchor(a, "b:R1", 1, "after");
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = values[seed % values.length];
    transactSharedDocument(a, "local-command", () => {
      collabState(a).roots.segments.set("b:R1", sample % 2 ? new Y.Map([["text", value]]) : value);
      collabState(a).roots.segments.set("é", { text: value });
      collabState(a).roots.segments.set("e\u0301", { text: value });
    });
    assert.deepEqual(applySharedUpdate(c, encodeSharedState(a)), { ok: true });
    assert.equal(createSharedAnchor(a, "b:R1", 0, "after"), null);
    assert.equal(createSharedAnchor(c, "b:R1", 0, "after"), null);
    assert.equal(resolveSharedAnchor(a, reference), "gone");
    assertReplicasAgree(`malformed anchor ${sample}`, [{ order: "D1", replica: "A", output: resolveSharedAnchor(a, reference) }, { order: "late-C", replica: "C", output: resolveSharedAnchor(c, reference) }]);
    destroySharedDocument(a);
    destroySharedDocument(c);
  }
});

test("seeded three-writer inserts, deletes, marks and malformed records agree at every encoded checkpoint and delivery order", () => {
  const source = seeded("abcdefgh");
  const initial = encodeSharedState(source);
  const reference = createSharedAnchor(source, "b:R1", 3, "after");
  const readings: ReplicaReading<unknown>[] = [];
  const declaredLimits: readonly string[] = [];
  const violations: string[] = [];
  for (const order of ["D1", "rev", "dup"] as const) {
    const writers = [createSharedDocument(), createSharedDocument(), createSharedDocument()];
    const names = ["A", "B", "C"] as const;
    const queue = new DeliveryQueue<Uint8Array>(update => update.slice(), update => `${update.length} bytes`);
    writers.forEach((handle, index) => {
      collabState(handle).doc.clientID = 101 + index;
      assert.deepEqual(applySharedUpdate(handle, initial), { ok: true });
      queue.addReplica(names[index] as typeof names[number], deliveryReplica(handle));
    });
    let seed = 0x5aa51414;
    const next = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let step = 0; step < 36; step++) {
      const handle = writers[step % 3] as SharedDocumentHandle;
      const text = textOf(handle);
      const command = Math.floor(step / 3) % 4;
      transactSharedDocument(handle, "local-command", () => {
        if (command === 0) text.insert(next() % (text.length + 1), String.fromCharCode(65 + next() % 26), {});
        if (command === 1 && text.length) text.delete(next() % text.length, 1);
        if (command === 2 && text.length) text.format(next() % text.length, 1, { b: true });
        if (command === 3) collabState(handle).roots.people.set(`P${step}`, next() % 2 ? { id: "dangling", rank: [] } : null);
      });
      const checkpoint = createSharedDocument();
      assert.deepEqual(applySharedUpdate(checkpoint, encodeSharedState(handle)), { ok: true });
      assertReplicasAgree(`checkpoint ${order}/${step}`, [
        { order, replica: names[step % 3] as typeof names[number], output: { roots: readRoots(handle), anchor: resolveSharedAnchor(handle, reference) } },
        { order: "late-C", replica: "C", output: { roots: readRoots(checkpoint), anchor: resolveSharedAnchor(checkpoint, reference) } }
      ]);
      destroySharedDocument(checkpoint);
      if (order === "D1") queue.flush(order);
    }
    queue.flush(order);
    writers.forEach((handle, index) => {
      readings.push({ order, replica: names[index] as typeof names[number], output: { roots: readRoots(handle), anchor: resolveSharedAnchor(handle, reference) } });
    });
    queue.destroy();
    const late = createSharedDocument();
    const lateQueue = new DeliveryQueue<Uint8Array>(update => update.slice(), update => `${update.length} bytes`);
    lateQueue.addReplica("A", deliveryReplica(writers[0] as SharedDocumentHandle));
    lateQueue.lateJoin("C", deliveryReplica(late), "A", encodeSharedState(writers[0] as SharedDocumentHandle));
    readings.push({ order: "late-C", replica: "C", output: { roots: readRoots(late), anchor: resolveSharedAnchor(late, reference) } });
    try { assertReplicasAgree(`three writers ${order}`, readings.slice(-4)); }
    catch (error) { violations.push(String(error)); }
    lateQueue.destroy();
    for (const handle of [...writers, late]) destroySharedDocument(handle);
  }
  assert.deepEqual(violations, declaredLimits);
  destroySharedDocument(source);
});
