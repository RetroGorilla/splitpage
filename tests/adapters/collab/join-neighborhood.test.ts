import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree } from "./executor-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { observeSharedStructureIndex } from "../../../src/adapters/collab/structure-index.ts";
import { transactSharedDocument, encodeSharedState, applySharedUpdate, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { trapSharedCollectionWalks } from "./collection-guards.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const source = { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "b" }, { id: "R3", audioText: "c" }, { id: "R4", audioText: "d" }] };
const ids = ["R1", "R2", "R3", "R4", "missing"];
function joins(handle: SharedDocumentHandle, id: string): Y.Map<unknown> {
  const beat = collabState(handle).roots.beats.get(id); assert.ok(beat instanceof Y.Map);
  const joins = beat.get("joins"); assert.ok(joins instanceof Y.Map); return joins;
}
function reading(handle: SharedDocumentHandle) {
  const index = observeSharedStructureIndex(handle).joins();
  return ids.map(id => [id, index.neighbors(id)]);
}

test("join neighborhoods retain duplicate edges and patch retargets, nested-map replacement and beat deletion", () => {
  const set = replicas(2, source), index = observeSharedStructureIndex(set.a).joins();
  try {
    transactSharedDocument(set.a, "hydration", () => {
      joins(set.a, "R2").set("j0", { into: "R1", glue: " " }); joins(set.a, "R2").set("j1", { into: "R1", glue: "" });
      joins(set.a, "R3").set("j0", { into: "R2", glue: " " }); joins(set.a, "R4").set("self", { into: "R4", glue: "" });
    });
    assert.deepEqual(index.neighbors("R1"), ["R2"]); assert.deepEqual(index.neighbors("R2"), ["R1", "R3"]); assert.deepEqual(index.neighbors("R4"), []);
    transactSharedDocument(set.a, "hydration", () => joins(set.a, "R2").delete("j0")); assert.deepEqual(index.neighbors("R1"), ["R2"]);
    transactSharedDocument(set.a, "hydration", () => joins(set.a, "R2").set("j1", { into: "R4", glue: "" }));
    assert.deepEqual(index.neighbors("R1"), []); assert.deepEqual(index.neighbors("R2"), ["R3", "R4"]);
    transactSharedDocument(set.a, "hydration", () => {
      const beat = collabState(set.a).roots.beats.get("R2"); assert.ok(beat instanceof Y.Map);
      beat.set("joins", new Y.Map([["j2", { into: "missing", glue: " " }]]));
    });
    assert.deepEqual(index.neighbors("R2"), ["R3", "missing"]); assert.deepEqual(index.neighbors("R4"), []);
    transactSharedDocument(set.a, "hydration", () => collabState(set.a).roots.beats.delete("R2"));
    assert.deepEqual(index.neighbors("R2"), ["R3"]); assert.deepEqual(index.neighbors("missing"), []);
    set.queue.flush("dup"); agree("join neighborhood patches", "dup", [set.a, set.b], reading,
      [["R1", []], ["R2", ["R3"]], ["R3", ["R2"]], ["R4", []], ["missing", []]]);
  } finally { set.close(); }
});

test("join neighborhoods use the join validator while native identity reservations retain malformed keys", () => {
  const set = replicas(2, source), index = observeSharedStructureIndex(set.a).joins();
  try {
    for (const raw of [null, [], { into: "R1", glue: "x" }, { into: "", glue: " " }, { into: "R1", glue: " ", generation: -1 }, new Y.Text("hidden")]) {
      transactSharedDocument(set.a, "hydration", () => joins(set.a, "R2").set("bad", raw));
      assert.deepEqual(index.locations("bad"), ["R2"]); assert.deepEqual(index.neighbors("R1"), []);
    }
    transactSharedDocument(set.a, "hydration", () => {
      joins(set.a, "R2").set("", { into: "R1", glue: " " });
      const invalid = new Y.Map<unknown>(); invalid.set("joins", new Y.Map([["unstable", { into: "R1", glue: " " }]]));
      collabState(set.a).roots.beats.set("\ufffd", invalid);
      joins(set.a, "R2").set("valid", { into: "R1", glue: " ", generation: Number.MAX_SAFE_INTEGER });
    });
    assert.deepEqual(index.locations(""), ["R2"]); assert.deepEqual(index.neighbors("R1"), ["R2"]);
    set.queue.flush("rev"); agree("invalid neighborhood entries", "rev", [set.a, set.b], reading,
      [["R1", ["R2"]], ["R2", ["R1"]], ["R3", []], ["R4", []], ["missing", []]]);
  } finally { set.close(); }
});

test("join neighborhood lookups read no native collection with zero or many unrelated beats", t => {
  const counts: number[] = [];
  for (const unrelated of [0, 10000]) {
    const set = replicas(2, source);
    try {
      const roots = collabState(set.a).roots;
      transactSharedDocument(set.a, "hydration", () => {
        for (let index = 0; index < unrelated; index++) { roots.beats.set("unrelated" + index, {}); roots.order.push(["unrelated" + index]); }
        joins(set.a, "R2").set("join", { into: "R1", glue: " " });
      });
      const index = observeSharedStructureIndex(set.a).joins(), restore = trapSharedCollectionWalks(roots.beats, roots.segments, roots.headings, roots.order);
      const get = mock.method(roots.beats, "get", () => { throw new Error("Neighborhood reread a native beat"); });
      try { assert.deepEqual(index.neighbors("R1"), ["R2"]); assert.deepEqual(index.neighbors("R2"), ["R1"]); counts.push(get.mock.callCount()); }
      finally { get.mock.restore(); restore(); }
    } finally { set.close(); }
  }
  assert.deepEqual(counts, [0, 0]); t.diagnostic(JSON.stringify({ unrelated: [0, 10000], nativeReads: counts, collectionWalks: 0 }));
});

test("seeded join neighborhood checkpoints equal fresh encoded indexes across several writers", t => {
  const declaredLimits: readonly string[] = [], violations = new Set<string>();
  let random = 0x5c629, histories = 0, changes = 0, checkpoints = 0, comparisons = 0;
  const pick = (limit: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 16) % limit; };
  for (let sample = 0; sample < 6; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
    const checkpoint = () => {
      checkpoints++;
      for (const handle of handles) {
        const fresh = createMonitoredSharedDocument();
        try {
          assert.ok(applySharedUpdate(fresh, encodeSharedState(handle)).ok);
          const index = observeSharedStructureIndex(handle).joins(), rebuilt = observeSharedStructureIndex(fresh).joins();
          const read = (value: typeof index) => ({ neighbors: ids.map(id => value.neighbors(id)), locations: ["j0", "j1", "j2"].map(id => value.locations(id)) });
          assertReplicasAgree("join neighborhood checkpoint", [{ order, replica: "A", output: read(index) }, { order: "late-C", replica: "C", output: read(rebuilt) }]);
          comparisons++;
        } catch (error) { violations.add("join neighborhood differs from a fresh encoded index"); t.diagnostic(String(error)); }
        finally { destroySharedDocument(fresh); }
      }
    };
    try {
      handles.forEach(handle => observeSharedStructureIndex(handle).joins());
      for (let step = 0; step < 18; step++) {
        const handle = handles[pick(copies)], id = ids[pick(4)]; assert.ok(handle && id);
        transactSharedDocument(handle, "hydration", () => {
          const root = collabState(handle).roots.beats;
          if (step % 4 === 3) { root.delete(id); return; }
          let beat = root.get(id);
          if (!(beat instanceof Y.Map)) { beat = new Y.Map<unknown>(); root.set(id, beat); }
          assert.ok(beat instanceof Y.Map);
          let store = beat.get("joins");
          if (!(store instanceof Y.Map) || step % 4 === 2) { store = new Y.Map<unknown>(); beat.set("joins", store); }
          assert.ok(store instanceof Y.Map); const key = "j" + pick(3);
          if (step % 4 === 1) store.delete(key);
          else {
            const values = [null, [], { into: "R1", glue: "x" }, { into: ids[pick(5)], glue: " " }, { into: ids[pick(5)], glue: "", generation: pick(3) }];
            store.set(key, values[pick(values.length)]);
          }
        });
        changes++; if (step % 6 === 5) set.queue.flush(order); checkpoint();
      }
      set.queue.flush(order); checkpoint(); agree("merged join neighborhood", order, handles, reading); histories++;
    } finally { set.close(); }
  }
  assert.deepEqual([...violations], declaredLimits);
  assert.deepEqual({ histories, changes, checkpoints, comparisons }, { histories: 36, changes: 648, checkpoints: 684, comparisons: 1710 });
  t.diagnostic(JSON.stringify({ seed: 0x5c629, histories, changes, checkpoints, comparisons, declaredLimits, violations: [...violations] }));
});
