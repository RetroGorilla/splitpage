import assert from "node:assert/strict";
import { test } from "node:test";
import { bufferOracles, bufferTraceOrder } from "../buffer-oracles.ts";
import type { BufferTrace } from "../buffer-oracles.ts";
import { bufferMechanisms } from "../../src/editing-buffer.ts";
import { checkSliceArtifacts, checkSliceSnapshot, readSliceEvidence } from "../../src/slice/report.ts";

const evidence = readSliceEvidence();

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

function probeStages(name: string): typeof evidence.probes[number]["stages"] {
  return present(evidence.probes.find(probe => probe.name === name)).stages;
}

test("browser evidence covers exactly the prescribed traces, mechanisms and delivery orders", () => {
  assert.match(String(evidence.version.product), /^Edg\/\d/);
  const expected = bufferTraceOrder.flatMap(trace => bufferMechanisms.flatMap(mechanism => bufferOracles[trace].orders.map(order => `${trace}/${mechanism}/${order}`)));
  assert.deepEqual(evidence.traces.map(result => `${result.trace}/${result.mechanism}/${result.order}`), expected);
  assert.equal(evidence.traces.length, 72);
  assert.equal(evidence.inputs.length, 12);
});

for (const result of evidence.traces) {
  test(`recorded browser ${result.trace} ${result.mechanism} ${result.order} matches literal forward and undo identity oracles`, () => {
    assert.equal(result.status, "PASS", result.difference ?? "");
    assert.equal(result.difference, null);
    assert.ok(result.forward);
    const fixture = bufferOracles[result.trace as BufferTrace];
    checkSliceSnapshot(result.forward, fixture.expected, result.mechanism, result.order);
    checkSliceSnapshot(result.snapshot, fixture.undo, result.mechanism, result.order);
    assert.ok(result.forward.events.some(event => event.type === "beforeinput" && event.trusted));
    assert.ok(result.snapshot.commits.includes("beforeinput:historyUndo"));
    if (result.trace.includes("composition") || result.trace.startsWith("T04")) assert.ok(result.forward.commits.includes("compositionend"));
    if (result.trace === "T02") {
      assert.ok(result.forward.commits.includes("beforeinput:stale"));
      assert.ok(result.forward.events.some(event => event.type === "beforeinput" && event.cancelled));
      assert.equal(result.forward.events.some(event => event.type === "input"), false);
    }
  });
}

test("native repeated-text input supplies real target ranges before mutation", () => {
  const expected: Record<string, [number, number]> = {
    "typing one character": [7, 7], "Backspace collapsed": [6, 7], "Delete collapsed": [4, 5],
    "Backspace selection": [4, 7], "typing over selection": [4, 7], "paste over selection": [4, 7],
    cut: [4, 7], "Ctrl+Backspace": [4, 7], Enter: [4, 4], "native undo Ctrl+Z": [8, 8],
    "composition at caret": [4, 4], "composition over selection": [4, 7]
  };
  assert.deepEqual(evidence.inputs.map(input => input.name).sort(), Object.keys(expected).sort());
  for (const { name, snapshot } of evidence.inputs) {
    assert.deepEqual(snapshot.errors, []);
    const before = snapshot.events.find(event => event.type === "beforeinput");
    assert.ok(before, name);
    assert.deepEqual(before.ranges, [expected[name]], name);
    assert.equal(before.trusted, true, name);
    assert.equal(before.cancelable, !name.startsWith("composition"), name);
    assert.equal(before.rangeNodes.length, 1, name);
    for (const input of snapshot.events.filter(event => event.type === "input")) {
      assert.equal(input.trusted, true);
      assert.deepEqual(input.ranges, []);
    }
  }
});

test("composition cannot be cancelled and retains initial selection evidence", () => {
  for (const name of ["composition at caret", "composition over selection"]) {
    const snapshot = present(evidence.inputs.find(input => input.name === name)).snapshot;
    assert.equal(snapshot.events[0]?.type, "compositionstart");
    assert.equal(snapshot.events.at(-1)?.type, "compositionend");
    assert.equal(snapshot.events.at(-1)?.trusted, false);
    assert.equal(snapshot.events.filter(event => event.type === "input").length, 3);
    assert.equal(snapshot.text, name.endsWith("selection") ? "the xy" : "the xythe");
  }
  const probe = present(probeStages("composition beforeinput cancellation attempt")[0]);
  assert.equal(probe.text, "the xthe");
  for (const event of probe.events.filter(event => event.type === "beforeinput")) {
    assert.equal(event.cancelable, false);
    assert.equal(event.cancelled, false);
  }
});

test("replacing the beat or active text node disrupts composition even with selection restored", () => {
  for (const mode of ["whole", "text"]) {
    const plain = probeStages(`${mode} repaint during composition`);
    assert.equal(plain[0]?.text, "the xthe");
    assert.equal(plain[1]?.text, "the xthe");
    assert.notEqual(plain[2]?.text, "the xythe");
    assert.equal(plain[2]?.events.filter(event => event.type === "compositionstart").length, 2);
    const restored = probeStages(`${mode} repaint during composition with selection restoration`);
    assert.deepEqual(restored[1]?.selection, restored[0]?.selection);
    assert.equal(restored[2]?.text, "the xxythe");
    assert.equal(restored[2]?.events.filter(event => event.type === "compositionstart").length, 2);
  }
});

test("whole repaint requires explicit selection restoration and input can commit synchronously", () => {
  const plain = probeStages("whole repaint selection");
  assert.deepEqual(plain[0]?.selection, [4, 4]);
  assert.deepEqual(plain[1]?.selection, [0, 0]);
  const restored = probeStages("whole repaint explicit selection restoration");
  assert.deepEqual(restored[0]?.selection, [4, 7]);
  assert.deepEqual(restored[1]?.selection, [4, 7]);
  const committed = present(probeStages("synchronous input commit")[0]);
  assert.deepEqual(committed.errors, []);
  assert.deepEqual(committed.commits, ["input"]);
  assert.equal(committed.text, "the a");
  assert.deepEqual(committed.selection, [5, 5]);
  assert.equal(committed.dirty, false);
  const clean = present(probeStages("M2 clean remote repaint").at(-1));
  assert.equal(clean.html, "<strong>the</strong> the");
  assert.deepEqual(clean.selection, [7, 7]);
});

test("ordinary stale native operations can be cancelled before synchronous identity-mapped repaint", () => {
  const probes = evidence.probes.filter(probe => probe.name.startsWith("stale cancellation"));
  assert.equal(probes.length, 6);
  for (const probe of probes) {
    const stage = present(probe.stages[0]);
    assert.deepEqual(stage.errors, [], probe.name);
    assert.equal(stage.dirty, false, probe.name);
    assert.deepEqual(stage.commits, ["beforeinput:stale"], probe.name);
    assert.ok(stage.events.some(event => event.type === "beforeinput" && event.cancelled), probe.name);
    assert.equal(stage.events.some(event => event.type === "input"), false, probe.name);
    assert.equal(stage.models["A.E"]?.rows[0]?.characters.at(-1)?.notation, "b1");
  }
});

test("identical native selection replacement exposes the unchanged mapper limitation under every mechanism", () => {
  for (const mechanism of bufferMechanisms) {
    const probe = present(probeStages(`T03 replace identical text ${mechanism}`)[0]);
    assert.equal(probe.text, "the the");
    assert.deepEqual(probe.events.find(event => event.type === "beforeinput")?.ranges, [[4, 7]]);
    assert.deepEqual(probe.errors, ["Ambiguous native diff: 0 minimal splices; target evidence present"]);
    assert.equal(probe.dirty, true);
    assert.deepEqual(probe.commits, []);
  }
});

test("retained report and minimized browser histories match the measured evidence", () => { checkSliceArtifacts(evidence); });
