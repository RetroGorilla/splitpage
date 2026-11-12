import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { replicas, ref } from "./executor-support.ts";
import { cacheText, cacheMarks, cacheStatus } from "./read-cache-support.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, observeSharedTransactions, observeSharedUpdates, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument as createSharedDocument } from "./helpers.ts";
import { prepareSharedMarkRecord, readCollabMarkState, readSharedMarkCharacters, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { sharedMarkRecordKey } from "../../../src/adapters/collab/mark-record.ts";
import { measureSharedReads } from "../../../src/adapters/collab/read-counts.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { measureLibraryReads } from "../../collab/library-read-counts.ts";
import { sharedTextCommandPlan } from "../../../src/adapters/collab/executor-text-plan.ts";
import { collabProjectedTextTarget } from "../../../src/adapters/collab/text-target.ts";

const target = Object.freeze({ owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const });
const plain = [{ value: "a", marks: [] }, { value: "b", marks: [] }, { value: "Z", marks: [] }];
const bold = [{ value: "a", marks: [["b", true]] }, { value: "b", marks: [["b", true]] }, { value: "Z", marks: [] }];

test("warm mark and preparation caches cannot bypass missing projected text addresses", () => {
  for (const field of ["audioText", "visualText"] as const) {
    const run = replicas(2, { rows: [{ id: "R1", audioText: "ab", visualText: "cd" }, { id: "R2", audioText: "ef" }] });
    const address = { owner: ref("R1"), segment: ref("R1"), field };
    const preparation = createSharedPreparation(run.b);
    const values = () => sharedTextCommandPlan(preparation.view, address).units.map(unit => unit.value);
    try {
      assert.deepEqual(readSharedMarkCharacters(run.b, address)?.map(character => character.value), field === "audioText" ? ["a", "b"] : ["c", "d"]);
      assert.deepEqual(values(), field === "audioText" ? ["a", "b"] : ["c", "d"]);
      const warm = measureSharedReads(values);
      assert.deepEqual(warm.result, field === "audioText" ? ["a", "b"] : ["c", "d"]);
      assert.equal(warm.counts.texts, 0);
      const record = prepareSharedMarkRecord(run.a, address, "before-hidden", 0, 1, { type: "add", mark: { kind: "b", value: true } });
      assert.ok(record);
      transactSharedDocument(run.a, "local-command", () => {
        const roots = collabState(run.a).roots;
        if (field === "audioText") roots.order.delete(0, roots.order.length);
        else {
          const visual = roots.visuals.get("R1"); assert.ok(visual instanceof Y.Map); visual.set("beat", "R2");
        }
      });
      assert.deepEqual(applySharedUpdate(run.b, encodeSharedState(run.a)), { ok: true });
      assert.equal(collabProjectedTextTarget(run.b, address), null);
      assert.equal(readSharedMarkCharacters(run.b, address), null);
      assert.equal(prepareSharedMarkRecord(run.b, address, "after-hidden", 0, 1, { type: "add", mark: { kind: "b", value: true } }), null);
      assert.deepEqual(writeSharedMarkRecord(run.b, address, "before-hidden", { ...record, writer: collabState(run.b).doc.clientID }), { ok: false, reason: "missing-text" });
      assert.throws(values, /missing-target/);
      const fresh = createSharedPreparation(run.b);
      try { assert.throws(() => sharedTextCommandPlan(fresh.view, address), /missing-target/); }
      finally { fresh.close(); }
    } finally { preparation.close(); run.close(); }
  }
});

test("a cached text reflects a mark record received without a text change", () => {
  const run = replicas();
  try {
    assert.deepEqual(cacheMarks(run.b), plain);
    const record = prepareSharedMarkRecord(run.a, target, "bold", 0, 2, { type: "add", mark: { kind: "b", value: true } });
    assert.ok(record);
    assert.deepEqual(writeSharedMarkRecord(run.a, target, "bold", record), { ok: true });
    assert.deepEqual(applySharedUpdate(run.b, encodeSharedState(run.a)), { ok: true });
    assert.deepEqual(cacheMarks(run.b), bold);
    assert.equal(measureSharedReads(() => cacheMarks(run.b)).counts.markRecords, 0);
  } finally { run.close(); }
});

test("preparation reads again and returns new marks and text after another writer's updates", () => {
  const run = replicas();
  const prepare = () => {
    const preparation = createSharedPreparation(run.b);
    try {
      const text = preparation.view.text(["segments", "b:R1", "text"]); assert.ok(text);
      return text.units.map(unit => ({ value: unit.value, marks: unit.marks.flatMap(group => group.values.map(value => [group.kind, value])) }));
    } finally { preparation.close(); }
  };
  try {
    assert.deepEqual(prepare(), plain);
    const warm = measureLibraryReads(run.b, "R1", prepare);
    assert.deepEqual(warm.result, plain); assert.equal(warm.totals.texts, 0);
    const record = prepareSharedMarkRecord(run.a, target, "remote-bold", 0, 2, { type: "add", mark: { kind: "b", value: true } });
    assert.ok(record); assert.deepEqual(writeSharedMarkRecord(run.a, target, "remote-bold", record), { ok: true });
    assert.deepEqual(applySharedUpdate(run.b, encodeSharedState(run.a)), { ok: true });
    const marked = measureLibraryReads(run.b, "R1", prepare);
    assert.deepEqual(marked.result, bold);
    assert.equal(marked.totals.texts, 2);
    const again = measureLibraryReads(run.b, "R1", prepare);
    assert.deepEqual(again.result, bold); assert.equal(again.totals.texts, 0);
    transactSharedDocument(run.a, "local-command", () => { cacheText(run.a).text.insert(3, "!"); });
    assert.deepEqual(applySharedUpdate(run.b, encodeSharedState(run.a)), { ok: true });
    const typed = measureLibraryReads(run.b, "R1", prepare);
    assert.deepEqual(typed.result, [{ value: "a", marks: [["b", true]] }, { value: "b", marks: [["b", true]] },
      { value: "Z", marks: [] }, { value: "!", marks: [] }]);
    assert.equal(typed.totals.texts, 2);
  } finally { run.close(); }
});

test("cached text readings change inside a transaction and survive a throwing body", () => {
  const run = replicas();
  try {
    const { text, store } = cacheText(run.a);
    assert.deepEqual(cacheMarks(run.a), plain);
    assert.throws(() => transactSharedDocument(run.a, "local-command", () => {
      assert.deepEqual(cacheMarks(run.a), plain);
      text.insert(1, "x");
      assert.deepEqual(cacheMarks(run.a), [{ value: "a", marks: [] }, { value: "x", marks: [] }, { value: "b", marks: [] }, { value: "Z", marks: [] }]);
      text.delete(0, 2);
      assert.deepEqual(cacheMarks(run.a), [{ value: "b", marks: [] }, { value: "Z", marks: [] }]);
      throw new Error("body failed");
    }), /body failed/);
    const first = readCollabMarkState(run.a, text, store);
    assert.deepEqual(cacheMarks(run.a), [{ value: "b", marks: [] }, { value: "Z", marks: [] }]);
    assert.equal(readCollabMarkState(run.a, text, store), first);
    assert.equal(collabState(run.a).reads.settled, true);
  } finally { run.close(); }
});

test("a replaced store, changed record, deleted record and invalid stored value invalidate only their text", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "abZ" }, { id: "R2", audioText: "other" }] });
  try {
    const own = cacheText(run.a), other = cacheText(run.a, "R2");
    const unchanged = readCollabMarkState(run.a, other.text, other.store);
    assert.deepEqual(cacheMarks(run.a), plain);
    const record = prepareSharedMarkRecord(run.a, target, "bold", 0, 2, { type: "add", mark: { kind: "b", value: true } });
    const key = sharedMarkRecordKey("bold", collabState(run.a).doc.clientID);
    assert.ok(record && key);
    transactSharedDocument(run.a, "remote", () => { own.store.set(key, record); });
    assert.deepEqual(cacheMarks(run.a), bold);
    transactSharedDocument(run.a, "remote", () => { own.store.set(key, { ...record, mark: { kind: "i", value: true } }); });
    assert.deepEqual(cacheMarks(run.a), [{ value: "a", marks: [["i", true]] }, { value: "b", marks: [["i", true]] }, { value: "Z", marks: [] }]);
    transactSharedDocument(run.a, "remote", () => { own.store.delete(key); });
    assert.deepEqual(cacheMarks(run.a), plain);
    transactSharedDocument(run.a, "remote", () => { own.store.set(key, new Y.Map()); });
    assert.deepEqual(cacheMarks(run.a), plain);
    const preparation = createSharedPreparation(run.a);
    assert.deepEqual(preparation.view.text(["segments", "b:R1", "text"])?.recordKeys, [key]);
    preparation.close();
    transactSharedDocument(run.a, "remote", () => { own.container.set("markRecords", new Y.Map<unknown>([[key, record]])); });
    assert.deepEqual(cacheMarks(run.a), bold);
    assert.equal(readCollabMarkState(run.a, other.text, other.store), unchanged);
  } finally { run.close(); }
});

test("status index follows replacement, retargeting, deletion, invalid values and preparation overlays", () => {
  const run = replicas(), root = collabState(run.a).roots.statusEvents;
  const event = { kind: "status", id: "e1", by: "A", target: { scope: "beat", record: "R1" }, value: "ready", parents: [] };
  try {
    assert.deepEqual(cacheStatus(run.a), { value: [], keys: [] });
    transactSharedDocument(run.a, "remote", () => { root.set("e1", event); });
    assert.deepEqual(cacheStatus(run.a), { value: [event], keys: ["e1"] });
    transactSharedDocument(run.a, "remote", () => { root.set("e1", { ...event, target: { scope: "beat", record: "R2" } }); });
    assert.deepEqual(cacheStatus(run.a), { value: [], keys: [] });
    assert.deepEqual(cacheStatus(run.a, "R2"), { value: [{ ...event, target: { scope: "beat", record: "R2" } }], keys: ["e1"] });
    transactSharedDocument(run.a, "remote", () => {
      root.set("e1", null);
      assert.deepEqual(cacheStatus(run.a), { value: [null], keys: ["e1"] });
    });
    assert.deepEqual(cacheStatus(run.a, "R2"), { value: [], keys: [] });
    transactSharedDocument(run.a, "remote", () => { root.set("e1", event); });
    const preparation = createSharedPreparation(run.a);
    preparation.include([{ path: ["statusEvents", "e1"], kind: "delete" }, { path: ["statusEvents", "e2"], kind: "set", value: { ...event, id: "e2" } }]);
    assert.deepEqual(preparation.view.statusEvents(targetForStatus()), ["e2"]);
    assert.deepEqual(preparation.view.get(["statusEvents", "e2"]), { ...event, id: "e2" });
    preparation.close();
    transactSharedDocument(run.a, "remote", () => { root.delete("e1"); });
    assert.deepEqual(cacheStatus(run.a), { value: [], keys: [] });
  } finally { run.close(); }
});

test("cached visual and title marks retain physical addresses when metadata changes without text edits", () => {
  const run = replicas(2, { title: "<b>Title</b>", rows: [{ id: "R1", audioText: "a", visualText: "<b>ab</b>" }, { id: "R2", audioText: "b", visualText: "cd" }] });
  try {
    const roots = collabState(run.a).roots, visual = [...roots.visuals.values()].find(value => value instanceof Y.Map && value.get("beat") === "R1");
    assert.ok(visual instanceof Y.Map);
    const text: unknown = visual.get("text"), store: unknown = visual.get("markRecords");
    assert.ok(text instanceof Y.Text); assert.ok(store instanceof Y.Map);
    assert.deepEqual(readCollabMarkState(run.a, text, store).characters.map(character => character.marks.map(mark => mark.kind)), [["b"], ["b"]]);
    const preparation = createSharedPreparation(run.a), visualKey = [...roots.visuals.keys()].find(key => roots.visuals.get(key) === visual);
    assert.ok(visualKey);
    assert.deepEqual(preparation.view.text(["visuals", visualKey, "text"])?.units.map(unit => unit.marks.map(mark => mark.kind)), [["b"], ["b"]]);
    preparation.close();
    transactSharedDocument(run.a, "remote", () => { visual.set("beat", "R2"); });
    assert.deepEqual(readCollabMarkState(run.a, text, store).characters.map(character => character.marks.map(mark => mark.kind)), [["b"], ["b"]]);
    const updated = createSharedPreparation(run.a);
    assert.deepEqual(updated.view.text(["visuals", visualKey, "text"])?.units.map(unit => unit.marks.map(mark => mark.kind)), [["b"], ["b"]]); updated.close();
    const title: unknown = roots.meta.get("title"), titleStore: unknown = roots.meta.get("titleMarks");
    assert.ok(title instanceof Y.Text); assert.ok(titleStore instanceof Y.Map);
    const address = { owner: ref(String(roots.meta.get("docId"))), segment: ref(String(roots.meta.get("docId"))), field: "title" as const };
    const record = prepareSharedMarkRecord(run.a, address, "title-bold", 0, title.length, { type: "add", mark: { kind: "b", value: true } });
    assert.ok(record); assert.deepEqual(writeSharedMarkRecord(run.a, address, "title-bold", record), { ok: true });
    assert.equal(readCollabMarkState(run.a, title, titleStore).characters.every(character => character.marks.length === 1), true);
    transactSharedDocument(run.a, "remote", () => { roots.meta.set("docId", "other-document"); });
    assert.equal(readCollabMarkState(run.a, title, titleStore).characters.every(character => character.marks.length === 1), true);
  } finally { run.close(); }
});

function targetForStatus() { return { scope: "beat" as const, record: ref("R1") }; }

test("held mark updates refresh the cache at each separately published revision", () => {
  const run = replicas(), updates: Uint8Array[] = [], seen: unknown[] = [];
  try {
    const collect = observeSharedUpdates(run.a, update => { updates.push(update); });
    for (const [id, kind] of [["bold", "b"], ["italic", "i"]] as const) {
      const record = prepareSharedMarkRecord(run.a, target, id, 0, 2, { type: "add", mark: { kind, value: true } });
      assert.ok(record); assert.deepEqual(writeSharedMarkRecord(run.a, target, id, record), { ok: true });
    }
    collect();
    const [first, second] = updates; assert.ok(first && second); assert.equal(updates.length, 2);
    assert.deepEqual(cacheMarks(run.b), plain);
    const stop = observeSharedTransactions(run.b, () => {
      const revision = readSharedRevision(run.b);
      if (revision === 2) assert.deepEqual(applySharedUpdate(run.b, second), { ok: true });
      seen.push([revision, cacheMarks(run.b)]);
      const late = createSharedDocument();
      try {
        assert.deepEqual(applySharedUpdate(late, encodeSharedState(run.b)), { ok: true });
        assertReplicasAgree("held cache", [
          { order: "D1", replica: "A", output: projectSharedDocumentWithRecovery(run.b) },
          { order: "late-C", replica: "C", output: projectSharedDocumentWithRecovery(late) }
        ]);
      } finally { destroySharedDocument(late); }
    });
    assert.deepEqual(applySharedUpdate(run.b, first), { ok: true }); stop();
    assert.deepEqual(seen, [[2, bold], [3, [
      { value: "a", marks: [["b", true], ["i", true]] }, { value: "b", marks: [["b", true], ["i", true]] }, { value: "Z", marks: [] }
    ]]]);
  } finally { run.close(); }
});
