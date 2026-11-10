import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { ReplicaHarness, deliveryOrders } from "../../src/delivery.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { readReplica } from "../../src/reader.ts";
import { moveBeat } from "../../src/structure.ts";
import { ReaderConvergence } from "../reader-convergence.ts";
import { classifyReaderFinding, knownReaderFailures } from "./known-failures.ts";
import { readerHistoryRows, runReaderHistory } from "./histories.ts";

function literalFields(id: string, model: ReturnType<typeof readStructure>): unknown {
  if (id === "removal-attribution") return { by: model.recovery[0]?.by };
  if (id === "visual-component-order") return { visuals: model.rows[0]?.visuals?.map(row => row.characters.map(character => character.value).join("")), text: model.rows[0]?.visualText };
  if (id === "reply-collation") return { replies: ((model.records?.comments as Record<string, { replies: { id: string }[] }>).C1?.replies ?? []).map(reply => reply.id) };
  return { rows: model.rows.map(row => [row.id, row.characters.map(character => character.value).join("")]),
    recovery: model.recovery.map(entry => [entry.row.id, entry.row.characters.map(character => character.value).join(""), entry.by]) };
}

for (const row of readerHistoryRows) for (const candidate of ["A", "B"] as const) {
  if (row.id === "join-target-moved" && candidate === "A") continue;
  test(`${candidate}: literal known reader failure ${row.id}, every delivery plus encoded late join`, () => {
    for (const order of deliveryOrders) {
      const h = new ReplicaHarness(candidate, row.beats), guard = new ReaderConvergence(h, deliveryOrders);
      try {
        runReaderHistory(row.id, h, order);
        let literalFailures = 0;
        const actual = h.replicas.map(replica => {
          try {
            const model = readStructure(replica.doc, candidate, h.identities);
            if (!row.id.startsWith("removal-observed") && !row.id.startsWith("removal-split")) {
              try { assert.deepEqual(literalFields(row.id, model), row.desired); } catch { literalFailures++; }
            }
            if (row.id === "removal-attribution") return model.recovery[0]?.by;
            if (row.id === "visual-component-order") return model.rows[0]?.visualText;
            if (row.id === "reply-collation") return ((model.records?.comments as Record<string, { replies: { id: string }[] }>).C1?.replies ?? []).map(reply => reply.id);
            const recovery = model.recovery.find(entry => entry.row.id === (row.id === "removal-split-attribution" ? "Ra" : "R1"));
            return row.id === "removal-observed-identities" ? recovery?.edited : recovery?.splitBy ?? null;
          } catch (error) { literalFailures++; return error instanceof Error ? error.message : String(error); }
        });
        assert.deepEqual(actual, row.legacy);
        if (!row.id.startsWith("removal-observed") && !row.id.startsWith("removal-split")) assert.ok(literalFailures > 0, `${row.id}: literal checker missed the defect`);
        for (const replica of h.replicas) assert.deepEqual(Y.encodeStateAsUpdate(replica.doc), Y.encodeStateAsUpdate(h.alice.doc));
        const findings = guard.checkKnown(row.id), kinds = new Set(findings.flatMap(classifyReaderFinding));
        for (const kind of row.kinds) assert.ok(kinds.has(kind), `${row.id}: missing known failure ${kind}`);
        assert.throws(() => guard.check(row.id), /full output or no-throw check failed/);
        if (row.id.startsWith("join-target")) {
          const earlier = guard.checkKnown(row.id, new Map(), readReplica);
          assert.ok(earlier.some(finding => classifyReaderFinding(finding).includes("earlier-join-target-removed-or-moved")));
          assert.throws(() => guard.check(row.id, new Map(), readReplica), /full output or no-throw check failed/);
        }
      } finally { h.destroy(); }
    }
  });
}

test("the known-failure table rejects arbitrary output loss, new fields and unknown reader exceptions", () => {
  assert.equal(knownReaderFailures.length, 7);
  for (const finding of [
    { kind: "output" as const, paths: ["rows.0.characters.0.value"], message: "Full projected output differs" },
    { kind: "output" as const, paths: ["recovery.0.by", "rows.0.status"], message: "Full projected output differs" },
    { kind: "throw" as const, paths: [], message: "New reader exception" }
  ]) assert.deepEqual(classifyReaderFinding({ phase: "control", replica: "control", ...finding }), []);
});

test("an ordinary history rejects the old comparator without a dedicated reply matrix", () => {
  const h = new ReplicaHarness("B", [{ id: "R1", text: "ab" }]), guard = new ReaderConvergence(h, deliveryOrders);
  try {
    h.alice.insert("R1", 1, "X", ["a1"]); h.queue.flush("D1");
    assert.deepEqual([...new Set(guard.checkKnown("ordinary history").flatMap(classifyReaderFinding))], ["reply-collation"]);
    assert.throws(() => guard.check("ordinary history"), /full output or no-throw check failed/);
    const lost: typeof readStructure = (...args) => { const model = readStructure(...args); if (args[0].clientID === 101) model.rows = []; return model; };
    assert.throws(() => guard.checkKnown("unlisted loss", new Map(), lost), /Unlisted reader failure/);
    const throwing: typeof readStructure = () => { throw new Error("Unlisted exception"); };
    assert.throws(() => guard.checkKnown("unlisted throw", new Map(), throwing), /Unlisted reader failure/);
  } finally { h.destroy(); }
});

for (const seed of [1376, 1413, 0x5eed0001, 0x5eed0002]) for (const candidate of ["A", "B"] as const) {
  test(`${candidate}: seeded valid-command histories ${seed} check complete output and every reader exception`, t => {
    let random = seed, checkpoints = 0;
    const next = (): number => random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const failures = new Set<string>();
    for (let history = 0; history < 12; history++) {
      const h = new ReplicaHarness(candidate, [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }, { id: "R3", text: "gh" }], Boolean(next() & 1));
      const guard = new ReaderConvergence(h, deliveryOrders);
      try {
        for (let step = 0; step < 12; step++) {
          const replica = next() & 1 ? h.alice : h.bob, beats = [...replica.doc.getMap("beats").keys()];
          const beat = beats[next() % beats.length]; assert.ok(beat);
          const id = `${history}:${step}`;
          switch ((next() >>> 8) % 6) {
            case 0: replica.insert(beat, 0, "x", [`x:${id}`]); break;
            case 1: replica.remove(beat, `r:${id}`, replica === h.alice ? "Alice" : "Bob"); break;
            case 2: replica.split(beat, 0, `R:${id}`, `boundary:${id}`, replica === h.alice ? "Alice" : "Bob"); break;
            case 3: {
              const into = beats[(beats.indexOf(beat) + 1) % beats.length]; assert.ok(into); replica.join(beat, into, `j:${id}`); break;
            }
            case 4: if (candidate === "B") moveBeat(replica, "R1", null); else replica.insert(beat, 0, "y", [`y:${id}`]); break;
            case 5: {
              const record = replica.doc.getMap<Y.Map<unknown>>("beats").get(beat); assert.ok(record);
              const removals = record.get("removals") as Y.Map<unknown>, removal = [...removals.keys()].at(0);
              if (removal) replica.restore(beat, removal); else replica.insert(beat, 0, "z", [`z:${id}`]); break;
            }
          }
          if (step % 3 === 2) {
            const order = deliveryOrders[next() % deliveryOrders.length]; assert.ok(order); h.queue.flush(order);
            for (const finding of guard.checkKnown(`seed ${seed}, history ${history}, step ${step}`)) for (const kind of classifyReaderFinding(finding)) failures.add(kind);
            checkpoints++;
          }
        }
      } finally { h.destroy(); }
    }
    assert.equal(checkpoints, 48); t.diagnostic(JSON.stringify({ seed, histories: 12, checkpoints, knownFailures: [...failures].sort() }));
  });
}
