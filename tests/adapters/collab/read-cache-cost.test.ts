import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBenchmarkDocument, submitBenchmarkOperations, typeBenchmarkCharacter } from "../../collab/benchmark-document.ts";
import { measureLibraryReads } from "../../collab/library-read-counts.ts";
import { cacheText } from "./read-cache-support.ts";
import { replicas, ref } from "./executor-support.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { readCollabMarkState, prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { measureSharedReads } from "../../../src/adapters/collab/read-counts.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";

const noLibraryReads = Object.freeze({ texts: 0, markEntries: 0, records: 0, statusEntries: 0, orderEntries: 0 });
const noRuleReads = Object.freeze({ texts: 0, identities: 0, markRecords: 0, markAnchors: 0, markChecks: 0, statusEvents: 0 });

function primePreparation(handle: Parameters<typeof createSharedPreparation>[0], row: string): void {
  const preparation = createSharedPreparation(handle);
  try { assert.ok(preparation.view.text(["segments", "b:" + row, "text"])); }
  finally { preparation.close(); }
}

test("typing and mark preparation read zero unrelated texts, marks and records with 0, 299 and 10000 unrelated beats", t => {
  const readings: unknown[] = [];
  for (const [beats, editedBeats, checks, refreshedChecks, commands] of [[1, 1, 52, 53, 17], [300, 300, 68, 69, 5100], [10001, 1, 52, 53, 17]] as const) {
    const run = buildBenchmarkDocument({ beats, editedBeats });
    try {
      assert.equal(run.commands, commands);
      const { text, store } = cacheText(run.a, "R0");
      const cold = measureLibraryReads(run.a, "R0", () => measureSharedReads(() => readCollabMarkState(run.a, text, store)));
      assert.deepEqual(cold.totals, { texts: 1, markEntries: 20, records: 0, statusEntries: 0, orderEntries: 0 });
      assert.deepEqual(cold.unrelated, noLibraryReads);
      assert.deepEqual(cold.result.counts, { texts: 1, identities: 69, markRecords: 3, markAnchors: 34, markChecks: checks, statusEvents: 0 });
      const warm = measureLibraryReads(run.a, "R0", () => measureSharedReads(() => readCollabMarkState(run.a, text, store)));
      assert.deepEqual(warm.totals, noLibraryReads); assert.deepEqual(warm.result.counts, noRuleReads);
      primePreparation(run.a, "R0");
      const typed = measureLibraryReads(run.a, "R0", () => measureSharedReads(() => typeBenchmarkCharacter(run.a, "R0", 2, "z", "measured-type")));
      assert.deepEqual(typed.totals, { texts: 0, markEntries: 0, records: 1, statusEntries: 0, orderEntries: 0 });
      assert.deepEqual(typed.unrelated, noLibraryReads); assert.deepEqual(typed.result.counts, noRuleReads);
      const refreshed = measureLibraryReads(run.a, "R0", () => measureSharedReads(() => readCollabMarkState(run.a, text, store)));
      assert.deepEqual(refreshed.totals, { texts: 1, markEntries: 19, records: 0, statusEntries: 0, orderEntries: 0 });
      assert.deepEqual(refreshed.unrelated, noLibraryReads);
      assert.deepEqual(refreshed.result.counts, { texts: 1, identities: 70, markRecords: 1, markAnchors: 36, markChecks: refreshedChecks, statusEvents: 0 });
      primePreparation(run.a, "R0");
      const marked = measureLibraryReads(run.a, "R0", () => measureSharedReads(() => submitBenchmarkOperations(run.a, [{
        kind: "mark", id: "measured-mark", by: "Writer", target: { owner: "R0", segment: "b:R0", field: "audioText" },
        observed: [flowBaseReference("R0", "audioText", 0, 2)], mark: { kind: "b", value: true }
      }])));
      assert.deepEqual(marked.totals, { texts: 0, markEntries: 0, records: 1, statusEntries: 0, orderEntries: 0 });
      assert.deepEqual(marked.unrelated, noLibraryReads); assert.deepEqual(marked.result.counts, noRuleReads);
      readings.push({ beats, cold: cold.totals, warm: warm.totals, typed: typed.totals, refreshed: refreshed.totals, marked: marked.totals });
    } finally { run.close(); }
  }
  t.diagnostic(JSON.stringify(readings));
});

test("a thousand-unit text tests only its 200 covering marks and a repeated read tests none", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "a".repeat(1000) }] });
  const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
  try {
    for (let index = 0; index < 200; index++) {
      const id = "narrow" + index, record = prepareSharedMarkRecord(run.a, target, id, index * 2, index * 2 + 1, { type: "add", mark: { kind: "b", value: true } });
      assert.ok(record); assert.deepEqual(writeSharedMarkRecord(run.a, target, id, record), { ok: true });
    }
    const { text, store } = cacheText(run.a);
    const first = measureSharedReads(() => readCollabMarkState(run.a, text, store));
    assert.deepEqual(first.counts, { texts: 1, identities: 1000, markRecords: 200, markAnchors: 400, markChecks: 200, statusEvents: 0 });
    assert.equal(first.result.characters.filter(character => character.marks.length).length, 200);
    assert.deepEqual(first.result.characters[0]?.marks.map(group => group.kind), ["b"]);
    assert.deepEqual(first.result.characters[1]?.marks, []);
    const second = measureSharedReads(() => readCollabMarkState(run.a, text, store));
    assert.deepEqual(second.counts, noRuleReads); assert.equal(second.result, first.result);
  } finally { run.close(); }
});

test("a warmed status command reads only its target events with 0 or 10000 unrelated events", t => {
  const readings: unknown[] = [];
  for (const size of [0, 10000]) {
    const run = buildBenchmarkDocument({ beats: 1, rounds: 0 }), root = collabState(run.a).roots.statusEvents;
    try {
      transactSharedDocument(run.a, "remote", () => {
        for (let index = 0; index < size; index++) root.set("other" + index, {
          kind: "status", id: "other" + index, by: "Other", target: { scope: "beat", record: "R_other" }, value: "ready", parents: []
        });
      });
      const preparation = createSharedPreparation(run.a);
      assert.deepEqual(preparation.view.statusEvents({ scope: "beat", record: ref("R0") }), []); preparation.close();
      const command = (id: string, parents: readonly string[]) => ({ kind: "status", id, by: "Writer", target: { scope: "beat", record: "R0" }, value: "shot", parents });
      const first = measureLibraryReads(run.a, "R0", () => measureSharedReads(() => submitBenchmarkOperations(run.a, [command("first", [])])));
      assert.deepEqual(first.totals, { texts: 0, markEntries: 0, records: 3, statusEntries: 1, orderEntries: 0 });
      assert.deepEqual(first.unrelated, noLibraryReads);
      assert.deepEqual(first.result.counts, noRuleReads);
      const second = measureLibraryReads(run.a, "R0", () => measureSharedReads(() => submitBenchmarkOperations(run.a, [command("second", ["first"])])));
      readings.push({ size, first: first.totals, second: second.totals, unrelated: second.unrelated, rules: second.result.counts });
      assert.deepEqual(second.totals, { texts: 0, markEntries: 0, records: 3, statusEntries: 4, orderEntries: 0 });
      assert.deepEqual(second.unrelated, noLibraryReads);
      assert.deepEqual(second.result.counts, { texts: 0, identities: 0, markRecords: 0, markAnchors: 0, markChecks: 0, statusEvents: 2 });
    } finally { run.close(); }
  }
  t.diagnostic(JSON.stringify(readings));
});

test("native read instrumentation counts every map enumeration and full text and order readings", () => {
  const run = replicas();
  try {
    const { text, store } = cacheText(run.a), order = collabState(run.a).roots.order;
    transactSharedDocument(run.a, "remote", () => { store.set("one", null); store.set("two", null); });
    const measured = measureLibraryReads(run.a, "R1", () => {
      store.get("one"); store.has("two");
      Array.from(store.keys()); Array.from(store.values()); Array.from(store.entries()); Array.from(store);
      store.forEach(() => {}); store.toJSON();
      text.toDelta(); text.toString(); text.toJSON();
      order.toArray(); order.slice(); Array.from(order); order.forEach(() => {}); order.map(value => value);
    });
    assert.deepEqual(measured.totals, { texts: 4, markEntries: 16, records: 0, statusEntries: 0, orderEntries: 10 });
  } finally { run.close(); }
});
