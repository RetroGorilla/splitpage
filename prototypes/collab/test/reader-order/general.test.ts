import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { ReplicaHarness, deliveryOrders } from "../../src/delivery.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { readReplica } from "../../src/reader.ts";
import { moveBeat } from "../../src/structure.ts";
import { ReaderConvergence } from "../reader-convergence.ts";
import { classifyLegacyFinding, classifyReaderFinding, knownReaderFailures } from "./known-failures.ts";
import { readerHistoryRows, runReaderHistory } from "./histories.ts";
import { legacyStructureReader } from "./legacy-structure.ts";
import { legacyReplyReader } from "./legacy.ts";
import { IncrementalProjection } from "../../src/perf/incremental.ts";
import { projectionDifference } from "../strict-comparison.ts";

function literalFields(id: string, model: ReturnType<typeof readStructure>): unknown {
  if (id === "removal-attribution") return { by: model.recovery[0]?.by };
  if (id === "visual-component-order") return { visuals: model.rows[0]?.visuals?.map(row => row.characters.map(character => character.value).join("")), text: model.rows[0]?.visualText };
  if (id === "reply-collation") return { replies: ((model.records?.comments as Record<string, { replies: { id: string }[] }>).C1?.replies ?? []).map(reply => reply.id) };
  if (id === "removal-observed-identities") return { edited: model.recovery.find(entry => entry.row.id === "R1")?.edited };
  if (id === "removal-split-attribution") return { splitBy: model.recovery.find(entry => entry.row.id === "Ra")?.splitBy };
  return { rows: model.rows.map(row => [row.id, row.characters.map(character => character.value).join("")]),
    recovery: model.recovery.map(entry => [entry.row.id, entry.row.characters.map(character => character.value).join(""), entry.by]) };
}

for (const row of readerHistoryRows) for (const candidate of ["A", "B"] as const) {
  if (row.id === "join-target-moved" && candidate === "A") continue;
  test(`${candidate}: repaired ${row.id} and retained failing reader, every delivery plus encoded late join`, () => {
    for (const order of deliveryOrders) {
      const h = new ReplicaHarness(candidate, row.beats), guard = new ReaderConvergence(h, deliveryOrders);
      try {
        runReaderHistory(row.id, h, order);
        const desired = row.desired;
        for (const replica of h.replicas) {
          const model = readStructure(replica.doc, candidate, h.identities);
          assert.deepEqual(literalFields(row.id, model), desired);
          if (row.id.startsWith("join-target")) {
            const joined = [...model.rows, ...model.recovery.map(entry => entry.row)].find(row => row.id === "R1");
            assert.deepEqual(joined?.characters.map(character => character.notation), ["s1", "s2", "[glue]", "s3", "s4"]);
            assert.deepEqual(literalFields(row.id, readReplica(replica.doc, candidate, h.identities)), desired);
          }
        }
        assert.deepEqual(guard.checkKnown(row.id), []); guard.check(row.id);
        const old = row.id === "reply-collation" ? legacyReplyReader : legacyStructureReader;
        let literalFailures = 0;
        const actual = h.replicas.map(replica => {
          try {
            const model = old(replica.doc, candidate, h.identities);
            try { assert.deepEqual(literalFields(row.id, model), desired); } catch { literalFailures++; }
            if (row.id === "removal-attribution") return model.recovery[0]?.by;
            if (row.id === "visual-component-order") return model.rows[0]?.visualText;
            if (row.id === "reply-collation") return ((model.records?.comments as Record<string, { replies: { id: string }[] }>).C1?.replies ?? []).map(reply => reply.id);
            const recovery = model.recovery.find(entry => entry.row.id === (row.id === "removal-split-attribution" ? "Ra" : "R1"));
            return row.id === "removal-observed-identities" ? recovery?.edited : recovery?.splitBy ?? null;
          } catch (error) { literalFailures++; return error instanceof Error ? error.message : String(error); }
        });
        assert.deepEqual(actual, row.legacy);
        assert.ok(literalFailures > 0, `${row.id}: literal checker missed the defect`);
        for (const replica of h.replicas) assert.deepEqual(Y.encodeStateAsUpdate(replica.doc), Y.encodeStateAsUpdate(h.alice.doc));
        const findings = guard.inspect(row.id, new Map(), old), kinds = new Set(findings.flatMap(classifyLegacyFinding));
        for (const kind of row.kinds) assert.ok(kinds.has(kind), `${row.id}: missing known failure ${kind}`);
        assert.throws(() => guard.check(row.id, new Map(), old), /full output or no-throw check failed/);
        if (row.id.startsWith("join-target")) {
          guard.check(row.id, new Map(), readReplica);
        }
      } finally { h.destroy(); }
    }
  });
}

test("the known-failure table rejects arbitrary output loss, new fields and unknown reader exceptions", () => {
  assert.deepEqual(knownReaderFailures, []);
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
    assert.deepEqual(guard.checkKnown("ordinary history"), []); guard.check("ordinary history");
    assert.throws(() => guard.check("ordinary history", new Map(), legacyReplyReader), /full output or no-throw check failed/);
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
      const caches = [new IncrementalProjection(h.alice), new IncrementalProjection(h.bob)];
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
            for (const cache of caches) {
              const fresh = new IncrementalProjection(cache.replica);
              try {
                assert.equal(projectionDifference(cache.document, fresh.document, "generated document cache"), null);
                assert.equal(projectionDifference(cache.index.spans.map(span => span.block), fresh.index.spans.map(span => span.block), "generated block cache"), null);
              } finally { fresh.destroy(); }
            }
            checkpoints++;
          }
        }
      } finally { for (const cache of caches) cache.destroy(); h.destroy(); }
    }
    assert.equal(checkpoints, 48); assert.equal(failures.size, 0); t.diagnostic(JSON.stringify({ seed, histories: 12, checkpoints, knownFailures: [...failures].sort() }));
  });
}

for (const [label, first, second] of [
  ["missing property", {}, { absent: undefined }],
  ["array length", [], new Array(1)],
  ["array hole", [undefined], new Array(1)],
  ["array property", [], Object.assign([], { absent: undefined })],
  ["non-index numeric array property", [], Object.assign([], { "4294967295": undefined })],
  ["object key order", { a: 1, b: 2 }, { b: 2, a: 1 }],
  ["unsupported kind", {}, new Date(0)]
] as const) test(`strict complete-output check rejects ${label} through check and checkKnown`, () => {
  const h = new ReplicaHarness("B", [{ id: "R1", text: "a" }]), guard = new ReaderConvergence(h, deliveryOrders);
  try {
    const wrapped: typeof readStructure = (...args) => {
      const model = readStructure(...args); (model.records ??= {}).probe = args[0].clientID === 101 ? second : first; return model;
    };
    assert.throws(() => guard.check(label, new Map(), wrapped));
    assert.throws(() => guard.checkKnown(label, new Map(), wrapped));
  } finally { h.destroy(); }
});
