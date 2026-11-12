import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { createMonitoredNativeDocument, createMonitoredSharedDocument } from "./helpers.ts";
import { readSharedIdentityEmbeds } from "../../../src/adapters/collab/identity-structs.ts";
import { observeSharedStructureIdentities } from "../../../src/adapters/collab/structure-reservations.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument, applySharedUpdate, encodeSharedState, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { replicas, agree } from "./executor-support.ts";

test("Yjs 13.6.33 removed-embed contract guards the struct representation and observer-before-GC order", () => {
  const message = "Yjs 13.6.33 removed-embed observer contract changed; review the guarded representation";
  const installed = JSON.parse(readFileSync(new URL("../../../node_modules/yjs/package.json", import.meta.url), "utf8")) as { version: unknown };
  assert.equal(installed.version, "13.6.33", message);
  const doc = createMonitoredNativeDocument(); doc.clientID = 1;
  try {
    const text = doc.getText("text"), captured: { transaction: Y.Transaction | null; removed: Y.Item | null } = { transaction: null, removed: null };
    const observed: unknown[] = [];
    doc.on("beforeObserverCalls", transaction => {
      captured.transaction = transaction;
      const changes = readSharedIdentityEmbeds(transaction);
      for (const change of changes) { assert.equal(change.text, text, message); if (change.delta === -1) assert.ok(captured.removed?.content instanceof Y.ContentEmbed, message); }
      observed.push(changes.map(change => ({ value: change.value, identity: change.identity, delta: change.delta })));
    });
    doc.transact(() => { text.insert(0, "ab"); });
    doc.transact(() => { text.delete(0, 1); });
    doc.transact(() => { text.insertEmbed(0, { k: "A" }); });
    captured.removed = text._start; while (captured.removed?.deleted) captured.removed = captured.removed.right;
    assert.ok(captured.removed instanceof Y.Item && captured.removed.content instanceof Y.ContentEmbed, message);
    doc.transact(() => { text.delete(0, 1); });
    assert.deepEqual(observed, [[], [], [{ value: { k: "A" }, identity: { client: 1, clock: 2 }, delta: 1 }],
      [{ value: { k: "A" }, identity: { client: 1, clock: 2 }, delta: -1 }]], message);
    assert.ok(captured.removed.content instanceof Y.ContentDeleted, message); assert.ok(captured.transaction, message);
    assert.deepEqual(readSharedIdentityEmbeds(captured.transaction), [], message);
  } finally { doc.destroy(); }
});

test("split structs, GC, duplicate embeds and native container changes retain encoded-fresh reservation agreement", t => {
  let checkpoints = 0, comparisons = 0, lateComparisons = 0;
  for (const order of ["D1", "dup", "rev"] as const) {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd", visualText: "uv" }] }), subdoc = createMonitoredNativeDocument();
    try {
      const roots = collabState(set.a).roots, audio = (roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
      const visual = (roots.visuals.get("R1") as Y.Map<unknown>).get("text") as Y.Text;
      for (const handle of [set.a, set.b]) observeSharedStructureIdentities(handle);
      const read = (handle: typeof set.a) => ["A", "B"].map(id => observeSharedStructureIdentities(handle).has(id));
      const fresh = () => {
        for (const handle of [set.a, set.b]) {
          const copy = createMonitoredSharedDocument();
          try { assert.ok(applySharedUpdate(copy, encodeSharedState(handle)).ok); assert.deepEqual(read(handle), read(copy)); comparisons++; }
          finally { destroySharedDocument(copy); }
        }
      };
      const checkpoint = (expected: readonly boolean[]) => { fresh(); set.queue.flush(order); fresh(); agree("native embed edge checkpoint " + checkpoints, order, [set.a, set.b], handle => {
        if (handle !== set.a && handle !== set.b) lateComparisons++; return read(handle);
      }, [...expected]); checkpoints++; };
      const edit = (change: () => void, expected: readonly boolean[]) => { transactSharedDocument(set.a, "local-command", change); checkpoint(expected); };
      const container = (key: string) => {
        const value = new Y.Map<unknown>(), text = new Y.Text(); text.insertEmbed(0, { k: "B" }); value.set("text", text); roots.segments.set(key, value);
      };
      checkpoint([false, false]);
      edit(() => { audio.insertEmbed(2, { k: "A" }); }, [true, false]);
      edit(() => { audio.delete(2, 1); audio.insertEmbed(1, { k: "B" }); }, [false, true]);
      edit(() => { audio.insertEmbed(0, { k: "A" }); }, [true, true]);
      edit(() => { audio.insertEmbed(0, { k: "A" }); }, [true, true]);
      edit(() => { audio.delete(0, 1); }, [true, true]);
      edit(() => { audio.delete(0, 1); }, [false, true]);
      edit(() => { audio.insertEmbed(0, { k: "A" }); audio.delete(0, 1); }, [false, true]);
      edit(() => { audio.insertEmbed(0, { k: "A" }); visual.insertEmbed(0, { k: "B" }); }, [true, true]);
      edit(() => { audio.delete(2, 1); }, [true, true]);
      edit(() => { visual.delete(0, 1); }, [true, false]);
      edit(() => { container("prefilled"); }, [true, true]);
      edit(() => { roots.segments.delete("prefilled"); }, [true, false]);
      transactSharedDocument(set.a, "local-command", () => { container("collected"); roots.segments.delete("collected"); audio.insert(0, "X"); });
      assert.ok(set.queue.pending.some(message => Y.decodeUpdate(message.update).structs.some(struct => struct instanceof Y.GC)), "Yjs 13.6.33 GC fixture did not deliver a collected struct");
      checkpoint([true, false]);
      edit(() => { roots.people.set("subdoc", new Y.Map([["child", subdoc]])); audio.insert(0, "X"); }, [true, false]);
      edit(() => { (roots.segments.get("b:R1") as Y.Map<unknown>).set("text", new Y.Text("empty")); }, [false, false]);
    } finally { set.close(); subdoc.destroy(); }
  }
  assert.deepEqual({ checkpoints, comparisons, lateComparisons }, { checkpoints: 48, comparisons: 192, lateComparisons: 48 });
  t.diagnostic(JSON.stringify({ checkpoints, comparisons, lateComparisons, cases: ["split struct", "mixed add/delete", "reinsertion", "duplicate embeds", "create/delete in one transaction", "several texts", "prefilled container", "GC", "subdocument", "text replacement"] }));
});
