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
  try {
    writers.forEach((handle, index) => { collabState(handle).doc.clientID = index + 1; });
    hydrateSharedDocument(a, validatedFixture({ rows: [{ id: "R1", audioText: "abcdefgh" }] }));
    assert.equal(applySharedUpdate(b, encodeSharedState(a)).ok, true);
    writers.forEach((handle, index) => queue.addReplica(index ? "B" : "A", deliveryReplica(handle)));
    let state = seed;
    const pick = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
    for (let step = 0; step < (literal ? 4 : 36); step++) {
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
      if (step % 9 === 8) queue.flush(order);
    }
    queue.flush(order);
    queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a));
    const readings = [a, b, c].map((handle, index) => ({ order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order,
      replica: (["A", "B", "C"] as const)[index] as "A" | "B" | "C", output: storedValue(textOf(handle)) }));
    return { readings, deliveries: queue.history.filter(item => item.startsWith("deliver ")).length };
  } finally { queue.destroy(); for (const handle of [a, b, c]) destroySharedDocument(handle); }
}

test("cleanup delivery policy sends this copy's maintenance changes and excludes received updates", () => {
  for (const origin of ["local-command", "local-undo", "hydration", "cleanup", null] as const) assert.equal(shouldDeliverSharedUpdate(origin), true);
  assert.equal(shouldDeliverSharedUpdate("remote"), false);
});

test("seeded formatting cleanup: 48 two-writer histories agree in every order and with a late joiner", t => {
  const limits: readonly string[] = [], violations: string[] = [];
  let commands = 0, deliveries = 0;
  for (let seed = 1; seed <= 48; seed++) for (const order of deliveryOrders) {
    const result = history(seed, order);
    commands += 36;
    deliveries += result.deliveries;
    try { assertReplicasAgree(`cleanup seed=${seed}/${order}`, result.readings); }
    catch (error) { violations.push(String(error)); }
  }
  assert.deepEqual(violations, limits);
  assert.equal(commands, 10368);
  assert.equal(deliveries, 8738);
  t.diagnostic(`48 histories, 288 order runs, ${commands} commands, ${deliveries} deliveries, 288 late joiners, 0 violations`);
});

test("formatting cleanup literal: deleted italic abc cannot make the untouched suffix italic", () => {
  const readings = deliveryOrders.flatMap(order => history(1, order, true).readings);
  assertReplicasAgree("italic deletion literal", [{ order: "D1", replica: "A", output: [{ insert: "defgh" }] }, ...readings]);
});

test("cleanup after a local command is separately visible and has no command attribution", () => {
  const handle = createSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
    const origins: unknown[] = [], detach = observeSharedTransactions(handle, origin => origins.push(origin));
    collabState(handle).doc.on("afterTransaction", transaction => {
      if (transaction.origin === "local-command") Y.cleanupYTextFormatting(textOf(handle));
    });
    transactSharedDocument(handle, "local-command", () => textOf(handle).format(0, 4, { b: true }));
    assert.deepEqual(origins, ["local-command", "cleanup"]);
    detach();
  } finally { destroySharedDocument(handle); }
});
