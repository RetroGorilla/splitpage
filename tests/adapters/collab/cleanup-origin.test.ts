import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState, shouldDeliverSharedUpdate, transactSharedDocument, observeSharedTransactions } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { DeliveryQueue, deliveryOrders } from "../../collab/delivery.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";
import { deliveryReplica, storedValue, validatedFixture } from "./helpers.ts";
import { formattingLibraryControl } from "./formatting-controls.ts";

function textOf(handle: SharedDocumentHandle): Y.Text {
  const segment = collabState(handle).roots.segments.get("b:R1");
  assert.ok(segment instanceof Y.Map);
  const text: unknown = segment.get("text");
  assert.ok(text instanceof Y.Text);
  return text;
}

function history(seed: number, order: DeliveryOrder, literal = false) {
  const a = createSharedDocument(), b = createSharedDocument(), c = createSharedDocument();
  const writers = [a, b], queue = new DeliveryQueue<Uint8Array>(update => update.slice(), update => String(update.length));
  let joined = false, checkpoints = 0, sequential = 0, selective = 0;
  try {
    writers.forEach((handle, index) => { collabState(handle).doc.clientID = index + 1; });
    hydrateSharedDocument(a, validatedFixture({ rows: [{ id: "R1", audioText: "abcdefgh" }] }));
    assert.equal(applySharedUpdate(b, encodeSharedState(a)).ok, true);
    writers.forEach((handle, index) => queue.addReplica(index ? "B" : "A", deliveryReplica(handle)));
    let state = seed;
    const pick = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    function checkpoint(): void {
      const copy = createSharedDocument();
      try {
        assert.equal(applySharedUpdate(copy, encodeSharedState(a)).ok, true);
        assertReplicasAgree(`checkpoint ${seed}/${order}/${checkpoints}`, [
          { order: order === "late-C" ? "D1" : order, replica: "A", output: storedValue(textOf(a)) },
          { order: order === "late-C" ? "D1" : order, replica: "B", output: storedValue(textOf(b)) },
          { order: "late-C", replica: "C", output: storedValue(textOf(copy)) }
        ]);
        if (joined) assert.deepEqual(storedValue(textOf(c)), storedValue(textOf(a)));
        checkpoints++;
      } finally { destroySharedDocument(copy); }
    }
    for (let step = 0; step < (literal ? 4 : 36); step++) {
      if (order === "D3" && step > 0 && step % 2 === 0) { queue.deliverFrom("B", order); selective++; }
      const handle = writers[step % 2] as SharedDocumentHandle, text = textOf(handle), from = pick(text.length + 1), to = from + pick(text.length - from + 1);
      transactSharedDocument(handle, "local-command", () => {
        if (literal) {
          if (step === 0) text.format(2, 1, { i: true });
          if (step === 1) text.format(1, 1, { i: true });
          if (step === 2) text.format(1, 2, { i: true });
          if (step === 3) text.delete(0, 3);
        } else if (step % 3 === 0) text.insert(from, "X", {});
        else if (step % 3 === 1) { for (let offset = to - 1; offset >= from; offset--) text.delete(offset, 1); }
        else {
          const key = ["b", "i", "u", "s", "hl", "dir", "cue", `c:C${step}`, `t:T${step}`, `l:L${step}`][Math.floor(step / 3 + seed) % 10] as string;
          const value = step % 2 ? null : key.startsWith("t:") ? "P" : key.startsWith("l:") ? "https://x" : true;
          if (to > from) text.format(from, to - from, { [key]: value });
        }
      });
      if (order === "D2" || step % 9 === 8 || (literal && order === "late-C" && step === 1)) {
        queue.flush(order);
        if (order === "D2") sequential++;
        if (order === "late-C" && step === (literal ? 1 : 17)) { queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a)); joined = true; }
        checkpoint();
      }
    }
    queue.flush(order);
    if (!joined) queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a));
    const readings = [a, b, c].map((handle, index) => ({ order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order,
      replica: (["A", "B", "C"] as const)[index] as "A" | "B" | "C", output: storedValue(textOf(handle)) }));
    return { readings, deliveries: queue.history.filter(item => item.startsWith("deliver ")).length,
      checkpoints, sequential, selective, earlyJoin: joined,
      afterJoinDeliveries: queue.history.slice(queue.history.findIndex(item => item.startsWith("late-C")) + 1).filter(item => item.startsWith("deliver ")).length };
  } finally { queue.destroy(); for (const handle of [a, b, c]) destroySharedDocument(handle); }
}

test("cleanup delivery policy sends this copy's maintenance changes and excludes received updates", () => {
  for (const origin of ["local-command", "local-undo", "hydration", "cleanup", null] as const) assert.equal(shouldDeliverSharedUpdate(origin), true);
  assert.equal(shouldDeliverSharedUpdate("remote"), false);
});

test(formattingLibraryControl("seeded formatting cleanup: 48 two-writer histories agree in every order and with a late joiner"), t => {
  const limits: readonly string[] = [], violations: string[] = [];
  let commands = 0, deliveries = 0, checkpoints = 0;
  const schedules = new Map(deliveryOrders.map(order => [order, 0]));
  for (let seed = 1; seed <= 48; seed++) for (const order of deliveryOrders) {
    const result = history(seed, order);
    commands += 36;
    deliveries += result.deliveries;
    checkpoints += result.checkpoints;
    schedules.set(order, (schedules.get(order) ?? 0) + 1);
    assert.equal(result.sequential, order === "D2" ? 36 : 0);
    assert.equal(result.selective, order === "D3" ? 17 : 0);
    assert.equal(result.earlyJoin, order === "late-C");
    assert.equal(result.afterJoinDeliveries > 0, order === "late-C");
    try { assertReplicasAgree(`cleanup seed=${seed}/${order}`, result.readings); }
    catch (error) { violations.push(String(error)); }
  }
  assert.deepEqual(violations, limits);
  assert.equal(commands, 10368);
  assert.deepEqual([...schedules], [["D1",48],["D2",48],["D3",48],["dup",48],["rev",48],["late-C",48]]);
  assert.equal(checkpoints, 2688);
  assert.equal(deliveries, 9130);
  t.diagnostic(`48 histories, 288 distinct schedule runs, ${commands} commands, ${deliveries} deliveries, 288 joins, ${checkpoints} checkpoint reloads, 0 violations`);
});

test(formattingLibraryControl("formatting cleanup literal: deleted italic abc cannot make the untouched suffix italic"), () => {
  const readings = deliveryOrders.flatMap(order => history(1, order, true).readings);
  assertReplicasAgree("italic deletion literal", [{ order: "D1", replica: "A", output: [{ insert: "defgh" }] }, ...readings]);
});

test(formattingLibraryControl("cleanup after a local command publishes a separate checked origin"), () => {
  const handle = createSharedDocument(), peer = createSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
    assert.equal(applySharedUpdate(peer, encodeSharedState(handle)).ok, true);
    for (const current of [handle, peer]) transactSharedDocument(current, "local-command", () => textOf(current).format(0, 4, { b: true }));
    const origins: unknown[] = [], detach = observeSharedTransactions(handle, origin => origins.push(origin));
    transactSharedDocument(handle, "local-command", () => Y.applyUpdate(collabState(handle).doc, encodeSharedState(peer)));
    assert.deepEqual(origins, ["local-command", "cleanup"]);
    detach();
  } finally { destroySharedDocument(handle); destroySharedDocument(peer); }
});

test("an ordinary unnamed observer write remains null, visible as a contract violation and deliverable", () => {
  const handle = createSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
    const origins: unknown[] = [], updates: unknown[] = [];
    observeSharedTransactions(handle, origin => {
      origins.push(origin);
      if (origin === "local-command") collabState(handle).roots.meta.set("raw", true);
    });
    collabState(handle).doc.on("update", (_update, origin: "local-command" | null) => {
      if (shouldDeliverSharedUpdate(origin)) updates.push(origin);
    });
    transactSharedDocument(handle, "local-command", () => textOf(handle).insert(0, "X", {}));
    assert.deepEqual(origins, ["local-command", null]);
    assert.deepEqual(updates, ["local-command", null]);
    assert.equal(collabState(handle).roots.meta.get("raw"), true);
    assert.equal(textOf(handle).toString(), "Xabcd");
  } finally { destroySharedDocument(handle); }
});

test("adapter mutations refuse an externally opened transaction before writing", () => {
  const handle = createSharedDocument(), peer = createSharedDocument(), fresh = createSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
    hydrateSharedDocument(peer, validatedFixture({ rows: [{ id: "R1", audioText: "peer" }] }));
    for (const origin of [null, "local-command", {}]) {
      const before = encodeSharedState(handle);
      collabState(handle).doc.transact(() => {
        assert.throws(() => transactSharedDocument(handle, "local-command", () => textOf(handle).insert(0, "lost")), /inside an external transaction/);
        assert.throws(() => applySharedUpdate(handle, encodeSharedState(peer)), /inside an external transaction/);
      }, origin);
      assert.deepEqual(encodeSharedState(handle), before);
    }
    collabState(fresh).doc.transact(() => {
      assert.throws(() => hydrateSharedDocument(fresh, validatedFixture({ rows: [] })), /inside an external transaction/);
    });
    assert.equal(collabState(fresh).fresh, true);
    assert.deepEqual(encodeSharedState(fresh), new Uint8Array([0, 0]));
  } finally { [handle, peer, fresh].forEach(destroySharedDocument); }
});

test("ordinary unnamed text and map deletions are not formatting cleanup", () => {
  const handle = createSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
    const origins: unknown[] = [];
    observeSharedTransactions(handle, origin => {
      origins.push(origin);
      if (origin === "local-command") { textOf(handle).delete(0, 1); collabState(handle).roots.meta.delete("schema"); }
    });
    transactSharedDocument(handle, "local-command", () => textOf(handle).insert(4, "X", {}));
    assert.deepEqual(origins, ["local-command", null, null]);
    assert.equal(textOf(handle).toString(), "bcdX");
  } finally { destroySharedDocument(handle); }
});

test("callers cannot assign the checked cleanup origin to a command", () => {
  const handle = createSharedDocument();
  try {
    const before = encodeSharedState(handle);
    assert.throws(() => transactSharedDocument(handle, "cleanup" as "local-command", () => collabState(handle).roots.meta.set("raw", true)), /assigned only to checked formatting maintenance/);
    assert.deepEqual(encodeSharedState(handle), before);
    assert.equal(collabState(handle).fresh, true);
  } finally { destroySharedDocument(handle); }
});

for (const event of ["beforeTransaction", "beforeAllTransactions"] as const) test(`an adapter call from ${event} recognises its pending owner and leaves the document usable`, () => {
  const handle = createSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
    const { doc, roots } = collabState(handle), origins: unknown[] = [];
    let calls = 0;
    doc.once(event, () => {
      calls++;
      transactSharedDocument(handle, "local-command", () => roots.meta.set("early", true));
    });
    observeSharedTransactions(handle, origin => origins.push(origin));
    transactSharedDocument(handle, "local-command", () => textOf(handle).insert(0, "X", {}));
    transactSharedDocument(handle, "local-command", () => textOf(handle).insert(0, "Y", {}));
    assert.equal(calls, 1);
    assert.equal(roots.meta.get("early"), true);
    assert.equal(textOf(handle).toString(), "YXabcd");
    assert.deepEqual(origins, ["local-command", "local-command"]);
    assert.equal(collabState(handle).pendingTickets.size, 0);
  } finally { destroySharedDocument(handle); }
});
