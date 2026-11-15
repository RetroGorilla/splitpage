import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, encodeSharedStateVector, encodeSharedUpdate, observeSharedTransactions,
  readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { holdSharedBuffer, observeSharedIntakeStopped, sharedIntakeStopped } from "../../../src/adapters/collab/ingress.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { createSharedReplica } from "../../../src/adapters/collab/replica.ts";
import { collabState, TRIAL_DIVERGED } from "../../../src/adapters/collab/state.ts";
import type { SharedAdmissionCount } from "../../../src/adapters/collab/state.ts";
import { insertSharedHtml } from "../../../src/adapters/collab/text-import.ts";
import { collabTextTarget, createCollabText } from "../../../src/adapters/collab/text-target.ts";
import { openSharedTrialReplicas, SHARED_TRIAL_REBUILD_BUDGET, SharedTrialReplica, startSharedTrialReplica } from "../../../src/adapters/collab/trial-replica.ts";
import type { SharedApplyResult, SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { operation, ref } from "./executor-support.ts";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { recordReplicas } from "./record-support.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE = { title: "Title", rows: [{ id: "R1", audioText: "ab", status: "todo" }, { id: "R2", audioText: "cd", status: "todo" }] };
const WATCHED = ["beforeTransaction", "update", "afterAllTransactions"] as const;
const META = "meta" as unknown as Y.AbstractType<unknown>;

function scalar(id: string, record: string, value: number, by = "Alice") {
  return operation({ kind: "scalar", id, by, target: { scope: "beat", record }, field: "lengthSeconds", value });
}

function projectLengths(handle: SharedDocumentHandle): unknown[] {
  return projectSharedDocument(handle).rows.map(row => row["lengthSeconds"] ?? null);
}

function same(first: Uint8Array, second: Uint8Array): boolean {
  return first.byteLength === second.byteLength && first.every((value, index) => value === second[index]);
}

function trialOf(handle: SharedDocumentHandle): SharedTrialReplica {
  const trial = collabState(handle).trial;
  assert.ok(trial instanceof SharedTrialReplica);
  return trial;
}

function livePlusHeld(handle: SharedDocumentHandle): Uint8Array {
  const copy = createMonitoredSharedDocument();
  try {
    Y.applyUpdate(collabState(copy).doc, encodeSharedState(handle));
    for (const held of collabState(handle).ingress.held) Y.applyUpdate(collabState(copy).doc, held);
    return encodeSharedState(copy);
  } finally { destroySharedDocument(copy); }
}

function matches(handle: SharedDocumentHandle): boolean {
  return same(trialOf(handle).encode(), livePlusHeld(handle));
}

function observers(handle: SharedDocumentHandle): number[] {
  const doc = collabState(handle).doc as unknown as { _observers: Map<string, Set<unknown>> };
  return WATCHED.map(name => doc._observers.get(name)?.size ?? 0);
}

function counter() {
  const totals = new Map<string, [number, number]>();
  const count: SharedAdmissionCount = (work, key, bytes) => {
    const name = work + ":" + key, entry = totals.get(name) ?? [0, 0];
    totals.set(name, [entry[0] + 1, entry[1] + bytes]);
  };
  return {
    count,
    read: (): Record<string, [number, number]> => Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b))),
    calls: (name: string): number => totals.get(name)?.[0] ?? 0,
    bytes: (): number => [...totals.values()].reduce((sum, [, bytes]) => sum + bytes, 0),
    reset: () => { totals.clear(); }
  };
}

function crafted(client: number, items: readonly Y.Item[]): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  encoder.writeLen(1); encoder.writeLen(items.length); encoder.writeClient(client); encoder.writeLen(items[0]?.id.clock ?? 0);
  for (const item of items) item.write(encoder, 0);
  encoder.writeLen(0);
  return encoder.toUint8Array();
}

function metaItem(client: number, clock: number, key: string, value: number, origin: Y.ID | null = null): Y.Item {
  return new Y.Item(Y.createID(client, clock), null, origin, null, null, origin ? null : META, origin ? null : key, new Y.ContentAny([value]));
}

function throwingUpdate(): Uint8Array { return crafted(7, [metaItem(7, 0, "x", 1, Y.createID(7, 5))]); }

function partialUpdate(client = 7): Uint8Array {
  return crafted(client, [metaItem(client, 0, "prefix", 1),
    new Y.Item(Y.createID(client, 1), null, Y.createID(client, 2), null, null, META, "cycle", new Y.ContentAny([2])),
    new Y.Item(Y.createID(client, 2), null, Y.createID(client, 1), null, null, META, "cycle", new Y.ContentAny([3]))]);
}

function zeroLengthUpdate(): Uint8Array {
  return crafted(7, [new Y.Item(Y.createID(7, 0), null, null, null, null, META, "zero", new Y.ContentAny([]))]);
}

function validFrom(sender: SharedDocumentHandle, write: () => void): Uint8Array {
  const vector = encodeSharedStateVector(sender);
  write();
  return encodeSharedUpdate(sender, vector);
}

function senderOf(handle: SharedDocumentHandle, client: number): SharedDocumentHandle {
  const sender = createMonitoredSharedDocument();
  collabState(sender).doc.clientID = client;
  registerSharedRecordHandlers(sender);
  assert.deepEqual(applySharedUpdate(sender, encodeSharedState(handle)), { ok: true });
  return sender;
}

function scalarUpdate(sender: SharedDocumentHandle, id: string, value: number): Uint8Array {
  return validFrom(sender, () => { assert.deepEqual(executeSharedOperations(sender, [scalar(id, "R1", value, "Bob")], { base: readSharedRevision(sender) }), { ok: true }); });
}

function thrown(run: () => unknown): string {
  try { run(); } catch (error) { return error instanceof Error ? error.constructor.name : String(error); }
  return "nothing thrown";
}

function hydrated(client: number, source: Record<string, unknown> = SOURCE): SharedDocumentHandle {
  const handle = createMonitoredSharedDocument();
  collabState(handle).doc.clientID = client;
  registerSharedRecordHandlers(handle);
  hydrateSharedDocument(handle, validatedFixture(source));
  return handle;
}

test("trial replica routes: commands, undo and redo, text creation, HTML import, mark records, transactions, open remote updates and released held updates each reach the replica before the next trial", () => {
  const run = recordReplicas(2, SOURCE), counts = counter();
  try {
    const trial = startSharedTrialReplica(run.a, counts.count), state = collabState(run.a);
    const target = { segment: ref("b:R1"), owner: ref("R1"), field: "audioText" as const };
    let serial = 0;
    const undoer = { by: "Alice", nextId: () => "undo-" + String(++serial) };
    const seen: [string, boolean, number][] = [];
    const step = (label: string, write: () => void): void => {
      counts.reset();
      write();
      seen.push([label, same(trial.encode(), livePlusHeld(run.a)), counts.calls("apply:follow")]);
    };
    const sender = senderOf(run.a, 9);
    step("command", () => { assert.deepEqual(executeSharedOperations(run.a, [scalar("c1", "R1", 4)], { base: readSharedRevision(run.a) }), { ok: true }); });
    let record: ReturnType<typeof executeSharedCommand>["record"] = null;
    step("undoable command", () => {
      const execution = executeSharedCommand(run.a, [scalar("c2", "R2", 5)], { label: "length", selection: null, typing: null });
      assert.deepEqual(execution.result, { ok: true });
      record = execution.record;
    });
    assert.ok(record);
    let inverse: Parameters<typeof reverseSharedUndoRecord>[1] | null = null;
    step("undo", () => {
      assert.ok(record);
      const undone = reverseSharedUndoRecord(run.a, record, undoer);
      assert.ok(undone.ok && undone.effective);
      inverse = undone.inverse;
    });
    step("redo", () => {
      assert.ok(inverse);
      const redone = reverseSharedUndoRecord(run.a, inverse, undoer);
      assert.ok(redone.ok && redone.effective);
    });
    const box = new Y.Map<unknown>();
    transactSharedDocument(run.a, "local-command", () => { state.roots.meta.set("box", box); });
    step("text creation", () => { createCollabText(run.a, box); });
    step("HTML import", () => {
      const text = collabTextTarget(run.a, target)?.text;
      assert.ok(text);
      insertSharedHtml(run.a, target, text, "imported", [], "imported");
    });
    step("mark record", () => {
      const prepared = prepareSharedMarkRecord(run.a, target, "kept", 0, 1, { type: "add", mark: { kind: "tag", id: ref("z"), value: ref("t_1") } });
      assert.ok(prepared);
      assert.deepEqual(writeSharedMarkRecord(run.a, target, "kept", prepared), { ok: true });
    });
    step("transaction", () => { transactSharedDocument(run.a, "local-command", () => { state.roots.meta.set("local", true); }); });
    step("remote update, gate open", () => { assert.deepEqual(applySharedUpdate(run.a, scalarUpdate(sender, "r1", 8)), { ok: true }); });
    step("held update and local change during a buffer hold", () => {
      const release = holdSharedBuffer(run.a);
      assert.deepEqual(applySharedUpdate(run.a, scalarUpdate(sender, "r2", 9)), { ok: true });
      assert.equal(state.ingress.held.length, 1);
      assert.equal(matches(run.a), true);
      assert.deepEqual(executeSharedOperations(run.a, [scalar("c3", "R2", 6)], { base: readSharedRevision(run.a) }), { ok: true });
      assert.equal(matches(run.a), true);
      release();
      assert.equal(state.ingress.held.length, 0);
    });
    assert.deepEqual(seen, [
      ["command", true, 1], ["undoable command", true, 1], ["undo", true, 1], ["redo", true, 1], ["text creation", true, 1], ["HTML import", true, 1],
      ["mark record", true, 1], ["transaction", true, 1], ["remote update, gate open", true, 0], ["held update and local change during a buffer hold", true, 1]
    ]);
    destroySharedDocument(sender);
  } finally { run.close(); }
});

test("trial replica routes: hydration into a new shared document reaches the replica", () => {
  const handle = createMonitoredSharedDocument(), counts = counter();
  try {
    collabState(handle).doc.clientID = 1;
    const trial = startSharedTrialReplica(handle, counts.count);
    hydrateSharedDocument(handle, validatedFixture(SOURCE));
    assert.deepEqual([counts.calls("apply:follow"), counts.calls("encode:flush"), counts.calls("encode:rebuild")], [1, 0, 1]);
    assert.equal(same(trial.encode(), encodeSharedState(handle)), true);
  } finally { destroySharedDocument(handle); }
});

test("trial replica routes: an arrival inside a local transaction's notification is tried against that transaction's change", () => {
  const handle = hydrated(1), counts = counter();
  try {
    startSharedTrialReplica(handle, counts.count);
    const state = collabState(handle), results: unknown[] = [];
    const before = Y.decodeStateVector(encodeSharedStateVector(handle)).get(1) ?? 0;
    const stop = observeSharedTransactions(handle, origin => {
      if (origin !== "local-command" || results.length) return;
      results.push(applySharedUpdate(handle, crafted(7, [metaItem(7, 0, "", 1, Y.createID(1, before)),
        new Y.Item(Y.createID(7, 1), null, Y.createID(7, 2), null, null, META, "cycle", new Y.ContentAny([2])),
        new Y.Item(Y.createID(7, 2), null, Y.createID(7, 1), null, null, META, "cycle", new Y.ContentAny([3]))])));
    });
    counts.reset();
    transactSharedDocument(handle, "local-command", () => { state.roots.meta.set("local", true); });
    stop();
    assert.deepEqual(results, [{ ok: false, reason: "invalid-update" }]);
    assert.deepEqual([counts.calls("encode:flush"), counts.calls("apply:trial")], [1, 1]);
    assert.equal(state.roots.meta.get("cycle"), undefined);
    assert.equal(matches(handle), true);
  } finally { destroySharedDocument(handle); }
});

test("trial replica write inventory: every library write under the shared adapter is listed with how it reaches the replica", () => {
  const writes = /\b(transactCollabState|transactSharedDocument|runCollabTransaction|Y\.transact|Y\.applyUpdate|Y\.applyUpdateV2)\(|\.transact\(/g;
  const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(path, entry.name)) : entry.name.endsWith(".ts") ? [join(path, entry.name)] : []);
  const found: Record<string, number> = {};
  for (const file of files(join(REPO, "src/adapters/collab"))) {
    const name = relative(REPO, file).replaceAll("\\", "/"), hits = readFileSync(file, "utf8").match(writes)?.length ?? 0;
    if (hits) found[name] = hits;
  }
  const routes: Record<string, [number, string]> = {
    "src/adapters/collab/document.ts": [5, "transactSharedDocument definition; copy trial outside a session; open remote apply after the trial"],
    "src/adapters/collab/execute.ts": [1, "commands, buffer commits and recovery commands: live update event"],
    "src/adapters/collab/hydrate.ts": [1, "hydration: live update event"],
    "src/adapters/collab/incremental-project.ts": [4, "the projector's own mirror and normalized copy, not the live document"],
    "src/adapters/collab/mark-store.ts": [1, "mark records: live update event"],
    "src/adapters/collab/snapshot.ts": [1, "a read copy, not the live document"],
    "src/adapters/collab/state.ts": [6, "the write frame, held updates released after their trial, and the transaction helper"],
    "src/adapters/collab/text-edit.ts": [1, "native text edits inside an adapter transaction: live update event"],
    "src/adapters/collab/text-target.ts": [1, "text creation: live update event"],
    "src/adapters/collab/trial-replica.ts": [5, "the replica itself: rebuild, follow, flush and trial"]
  };
  assert.deepEqual(found, Object.fromEntries(Object.entries(routes).map(([file, [count]]) => [file, count])),
    "A write route changed: list it here and show by test how it reaches the trial replica");
});

test("a refused update that throws while applying leaves live untouched, marks the replica for one rebuild, and the rebuilt replica equals live plus held", () => {
  const handle = hydrated(1), counts = counter();
  try {
    const trial = startSharedTrialReplica(handle, counts.count), sender = senderOf(handle, 2);
    const release = holdSharedBuffer(handle);
    assert.deepEqual(applySharedUpdate(handle, scalarUpdate(sender, "h1", 3)), { ok: true });
    const live = encodeSharedState(handle);
    counts.reset();
    assert.deepEqual(applySharedUpdate(handle, throwingUpdate()), { ok: false, reason: "invalid-update" });
    assert.equal(same(encodeSharedState(handle), live), true);
    assert.deepEqual([counts.calls("encode:rebuild"), counts.calls("apply:rebuild"), trial.stale, trial.spent], [1, 2, false, 1]);
    assert.equal(matches(handle), true);
    assert.equal(counts.calls("encode:rebuild"), 1);
    release();
    assert.equal(matches(handle), true);
    destroySharedDocument(sender);
  } finally { destroySharedDocument(handle); }
});

test("a refused update with a zero-length struct never reaches the replica: no rebuild and the replica is unchanged", () => {
  const handle = hydrated(1), counts = counter();
  try {
    const trial = startSharedTrialReplica(handle, counts.count), before = trial.encode();
    counts.reset();
    assert.deepEqual(applySharedUpdate(handle, zeroLengthUpdate()), { ok: false, reason: "invalid-update" });
    assert.deepEqual([trial.stale, trial.spent, counts.read()], [false, 0, {}]);
    assert.equal(same(trial.encode(), before), true);
    assert.equal(matches(handle), true);
  } finally { destroySharedDocument(handle); }
});

test("a refused update that applies partly before failing leaves its prefix only in the replica, which is rebuilt at once to equal live", () => {
  const handle = hydrated(1), counts = counter(), seen: unknown[] = [];
  let trial: SharedTrialReplica | null = null;
  try {
    trial = startSharedTrialReplica(handle, (work, key, bytes) => {
      if (work === "encode" && key === "rebuild" && trial) seen.push(trial.replica.getMap("meta").get("prefix"));
      counts.count(work, key, bytes);
    });
    const live = encodeSharedState(handle);
    counts.reset();
    assert.deepEqual(applySharedUpdate(handle, partialUpdate()), { ok: false, reason: "invalid-update" });
    assert.deepEqual([seen, collabState(handle).roots.meta.get("prefix"), trial.replica.getMap("meta").get("prefix"), trial.stale, trial.spent],
      [[1], undefined, undefined, false, 1]);
    assert.equal(same(encodeSharedState(handle), live), true);
    assert.equal(same(trial.encode(), live), true);
    assert.equal(counts.calls("encode:rebuild"), 1);
  } finally { destroySharedDocument(handle); }
});

test("an update refused because the buffer queue is full never reaches the replica", () => {
  const handle = hydrated(1), counts = counter();
  try {
    const trial = startSharedTrialReplica(handle, counts.count), sender = senderOf(handle, 2);
    const large = validFrom(sender, () => { transactSharedDocument(sender, "local-command", () => { collabState(sender).roots.meta.set("large", "x".repeat(70000)); }); });
    const release = holdSharedBuffer(handle), before = trial.encode();
    counts.reset();
    assert.deepEqual(applySharedUpdate(handle, large), { ok: false, reason: "queue-full" });
    assert.deepEqual([trial.stale, trial.spent, counts.read(), collabState(handle).ingress.held.length], [false, 0, {}, 0]);
    assert.equal(same(trial.encode(), before), true);
    release();
    assert.equal(matches(handle), true);
    destroySharedDocument(sender);
  } finally { destroySharedDocument(handle); }
});

test("rule 210: an update that depends on a held update is tried against it, so one that fails once the held update is present is refused at receipt", () => {
  const base = crafted(8, [metaItem(8, 0, "base", 1)]);
  const dependent = crafted(7, [metaItem(7, 0, "", 1, Y.createID(8, 0)),
    new Y.Item(Y.createID(7, 1), null, Y.createID(7, 2), null, null, META, "cycle", new Y.ContentAny([2])),
    new Y.Item(Y.createID(7, 2), null, Y.createID(7, 1), null, null, META, "cycle", new Y.ContentAny([3]))]);
  const outcomes: unknown[] = [];
  for (const standing of [false, true]) {
    const handle = createMonitoredSharedDocument();
    try {
      if (standing) startSharedTrialReplica(handle);
      const release = holdSharedBuffer(handle);
      const results = [applySharedUpdate(handle, base), applySharedUpdate(handle, dependent)];
      const failure = thrown(release);
      outcomes.push([standing ? "standing replica" : "copy of live alone", results, failure, collabState(handle).roots.meta.toJSON(),
        [...Y.decodeStateVector(encodeSharedStateVector(handle))].sort()]);
    } finally { destroySharedDocument(handle); }
  }
  assert.deepEqual(outcomes, [
    ["copy of live alone", [{ ok: true }, { ok: true }], "TypeError", { base: 1 }, [[7, 1], [8, 1]]],
    ["standing replica", [{ ok: true }, { ok: false, reason: "invalid-update" }], "nothing thrown", { base: 1 }, [[8, 1]]]
  ]);
});

test("a live write that fails after its trial passed, gate open: the error reaches the caller as before and the replica is rebuilt from live", () => {
  const handle = hydrated(1), counts = counter();
  try {
    const trial = startSharedTrialReplica(handle, counts.count);
    Y.applyUpdate(trial.replica, crafted(7, [metaItem(7, 0, "a", 1), metaItem(7, 1, "b", 2), metaItem(7, 2, "c", 3)]));
    counts.reset();
    assert.equal(thrown(() => applySharedUpdate(handle, partialUpdate())), "TypeError");
    assert.deepEqual([collabState(handle).roots.meta.get("prefix"), trial.stale], [1, true]);
    assert.equal(matches(handle), true);
    assert.deepEqual([counts.calls("apply:trial"), counts.calls("encode:rebuild"), trial.stale, trial.spent], [1, 1, false, 0]);
    assert.equal(same(trial.encode(), encodeSharedState(handle)), true);
  } finally { destroySharedDocument(handle); }
});

test("a live write that fails after its trial passed, held update: the drain reports it, applies the rest, and the replica is rebuilt from live", () => {
  const handle = hydrated(1), counts = counter();
  try {
    const trial = startSharedTrialReplica(handle, counts.count), sender = senderOf(handle, 2);
    Y.applyUpdate(trial.replica, crafted(7, [metaItem(7, 0, "a", 1), metaItem(7, 1, "b", 2), metaItem(7, 2, "c", 3)]));
    const release = holdSharedBuffer(handle);
    assert.deepEqual([applySharedUpdate(handle, partialUpdate()), applySharedUpdate(handle, scalarUpdate(sender, "after", 6))], [{ ok: true }, { ok: true }]);
    assert.equal(thrown(release), "TypeError");
    assert.deepEqual([collabState(handle).ingress.held.length, collabState(handle).roots.meta.get("prefix"), trial.stale], [0, 1, true]);
    counts.reset();
    assert.equal(same(trial.encode(), encodeSharedState(handle)), true);
    assert.deepEqual([counts.calls("encode:rebuild"), trial.stale, trial.spent], [1, false, 0]);
    destroySharedDocument(sender);
  } finally { destroySharedDocument(handle); }
});

test("when a hold ends with live behind the replica, the releasing write reports the divergence and the replica is rebuilt", () => {
  const handle = hydrated(1);
  try {
    const trial = startSharedTrialReplica(handle), sender = senderOf(handle, 2);
    const release = holdSharedBuffer(handle);
    assert.deepEqual(applySharedUpdate(handle, scalarUpdate(sender, "held", 6)), { ok: true });
    Y.applyUpdate(trial.replica, crafted(7, [metaItem(7, 0, "ahead", 1)]));
    let message = "";
    try { release(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    assert.deepEqual([message, trial.stale], [TRIAL_DIVERGED, true]);
    assert.equal(same(trial.encode(), encodeSharedState(handle)), true);
    assert.equal(trial.spent, 0);
    destroySharedDocument(sender);
  } finally { destroySharedDocument(handle); }
});

function reasons(results: readonly { readonly ok: boolean; readonly reason?: string }[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const result of results) { const name = result.ok ? "ok" : result.reason ?? "?"; totals[name] = (totals[name] ?? 0) + 1; }
  return totals;
}

test("the rebuild budget is 3 per replica: 1,000 refused updates in a row cost exactly 3 rebuilds of one live copy each, then intake stops and costs nothing", () => {
  const handle = hydrated(1), counts = counter();
  try {
    const trial = startSharedTrialReplica(handle, counts.count), sender = senderOf(handle, 2), size = encodeSharedState(handle).byteLength;
    const open = openSharedTrialReplicas(), live = encodeSharedState(handle);
    let heard = 0;
    observeSharedIntakeStopped(handle, () => { heard++; });
    assert.equal(SHARED_TRIAL_REBUILD_BUDGET, 3);
    counts.reset();
    const results = Array.from({ length: 1000 }, () => applySharedUpdate(handle, throwingUpdate()));
    assert.deepEqual(results.slice(0, 4), [{ ok: false, reason: "invalid-update" }, { ok: false, reason: "invalid-update" }, { ok: false, reason: "invalid-update" },
      { ok: false, reason: "intake-stopped" }]);
    assert.deepEqual(reasons(results), { "invalid-update": 3, "intake-stopped": 997 });
    assert.deepEqual([counts.read()["encode:rebuild"], counts.calls("apply:trial"), trial.spent, heard, sharedIntakeStopped(handle)], [[3, 3 * size], 3, 3, 1, true]);
    counts.reset();
    assert.deepEqual(applySharedUpdate(handle, scalarUpdate(sender, "after", 2), counts.count), { ok: false, reason: "intake-stopped" });
    assert.deepEqual([counts.read(), counts.bytes(), heard], [{}, 0, 1]);
    assert.equal(same(encodeSharedState(handle), live), true);
    assert.deepEqual([openSharedTrialReplicas() - open, collabState(handle).ingress.held.length, collabState(handle).ingress.heldBytes, trial.stale], [0, 0, 0, false]);
    assert.equal(matches(handle), true);
    destroySharedDocument(sender);
  } finally { destroySharedDocument(handle); }
});

test("refusals that never reach the replica spend no rebuild: 1,000 zero-length updates and 1,000 undecodable ones leave the budget whole", () => {
  const handle = hydrated(1), counts = counter();
  try {
    const trial = startSharedTrialReplica(handle, counts.count);
    counts.reset();
    for (let index = 0; index < 1000; index++) {
      assert.deepEqual(applySharedUpdate(handle, zeroLengthUpdate()), { ok: false, reason: "invalid-update" });
      assert.deepEqual(applySharedUpdate(handle, Uint8Array.of(255)), { ok: false, reason: "invalid-update" });
    }
    assert.deepEqual([counts.read(), trial.spent, sharedIntakeStopped(handle)], [{}, 0, false]);
  } finally { destroySharedDocument(handle); }
});

test("1,000 refused updates interleaved with 1,000 valid ones cost exactly 3 rebuilds: valid updates before the stop land, later ones are refused and live stays as it was", () => {
  const handle = hydrated(1), counts = counter();
  try {
    const trial = startSharedTrialReplica(handle, counts.count), sender = senderOf(handle, 2);
    counts.reset();
    const bad: SharedApplyResult[] = [], good: SharedApplyResult[] = [];
    let atStop: Uint8Array | null = null;
    for (let index = 0; index < 1000; index++) {
      bad.push(applySharedUpdate(handle, index % 2 ? partialUpdate() : throwingUpdate()));
      if (!atStop && sharedIntakeStopped(handle)) { atStop = encodeSharedState(handle); counts.reset(); }
      good.push(applySharedUpdate(handle, scalarUpdate(sender, "v" + String(index), index + 1)));
    }
    assert.deepEqual([reasons(bad), reasons(good)], [{ "invalid-update": 3, "intake-stopped": 997 }, { ok: 2, "intake-stopped": 998 }]);
    assert.ok(atStop);
    assert.deepEqual([counts.read(), trial.spent], [{}, 3]);
    assert.equal(same(encodeSharedState(handle), atStop), true);
    assert.deepEqual(projectLengths(handle), [2, null]);
    assert.equal(matches(handle), true);
    assert.equal(collabState(handle).roots.meta.get("prefix"), undefined);
    destroySharedDocument(sender);
  } finally { destroySharedDocument(handle); }
});

test("after intake stops, local commands and undo go on, the replica follows them, held updates already accepted are released, and a new replica starts open", () => {
  const handle = hydrated(1);
  try {
    const trial = startSharedTrialReplica(handle), sender = senderOf(handle, 2);
    const release = holdSharedBuffer(handle);
    assert.deepEqual(applySharedUpdate(handle, scalarUpdate(sender, "held", 5)), { ok: true });
    for (let index = 0; index < 3; index++) assert.deepEqual(applySharedUpdate(handle, throwingUpdate()), { ok: false, reason: "invalid-update" });
    assert.deepEqual([sharedIntakeStopped(handle), collabState(handle).ingress.held.length], [true, 1]);
    assert.deepEqual(executeSharedOperations(handle, [scalar("local", "R2", 8)], { base: readSharedRevision(handle) }), { ok: true });
    const execution = executeSharedCommand(handle, [scalar("undoable", "R2", 9)], { label: "length", selection: null, typing: null });
    assert.ok(execution.record);
    assert.ok(reverseSharedUndoRecord(handle, execution.record, { by: "Alice", nextId: () => "undo-1" }).ok);
    assert.equal(matches(handle), true);
    release();
    assert.deepEqual([projectLengths(handle), collabState(handle).ingress.held.length], [[5, 8], 0]);
    assert.equal(matches(handle), true);
    trial.dispose();
    assert.equal(sharedIntakeStopped(handle), false);
    const fresh = startSharedTrialReplica(handle);
    assert.deepEqual([fresh.spent, sharedIntakeStopped(handle)], [0, false]);
    assert.deepEqual(applySharedUpdate(handle, scalarUpdate(sender, "again", 6)), { ok: true });
    destroySharedDocument(sender);
  } finally { destroySharedDocument(handle); }
});

test("disposing the trial replica removes its three live observers and its document, and a new start is a fresh replica", () => {
  const handle = hydrated(1);
  try {
    const open = openSharedTrialReplicas(), idle = observers(handle);
    const first = startSharedTrialReplica(handle);
    assert.deepEqual([observers(handle).map((value, index) => value - (idle[index] ?? 0)), openSharedTrialReplicas() - open], [[1, 1, 1], 1]);
    assert.equal(thrown(() => startSharedTrialReplica(handle)), "Error");
    const replica = first.replica;
    first.dispose(); first.dispose();
    assert.deepEqual([observers(handle), openSharedTrialReplicas() - open, collabState(handle).trial, replica.isDestroyed], [idle, 0, null, true]);
    assert.equal(thrown(() => first.encode()), "Error");
    const second = startSharedTrialReplica(handle);
    assert.notEqual(second, first);
    assert.equal(matches(handle), true);
    second.dispose();
  } finally { destroySharedDocument(handle); }
});

test("destroying a shared document during a hold releases its trial replica, its observers and its held updates", () => {
  const handle = hydrated(1), sender = senderOf(handle, 2);
  const open = openSharedTrialReplicas(), idle = observers(handle);
  const trial = startSharedTrialReplica(handle);
  holdSharedBuffer(handle);
  assert.deepEqual(applySharedUpdate(handle, scalarUpdate(sender, "held", 4)), { ok: true });
  assert.deepEqual(observers(handle).map((value, index) => value - (idle[index] ?? 0)), [1, 1, 1]);
  destroySharedDocument(handle);
  assert.deepEqual([observers(handle), openSharedTrialReplicas() - open, collabState(handle).trial, trial.replica.isDestroyed, collabState(handle).ingress.held.length],
    [[0, 0, 0], 0, null, true, 0]);
  destroySharedDocument(sender);
});

test("replica ports on one document share its one trial replica, and the last port's dispose releases it", () => {
  const handle = hydrated(1);
  try {
    const open = openSharedTrialReplicas(), idle = observers(handle);
    const first = createSharedReplica(handle), trial = trialOf(handle);
    const second = createSharedReplica(handle);
    assert.deepEqual([openSharedTrialReplicas() - open, trialOf(handle) === trial], [1, true]);
    first.dispose(); first.dispose();
    assert.deepEqual([openSharedTrialReplicas() - open, trialOf(handle) === trial, trial.replica.isDestroyed], [1, true, false]);
    second.dispose();
    assert.deepEqual([observers(handle), openSharedTrialReplicas() - open, collabState(handle).trial, trial.replica.isDestroyed], [idle, 0, null, true]);
  } finally { destroySharedDocument(handle); }
});

test("outside a shared session nothing starts a trial replica: received updates keep the copy trial and the document gains no observer", () => {
  const handle = hydrated(1), counts = counter(), open = openSharedTrialReplicas(), idle = observers(handle);
  try {
    const sender = senderOf(handle, 2);
    assert.deepEqual(applySharedUpdate(handle, scalarUpdate(sender, "plain", 4), counts.count), { ok: true });
    assert.deepEqual([collabState(handle).trial, openSharedTrialReplicas() - open, observers(handle)], [null, 0, idle]);
    assert.deepEqual(Object.keys(counts.read()), ["apply:copy", "apply:live", "apply:trial", "encode:copy"]);
    const callers = (name: string): string[] => {
      const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? files(join(path, entry.name)) : /\.(ts|mjs|js)$/.test(entry.name) ? [join(path, entry.name)] : []);
      return files(join(REPO, "src")).filter(file => new RegExp(`\\b${name}\\(`).test(readFileSync(file, "utf8"))
        && !readFileSync(file, "utf8").includes(`export function ${name}(`)).map(file => relative(REPO, file).replaceAll("\\", "/")).sort();
    };
    assert.deepEqual(callers("startSharedTrialReplica"), []);
    assert.deepEqual(callers("acquireSharedTrialReplica"), ["src/adapters/collab/replica.ts"]);
    assert.deepEqual(callers("createSharedReplica"), ["src/bootstrap/wiring/shared-session.ts", "src/bootstrap/wiring/shared-test-peer.ts"]);
    destroySharedDocument(sender);
  } finally { destroySharedDocument(handle); }
});

function largeSource(): Record<string, unknown> {
  return { title: "Large", rows: Array.from({ length: 300 }, (_, index) => ({ id: "R" + String(index + 1), audioText: "line " + String(index) + " " + "w".repeat(60), status: "todo" })) };
}

test("counted cost per received update: the copy trial encodes and applies the whole document, the standing replica only the update", () => {
  const rows: unknown[] = [];
  for (const [label, source] of [["small", SOURCE], ["large", largeSource()]] as const) {
    for (const method of ["copy", "replica"] as const) {
      const handle = hydrated(1, source), counts = counter();
      try {
        if (method === "replica") startSharedTrialReplica(handle, counts.count);
        const sender = senderOf(handle, 2), update = scalarUpdate(sender, "cost", 7);
        counts.reset();
        assert.deepEqual(applySharedUpdate(handle, update, counts.count), { ok: true });
        rows.push([label, method, encodeSharedState(handle).byteLength, update.byteLength, counts.read(), counts.bytes()]);
        destroySharedDocument(sender);
      } finally { destroySharedDocument(handle); }
    }
  }
  assert.deepEqual(rows, [
    ["small", "copy", 967, 26, { "apply:copy": [1, 943], "apply:live": [1, 26], "apply:trial": [1, 26], "encode:copy": [1, 943] }, 1938],
    ["small", "replica", 967, 26, { "apply:live": [1, 26], "apply:trial": [1, 26] }, 52],
    ["large", "copy", 143438, 26, { "apply:copy": [1, 143414], "apply:live": [1, 26], "apply:trial": [1, 26], "encode:copy": [1, 143414] }, 286880],
    ["large", "replica", 143438, 26, { "apply:live": [1, 26], "apply:trial": [1, 26] }, 52]
  ]);
});
