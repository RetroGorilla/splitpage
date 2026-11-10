import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { bindingFollowupCases, bindingFollowupInput } from "../../src/app-binding-2/cases.ts";
import { checkBindingFollowup } from "../../src/app-binding-2/checker.ts";
import { checkBindingFollowupHistories, readBindingFollowupEvidence } from "../../src/app-binding-2/report.ts";
import type { BindingFollowupResult, BindingFollowupStage } from "../../src/app-binding-2/run.ts";
import { bufferMechanisms } from "../../src/editing-buffer.ts";
import { bufferOracles } from "../buffer-oracles.ts";
import { checkModel, IdentityBook } from "../../src/model.ts";
import { validateReaderBrowserBundle } from "../../src/marks/status-browser-audit.ts";

const evidence = readBindingFollowupEvidence();
function present<T>(value: T | null | undefined): T { assert.ok(value !== null && value !== undefined); return value; }
function final(result: BindingFollowupResult): BindingFollowupStage { return present(result.stages.at(-1)); }
function observedFailure(result: BindingFollowupResult): boolean {
  return result.name === "split-before" && result.mechanism === "M2"
    || result.name.startsWith("reentry-") && (!result.retained || result.mechanism === "M2" && !result.paintGate && result.name !== "reentry-paste");
}

test("follow-up evidence pins the extended throwaway app and covers all 96 mechanism, order and re-entry variants", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../app-binding-2/manifest.json", import.meta.url), "utf8")) as { appCommit: string };
  assert.equal(evidence.appCommit, manifest.appCommit);
  assert.equal(evidence.appCommit, "935e618949a2e964198847daa2115d35e1da58ef");
  assert.match(String(evidence.version.product), /^Edg\//);
  assert.deepEqual(evidence.off, { rows: 2, experiment: null });
  assert.equal(evidence.machine.host, "<machine>");
  assert.equal(evidence.machine.node, "v24.22.1");
  const wanted = bindingFollowupCases.flatMap(name => bufferMechanisms.flatMap(mechanism =>
    (name.startsWith("reentry-") ? ["D3"] : name === "removed" ? ["D3", "late-C"] : ["D3", "dup", "late-C"]).flatMap(order =>
      (name.startsWith("reentry-") ? [[false, false], [true, false], [true, true]] : [[false, false]]).map(([retained, paintGate]) => `${name}/${mechanism}/${order}/${retained}/${paintGate}`))));
  assert.deepEqual(evidence.results.map(result => `${result.name}/${result.mechanism}/${result.order}/${result.retained}/${result.paintGate}`), wanted);
  assert.equal(evidence.results.length, 96);
  assert.equal(evidence.results.filter(result => result.status === "PASS").length, 82);
});

test("follow-up browser evidence reproduces its exact archived bundle and pins the status-only source change", async () => {
  const bundle = await build({ absWorkingDir: fileURLToPath(new URL("../../../../", import.meta.url)), entryPoints: [fileURLToPath(new URL("../../src/app-binding-2/page.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
  await validateReaderBrowserBundle("src/app-binding-2/page.ts", evidence.bundleSha256,
    createHash("sha256").update(present(bundle.outputFiles?.[0]?.text)).digest("hex"));
  const current = createHash("sha256").update(present(bundle.outputFiles?.[0]?.text)).digest("hex");
  await assert.rejects(validateReaderBrowserBundle("src/app-binding-2/page.ts", "0".repeat(64), current));
  await assert.rejects(validateReaderBrowserBundle("src/app-binding-2/page.ts", evidence.bundleSha256, "0".repeat(64)));
});

for (const result of evidence.results) {
  test(`retained invariant observation ${result.name}/${result.mechanism}/${result.order}/retain=${result.retained}/paintGate=${result.paintGate}`, () => {
    const last = final(result);
    const failures = checkBindingFollowup(bindingFollowupInput(result.name), last.facts, last, result.mechanism, result.order === "late-C");
    assert.deepEqual(result.failures, failures);
    assert.equal(result.status, failures.length ? "FAIL" : "PASS");
    assert.equal(result.status, observedFailure(result) ? "FAIL" : "PASS");
    assert.equal(last.history.filter(line => line.startsWith("queue enqueue B")).length, last.facts.updates);
    assert.ok(last.events.some(event => event.type === "input" && event.trusted) || result.name === "reentry-paste" && last.events.some(event => event.type === "paste" && event.trusted));
    if (result.status === "PASS") {
      assert.equal(last.queuePending, 0);
      assert.equal(last.heldBytes, 0);
      assert.equal(last.heldMessages, 0);
      assert.equal(last.history.filter(line => line.startsWith("queue enqueue A")).length, 1);
    }
    if (!result.name.startsWith("reentry-")) {
      const native = present(result.stages[1]); const remote = present(result.stages[2]);
      assert.equal(native.composing, true);
      assert.equal(remote.composing, true);
      const content = (row: typeof remote.dom[number]) => ({ id: row.id, text: row.text, html: row.html });
      assert.deepEqual(remote.dom.map(content), native.dom.map(content), "remote updates must preserve composing DOM content");
      assert.deepEqual(remote.remoteDOM, [{ sameNodes: true }]);
      if (!(result.mechanism === "M2" && ["join-previous", "removed"].includes(result.name))) assert.deepEqual(remote.dom, native.dom);
      assert.deepEqual(remote.paints, [], "the app must defer actual DOM paint during composition");
      assert.equal(last.commits.filter(name => name === "syncComposition:syncBeatEl").length, 1);
    }
  });
}

test("removed targets use the unchanged complete T04 removed forward and undo literal oracles", () => {
  for (const result of evidence.results.filter(result => result.name === "removed")) {
    assert.equal(result.literal, "PASS");
    assert.equal(result.literalUndo, "PASS");
    for (const [snapshot, oracle] of [[final(result), bufferOracles["T04 removed"].expected], [present(result.undo), bufferOracles["T04 removed"].undo]] as const) {
      const identities = new IdentityBook();
      for (const [name, identity] of Object.entries(snapshot.bindings)) identities.bind(name, identity);
      for (const [replica, model] of Object.entries(snapshot.models)) checkModel(model, oracle, identities, replica);
      const caret = present(oracle.carets.A);
      assert.deepEqual(snapshot.dom.find(row => row.id === caret.beat)?.selection, [caret.offset, caret.offset]);
    }
  }
});

test("recorded M2 selection validation clears the composing selection after join/removal without replacing DOM nodes", () => {
  for (const result of evidence.results.filter(result => result.mechanism === "M2" && ["join-previous", "removed"].includes(result.name))) {
    const native = present(result.stages[1]); const remote = present(result.stages[2]);
    assert.ok(native.dom.some(row => row.selection !== null));
    assert.ok(remote.dom.every(row => row.selection === null));
    assert.deepEqual(remote.remoteDOM, [{ sameNodes: true }]);
    assert.equal(result.status, "PASS");
  }
});

test("recorded split-before difference violates the painted identity location only under immediate integration", () => {
  for (const result of evidence.results.filter(result => result.name === "split-before")) {
    if (result.mechanism === "M2") {
      assert.ok(result.failures.every(failure => failure.includes("local text moved away from its painted left identity s2")));
      assert.deepEqual(final(result).dom.map(row => [row.id, row.text]), [["R1", "axy"], ["Rb", "bd"], ["R2", "ef"]]);
    } else assert.deepEqual(final(result).dom.map(row => [row.id, row.text]), [["R1", "a"], ["Rb", "bxyd"], ["R2", "ef"]]);
  }
});

test("recorded bold observation distinguishes marks on new local identities without selecting a product mark policy", () => {
  for (const result of evidence.results.filter(result => result.name === "bold")) {
    const last = final(result);
    assert.deepEqual(last.rawLocalMarks.map(item => item.marks), result.mechanism === "M2" ? [{}, {}] : [{ b: true }, { b: true }]);
    assert.equal(last.dom.find(row => row.id === "R1")?.html, result.mechanism === "M2" ? "a<strong>b</strong>xy<strong>c</strong>d" : "a<strong>bxyc</strong>d");
  }
});

test("comment and tag records survive with native DOM untouched; their app projection remains unbound", () => {
  for (const result of evidence.results.filter(result => result.name === "comment-tag")) {
    const last = final(result);
    assert.deepEqual(last.rawLocalMarks.map(item => Object.keys(item.marks).sort()), result.mechanism === "M2" ? [[], []] : [["c:C1", "t:oB"], ["c:C1", "t:oB"]]);
    for (const model of Object.values(last.models)) {
      const comment = (model.records?.comments as Record<string, { rowId: string; field: string; recovery: boolean }>).C1;
      assert.ok(comment);
      assert.equal(comment.rowId, "R1");
      assert.equal(comment.field, "audioText");
      assert.equal(comment.recovery, false);
      for (const local of model.rows.flatMap(row => row.characters).filter(character => character.identity?.client === 1)) {
        assert.equal(local.marks.tag, "P");
        assert.equal(local.marks["c:C1"], true);
      }
    }
    assert.equal(last.dom.find(row => row.id === "R1")?.html, "abxycd");
  }
});

test("240 known remote updates span both beats and M3 filters duplicates before its editor hold", () => {
  for (const result of evidence.results.filter(result => result.name === "long")) {
    const remote = present(result.stages[2]); const last = final(result);
    assert.equal(remote.facts.updates, 240);
    assert.equal(remote.facts.inserted.length, 160);
    assert.equal(remote.facts.deleted.length, 80);
    assert.equal(remote.history.filter(line => line.startsWith("queue enqueue B")).length, 240);
    assert.equal(remote.peak.transportMessages, 240);
    assert.equal(remote.heldMessages, result.mechanism === "M2" ? 0 : result.mechanism === "M1" && result.order === "dup" ? 480 : 240);
    assert.equal(remote.heldBytes, result.mechanism === "M2" ? 0 : result.mechanism === "M1" && result.order === "dup" ? 4636 : 2318);
    assert.equal(last.models["A.E"]?.rows.length, 2);
    for (const row of present(last.models["A.E"]).rows) assert.equal(row.characters.filter(character => character.identity?.client === 2).length, 40);
    const committed = present(result.stages[3]);
    assert.equal(committed.dirty, false);
    assert.equal(committed.composing, false);
    assert.equal(committed.paints.length, 4);
    assert.equal(last.paints.length, 6);
    for (let index = 0; index < last.paints.length; index += 2) {
      assert.equal(last.paints[index]?.phase, "start");
      assert.equal(last.paints[index + 1]?.phase, "end");
      assert.ok(present(last.paints[index + 1]).at - present(last.paints[index]).at >= 0);
    }
    const timing = present(committed.timings.find(timing => timing.phase === "commit-and-projection"));
    assert.ok(Number.isFinite(timing.ms) && timing.ms >= 0);
  }
});

test("ordinary re-entry occurs in a trusted listener after app beforeinput; M2 additionally needs native DOM paint deferral", () => {
  for (const result of evidence.results.filter(result => result.name === "reentry-type" || result.name === "reentry-replace")) {
    const last = final(result);
    assert.deepEqual(last.reentry[0], { where: "after-app-beforeinput", defaultPrevented: false, trusted: true, inputType: "insertText" });
    assert.equal(last.reentry[1]?.phase, "before-delivery");
    assert.equal(last.reentry[2]?.phase, "after-delivery");
    if (result.status === "PASS") {
      const committed = present(result.stages[1]);
      assert.equal(committed.dirty, false);
      assert.deepEqual(committed.dom, last.dom, "driver finish must not rescue a failed native commit");
      const model = present(committed.models["A.E"]);
      const app = committed.app as { document: { rows: { id: string; audioText: string }[] } };
      for (const row of model.rows) assert.equal(app.document.rows.find(item => item.id === row.id)?.audioText, row.characters.map(character => character.value).join(""));
      if (result.mechanism === "M2") assert.ok(committed.commits.includes("input:stale-reentry"));
      else assert.ok(committed.commits.includes("onInput:syncBeatEl"));
    }
  }
});

test("real paste uses the nearest model-command boundary and retains its captured selection before re-entry", () => {
  for (const result of evidence.results.filter(result => result.name === "reentry-paste")) {
    const last = final(result);
    assert.equal(last.events.some(event => event.type === "beforeinput" || event.type === "input"), false);
    assert.ok(last.events.some(event => event.type === "paste" && event.trusted && event.cancelled));
    assert.equal(last.reentry[0]?.where, "inside-flow-writer-commit-after-paste-range-captured");
    if (result.status === "PASS") {
      assert.equal(present(result.stages[1]).dirty, false);
      assert.deepEqual(present(result.stages[1]).dom, last.dom);
      assert.ok(last.commits.some(commit => commit.startsWith("paste:")));
    }
  }
});

test("the invariant checker rejects equally wrong replicas without inventing a combined visible-script oracle", () => {
  const good = present(evidence.results.find(result => result.name === "long" && result.mechanism === "M3" && result.order === "late-C"));
  for (const defect of ["lost-remote", "duplicate", "local-twice", "missing-replica"] as const) {
    const copy = structuredClone(final(good));
    if (defect === "missing-replica") Reflect.deleteProperty(copy.models, "C.N");
    else for (const model of Object.values(copy.models)) {
      const row = present(model.rows[0]);
      if (defect === "lost-remote") row.characters.splice(row.characters.findIndex(character => character.notation === "b2"), 1);
      else row.characters.push(structuredClone(present(row.characters.find(character => defect === "duplicate" ? character.notation === "s1" : character.identity?.client === 1))));
    }
    const failures = checkBindingFollowup(bindingFollowupInput(good.name), copy.facts, copy, good.mechanism, true);
    assert.ok(failures.length, defect);
    assert.ok(failures.some(failure => defect === "lost-remote" ? failure.includes("required identity/value b2") : defect === "missing-replica" ? failure.includes("replica coverage") : failure.includes("duplicated identity")), defect);
  }
});

test("the invariant checker rejects a lost remote mark or comment record even when every replica agrees", () => {
  const good = present(evidence.results.find(result => result.name === "comment-tag" && result.mechanism === "M2" && result.order === "D3"));
  for (const defect of ["mark", "record"]) {
    const copy = structuredClone(final(good));
    for (const model of Object.values(copy.models)) {
      if (defect === "record") Reflect.deleteProperty(present(model.records?.comments) as object, "C1");
      else for (const row of model.rows) for (const character of row.characters) if (character.notation === "s2") character.marks = {};
    }
    assert.ok(checkBindingFollowup(bindingFollowupInput(good.name), copy.facts, copy, good.mechanism, false).some(failure => failure.includes(defect === "record" ? "comment record" : "remote mark")));
  }
});

test("every failure and mechanism difference has a retained generated history", () => { checkBindingFollowupHistories(evidence); });

test("duplicate visible beat copies fail the identity projection boundary", () => {
  const good = present(evidence.results.find(result => result.name === "bold" && result.mechanism === "M1" && result.order === "D3"));
  const copy = structuredClone(final(good));
  copy.dom.push(structuredClone(present(copy.dom[0])));
  assert.ok(checkBindingFollowup(bindingFollowupInput(good.name), copy.facts, copy, good.mechanism, false).includes("DOM beat coverage differs from projection"));
});
