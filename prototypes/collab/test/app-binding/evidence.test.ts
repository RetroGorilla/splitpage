import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bufferOracles, bufferTraceOrder } from "../buffer-oracles.ts";
import type { BufferTrace } from "../buffer-oracles.ts";
import { bufferMechanisms } from "../../src/editing-buffer.ts";
import { checkAppBindingHistories, checkAppBindingSnapshot, readAppBindingEvidence } from "../../src/app-binding/report.ts";
import type { AppBindingSnapshot } from "../../src/app-binding/run.ts";

interface ObservedApp {
  generation: number;
  document: { rows: { id: string; audioText: string }[]; docId: string };
  counts: { compositionMark: number; dropEmptySince: number; hold: number };
  heldSelection: { anchor: { rowId: string; offset: number }; head: { rowId: string; offset: number } };
}

const evidence = readAppBindingEvidence();
function present<T>(value: T | null | undefined): T { assert.ok(value !== null && value !== undefined); return value; }
function app(snapshot: AppBindingSnapshot): ObservedApp { return snapshot.app as ObservedApp; }
function probe(name: string) { return present(evidence.probes.find(probe => probe.name === name)); }
function texts(snapshot: AppBindingSnapshot): string[] { return app(snapshot).document.rows.map(row => row.audioText); }
function events(snapshot: AppBindingSnapshot, type: string, phase: string) { return snapshot.events.filter(event => event.type === type && event.phase === phase); }

test("real-app evidence pins the pushed app patch and covers exactly all 72 prescribed cases", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../app-binding/manifest.json", import.meta.url), "utf8")) as { appCommit: string };
  assert.equal(evidence.appCommit, manifest.appCommit);
  assert.match(evidence.appCommit, /^[a-f0-9]{40}$/);
  assert.match(evidence.harnessSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.instanceDocId, /^d[a-f0-9]{32}$/);
  assert.match(String(evidence.version.product), /^Edg\//);
  assert.deepEqual(evidence.off, { rows: 2, experiment: null, errors: null });
  assert.deepEqual(evidence.traces.map(result => `${result.trace}/${result.mechanism}/${result.order}`),
    bufferTraceOrder.flatMap(trace => bufferMechanisms.flatMap(mechanism => bufferOracles[trace].orders.map(order => `${trace}/${mechanism}/${order}`))));
  assert.equal(evidence.traces.length, 72);
});

test("the retained browser evidence names the exact current injected prototype bundle", async () => {
  const bundle = await build({ absWorkingDir: fileURLToPath(new URL("../../../../", import.meta.url)), entryPoints: [fileURLToPath(new URL("../../src/app-binding/page.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
  const script = present(bundle.outputFiles?.[0]?.text);
  assert.equal(createHash("sha256").update(script).digest("hex"), evidence.harnessSha256);
});

for (const result of evidence.traces) {
  test(`real app ${result.trace} ${result.mechanism} ${result.order}: literal identities, recovery, DOM caret and selective undo`, () => {
    assert.equal(result.status, "PASS", result.difference ?? "");
    assert.equal(result.difference, null);
    const forward = present(result.forward);
    assert.equal(app(forward).document.docId, evidence.instanceDocId);
    assert.equal(app(result.snapshot).document.docId, evidence.instanceDocId);
    const fixture = bufferOracles[result.trace as BufferTrace];
    checkAppBindingSnapshot(forward, fixture.expected, result.mechanism, result.order);
    checkAppBindingSnapshot(result.snapshot, fixture.undo, result.mechanism, result.order);
    assert.ok(forward.events.some(event => event.type === "beforeinput" && event.trusted));
    assert.ok(result.snapshot.commits.includes("writer:selectiveUndo"));
    assert.equal(app(result.snapshot).generation, app(forward).generation);
    if (result.trace.startsWith("T04") || result.trace.includes("composition")) {
      assert.ok(forward.commits.includes("syncComposition:syncBeatEl"));
      assert.equal(forward.commits.includes("driver:instrumented-held-sync"), false);
    } else if (result.trace === "T02") {
      assert.ok(forward.commits.includes("beforeinput:stale"));
      assert.ok(forward.events.some(event => event.type === "beforeinput" && event.cancelled));
      assert.equal(forward.events.some(event => event.type === "input"), false);
    } else assert.ok(forward.commits.includes("driver:instrumented-held-sync"));
    for (const snapshot of [forward, result.snapshot]) {
      const held = app(snapshot).heldSelection;
      const caret = (snapshot === forward ? fixture.expected : fixture.undo).carets.A;
      assert.equal(held.anchor.rowId, caret?.beat);
      assert.equal(held.head.rowId, caret?.beat);
      assert.deepEqual([held.anchor.offset, held.head.offset], snapshot.selection);
      assert.equal(app(snapshot).generation, (present(snapshot.events[0]).app as ObservedApp).generation);
    }
  });
}

test("ordinary native edits enter with a stale session and commit by the end of the real input handler", () => {
  for (const [name, expected] of [["typing", "the thea"], ["Backspace", "the th"], ["Delete", "the he"], ["typing over selection", "the a"]] as const) {
    const snapshot = present(evidence.inputs.find(input => input.name === name)).snapshot;
    assert.deepEqual(snapshot.errors, []);
    const before = present(events(snapshot, "input", "capture")[0]);
    const after = present(events(snapshot, "input", "bubble")[0]);
    assert.equal(before.text, expected);
    assert.equal((before.app as ObservedApp).document.rows[0]?.audioText, "the the");
    assert.equal((after.app as ObservedApp).document.rows[0]?.audioText, expected);
    assert.equal((after.app as ObservedApp).generation, (before.app as ObservedApp).generation + 1);
    assert.equal(before.trusted, true);
    assert.equal(after.trusted, true);
  }
});

test("paste, cut, Enter and undo shortcut are synchronous model commands with native defaults cancelled", () => {
  for (const [name, type, expected] of [["paste", "paste", ["the Q"]], ["cut", "cut", ["the "]], ["Enter", "keydown", ["the ", "the"]], ["native undo shortcut", "keydown", ["the the"]]] as const) {
    const snapshot = present(evidence.inputs.find(input => input.name === name)).snapshot;
    assert.deepEqual(snapshot.errors, []);
    const before = present(events(snapshot, type, "capture")[0]);
    const after = present(events(snapshot, type, "bubble")[0]);
    assert.equal(after.cancelled, true, name);
    assert.deepEqual((after.app as ObservedApp).document.rows.map(row => row.audioText), expected, name);
    assert.equal((after.app as ObservedApp).generation, (before.app as ObservedApp).generation + 1, name);
    assert.equal(events(snapshot, "input", "capture").length, 0, name);
  }
});

test("Writer composition remains dirty across tasks and commits synchronously at compositionend", () => {
  const snapshot = present(evidence.inputs.find(input => input.name === "composition")).snapshot;
  const inputs = events(snapshot, "input", "bubble");
  assert.equal(inputs.length, 3);
  for (const input of inputs) {
    assert.equal((input.app as ObservedApp).document.rows[0]?.audioText, "the the");
    assert.equal(input.cancelable, false);
  }
  const start = present(events(snapshot, "compositionend", "capture")[0]);
  const end = present(events(snapshot, "compositionend", "bubble")[0]);
  assert.equal((start.app as ObservedApp).document.rows[0]?.audioText, "the the");
  assert.equal((end.app as ObservedApp).document.rows[0]?.audioText, "the xythe");
  assert.equal((end.app as ObservedApp).generation, (start.app as ObservedApp).generation + 1);
});

test("T02 boundary uses the real leading sentinel and the app mapper skips it", () => {
  for (const result of evidence.traces.filter(result => result.trace === "T02 boundary")) {
    const before = present(events(present(result.forward), "beforeinput", "capture")[0]);
    assert.equal(String(before.rawText).startsWith("\u200b"), true);
    const range = present((before.ranges as { rawStart: number; rawEnd: number; from: number; to: number; startBeat: string; endBeat: string }[])[0]);
    assert.deepEqual(range, { startBeat: "R2", endBeat: "R2", rawStart: 1, rawEnd: 1, from: 0, to: 0 });
    assert.deepEqual(before.selection, [0, 0]);
  }
});

test("all mechanisms reach real synchronous syncBeatEl and existing composition repaint deferral", () => {
  for (const mechanism of bufferMechanisms) {
    const synchronous = probe(`synchronous input ${mechanism}`).stages;
    const first = present(synchronous[0]);
    assert.equal(first.dirty, false);
    assert.deepEqual(first.commits, ["onInput:syncBeatEl"]);
    assert.deepEqual(texts(first), ["the a"]);
    checkAppBindingSnapshot(present(synchronous[1]), bufferOracles["T03 replace"].expected, mechanism, "D3");
    checkAppBindingSnapshot(present(synchronous[2]), bufferOracles["T03 replace"].undo, mechanism, "D3");
    const composition = probe(`composition repaint deferral ${mechanism}`).stages;
    const dirty = present(composition[1]);
    assert.equal(dirty.text, "abxcd");
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.composing, true);
    assert.deepEqual(texts(dirty), [mechanism === "M2" ? "Zabc" : "abcd", "ef"]);
    assert.equal(dirty.heldBytes, mechanism === "M2" ? 0 : 18);
    if (mechanism === "M3") assert.equal(dirty.models["A.N"]?.rows[0]?.characters.map(character => character.value).join(""), "Zabc");
    checkAppBindingSnapshot(present(composition[2]), bufferOracles.T04.expected, mechanism, "D3");
  }
});

test("standalone undo holds are bypassed by the experimental selective route under every mechanism", () => {
  for (const mechanism of bufferMechanisms) {
    const stages = probe(`standalone undo hold bypass ${mechanism}`).stages;
    const before = present(stages[0]); const after = present(stages[1]);
    assert.equal(app(before).counts.hold, 1);
    assert.equal(app(after).counts.hold, 1);
    assert.equal(before.text, "the an");
    assert.equal(after.text, "the then");
    assert.deepEqual(after.selection, [4, 7]);
  }
});

test("Writer host blur finishes protocol composition and retains the provisional local character", () => {
  for (const mechanism of bufferMechanisms) {
    const stages = probe(`writer host blur during composition ${mechanism}`).stages;
    assert.equal(stages[0]?.composing, true);
    const after = present(stages[1]);
    assert.equal(after.composing, false);
    assert.equal(after.dirty, false);
    assert.equal(after.text, "Zabxc");
    assert.equal(after.selection, null);
    assert.deepEqual(after.errors, []);
    assert.ok(after.commits.includes("syncComposition:syncBeatEl"));
    assert.ok(after.events.some(event => event.type === "focusout"));
  }
});

test("the generic composition mark is not reached by Writer host events and the diagnostic positive control works", () => {
  for (const result of evidence.traces) {
    assert.equal(app(result.snapshot).counts.compositionMark, 0);
    assert.equal(app(result.snapshot).counts.dropEmptySince, 0);
  }
  const control = probe("undo owner instrumentation controls");
  assert.deepEqual(app(present(control.stages[0])).counts, { compositionMark: 0, dropEmptySince: 0, hold: 0 });
  assert.deepEqual(app(present(control.stages[1])).counts, { compositionMark: 1, dropEmptySince: 1, hold: 0 });
  assert.deepEqual(control.result, { mark: false, hold: { ok: false, empty: true } });
});

test("unbound whole-beat reconciliation loses the remote composition changes and missing sync hooks fail closed", () => {
  const stages = probe("unbound whole-beat reconciliation overwrites remote").stages;
  assert.deepEqual(texts(present(stages[0])), ["abcd", "ef"]);
  assert.deepEqual(texts(present(stages[1])), ["Zabc", "ef"]);
  assert.deepEqual(texts(present(stages[2])), ["abxycd", "ef"]);
  const removed = present(probe("sync hook removed").stages[0]);
  assert.equal(removed.dirty, true);
  assert.deepEqual(removed.commits, []);
  assert.deepEqual(removed.errors, ["App whole-field command bypassed replica binding"]);
});

test("SLICE guards refuse direct writes, standalone stamps, legacy writes and all three comment bypass commands", () => {
  const isolation = probe("SLICE isolated session writers");
  assert.deepEqual(isolation.stages[1]?.app, isolation.stages[0]?.app);
  const result = isolation.result as Record<string, unknown>;
  assert.equal(result.documentReader, "DocumentWriteError");
  assert.equal(result["liveSession.held"], "DocumentWriteError");
  for (const name of ["stamp", "addComment", "addReply", "unwrap", "replay", "amend"]) assert.equal((result[name] as { kind: string }).kind, "rejected", name);
  assert.equal(result.adopt, "Whole-document replacement is isolated in the binding experiment");
});

test("a remote edit to the other beat keeps the focused beat, text node, sentinel and caret without a new local update", () => {
  const other = probe("remote other beat preserves focused DOM");
  assert.deepEqual(other.result, { sameBeat: true, sameText: true, focused: "writer-doc" });
  const before = present(other.stages[0]); const after = present(other.stages[1]);
  assert.deepEqual(before.selection, [0, 0]);
  assert.deepEqual(after.selection, [0, 0]);
  assert.equal(after.rawText, "\u200bcd");
  assert.equal(app(after).generation, app(before).generation);
  assert.equal(after.history.some(line => line.startsWith("queue enqueue A")), false);
});

test("the retained real-app checker rejects missing remote text, duplicated identity and omitted fields", () => {
  const original = present(evidence.traces.find(result => result.trace === "T04" && result.mechanism === "M2" && result.order === "D3")?.forward);
  for (const defect of ["lost", "duplicate", "omitted"]) {
    const copy = structuredClone(original);
    const model = present(copy.models["A.E"]);
    const row = present(model.rows[0]);
    if (defect === "lost") row.characters.shift();
    else if (defect === "duplicate") present(row.characters[1]).identity = present(row.characters[0]).identity;
    else Reflect.deleteProperty(model, "recovery");
    assert.throws(() => checkAppBindingSnapshot(copy, bufferOracles.T04.expected, "M2", "D3"));
  }
});

test("retained minimized real-app histories match the measured evidence", () => { checkAppBindingHistories(evidence); });
