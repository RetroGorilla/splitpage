import { test } from "node:test";
import assert from "node:assert/strict";
import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState, observeSharedTransactions, observeSharedUpdates, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { holdSharedBuffer, observeSharedDeclined } from "../../../src/adapters/collab/ingress.ts";
import { collabState, SharedExecutionWriteError } from "../../../src/adapters/collab/state.ts";
import { SHARED_BUFFER_QUEUE_BYTES } from "../../../src/core/collab/buffer.ts";

function updates(): { source: ReturnType<typeof createSharedDocument>; values: Uint8Array[] } {
  const source = createSharedDocument(), values: Uint8Array[] = [];
  observeSharedUpdates(source, value => { values.push(value); });
  for (const value of [1, 2, 3]) transactSharedDocument(source, "local-command", () => collabState(source).roots.meta.set("value", value));
  return { source, values };
}

for (const releaseInside of [false, true]) {
  test(`two reasons: buffer released ${releaseInside ? "before" : "after"} delivery; arrivals keep order`, () => {
    const { source, values } = updates(), target = createSharedDocument(), seen: unknown[] = [];
    const state = collabState(target);
    let release: (() => void) | null = null;
    observeSharedTransactions(target, () => {
      seen.push([readSharedRevision(target), state.roots.meta.get("value")]);
      if (seen.length !== 1) return;
      release = holdSharedBuffer(target);
      assert.deepEqual([...state.ingress.holds], ["delivering", "buffer"]);
      for (const value of values.slice(1)) assert.deepEqual(applySharedUpdate(target, value), { ok: true });
      assert.throws(() => transactSharedDocument(target, "local-command", () => {}), SharedExecutionWriteError);
      if (releaseInside) { release(); assert.deepEqual([...state.ingress.holds], ["delivering"]); }
    });
    try {
      const first = values[0]; assert.ok(first);
      assert.deepEqual(applySharedUpdate(target, first), { ok: true });
      if (!releaseInside) {
        assert.deepEqual(seen, [[1, 1]]);
        assert.deepEqual([...state.ingress.holds], ["buffer"]);
        (release as (() => void) | null)?.();
      }
      assert.deepEqual(seen, [[1, 1], [2, 2], [3, 3]]);
      assert.deepEqual([state.ingress.held.length, state.ingress.heldBytes, state.ingress.holds.size], [0, 0, 0]);
    } finally { destroySharedDocument(source); destroySharedDocument(target); }
  });
}

test("held update is not applied while dirty; cancel releases the same queue", () => {
  const { source, values } = updates(), target = createSharedDocument();
  try {
    const release = holdSharedBuffer(target);
    for (const value of values) assert.deepEqual(applySharedUpdate(target, value), { ok: true });
    assert.equal(collabState(target).roots.meta.get("value"), undefined);
    release(); release();
    assert.equal(collabState(target).roots.meta.get("value"), 3);
  } finally { destroySharedDocument(source); destroySharedDocument(target); }
});

test("a throwing subscriber while dirty leaves arrivals held and release drains them", () => {
  const { source, values } = updates(), target = createSharedDocument(), failure = new Error("subscriber");
  try {
    const release = holdSharedBuffer(target);
    const stop = observeSharedTransactions(target, () => { throw failure; });
    const first = values[0]; assert.ok(first);
    assert.deepEqual(applySharedUpdate(target, first), { ok: true });
    assert.throws(() => transactSharedDocument(target, "local-command", () => collabState(target).roots.meta.set("local", true)), error => error === failure);
    assert.equal(collabState(target).roots.meta.get("value"), undefined);
    stop(); release();
    assert.equal(collabState(target).roots.meta.get("value"), 1);
  } finally { destroySharedDocument(source); destroySharedDocument(target); }
});

function boundedUpdate(): { source: ReturnType<typeof createSharedDocument>; update: Uint8Array } {
  const source = createSharedDocument();
  let length = 65490;
  let update: Uint8Array = new Uint8Array();
  for (let attempt = 0; attempt < 3; attempt++) {
    const trial = createSharedDocument();
    collabState(trial).doc.clientID = 1;
    transactSharedDocument(trial, "local-command", () => collabState(trial).roots.meta.set("padding", "x".repeat(length)));
    update = encodeSharedState(trial);
    destroySharedDocument(trial);
    if (update.byteLength === SHARED_BUFFER_QUEUE_BYTES) break;
    length += SHARED_BUFFER_QUEUE_BYTES - update.byteLength;
  }
  assert.equal(update.byteLength, 65536);
  assert.deepEqual(applySharedUpdate(source, update), { ok: true });
  return { source, update };
}

for (const duringDelivery of [false, true]) {
  test(`rule 26: exact bound and latched refusal, declined once, redelivery${duringDelivery ? " with both reasons" : ""}`, () => {
    const { source, update } = boundedUpdate(), target = createSharedDocument(), small = updates();
    const state = collabState(target);
    let declined = 0, release = (): void => {}, once = false;
    observeSharedDeclined(target, () => { declined++; });
    const fill = (): void => {
      release = holdSharedBuffer(target);
      assert.deepEqual(applySharedUpdate(target, update), { ok: true });
      assert.equal(state.ingress.heldBytes, 65536);
      const first = small.values[0]; assert.ok(first);
      assert.deepEqual(applySharedUpdate(target, first), { ok: false, reason: "queue-full" });
      assert.deepEqual(applySharedUpdate(target, new Uint8Array([0, 0])), { ok: false, reason: "queue-full" });
      assert.equal(declined, 0);
    };
    try {
      if (duringDelivery) {
        observeSharedTransactions(target, () => { if (!once) { once = true; fill(); } });
        transactSharedDocument(target, "local-command", () => state.roots.meta.set("local", 1));
      } else fill();
      release(); release();
      assert.equal(declined, 1);
      assert.equal(state.roots.meta.get("padding"), "x".repeat((collabState(source).roots.meta.get("padding") as string).length));
      const first = small.values[0]; assert.ok(first);
      assert.deepEqual(applySharedUpdate(target, first), { ok: true });
      assert.equal(state.roots.meta.get("value"), 1);
      holdSharedBuffer(target)();
      assert.equal(declined, 1);
      assert.deepEqual([state.ingress.heldBytes, state.ingress.held.length], [0, 0]);
    } finally { destroySharedDocument(source); destroySharedDocument(target); destroySharedDocument(small.source); }
  });
}

test("destroy while full or dirty clears held bytes and never reports declined", () => {
  const { source, update } = boundedUpdate(), target = createSharedDocument();
  const release = holdSharedBuffer(target);
  let declined = 0;
  observeSharedDeclined(target, () => { declined++; });
  assert.deepEqual(applySharedUpdate(target, update), { ok: true });
  assert.deepEqual(applySharedUpdate(target, update), { ok: false, reason: "queue-full" });
  destroySharedDocument(target); release();
  assert.deepEqual([declined, collabState(target).ingress.heldBytes, collabState(target).ingress.holds.size], [0, 0, 0]);
  assert.equal(collabState(target).roots.meta.get("padding"), undefined);
  destroySharedDocument(source);
});

test("delivery-only queue has no buffer bound; declined callback failures still drain", () => {
  const { source, update } = boundedUpdate(), target = createSharedDocument(), failure = new Error("declined");
  let once = false;
  try {
    observeSharedTransactions(target, () => {
      if (once) return;
      once = true;
      assert.deepEqual(applySharedUpdate(target, update), { ok: true });
      assert.deepEqual(applySharedUpdate(target, update), { ok: true });
    });
    transactSharedDocument(target, "local-command", () => collabState(target).roots.meta.set("local", true));
    const release = holdSharedBuffer(target);
    assert.deepEqual(applySharedUpdate(target, update), { ok: true });
    assert.deepEqual(applySharedUpdate(target, update), { ok: false, reason: "queue-full" });
    observeSharedDeclined(target, () => { throw failure; });
    assert.throws(release, error => error === failure);
    assert.deepEqual([collabState(target).ingress.heldBytes, collabState(target).ingress.holds.size], [0, 0]);
  } finally { destroySharedDocument(source); destroySharedDocument(target); }
});
