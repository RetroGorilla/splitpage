import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bufferOracles, bufferTraceOrder } from "../buffer-oracles.ts";
import { IdentityBook, checkModel } from "../../src/model.ts";
import { readSplitRepairEvidence, readSplitLocalization } from "../../src/split-reconcile/records.ts";
import type { SplitRepairSnapshot, SplitLocalizationCase } from "../../src/split-reconcile/records.ts";
import { hasPrivatePerfMetadata } from "../../src/perf/privacy.ts";
import { checkSplitReconcileHistories } from "../../src/split-reconcile/report.ts";
import { assertAllSplitCounters, assertSplitCaseCounters, splitCounterExpectations } from "./lifecycle-expectations.ts";

function present<T>(value: T | null | undefined): T { assert.ok(value !== null && value !== undefined); return value; }
const evidence = readSplitRepairEvidence(); const localized = readSplitLocalization();

test("every retained Split case and stage has literal expectations for every reported counter", () => assertAllSplitCounters(evidence));

test("doubling ordinary T01 sync counts fails in all five retained runs", () => {
  for (const item of evidence.cases.filter(item => item.trace === "T01")) {
    const stages = structuredClone(item.stages);
    for (const stage of stages) stage.syncs.push(...structuredClone(stage.syncs));
    assert.throws(() => assertSplitCaseCounters(`cases/${item.trace}/${item.order}`, stages), /literal stage counters/);
  }
});

test("zeroing composition lifecycle counters after commit fails at every later stage", () => {
  for (const group of ["controls", "cases"] as const) for (const item of evidence[group]) {
    if (!["T04", "T04 removed", "T01 composition"].includes(item.trace)) continue;
    for (let index = 4; index < item.stages.length; index++) for (const counter of ["compositionMark", "dropEmptySince"] as const) {
      const stages = structuredClone(item.stages);
      present(stages[index]).app.counts[counter] = 0;
      assert.throws(() => assertSplitCaseCounters(`${group}/${item.trace}/${item.order}`, stages), /literal stage counters/);
    }
  }
});

test("a new case, extra stage or missing counter expectation cannot bypass coverage", () => {
  const extra = structuredClone(evidence); extra.cases.push({ ...present(extra.cases[0]), order: "new-order" });
  assert.throws(() => assertAllSplitCounters(extra), /literal case coverage/);
  const stages = structuredClone(present(evidence.cases[0]).stages); stages.push(structuredClone(present(stages[0])));
  assert.throws(() => assertSplitCaseCounters("cases/T04/D3", stages), /stage coverage/);
  const expected = { ...splitCounterExpectations, "cases/T04/D3": [[0]] };
  assert.throws(() => assertSplitCaseCounters("cases/T04/D3", present(evidence.cases[0]).stages.slice(0, 1), expected as unknown as typeof splitCounterExpectations), /counter coverage/);
});

function literal(snapshot: SplitRepairSnapshot, trace: keyof typeof bufferOracles, undo: boolean, lateJoin = false): void {
  const expected = undo ? bufferOracles[trace].undo : bufferOracles[trace].expected;
  const identities = new IdentityBook(); for (const [name, identity] of Object.entries(snapshot.bindings)) identities.bind(name, identity);
  const replicas = ["A.E", "B.E", ...(lateJoin ? ["C.E"] : [])];
  assert.deepEqual(Object.keys(snapshot.models).sort(), replicas.sort());
  for (const [name, model] of Object.entries(snapshot.models)) checkModel(model, expected, identities, name);
  const caret = present(expected.carets.A);
  assert.deepEqual(snapshot.selection, [caret.selection?.from ?? caret.offset, caret.selection?.to ?? caret.offset]);
  assert.equal(snapshot.text, present(expected.rows.find(row => row.id === caret.beat)).characters.map(character => character[1]).join(""));
}

test("one harness guard, unchanged B/M1 and literal coverage, stop after the T02 extension fails", () => {
  assert.equal(evidence.appCommit, "224b60c580dd03d2541f4edd58a9324b07ff389c");
  assert.equal(evidence.baseHead, "335ab4d6ef412db229d3fac788f7f975c091e325");
  assert.deepEqual(evidence.off, { rows: 2, writer: null, split: null });
  assert.deepEqual(evidence.cases.map(item => `${item.trace}/${item.order}`), bufferTraceOrder.slice(0, 5).flatMap(trace => bufferOracles[trace].orders.map(order => `${trace}/${order}`)));
  assert.equal(evidence.cases.filter(item => item.status === "PASS").length, 15);
  assert.equal(evidence.cases.filter(item => item.status === "FAIL").length, 3);
  assert.equal(evidence.controls.length, 5);
});

test("repair evidence pins the exact injected prototype bundle", async () => {
  const built = await build({ absWorkingDir: fileURLToPath(new URL("../../../../", import.meta.url)), entryPoints: [fileURLToPath(new URL("../../src/split-reconcile/page.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
  assert.equal(createHash("sha256").update(present(built.outputFiles?.[0]?.text)).digest("hex"), evidence.bundleSha256);
});

for (const result of evidence.cases) test(`Split repaired B/M1 ${result.trace}/${result.order}`, () => {
  assert.equal(result.mechanism, "M1");
  for (const stage of result.stages) { assert.equal(stage.candidate, "B"); assert.equal(stage.coordination.enabled, true); assert.equal(stage.coordination.reconciling, false); }
  if (result.trace === "T02") {
    assert.equal(result.status, "FAIL"); assert.match(present(result.difference), /Native selection outside painted text/);
    assert.equal(result.stages[0]?.text, "ab"); assert.deepEqual(result.stages[0]?.selection, [2, 2]);
    assert.equal(result.stages[1]?.text, "Xab"); assert.deepEqual(result.stages[1]?.selection, [3, 3]);
    assert.equal(result.stages[1]?.coordination.nestedPaintsSuppressed, 0);
    assert.deepEqual(result.stages.at(-1)?.commits, []);
    assert.throws(() => literal(present(result.stages.at(-1)), result.trace, false));
    return;
  }
  assert.equal(result.status, "PASS"); assert.equal(result.difference, null); assert.equal(result.stages.length, 6);
  literal(present(result.stages[4]), result.trace, false, result.order === "late-C"); literal(present(result.stages[5]), result.trace, true, result.order === "late-C");
  for (const stage of result.stages) assert.deepEqual(stage.errors, []);
  const last = present(result.stages[5]); assert.equal(last.heldBytes, 0);
  if (result.order === "late-C") assert.ok(last.models["C.E"]);
  if (["T04", "T04 removed", "T01 composition"].includes(result.trace)) {
    const native = present(result.stages[1]); const remote = present(result.stages[2]); const committed = present(result.stages[3]);
    assert.equal(native.composing, true); assert.equal(remote.composing, true); assert.equal(remote.remoteNodesPreserved, true);
    assert.equal(remote.text, native.text); assert.deepEqual(remote.selection, native.selection);
    assert.equal(committed.composing, false); assert.equal(committed.dirty, false);
    assert.deepEqual(committed.commits, ["compositionend:cellEditing.sync"]);
    assert.equal(committed.app.counts.compositionMark, 1); assert.equal(committed.app.counts.dropEmptySince, 1);
    assert.equal(committed.syncs.length, result.trace === "T01 composition" ? 3 : 4);
    assert.equal(committed.coordination.nestedPaintsSuppressed, 1);
    const commit = committed.history.findIndex(line => line.startsWith("A commit "));
    const release = committed.history.findIndex(line => line.startsWith("A release "));
    if (result.order !== "D1") assert.ok(commit >= 0 && release > commit);
    assert.ok(committed.history.findIndex(line => line.startsWith("A repaint ")) > commit);
  }
});

for (const result of evidence.controls) test(`removing only the harness guard reproduces ${result.trace}/${result.order}`, () => {
  assert.equal(result.status, "FAIL");
  assert.match(present(result.difference), result.trace === "T04" ? /replaceChild/ : /removeChild/);
  const after = present(result.stages[3]);
  assert.equal(after.coordination.enabled, false); assert.equal(after.coordination.nestedPaintsSuppressed, 0);
  assert.equal(after.errors.length, 1); assert.deepEqual(after.commits, ["compositionend:cellEditing.sync"]);
  assert.throws(() => literal(after, result.trace, false));
});

function assertBrokenStack(item: SplitLocalizationCase): void {
  const op = item.kind === "T04" ? "replaceChild" : "removeChild";
  const outer = present(item.trace.find(entry => entry.site === `${op}:enter` && entry.depth === 0));
  const inner = present(item.trace.find(entry => entry.site === `${op}:enter` && entry.depth === 1));
  assert.equal((inner.detail as { old: string }).old, (outer.detail as { old: string }).old);
  assert.ok(inner.stack.includes("split-binding.js")); assert.ok(inner.stack.includes("commitRows"));
  assert.ok((inner.stack.match(new RegExp(`Node\\.${op}`, "g")) ?? []).length >= 2);
  const handler = present(item.trace.find(entry => entry.site === "focusout-handler:enter" && typeof entry.detail === "object" && entry.detail.source?.includes("repaintOwed")));
  assert.equal((handler.detail as { phase: number }).phase, 3); assert.equal(handler.depth, 1);
  assert.ok(item.trace.some(entry => entry.site === "binding.paint" && entry.depth === 1));
  assert.ok(item.trace.some(entry => entry.site === `${op}:throw`));
}

test("browser stacks attribute both failed native writes to the prototype bubble repaint, not app blur sync", () => {
  const broken = localized.cases.filter(item => item.mode === "binding"); assert.equal(broken.length, 2);
  for (const item of broken) {
    assertBrokenStack(item);
    assert.ok(item.trace.some(entry => entry.site === "editorBlur" && entry.depth === 1));
    assert.equal(item.trace.filter(entry => entry.site === "leftEditable" && entry.depth === 1).length, 1);
    assert.ok(!item.trace.some(entry => ["blurredCell", "syncShown"].includes(entry.site) && entry.depth > 0));
  }
});

test("corrected harness leaves app blur cleanup active, with no nested renderer or native write", () => {
  const repaired = localized.cases.filter(item => item.mode === "guarded"); assert.equal(repaired.length, 2);
  for (const item of repaired) {
    assert.equal(item.failure, null);
    assert.ok(item.trace.some(entry => entry.site === "leftEditable" && entry.depth === 1));
    assert.ok(!item.trace.some(entry => ["render", "syncShown", "blurredCell", "replaceChild:enter", "removeChild:enter"].includes(entry.site) && entry.depth > 0));
    assert.equal(item.sourceTree, localized.cases.find(other => other.mode === "binding")?.sourceTree);
    assert.equal(item.sourceTree, "6de8ffb655129b7d6d5844ba6153d730795da5d5");
  }
});

test("unpatched standalone focusout during row removal is harmless; ordinary leave still syncs", () => {
  const removed = present(localized.cases.find(item => item.mode === "standalone" && item.kind === "delete-focused-row"));
  assert.equal(removed.sourceCommit, "efcd94c21a12585d232e9012a603b92031ce0b21"); assert.equal(removed.failure, null);
  assert.ok(removed.trace.some(entry => entry.site === "editorBlur" && entry.depth === 1));
  assert.ok(removed.trace.some(entry => entry.site === "leftEditable" && entry.depth === 1));
  assert.ok(!removed.trace.some(entry => ["render", "syncShown", "blurredCell"].includes(entry.site) && entry.depth > 0));
  assert.equal((removed.snapshot as { rows: number }).rows, 1);
  const leave = present(localized.cases.find(item => item.mode === "standalone" && item.kind === "composition-and-blur"));
  assert.equal(leave.failure, null); assert.ok(leave.trace.some(entry => entry.site === "blurredCell" && entry.depth === 0));
  assert.ok(leave.trace.some(entry => entry.site === "syncShown" && entry.depth === 0));
});

test("localization checker rejects a missing nested writer and a different native target", () => {
  const broken = present(localized.cases.find(item => item.mode === "binding" && item.kind === "T04"));
  const missing = structuredClone(broken); missing.trace = missing.trace.filter(entry => !(entry.site === "replaceChild:enter" && entry.depth === 1));
  assert.throws(() => assertBrokenStack(missing));
  const wrong = structuredClone(broken); (present(wrong.trace.find(entry => entry.site === "replaceChild:enter" && entry.depth === 1)).detail as { old: string }).old = "another node";
  assert.throws(() => assertBrokenStack(wrong));
});

test("retained evidence contains no identifying metadata or timing samples", () => {
  assert.equal(hasPrivatePerfMetadata(JSON.stringify(evidence)), false);
  assert.equal(hasPrivatePerfMetadata(JSON.stringify(localized)), false);
  assert.doesNotMatch(JSON.stringify(evidence), /"timings":/);
});

test("localized stacks and every remaining failure have reproducible histories", checkSplitReconcileHistories);
