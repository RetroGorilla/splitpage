import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bufferOracles } from "../buffer-oracles.ts";
import { IdentityBook, checkModel } from "../../src/model.ts";
import { readSplitStaleEvidence, readSplitStaleLocalization } from "../../src/split-stale/records.ts";
import type { StalePaintObservation, StaleReplayCase, StaleReplayStage } from "../../src/split-stale/records.ts";
import { assertStaleCounters, staleCounterExpectations } from "./lifecycle-expectations.ts";
import { hasPrivatePerfMetadata } from "../../src/perf/privacy.ts";
import { checkSplitStaleHistories } from "../../src/split-stale/report.ts";

function present<T>(value: T | null | undefined): T { assert.ok(value !== null && value !== undefined); return value; }
const evidence = readSplitStaleEvidence(); const localized = readSplitStaleLocalization();

function checkLiteral(item: StaleReplayCase, stage: StaleReplayStage, undo: boolean): void {
  const expected = undo ? bufferOracles[item.trace].undo : bufferOracles[item.trace].expected;
  const identities = new IdentityBook(); for (const [name, identity] of Object.entries(stage.binding.bindings)) identities.bind(name, identity);
  assert.deepEqual(Object.keys(stage.binding.models).sort(), ["A.E", "B.E", ...(item.order === "late-C" ? ["C.E"] : [])].sort());
  for (const [name, model] of Object.entries(stage.binding.models)) checkModel(model, expected, identities, name);
  const caret = present(expected.carets.A);
  assert.deepEqual(stage.binding.selection, [caret.selection?.from ?? caret.offset, caret.selection?.to ?? caret.offset]);
  assert.equal(stage.binding.text, present(expected.rows.find(row => row.id === caret.beat)).characters.map(character => character[1]).join(""));
}
function assertStaleAtNativeInput(state: StalePaintObservation): void {
  assert.equal(state.dom, "ab"); assert.deepEqual(state.selection, [2, 2]);
  assert.equal(state.paintHeld, true); assert.equal(state.nativeBaseChanged, true);
  assert.equal(state.painted?.value, "ab"); assert.deepEqual(state.painted.names, ["s1", "s2"]);
  assert.deepEqual(state.model.rows[0]?.characters.map(character => [character.notation, character.value]), [["b1", "X"], ["s1", "a"], ["s2", "b"]]);
}

test("literal expectations cover all nine replay cases, forty stages and eight counters", () => {
  assert.equal(evidence.appCommit, "224b60c580dd03d2541f4edd58a9324b07ff389c");
  assert.equal(evidence.baseHead, "f4730c6c8e9581443ef654da869db67acab8f9db");
  assert.equal(evidence.candidate, "B"); assert.equal(evidence.mechanism, "M1");
  assert.deepEqual(evidence.off, { rows: 2, writer: null, split: null });
  assertStaleCounters(evidence);
  assert.equal(evidence.cases.length, 6); assert.equal(evidence.controls.length, 3);
  assert.equal([...evidence.cases, ...evidence.controls].reduce((count, item) => count + item.stages.length, 0), 40);
});

test("native proof and replay pin the current injected bundle", async () => {
  const built = await build({ absWorkingDir: fileURLToPath(new URL("../../../../", import.meta.url)), entryPoints: [fileURLToPath(new URL("../../src/split-stale/page-probe.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
  assert.equal(createHash("sha256").update(present(built.outputFiles?.[0]?.text)).digest("hex"), evidence.bundleSha256);
});

for (const item of evidence.cases) test(`Split stale binding B/M1 ${item.trace}/${item.order}`, () => {
  assert.ok(item.stages.every(stage => stage.binding.preserveStalePaint));
  if (item.trace === "T03") {
    assert.equal(item.status, "FAIL"); assert.match(present(item.failure), /App changed DOM outside observed native target/);
    const after = present(item.stages.find(stage => stage.phase === "after-input"));
    assert.deepEqual(after.binding.commits, []);
    assert.deepEqual(after.binding.syncs.map(sync => sync.text), ["the th", "the t", "the\u00a0", "the"]);
    const native = after.probe.states.filter(state => state.site === "native.begin");
    assert.equal(native.length, 4); assert.equal(native[2]?.state.dom, "the t"); assert.deepEqual(native[2]?.input?.ranges, [[4,5]]);
    const third = after.binding.events.filter(event => event.type === "input" && event.phase === "capture")[2];
    assert.equal(third?.text, "the\u00a0");
    assert.ok(after.binding.errors.length); return;
  }
  assert.equal(item.status, "PASS"); assert.equal(item.failure, null);
  const forward = present(item.stages.find(stage => stage.phase === "forward")); const undo = present(item.stages.find(stage => stage.phase === "undo"));
  checkLiteral(item, forward, false); checkLiteral(item, undo, true);
  for (const stage of [forward, undo]) {
    assert.equal(stage.probe.state.painted?.value, stage.probe.state.dom);
    assert.equal(stage.probe.state.nativeBaseChanged, false);
    const row = present(stage.probe.state.model.rows.find(row => row.id === stage.probe.state.painted?.id));
    assert.deepEqual(stage.probe.state.painted?.names, row.characters.map(character => character.notation));
  }
  for (const stage of item.stages) assert.deepEqual(stage.binding.errors, []);
  assert.equal(undo.binding.heldBytes, 0);
  if (item.trace === "T02") {
    const remote = present(item.stages.find(stage => stage.phase === "remote-before-input")); assertStaleAtNativeInput(remote.probe.state);
    const after = present(item.stages.find(stage => stage.phase === "after-input")); const native = after.probe.states.filter(state => state.site === "native.begin");
    assert.equal(native.length, 1); assertStaleAtNativeInput(present(native[0]).state);
    assert.deepEqual(native[0]?.input, { trusted: true, type: "insertText", data: "c", defaultPrevented: false, ranges: [[2,2]] });
    assert.equal(remote.probe.state.selectedElement, item.stages[0]?.probe.state.selectedElement);
    assert.deepEqual(after.binding.commits, ["beforeinput:stale"]);
    const bindings = after.binding.bindings;
    assert.deepEqual(native[0]?.state.painted?.identities, [bindings.s1, bindings.s2]);
    assert.deepEqual(native[0]?.state.model.rows[0]?.characters[0]?.identity, bindings.b1);
  }
});

for (const item of evidence.controls) test(`removing only the stale-paint repair reproduces ${item.order}`, () => {
  assert.equal(item.status, "FAIL"); assert.match(present(item.failure), /Native selection outside painted text/);
  assert.ok(item.stages.every(stage => !stage.binding.preserveStalePaint));
  const remote = present(item.stages.find(stage => stage.phase === "remote-before-input"));
  assert.equal(remote.probe.state.dom, "Xab"); assert.deepEqual(remote.probe.state.selection, [3,3]);
  assert.equal(remote.probe.state.painted?.value, "ab"); assert.equal(remote.probe.state.paintHeld, true);
  assert.equal(item.stages.at(-1)?.binding.commits.length, 0);
});

test("browser stack attributes Split's remote repaint to the prototype adapter, while Writer leaves its DOM unpainted", () => {
  assert.deepEqual(localized.cases.map(item => item.surface), ["split", "writer", "repaired"]);
  const split = present(localized.cases[0]); const writer = present(localized.cases[1]); const repaired = present(localized.cases[2]);
  assert.ok(split.failure); assert.equal(writer.failure, null); assert.equal(repaired.failure, null);
  assert.deepEqual(split.remoteTrace.map(entry => entry.site), ["binding.project:before", "binding.project:after", "binding.requestRepaint", "app.render", "replaceChild:enter", "replaceChild:exit"]);
  const renderer = present(split.remoteTrace.find(entry => entry.site === "app.render"));
  assert.match(renderer.stack, /Object\.remote/); assert.match(renderer.stack, /context\.bridge\.repaint/);
  assert.match(present(split.remoteTrace.find(entry => entry.site === "replaceChild:enter")).stack, /commitRowPatch/);
  for (const item of [writer, repaired]) {
    assert.deepEqual(item.remoteTrace.map(entry => entry.site), ["binding.project:before", "binding.project:after"]);
    const native = present(item.probe.states.find(state => state.site === "native.begin")); assertStaleAtNativeInput(native.state);
    assert.deepEqual(native.input?.ranges, [[2,2]]);
  }
});

test("repainting/rebasing away the stale condition or omitting the remote change cannot earn a pass", () => {
  const good = present(present(evidence.cases[0]).stages.find(stage => stage.phase === "remote-before-input")).probe.state;
  const repainted = structuredClone(good); repainted.dom = "Xab"; repainted.selection = [3,3]; present(repainted.painted).value = "Xab";
  assert.throws(() => assertStaleAtNativeInput(repainted));
  const missing = structuredClone(good); present(missing.model.rows[0]).characters.shift();
  assert.throws(() => assertStaleAtNativeInput(missing));
});

test("new cases, missing stages, changed sync counts and changed lifecycle counters cannot bypass literal coverage", () => {
  const extra = structuredClone(evidence); extra.cases.push({ ...present(extra.cases[0]), order: "new-order" });
  assert.throws(() => assertStaleCounters(extra), /case coverage/);
  const stage = structuredClone(evidence); present(stage.cases[0]).stages.pop(); assert.throws(() => assertStaleCounters(stage), /phase order/);
  const sync = structuredClone(evidence); present(present(sync.cases.find(item => item.trace === "T03")).stages[1]).binding.syncs.push({ id: "R1", text: "the", composing: false });
  assert.throws(() => assertStaleCounters(sync), /literal stage counters/);
  const lifecycle = structuredClone(evidence); present(present(lifecycle.cases[0]).stages[3]).binding.app.counts.compositionMark = 1;
  assert.throws(() => assertStaleCounters(lifecycle), /literal stage counters/);
  const expected = { ...staleCounterExpectations }; Reflect.deleteProperty(expected, "cases/T03/D1"); assert.throws(() => assertStaleCounters(evidence, expected), /case coverage/);
});

test("retained proof contains no identifying metadata or timing samples", () => {
  assert.equal(hasPrivatePerfMetadata(JSON.stringify(evidence)), false); assert.equal(hasPrivatePerfMetadata(JSON.stringify(localized)), false);
  assert.doesNotMatch(JSON.stringify(evidence), /"timings":/);
});

test("attribution, repair-removal and native-whitespace failure histories reproduce", checkSplitStaleHistories);
