import { test } from "node:test";
import assert from "node:assert/strict";
import { applySharedUpdate, destroySharedDocument, observeSharedTransactions, observeSharedUpdates, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { collabState, SharedExecutionWriteError } from "../../../src/adapters/collab/state.ts";
import { insertSharedHtml } from "../../../src/adapters/collab/text-import.ts";
import { collabTextTarget, createCollabText } from "../../../src/adapters/collab/text-target.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { operation, ref } from "./executor-support.ts";
import { createMonitoredSharedDocument, deliveryReplica, validatedFixture } from "./helpers.ts";
import { recordReplicas } from "./record-support.ts";

const SOURCE = { title: "Title", rows: [{ id: "R1", audioText: "ab", status: "todo" }, { id: "R2", audioText: "cd", status: "todo" }] };

type Seen = [string | null, number, unknown[]];

function lengths(handle: SharedDocumentHandle): unknown[] {
  return projectSharedDocument(handle).rows.map(row => row["lengthSeconds"] ?? null);
}

function scalar(id: string, record: string, value: number, by = "A") {
  return operation({ kind: "scalar", id, by, target: { scope: "beat", record }, field: "lengthSeconds", value });
}

function written(handle: SharedDocumentHandle, steps: readonly [string, number][], by = "A"): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const stop = deliveryReplica(handle).onLocalUpdate(update => { updates.push(update); });
  steps.forEach(([record, value], index) => {
    assert.deepEqual(executeSharedOperations(handle, [scalar(`o${index}`, record, value, by)], { base: readSharedRevision(handle) }), { ok: true });
  });
  stop();
  assert.equal(updates.length, steps.length);
  return updates;
}

function watch(handle: SharedDocumentHandle, seen: Seen[]): () => void {
  return observeSharedTransactions(handle, origin => { seen.push([origin, readSharedRevision(handle), lengths(handle)]); });
}

function gate(handle: SharedDocumentHandle): [number, number, number] {
  const state = collabState(handle);
  return [state.ingress.holds.size, state.ingress.held.length, state.ingress.frames];
}

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  return "nothing thrown";
}

test("received updates that arrive during a notification are held and applied in arrival order: an earlier and a later observer both see each revision with exactly its own content", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const [first, second, third] = written(run.a, [["R1", 7], ["R2", 9], ["R1", 8]]);
    assert.ok(first && second && third);
    const pending = [second, third], results: unknown[] = [], early: Seen[] = [], late: Seen[] = [];
    let updates = 0;
    const count = observeSharedUpdates(run.b, () => { updates++; });
    const stop = observeSharedTransactions(run.b, origin => {
      for (let next = pending.shift(); next; next = pending.shift()) results.push([applySharedUpdate(run.b, next), readSharedRevision(run.b), lengths(run.b)]);
      early.push([origin, readSharedRevision(run.b), lengths(run.b)]);
    });
    const detach = watch(run.b, late);
    assert.deepEqual([readSharedRevision(run.b), lengths(run.b)], [1, [null, null]]);
    assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
    stop(); detach(); count();
    assert.deepEqual(results, [[{ ok: true }, 2, [7, null]], [{ ok: true }, 2, [7, null]]]);
    assert.deepEqual(early, [["remote", 2, [7, null]], ["remote", 3, [7, 9]], ["remote", 4, [8, 9]]]);
    assert.deepEqual(late, [["remote", 2, [7, null]], ["remote", 3, [7, 9]], ["remote", 4, [8, 9]]]);
    assert.equal(updates, 3);
    assert.deepEqual(gate(run.b), [0, 0, 0]);
  } finally { run.close(); }
});

test("receiving U1 then queuing duplicate U1 and U2 notifies revisions [1, 1, 2]", () => {
  const source = createMonitoredSharedDocument(), target = createMonitoredSharedDocument();
  try {
    const updates: Uint8Array[] = [], seen: [number, unknown][] = [];
    const collect = observeSharedUpdates(source, update => { updates.push(update); });
    for (const value of [1, 2]) transactSharedDocument(source, "local-command", () => collabState(source).roots.meta.set("step", value));
    collect();
    const [first, second] = updates;
    assert.ok(first && second);
    const pending = [first, second];
    const stop = observeSharedTransactions(target, () => {
      seen.push([readSharedRevision(target), collabState(target).roots.meta.get("step")]);
      for (let next = pending.shift(); next; next = pending.shift()) assert.deepEqual(applySharedUpdate(target, next), { ok: true });
    });
    assert.deepEqual(applySharedUpdate(target, first), { ok: true });
    stop();
    assert.deepEqual(seen, [[1, 1], [1, 1], [2, 2]]);
    assert.deepEqual(gate(target), [0, 0, 0]);
  } finally { destroySharedDocument(source); destroySharedDocument(target); }
});

test("receiving U1 then queuing dependency-waiting U3 before U2 notifies revisions [1, 1, 2]", () => {
  const source = createMonitoredSharedDocument(), target = createMonitoredSharedDocument();
  try {
    const updates: Uint8Array[] = [], seen: [number, unknown][] = [];
    const collect = observeSharedUpdates(source, update => { updates.push(update); });
    for (const value of [1, 2, 3]) transactSharedDocument(source, "local-command", () => collabState(source).roots.meta.set("step", value));
    collect();
    const [first, second, third] = updates;
    assert.ok(first && second && third);
    const pending = [third, second];
    const stop = observeSharedTransactions(target, () => {
      seen.push([readSharedRevision(target), collabState(target).roots.meta.get("step")]);
      for (let next = pending.shift(); next; next = pending.shift()) assert.deepEqual(applySharedUpdate(target, next), { ok: true });
    });
    assert.deepEqual(applySharedUpdate(target, first), { ok: true });
    stop();
    assert.deepEqual(seen, [[1, 1], [1, 1], [2, 3]]);
    assert.deepEqual(gate(target), [0, 0, 0]);
  } finally { destroySharedDocument(source); destroySharedDocument(target); }
});

test("an invalid update that arrives during a notification is refused at once and nothing is held for it", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const [first] = written(run.a, [["R1", 7]]);
    assert.ok(first);
    const results: unknown[] = [], seen: Seen[] = [];
    const stop = observeSharedTransactions(run.b, () => {
      if (!results.length) results.push([applySharedUpdate(run.b, new Uint8Array([255, 255, 255])), collabState(run.b).ingress.held.length]);
    });
    const detach = watch(run.b, seen);
    assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
    stop(); detach();
    assert.deepEqual(results, [[{ ok: false, reason: "invalid-update" }, 0]]);
    assert.deepEqual(seen, [["remote", 2, [7, null]]]);
    assert.deepEqual(gate(run.b), [0, 0, 0]);
  } finally { run.close(); }
});

test(`an update subscriber that throws during a notification does not close the gate for good: the held update and two later ones are each announced at their own revision`, () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const [first, second, third, fourth] = written(run.a, [["R1", 7], ["R2", 9], ["R1", 8], ["R2", 10]]);
    assert.ok(first && second && third && fourth);
    const failure = new Error("update listener failed"), seen: Seen[] = [], pending = [second];
    let failures = 0;
    const fail = (): void => { if (!failures++) throw failure; };
    const stop = observeSharedTransactions(run.b, () => { for (let next = pending.shift(); next; next = pending.shift()) applySharedUpdate(run.b, next); });
    const detach = watch(run.b, seen);
    const remove = observeSharedUpdates(run.b, fail);
    assert.equal(thrown(() => applySharedUpdate(run.b, first)), failure);
    assert.deepEqual(seen, [["remote", 2, [7, null]], ["remote", 3, [7, 9]]]);
    assert.deepEqual(gate(run.b), [0, 0, 0]);
    remove();
    assert.deepEqual([applySharedUpdate(run.b, third), applySharedUpdate(run.b, fourth)], [{ ok: true }, { ok: true }]);
    stop(); detach();
    assert.deepEqual(seen, [["remote", 2, [7, null]], ["remote", 3, [7, 9]], ["remote", 4, [8, 9]], ["remote", 5, [8, 10]]]);
    assert.deepEqual([failures, readSharedRevision(run.b), lengths(run.b), gate(run.b)], [2, 5, [8, 10], [0, 0, 0]]);
  } finally { run.close(); }
});

test("a transaction observer that throws while the drain applies a held update does not stop the drain: every held update is announced, the error is thrown after the drain, and a later update keeps its place", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const [first, second, third, fourth] = written(run.a, [["R1", 7], ["R2", 9], ["R1", 8], ["R2", 10]]);
    assert.ok(first && second && third && fourth);
    const failure = new Error("observer failed"), seen: Seen[] = [], pending = [second, third];
    const stop = observeSharedTransactions(run.b, () => {
      for (let next = pending.shift(); next; next = pending.shift()) applySharedUpdate(run.b, next);
      if (readSharedRevision(run.b) === 3) throw failure;
    });
    const detach = watch(run.b, seen);
    assert.equal(thrown(() => applySharedUpdate(run.b, first)), failure);
    assert.deepEqual(seen, [["remote", 2, [7, null]], ["remote", 3, [7, 9]], ["remote", 4, [8, 9]]]);
    assert.deepEqual(gate(run.b), [0, 0, 0]);
    assert.deepEqual(applySharedUpdate(run.b, fourth), { ok: true });
    stop(); detach();
    assert.deepEqual(seen, [["remote", 2, [7, null]], ["remote", 3, [7, 9]], ["remote", 4, [8, 9]], ["remote", 5, [8, 10]]]);
  } finally { run.close(); }
});

test("two callbacks that throw are thrown together after the drain, in the order they failed", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const [first] = written(run.a, [["R1", 7]]);
    assert.ok(first);
    const one = new Error("one"), two = new Error("two"), seen: Seen[] = [];
    const stop = observeSharedTransactions(run.b, () => { throw one; }), detach = watch(run.b, seen), remove = observeSharedUpdates(run.b, () => { throw two; });
    const error = thrown(() => applySharedUpdate(run.b, first));
    stop(); detach(); remove();
    assert.ok(error instanceof AggregateError);
    assert.deepEqual([error.errors, seen, gate(run.b)], [[one, two], [["remote", 2, [7, null]]], [0, 0, 0]]);
  } finally { run.close(); }
});

for (const event of ["afterAllTransactions", "beforeTransaction"] as const) {
  test(`an update that arrives during the drain, from the library's ${event} event of a held update, joins the tail of the queue`, () => {
    const run = recordReplicas(3, SOURCE);
    try {
      const [first, second, third] = written(run.a, [["R1", 7], ["R2", 9], ["R1", 8]]), [fourth] = written(run.c, [["R2", 10]], "C");
      assert.ok(first && second && third && fourth);
      const seen: Seen[] = [], pending = [second, third], results: unknown[] = [], state = collabState(run.b);
      const stop = observeSharedTransactions(run.b, () => { for (let next = pending.shift(); next; next = pending.shift()) applySharedUpdate(run.b, next); });
      const detach = watch(run.b, seen);
      const deliver = (): void => {
        if (results.length || state.ingress.held.length !== 2 ||(event === "afterAllTransactions") !== (readSharedRevision(run.b) === 3)) return;
        results.push([applySharedUpdate(run.b, fourth), state.ingress.held.length]);
      };
      state.doc.on(event, deliver);
      assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
      state.doc.off(event, deliver);
      stop(); detach();
      assert.deepEqual(results, [[{ ok: true }, 3]]);
      assert.deepEqual(seen, [["remote", 2, [7, null]], ["remote", 3, [7, 9]], ["remote", 4, [8, 9]], ["remote", 5, [8, 10]]]);
      assert.deepEqual(gate(run.b), [0, 0, 0]);
    } finally { run.close(); }
  });
}

for (const place of ["the library's beforeTransaction event", "the body of a local transaction"] as const) {
  test(`an update that arrives inside another write, from ${place}, does not join that transaction: it is held and announced on its own`, () => {
    const run = recordReplicas(2, SOURCE);
    try {
      const [first, second] = written(run.a, [["R1", 7], ["R2", 9]]);
      assert.ok(first && second);
      const seen: Seen[] = [], results: unknown[] = [], state = collabState(run.b);
      const detach = watch(run.b, seen);
      const inner = place === "the body of a local transaction" ? first : second;
      const deliver = (): void => { if (!results.length) results.push([applySharedUpdate(run.b, inner), state.ingress.held.length, lengths(run.b)]); };
      if (place === "the body of a local transaction") transactSharedDocument(run.b, "local-command", () => { state.roots.meta.set("local", true); deliver(); });
      else {
        state.doc.on("beforeTransaction", deliver);
        assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
        state.doc.off("beforeTransaction", deliver);
      }
      detach();
      assert.deepEqual(results, [[{ ok: true }, 1, [null, null]]]);
      assert.deepEqual(seen, place === "the body of a local transaction" ? [["local-command", 2, [null, null]], ["remote", 3, [7, null]]] :[["remote", 2, [7, null]], ["remote", 3, [7, 9]]]);
      assert.deepEqual(gate(run.b), [0, 0, 0]);
    } finally { run.close(); }
  });
}

for (const writer of ["entry", "transaction", "hydration", "text-create", "html-import", "mark-write"] as const) {
  test(`${writer}: a local write from an observer of a received update is refused, and the later observer sees revision 2 with the received change alone`, () => {
    const run = recordReplicas(2, SOURCE);
    try {
      const [first] = written(run.a, [["R1", 7]]);
      assert.ok(first);
      const seen: Seen[] = [], refused: unknown[] = [], state = collabState(run.b);
      const target = { segment: ref("b:R1"), owner: ref("R1"), field: "audioText" as const }, text = collabTextTarget(run.b, target)?.text;
      assert.ok(text);
      const attempt = (): void => {
        if (writer === "entry") executeSharedOperations(run.b, [scalar("direct", "R2", 99, "B")]);
        else if (writer === "transaction") transactSharedDocument(run.b, "local-command", () => state.roots.meta.set("nested", true));
        else if (writer === "hydration") hydrateSharedDocument(run.b, validatedFixture({ title: "nested", rows: [] }));
        else if (writer === "text-create") createCollabText(run.b, state.roots.meta, true);
        else if (writer === "html-import") insertSharedHtml(run.b, target, text, "nested", [], "nested");
        else writeSharedMarkRecord(run.b, target, "nested", null);
      };
      let updates = 0, tried = false;
      const count = observeSharedUpdates(run.b, () => { updates++; });
      const stop = observeSharedTransactions(run.b, () => {
        if (tried) return;
        tried = true;
        refused.push(thrown(attempt) instanceof SharedExecutionWriteError);
      });
      const detach = watch(run.b, seen);
      assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
      stop(); detach(); count();
      assert.deepEqual([refused, seen, updates], [[true], [["remote", 2, [7, null]]], 1]);
      assert.deepEqual([readSharedRevision(run.b), state.roots.meta.has("nested"), text.toString(), gate(run.b)], [2, false, "ab", [0, 0, 0]]);
      assert.deepEqual(executeSharedOperations(run.b, [scalar("after", "R2", 5, "B")], { base: 2 }), { ok: true });
    } finally { run.close(); }
  });
}

test("a received update delivered from an observer of a local command is held and applied after the command's notifications", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const [incoming] = written(run.a, [["R2", 9]]);
    assert.ok(incoming);
    const seen: Seen[] = [], results: unknown[] = [];
    const stop = observeSharedTransactions(run.b, origin => { if (origin === "local-command") results.push([applySharedUpdate(run.b, incoming), readSharedRevision(run.b), lengths(run.b)]); });
    const detach = watch(run.b, seen);
    assert.deepEqual(executeSharedOperations(run.b, [scalar("local", "R1", 7, "B")], { base: 1 }), { ok: true });
    stop(); detach();
    assert.deepEqual(results, [[{ ok: true }, 2, [7, null]]]);
    assert.deepEqual(seen, [["local-command", 2, [7, null]], ["remote", 3, [7, 9]]]);
    assert.deepEqual(gate(run.b), [0, 0, 0]);
  } finally { run.close(); }
});

test("destroying a handle during a notification discards its held updates and leaves the gate open", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const [first, second] = written(run.a, [["R1", 7], ["R2", 9]]);
    assert.ok(first && second);
    const seen: Seen[] = [], results: unknown[] = [], state = collabState(run.b);
    observeSharedTransactions(run.b, () => {
      results.push(applySharedUpdate(run.b, second), state.ingress.held.length);
      destroySharedDocument(run.b);
      results.push(state.ingress.held.length, state.ingress.holds.size);
    });
    watch(run.b, seen);
    assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
    assert.deepEqual(results, [{ ok: true }, 1, 0, 0]);
    assert.deepEqual([seen, lengths(run.b), gate(run.b)], [[["remote", 2, [7, null]]], [7, null], [0, 0, 0]]);
  } finally { run.close(); }
});

test("a held update whose application fails is reported and skipped: the rest of the queue is applied, and the update applies when it is delivered again", () => {
  const run = recordReplicas(3, SOURCE);
  try {
    const [first, third] = written(run.a, [["R1", 7], ["R1", 8]]), [second] = written(run.c, [["R2", 10]], "C");
    assert.ok(first && second && third);
    const failure = new Error("application failed"), seen: Seen[] = [], pending = [second, third], state = collabState(run.b), transact = state.doc.transact.bind(state.doc);
    const stop = observeSharedTransactions(run.b, () => { for (let next = pending.shift(); next; next = pending.shift()) applySharedUpdate(run.b, next); });
    const detach = watch(run.b, seen);
    let calls = 0;
    state.doc.transact = ((...parameters: Parameters<typeof transact>) => { if (++calls === 2) throw failure; return transact(...parameters); }) as typeof transact;
    assert.equal(thrown(() => applySharedUpdate(run.b, first)), failure);
    state.doc.transact = transact;
    assert.deepEqual([calls, seen, gate(run.b)], [3, [["remote", 2, [7, null]], ["remote", 3, [8, null]]], [0, 0, 0]]);
    assert.deepEqual(applySharedUpdate(run.b, second), { ok: true });
    stop(); detach();
    assert.deepEqual(seen, [["remote", 2, [7, null]], ["remote", 3, [8, null]], ["remote", 4, [8, 10]]]);
  } finally { run.close(); }
});

test("with nothing held the gate adds no transaction and holds nothing: five received updates are five transactions, five revisions and no queue entry", () => {
  const run = recordReplicas(2, SOURCE);
  try {
    const updates = written(run.a, [["R1", 1], ["R2", 2], ["R1", 3], ["R2", 4], ["R1", 5]]), state = collabState(run.b), transact = state.doc.transact.bind(state.doc), hold = state.ingress.held.push.bind(state.ingress.held);
    let transactions = 0, entries = 0, closed = 0;
    state.doc.transact = ((...parameters: Parameters<typeof transact>) => { transactions++; return transact(...parameters); }) as typeof transact;
    state.ingress.held.push = (...items) => { entries++; return hold(...items); };
    for (const update of updates) { closed += state.ingress.holds.size; assert.deepEqual(applySharedUpdate(run.b, update), { ok: true }); }
    state.doc.transact = transact;
    assert.deepEqual([transactions, readSharedRevision(run.b), entries, closed, lengths(run.b), gate(run.b)], [5, 6, 0, 0, [5, 4], [0, 0, 0]]);
  } finally { run.close(); }
});
