import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeSessionChange, NativeSessionOptions, NativeSessionSource } from "../../../../src/adapters/collab/native/session.ts";
import {
  createNativeSizeTracker,
  NATIVE_SIZE_LIMIT_BYTES,
  NATIVE_SIZE_RECHECK_INTERVAL_BYTES,
  NATIVE_SIZE_WARNING_BYTES,
  resolveNativeSizeLimits
} from "../../../../src/adapters/collab/native/size.ts";
import { createRichText } from "../../../../src/adapters/richtext/richtext.ts";
import { cells } from "./helpers.ts";
import { AT, beatField, commentInput, replyInput } from "./record-harness.ts";
import { structureScript } from "./structure-harness.ts";

type Session = ReturnType<typeof openNativeSession>;

const conversion = { cells, creation: "seed", at: AT, by: "Alice" };
const ids = { id: (prefix: string) => prefix + "-test", docId: () => "test" };
const images = { known: () => null, fromDataUrl: () => null };
const { sanitize } = createRichText({ DOMParser, images, ids });
const narration = (beat = "A") => ({ beat, cell: "narration" }) as const;
const visual = (beat = "A") => ({ beat, cell: "visual" }) as const;

function open(
  source: NativeSessionSource,
  options: Partial<Pick<NativeSessionOptions, "actor" | "sizeLimit" | "sizeWarning">> = {}
): Session {
  return openNativeSession(source, { actor: "Alice", sanitize, ...options });
}

function fromRows(
  rows: Readonly<Record<string, string>>,
  options: Partial<Pick<NativeSessionOptions, "actor" | "sizeLimit" | "sizeWarning">> = {}
): Session {
  return open({ kind: "document", document: structureScript(rows), conversion }, options);
}

function anchor(session: Session, from: number, to = from, target: Parameters<Session["commands"]["anchorText"]>[0] = narration()) {
  const result = session.commands.anchorText(target, from, to);
  assert(result.kind === "anchored", JSON.stringify(result));
  return result.range;
}

function assertByteIdentical(session: Session, run: () => unknown, expected: unknown): void {
  const before = session.encodeState();
  let transactions = 0;
  const count = () => { transactions++; };
  session.ydoc.on("beforeTransaction", count);
  try {
    assert.deepEqual(run(), expected);
  } finally {
    session.ydoc.off("beforeTransaction", count);
  }
  assert.equal(transactions, 0);
  assert.deepEqual(session.encodeState(), before);
}

test("default session limits are 15 MB refusal and 12 MB warning", t => {
  assert.equal(NATIVE_SIZE_LIMIT_BYTES, 15_000_000);
  assert.equal(NATIVE_SIZE_WARNING_BYTES, 12_000_000);
  const session = open({ kind: "empty" });
  t.after(session.close);
  assert.equal(session.size, "ok");
  assert.deepEqual(session.sizeLimits, { limit: 15_000_000, warning: 12_000_000 });
  const custom = open({ kind: "empty" }, { sizeLimit: 5000 });
  t.after(custom.close);
  assert.deepEqual(custom.sizeLimits, { limit: 5000, warning: 5000 });
});

test("invalid size options throw RangeError without creating a Y.Doc", t => {
  const destroy = t.mock.method(Y.Doc.prototype, "destroy");
  const bad: readonly Partial<Pick<NativeSessionOptions, "sizeLimit" | "sizeWarning">>[] = [
    { sizeLimit: 0 },
    { sizeLimit: -10 },
    { sizeLimit: Number.NaN },
    { sizeLimit: Number.POSITIVE_INFINITY },
    { sizeLimit: 1000, sizeWarning: -1 },
    { sizeLimit: 1000, sizeWarning: 1001 },
    { sizeLimit: 1000, sizeWarning: Number.NaN }
  ];
  for (const options of bad) {
    assert.throws(() => open({ kind: "empty" }, options), RangeError);
  }
  assert.equal(destroy.mock.callCount(), 0);
});

test("initial size state reflects exact encoded bytes at open for ok, warning and full", t => {
  const seed = fromRows({ A: "a".repeat(200) });
  t.after(seed.close);
  const state = seed.encodeState();
  const exact = state.byteLength;

  const ok = open({ kind: "state", state }, { sizeWarning: exact + 1, sizeLimit: exact + 100 });
  const warn = open({ kind: "state", state }, { sizeWarning: exact, sizeLimit: exact + 1 });
  const full = open({ kind: "state", state }, { sizeWarning: exact - 100, sizeLimit: exact });
  const docWarn = fromRows({ A: "a".repeat(200) }, { sizeWarning: exact - 20, sizeLimit: exact + 100 });
  t.after(() => { ok.close(); warn.close(); full.close(); docWarn.close(); });

  assert.equal(ok.size, "ok");
  assert.equal(warn.size, "warning");
  assert.equal(full.size, "full");
  assert.equal(docWarn.size, "warning");
});

test("running estimate never reads below the true encoded size across adversarial edits and merges", t => {
  const session = fromRows({ A: "a".repeat(800), B: "b".repeat(800), C: "c".repeat(800) });
  t.after(session.close);
  session.ydoc.clientID = 0xffffffff;
  const tracker = createNativeSizeTracker(session.ydoc, resolveNativeSizeLimits(10_000_000, 8_000_000));
  const check = (label: string) => {
    const exact = Y.encodeStateAsUpdate(session.ydoc).byteLength;
    assert(tracker.estimate >= exact, `${label}: estimate ${tracker.estimate} < exact ${exact}`);
  };
  let local = false;
  session.ydoc.on("update", (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    tracker.recordUpdate(update.byteLength, transaction, local);
    check("after update");
  });

  local = true;
  for (let i = 0; i < 40; i++) {
    assert.equal(session.commands.typeText(anchor(session, 5 + i * 10), "x", {}).kind, "written");
  }
  for (let i = 0; i < 40; i++) {
    assert.equal(session.commands.deleteText(anchor(session, 5 + i * 10, 6 + i * 10)).kind, "written");
  }
  for (let i = 0; i < 30; i++) {
    assert.equal(session.commands.formatText(anchor(session, 5 + i * 10, 8 + i * 10), { kind: "plain", mark: "b", on: true }).kind, "written");
  }
  for (let i = 0; i < 10; i++) {
    assert.equal(session.commands.splitRow(anchor(session, 10)).kind, "written");
  }
  assert.equal(session.commands.setField(beatField("B", "note"), "n".repeat(400)).kind, "written");
  assert.equal(session.commands.createComment(commentInput("c1")).kind, "written");
  assert.equal(session.commands.moveBlocks([{ kind: "beat", id: "C" }], { kind: "beat", id: "A" }).kind, "written");
  local = false;

  const peer = open({ kind: "state", state: session.encodeState() }, { actor: "Bob" });
  t.after(peer.close);
  peer.ydoc.clientID = 0xfffffffe;
  const peerUpdates: Uint8Array[] = [];
  peer.ydoc.on("update", (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => {
    if (tr.local) peerUpdates.push(u);
  });
  for (let i = 0; i < 60; i++) {
    assert.equal(peer.commands.deleteText(anchor(peer, 5 + i * 8, 6 + i * 8, narration("B"))).kind, "written");
  }
  const mergedDeletes = Y.mergeUpdates(peerUpdates);
  Y.applyUpdate(session.ydoc, mergedDeletes, "peer");
  check("after batched peer scattered deletes");

  const latePeer = open({ kind: "state", state: session.encodeState() }, { actor: "Carol" });
  t.after(latePeer.close);
  const outOfOrder: Uint8Array[] = [];
  latePeer.ydoc.on("update", (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => {
    if (tr.local) outOfOrder.push(u);
  });
  assert.equal(latePeer.commands.typeText(anchor(latePeer, 0, 0, visual("C")), "first", {}).kind, "written");
  assert.equal(latePeer.commands.typeText(anchor(latePeer, 5, 5, visual("C")), "z".repeat(600), {}).kind, "written");
  const [firstUpdate, secondUpdate] = outOfOrder;
  assert(firstUpdate && secondUpdate);
  Y.applyUpdate(session.ydoc, secondUpdate, "peer");
  check("after out-of-order pending update");
  Y.applyUpdate(session.ydoc, firstUpdate, "peer");
  check("after resolving out-of-order update");
  assert.equal(tracker.measures, 1);
});

test("exact measure runs at open, on threshold crossing, and at most once per interval of growth", t => {
  const session = fromRows({ A: "a".repeat(200) });
  t.after(session.close);
  const base = session.encodeState().byteLength;

  const far = createNativeSizeTracker(session.ydoc, resolveNativeSizeLimits(1_000_000, 800_000));
  assert.equal(far.measures, 1);
  assert.equal(far.interval, Math.floor(1_000_000 / 250));
  assert.equal(createNativeSizeTracker(session.ydoc, resolveNativeSizeLimits()).interval, NATIVE_SIZE_RECHECK_INTERVAL_BYTES);

  const nearWarning = base + 300;
  const nearLimit = 100_000;
  const tracker = createNativeSizeTracker(session.ydoc, resolveNativeSizeLimits(nearLimit, nearWarning));
  assert.equal(tracker.measures, 1);
  assert.equal(tracker.interval, 400);

  session.ydoc.on("update", (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => {
    far.recordUpdate(u.byteLength, tr, true);
    tracker.recordUpdate(u.byteLength, tr, true);
  });

  for (let i = 0; i < 60; i++) {
    assert.equal(session.commands.typeText(anchor(session, i), "x", {}).kind, "written");
  }
  assert.equal(far.measures, 1);
  assert(tracker.measures >= 2, `expected at least one re-measure on false-alarm crossing, got ${tracker.measures}`);
  assert(tracker.measures <= 10, `expected interval cooldown to bound re-measures, got ${tracker.measures}`);
  assert.equal(tracker.state, "ok");

  assert.equal(session.commands.typeText(anchor(session, 0, 0, visual("A")), "w".repeat(400), {}).kind, "written");
  assert.equal(tracker.state, "warning");

  const fullTracker = createNativeSizeTracker(session.ydoc, resolveNativeSizeLimits(session.encodeState().byteLength, 0));
  assert.equal(fullTracker.state, "full");
  session.ydoc.on("update", (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => {
    fullTracker.recordUpdate(u.byteLength, tr, true);
  });
  assert.equal(session.commands.deleteText(anchor(session, 0, 5)).kind, "written");
  assert.equal(fullTracker.measures, 1);
});

test("size state reports warning and full once per crossing and recovers cleanly to warning and ok", async t => {
  const base = fromRows({ A: "a" });
  t.after(base.close);
  const start = base.encodeState().byteLength;
  const warning = start + 300;
  const limit = start + 800;

  const session = open({ kind: "state", state: base.encodeState() }, { sizeWarning: warning, sizeLimit: limit });
  t.after(session.close);
  const sizeEvents: string[] = [];
  session.subscribe(change => {
    if (change.kind === "size") sizeEvents.push(change.state);
  });

  assert.equal(session.size, "ok");
  assert.equal(session.commands.typeText(anchor(session, 0), "w".repeat(400), {}).kind, "written");
  assert.equal(session.size, "warning");
  await Promise.resolve();
  assert.deepEqual(sizeEvents, ["warning"]);

  assert.equal(session.commands.typeText(anchor(session, 0), "z", {}).kind, "written");
  assert.equal(session.commands.typeText(anchor(session, 0), "z", {}).kind, "written");
  await Promise.resolve();
  assert.deepEqual(sizeEvents, ["warning"]);

  assert.equal(session.commands.typeText(anchor(session, 0, 0, visual("A")), "f".repeat(600), {}).kind, "written");
  assert.equal(session.size, "full");
  await Promise.resolve();
  assert.deepEqual(sizeEvents, ["warning", "full"]);

  assertByteIdentical(session, () => session.commands.typeText(anchor(session, 0), "q", {}), {
    kind: "recovery", reason: "full", runs: [{ text: "q", marks: {} }]
  });
  await Promise.resolve();
  assert.deepEqual(sizeEvents, ["warning", "full"]);

  const peer = open({ kind: "state", state: session.encodeState() }, { actor: "Bob" });
  t.after(peer.close);
  const peerRow = peer.document().rows[0];
  assert(peerRow);
  assert.equal(peer.commands.deleteText(anchor(peer, 0, (peerRow.visualText ?? "").length, visual("A"))).kind, "written");
  Y.applyUpdate(session.ydoc, peer.encodeState(), "peer");
  assert.equal(session.size, "warning");
  await Promise.resolve();
  assert.deepEqual(sizeEvents, ["warning", "full", "warning"]);

  const peerRowAfter = peer.document().rows[0];
  assert(peerRowAfter);
  assert.equal(peer.commands.deleteText(anchor(peer, 0, (peerRowAfter.audioText ?? "").length, narration("A"))).kind, "written");
  Y.applyUpdate(session.ydoc, peer.encodeState(), "peer");
  assert.equal(session.size, "ok");
  await Promise.resolve();
  assert.deepEqual(sizeEvents, ["warning", "full", "warning", "ok"]);
});

test("an adding command checks exact size when the estimate crosses the limit during cooldown and refuses before writing", async t => {
  const seed = fromRows({ A: "a".repeat(50_000) });
  t.after(seed.close);
  const start = seed.encodeState().byteLength;
  const limit = start + 55;
  const session = open({ kind: "state", state: seed.encodeState() }, { sizeWarning: start, sizeLimit: limit });
  t.after(session.close);
  const sizeEvents: string[] = [];
  session.subscribe(change => {
    if (change.kind === "size") sizeEvents.push(change.state);
  });
  assert.equal(session.size, "warning");

  // why: trigger one false alarm just below limit so cooldown sets nextMeasureAt = exact + interval (~200 bytes)
  assert.equal(session.commands.typeText(anchor(session, 0), "x".repeat(25), {}).kind, "written");
  const gap = limit - session.encodeState().byteLength;
  assert(gap > 0 && gap < 40, `expected small gap below limit, got ${gap}`);
  assert.equal(session.size, "warning");

  // why: crosses exact >= limit while still under nextMeasureAt, so state stays warning until the add check runs
  assert.equal(session.commands.typeText(anchor(session, 25), "y".repeat(gap + 5), {}).kind, "written");
  assert(session.encodeState().byteLength >= limit);
  assert.equal(session.size, "warning");
  await Promise.resolve();
  assert.deepEqual(sizeEvents, []);

  assertByteIdentical(session, () => session.commands.setField(beatField("A", "status"), "ready"), {
    kind: "refused", reason: "full"
  });
  assert.equal(session.size, "full");
  await Promise.resolve();
  assert.deepEqual(sizeEvents, ["full"]);
});

test("every adding command refuses as full in its own shape without opening a transaction or changing stored bytes", t => {
  const seed = fromRows({ A: "alpha", B: "beta" });
  t.after(seed.close);
  assert.equal(seed.commands.createHeading(anchor(seed, 0, 0, narration("A")), "H1", "Scene 1").kind, "written");
  assert.equal(seed.commands.createHeading(anchor(seed, 0, 0, narration("B")), "H2", "Scene 2").kind, "written");
  assert.equal(seed.commands.removeHeading("H2").kind, "written");
  const created = seed.commands.createComment(commentInput("a1"));
  assert(created.kind === "written");
  assert.equal(seed.commands.resolveComment({ comment: created.created }, { by: "Alice", at: AT }).kind, "written");
  const comment2 = seed.commands.createComment(commentInput("a2"));
  assert(comment2.kind === "written");

  const fresh = open({ kind: "state", state: seed.encodeState() });
  t.after(fresh.close);
  const state = fresh.encodeState();
  const session = open({ kind: "state", state }, { sizeWarning: state.byteLength - 100, sizeLimit: state.byteLength });
  t.after(session.close);
  assert.equal(session.size, "full");

  const aRange = anchor(session, 0, 2, narration("A"));
  const aCaret = anchor(session, 0, 0, narration("A"));
  const nameRange = anchor(session, 0, 2, { beat: "H1", cell: "name" });
  const runs = [{ text: "hello", marks: { b: true } }] as const;
  const full = { kind: "refused", reason: "full" };

  assertByteIdentical(session, () => session.commands.typeText(aCaret, "x", { i: true }), {
    kind: "recovery", reason: "full", runs: [{ text: "x", marks: { i: true } }]
  });
  assertByteIdentical(session, () => session.commands.replaceText(aRange, runs), {
    kind: "recovery", reason: "full", runs
  });
  assertByteIdentical(session, () => session.commands.formatText(aRange, { kind: "plain", mark: "b", on: true }), full);
  assertByteIdentical(session, () => session.commands.splitRow(aCaret), full);
  assertByteIdentical(session, () => session.commands.joinRow("B", "A", " "), full);
  assertByteIdentical(session, () => session.commands.createHeading(aCaret, "H3", "Scene 3"), full);
  assertByteIdentical(session, () => session.commands.renameHeading(nameRange, "Renamed"), full);
  assertByteIdentical(session, () => session.commands.restoreHeading("H2"), full);
  assertByteIdentical(session, () => session.commands.moveBlocks([{ kind: "beat", id: "B" }], { kind: "beat", id: "A" }), full);
  assertByteIdentical(session, () => session.commands.setField(beatField("A", "status"), "ready"), full);
  assertByteIdentical(session, () => session.commands.createComment(commentInput("a3")), full);
  assertByteIdentical(session, () => session.commands.createReply(comment2.created, replyInput("reply")), full);
  assertByteIdentical(session, () => session.commands.setCommentBody({ comment: comment2.created }, "edited"), full);
  assertByteIdentical(session, () => session.commands.resolveComment({ comment: comment2.created }, { by: "Alice", at: AT }), full);
  assertByteIdentical(session, () => session.commands.reopenComment({ comment: created.created }), full);
});

test("removals, empty replacements, undo, redo, document and encodeState stay allowed while full", t => {
  const seed = fromRows({ A: "alpha", B: "beta", C: "gamma" });
  t.after(seed.close);
  assert.equal(seed.commands.createHeading(anchor(seed, 0, 0, narration("A")), "H1", "Scene 1").kind, "written");
  assert.equal(seed.commands.joinRow("B", "A", " ").kind, "written");
  assert.equal(seed.commands.setField(beatField("A", "note"), "keep").kind, "written");
  const comment = seed.commands.createComment(commentInput("a1"));
  assert(comment.kind === "written");

  const fresh = open({ kind: "state", state: seed.encodeState() });
  t.after(fresh.close);
  const state = fresh.encodeState();
  const session = open({ kind: "state", state }, { sizeWarning: state.byteLength - 100, sizeLimit: state.byteLength });
  t.after(session.close);
  assert.equal(session.size, "full");

  assert.equal(session.document().rows.length, 2);
  assert.deepEqual(session.encodeState(), state);

  assert.equal(session.commands.deleteText(anchor(session, 0, 1, narration("A"))).kind, "written");
  assert.equal(session.commands.typeText(anchor(session, 0, 1, narration("A")), "", {}).kind, "written");
  assert.equal(session.commands.replaceText(anchor(session, 0, 1, narration("A")), []).kind, "written");
  assert.equal(session.commands.renameHeading(anchor(session, 0, 2, { beat: "H1", cell: "name" }), "").kind, "written");
  assert.equal(session.commands.unjoinRow("B").kind, "written");
  assert.equal(session.commands.clearField(beatField("A", "note")).kind, "written");
  assert.equal(session.commands.removeComment({ comment: comment.created }).kind, "written");
  assert.equal(session.commands.removeHeading("H1").kind, "written");
  assert.equal(session.commands.removeRows(["C"]).kind, "written");

  const afterRemovals = session.document();
  assert.equal(afterRemovals.rows.map(row => row.id).join(","), "A,B");
  assert.equal(afterRemovals.rows[0]?.audioText, "ha");
  assert.equal(afterRemovals.rows[0]?.note, undefined);
  assert.equal(afterRemovals.comments.length, 0);
  assert.deepEqual(afterRemovals.sections ?? [], []);

  assert.equal(session.commands.undo().kind, "written");
  assert.equal(session.document().rows.map(row => row.id).join(","), "A,B,C");
  assert.equal(session.commands.redo().kind, "written");
  assert.equal(session.document().rows.map(row => row.id).join(","), "A,B");
  assert(session.encodeState().byteLength > 0);
});

test("busy, queued callback failure and closed take precedence over full", async t => {
  const seed = fromRows({ A: "alpha" });
  t.after(seed.close);
  const state = seed.encodeState();
  const session = open({ kind: "state", state }, { sizeWarning: state.byteLength - 50, sizeLimit: state.byteLength });
  t.after(session.close);
  assert.equal(session.size, "full");

  session.ydoc.transact(() => {
    assert.deepEqual(session.commands.setField(beatField("A", "status"), "ready"), { kind: "refused", reason: "busy" });
  });
  await Promise.resolve();

  const failure = new Error("schedule failed");
  const schedule = t.mock.method(globalThis, "queueMicrotask", () => { throw failure; });
  assert.equal(session.commands.deleteText(anchor(session, 0, 1)).kind, "written");
  schedule.mock.restore();
  assert.throws(() => session.commands.setField(beatField("A", "status"), "ready"), failure);

  session.close();
  assertByteIdentical(session, () => session.commands.setField(beatField("A", "status"), "ready"), {
    kind: "refused", reason: "closed"
  });
  await Promise.resolve();

  const destroyed = open({ kind: "state", state }, { sizeWarning: state.byteLength - 50, sizeLimit: state.byteLength });
  t.after(destroyed.close);
  destroyed.ydoc.destroy();
  assert.deepEqual(destroyed.commands.setField(beatField("A", "status"), "ready"), { kind: "refused", reason: "closed" });
});

test("two sessions merging past the limit both report full, refuse adds, allow removals, and recover", async t => {
  const base = fromRows({ A: "a", B: "b", C: "c" });
  t.after(base.close);
  const initial = base.encodeState();
  const warning = initial.byteLength + 500;
  const limit = initial.byteLength + 1000;

  const a = open({ kind: "state", state: initial }, { actor: "Alice", sizeWarning: warning, sizeLimit: limit });
  const b = open({ kind: "state", state: initial }, { actor: "Bob", sizeWarning: warning, sizeLimit: limit });
  t.after(() => { a.close(); b.close(); });

  const aSizes: string[] = [], bSizes: string[] = [];
  a.subscribe((change: NativeSessionChange) => { if (change.kind === "size") aSizes.push(change.state); });
  b.subscribe((change: NativeSessionChange) => { if (change.kind === "size") bSizes.push(change.state); });

  assert.equal(a.commands.typeText(anchor(a, 0, 0, narration("A")), "A".repeat(700), {}).kind, "written");
  assert.equal(b.commands.typeText(anchor(b, 0, 0, narration("B")), "B".repeat(700), {}).kind, "written");
  assert(a.encodeState().byteLength < limit);
  assert(b.encodeState().byteLength < limit);
  assert.equal(a.size, "warning");
  assert.equal(b.size, "warning");
  await Promise.resolve();
  assert.deepEqual(aSizes, ["warning"]);
  assert.deepEqual(bSizes, ["warning"]);

  const stateA = a.encodeState(), stateB = b.encodeState();
  Y.applyUpdate(a.ydoc, stateB, "peer");
  Y.applyUpdate(b.ydoc, stateA, "peer");

  assert.deepEqual(a.document(), b.document());
  assert.equal(a.document().rows[0]?.audioText, "A".repeat(700) + "a");
  assert.equal(a.document().rows[1]?.audioText, "B".repeat(700) + "b");
  assert.equal(a.size, "full");
  assert.equal(b.size, "full");
  await Promise.resolve();
  assert.deepEqual(aSizes, ["warning", "full"]);
  assert.deepEqual(bSizes, ["warning", "full"]);

  assertByteIdentical(a, () => a.commands.typeText(anchor(a, 0, 0, narration("C")), "blocked", {}), {
    kind: "recovery", reason: "full", runs: [{ text: "blocked", marks: {} }]
  });
  assertByteIdentical(b, () => b.commands.setField(beatField("C", "status"), "ready"), {
    kind: "refused", reason: "full"
  });

  // why: each writer deletes its own large addition; peer GC drops each copy's exact encoded size back under limit
  assert.equal(a.commands.deleteText(anchor(a, 0, 700, narration("A"))).kind, "written");
  Y.applyUpdate(b.ydoc, a.encodeState(), "peer");
  assert(b.encodeState().byteLength < limit);
  assert.equal(b.size, "warning");
  await Promise.resolve();
  assert.deepEqual(bSizes, ["warning", "full", "warning"]);

  assert.equal(b.commands.deleteText(anchor(b, 0, 700, narration("B"))).kind, "written");
  Y.applyUpdate(a.ydoc, b.encodeState(), "peer");
  assert(a.encodeState().byteLength < limit);
  assert.equal(a.size, "warning");
  await Promise.resolve();
  assert.deepEqual(aSizes, ["warning", "full", "warning"]);

  assert.equal(a.commands.typeText(anchor(a, 0, 0, narration("C")), "ok ", {}).kind, "written");
  assert.equal(b.commands.setField(beatField("C", "status"), "ready").kind, "written");
  Y.applyUpdate(a.ydoc, b.encodeState(), "peer");
  Y.applyUpdate(b.ydoc, a.encodeState(), "peer");
  assert.deepEqual(a.document(), b.document());
  assert.equal(a.document().rows[2]?.audioText, "ok c");
  assert.equal(a.document().rows[2]?.status, "ready");

  const reopened = open({ kind: "state", state: a.encodeState() }, { sizeWarning: warning, sizeLimit: limit });
  t.after(reopened.close);
  assert.equal(reopened.size, "ok");
  assert.deepEqual(reopened.document(), a.document());
});

test("peer removals recover size state from full to warning and from warning to ok via clearField and removeRows", async t => {
  const base = fromRows({ A: "a", B: "b" });
  t.after(base.close);
  const initial = base.encodeState();
  const warning = initial.byteLength + 300;
  const limit = initial.byteLength + 900;

  const writer = open({ kind: "state", state: initial }, { actor: "Alice" });
  const reader = open({ kind: "state", state: initial }, { actor: "Bob", sizeWarning: warning, sizeLimit: limit });
  t.after(() => { writer.close(); reader.close(); });

  const events: string[] = [];
  reader.subscribe(change => { if (change.kind === "size") events.push(change.state); });

  assert.equal(writer.commands.setField(beatField("A", "payload"), "p".repeat(600)).kind, "written");
  assert.equal(writer.commands.typeText(anchor(writer, 0, 0, narration("B")), "r".repeat(600), {}).kind, "written");
  Y.applyUpdate(reader.ydoc, writer.encodeState(), "peer");
  assert.equal(reader.size, "full");
  await Promise.resolve();
  assert.deepEqual(events, ["full"]);

  assert.equal(writer.commands.clearField(beatField("A", "payload")).kind, "written");
  Y.applyUpdate(reader.ydoc, writer.encodeState(), "peer");
  assert.equal(reader.size, "warning");
  await Promise.resolve();
  assert.deepEqual(events, ["full", "warning"]);

  assert.equal(writer.commands.removeRows(["B"]).kind, "written");
  Y.applyUpdate(reader.ydoc, writer.encodeState(), "peer");
  assert.equal(reader.size, "ok");
  await Promise.resolve();
  assert.deepEqual(events, ["full", "warning", "ok"]);
});
