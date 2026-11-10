import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { bufferOracles, bufferTraceOrder } from "../buffer-oracles.ts";
import { bufferMechanisms } from "../../src/editing-buffer.ts";
import { IdentityBook, checkModel } from "../../src/model.ts";
import { bindingFollowupCases, bindingFollowupInput } from "../../src/app-binding-2/cases.ts";
import { checkBindingFollowup } from "../../src/app-binding-2/checker.ts";
import { publicBEvidence } from "../../src/b-surfaces/public.ts";
import type { BSurfaceEvidence, BMatrixSnapshot } from "../../src/b-surfaces/run.ts";
import type { observeBSchema } from "../../src/b-surfaces/schema-observation.ts";

function present<T>(value: T | null | undefined): T { assert.ok(value !== null && value !== undefined); return value; }
const evidence = ["writer", "slice", "split"].map(surface => JSON.parse(readFileSync(new URL(`../../b-surfaces/${surface}.json`, import.meta.url), "utf8")) as BSurfaceEvidence);

function checkLiteral(snapshot: BMatrixSnapshot, trace: keyof typeof bufferOracles, undo: boolean): void {
  const expected = undo ? bufferOracles[trace].undo : bufferOracles[trace].expected;
  const book = new IdentityBook();
  for (const [name, identity] of Object.entries(snapshot.bindings)) book.bind(name, identity);
  for (const [name, model] of Object.entries(snapshot.models)) checkModel(model, expected, book, name);
  assert.deepEqual(snapshot.selection, [expected.carets.A?.selection?.from ?? expected.carets.A?.offset, expected.carets.A?.selection?.to ?? expected.carets.A?.offset]);
  const row = present(expected.rows.find(row => row.id === expected.carets.A?.beat));
  assert.equal(snapshot.text, row.characters.map(character => character[1]).join(""));
}

for (const data of evidence) {
  test(`${data.surface}: exact B matrix coverage and source pin`, () => {
    assert.equal(data.candidate, "B");
    assert.match(data.environment.browser, /^Edg\//);
    assert.equal(data.appCommit, data.surface === "slice" ? null : "c67139b8806d04231d2f2c5bb89814370bab8ef6");
    const wanted = bufferTraceOrder.filter(trace => data.surface !== "split" || ["T04", "T04 removed"].includes(trace)).flatMap(trace =>
      (data.surface === "split" ? ["M1"] : bufferMechanisms).flatMap(mechanism => bufferOracles[trace].orders.map(order => `${trace}/${mechanism}/${order}`)));
    assert.deepEqual(data.traces.map(item => `${item.trace}/${item.mechanism}/${item.order}`), wanted);
    if (data.surface !== "slice") assert.deepEqual(data.off, { rows: 2, experiment: null });
    assert.equal(data.traces.length, data.surface === "split" ? 5 : 72);
  });
  test(`${data.surface}: evidence corresponds to the current B bundle`, async () => {
    const entry = data.surface === "writer" ? "followup-page.ts" : data.surface === "slice" ? "slice-page.ts" : "split-page.ts";
    const built = await build({ absWorkingDir: fileURLToPath(new URL("../../../../", import.meta.url)), entryPoints: [fileURLToPath(new URL(`../../src/b-surfaces/${entry}`, import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
    assert.equal(createHash("sha256").update(present(built.outputFiles?.[0]?.text)).digest("hex"), data.bundleSha256);
  });
  for (const result of data.traces) test(`${data.surface} B ${result.mechanism} ${result.trace} ${result.order}`, () => {
    assert.ok(result.stages.length >= 4);
    for (const stage of result.stages) {
      assert.equal(stage.candidate, "B");
      assert.ok(stage.segments.every(id => id.startsWith("seg-")));
    }
    if (data.surface === "split") {
      assert.equal(result.status, "FAIL");
      assert.match(present(result.difference), result.trace === "T04" ? /replaceChild/ : /removeChild/);
      const native = present(result.stages[1]); const remote = present(result.stages[2]); const after = present(result.stages[3]);
      assert.equal(native.text, "abxcd"); assert.equal(remote.text, native.text);
      assert.equal(remote.composing, true); assert.equal(remote.dirty, true);
      assert.equal((remote as typeof remote & { remoteNodesPreserved: boolean }).remoteNodesPreserved, true);
      assert.ok(after.commits.includes("compositionend:cellEditing.sync"));
      assert.equal(after.composing, false); assert.equal(after.dirty, false);
      assert.ok(after.events.some(event => event.type === "focusout"));
      assert.equal(after.errors.length, 1);
      assert.throws(() => checkLiteral(after, result.trace, false));
    } else {
      assert.equal(result.status, "PASS"); assert.equal(result.difference, null);
      checkLiteral(present(result.stages[4]), result.trace, false);
      checkLiteral(present(result.stages[5]), result.trace, true);
      assert.deepEqual(result.stages.at(-1)?.errors, []);
      if (result.trace === "T04" || result.trace === "T04 removed" || result.trace === "T01 composition") {
        assert.equal(result.stages[1]?.composing, true);
        assert.equal(result.stages[3]?.composing, false);
        assert.equal(result.stages[3]?.dirty, false);
      }
    }
  });
}

const writer = present(evidence.find(data => data.surface === "writer"));
test("B Writer follow-up retains all 96 combinations, including deliberate re-entry controls", () => {
  const wanted = bindingFollowupCases.flatMap(name => bufferMechanisms.flatMap(mechanism =>
    (name.startsWith("reentry-") ? ["D3"] : name === "removed" ? ["D3", "late-C"] : ["D3", "dup", "late-C"]).flatMap(order =>
      (name.startsWith("reentry-") ? [[false, false], [true, false], [true, true]] : [[false, false]]).map(([retained, paintGate]) => `${name}/${mechanism}/${order}/${retained}/${paintGate}`))));
  assert.deepEqual(writer.followup.map(result => `${result.name}/${result.mechanism}/${result.order}/${result.retained}/${result.paintGate}`), wanted);
  assert.equal(writer.followup.filter(result => result.mechanism === "M1" && result.status === "PASS").length, 29);
  assert.equal(writer.followup.filter(result => result.mechanism === "M1" && result.status === "FAIL").length, 3);
});

for (const result of writer.followup) test(`B follow-up ${result.name}/${result.mechanism}/${result.order}/${result.retained}/${result.paintGate}`, () => {
  const last = present(result.stages.at(-1));
  const failures = checkBindingFollowup(bindingFollowupInput(result.name), last.facts, last, result.mechanism, result.order === "late-C");
  assert.deepEqual(result.failures, failures);
  const deliberateReentry = result.name.startsWith("reentry-") && (!result.retained || result.mechanism === "M2" && !result.paintGate && result.name !== "reentry-paste");
  assert.equal(result.status, deliberateReentry || result.name === "split-before" && result.mechanism === "M2" ? "FAIL" : "PASS");
  const schema = (last as typeof last & { schema: ReturnType<typeof observeBSchema> }).schema;
  assert.equal(schema.candidate, "B"); assert.equal(schema.hasFlow, false);
  if (result.name.startsWith("split-")) {
    const source = present(schema.segments.find(segment => segment.id === "seg-R1"));
    assert.deepEqual(source.inner, [{ b: "Rb" }]);
    assert.equal(source.characters.some(character => character.beat === "Rb"), result.name !== "split-after");
    assert.equal(schema.segments.length, 2);
  }
  if (result.name === "bold") {
    for (const model of Object.values(last.models)) {
      const local = model.rows.flatMap(row => row.characters).filter(character => character.identity?.client === 1);
      assert.deepEqual(local.map(character => character.marks), result.mechanism === "M2" ? [{}, {}] : [{ b: true }, { b: true }]);
    }
  }
  if (result.name === "long") {
    assert.equal(last.facts.updates, 240);
    assert.equal(last.facts.inserted.length, 160); assert.equal(last.facts.deleted.length, 80);
    assert.equal(result.stages[2]?.history.filter(line => line.startsWith("queue enqueue B")).length, 240);
    assert.ok(Object.values(last.models).every(model => model.rows.every(row => row.characters.filter(character => character.identity?.client === 2).length === 40)));
  }
  if (result.name === "removed") {
    assert.equal(result.literal, "PASS"); assert.equal(result.literalUndo, "PASS");
    for (const [snapshot, oracle] of [[last, bufferOracles["T04 removed"].expected], [present(result.undo), bufferOracles["T04 removed"].undo]] as const) {
      const book = new IdentityBook(); for (const [name, identity] of Object.entries(snapshot.bindings)) book.bind(name, identity);
      for (const [name, model] of Object.entries(snapshot.models)) checkModel(model, oracle, book, name);
      const caret = present(oracle.carets.A);
      assert.deepEqual(snapshot.dom.find(row => row.id === caret.beat)?.selection, [caret.offset, caret.offset]);
    }
  }
});

test("public retention preserves valid HTML/JSON and omits local paths and timing samples", () => {
  const local = String.fromCharCode(88, 58, 92) + ["private", "profile", "case.html"].join(String.fromCharCode(92));
  const retained = JSON.parse(publicBEvidence({ html: '<input placeholder="http://">', detail: local, timings: [{ ms: 1 }], paints: [{ phase: "start", at: 5 }] })) as Record<string, unknown>;
  assert.equal(retained.html, '<input placeholder="http://">'); assert.equal(retained.detail, "<local-path>");
  assert.equal(Object.hasOwn(retained, "timings"), false); assert.deepEqual(retained.paints, [{ phase: "start" }]);
});

test("retained artifacts contain no machine name, account name, absolute drive path or measured timing fields", () => {
  for (const data of evidence) {
    const encoded = JSON.stringify(data);
    assert.doesNotMatch(encoded, /\b[A-Za-z]:[\\/]/);
    assert.doesNotMatch(encoded, /"(?:hostname|host|timings)":/);
    assert.doesNotMatch(encoded, /"paints":\[[^\]]*"at":/);
  }
});
