import assert from "node:assert/strict";
import { test } from "node:test";
import { BufferHarness } from "../src/buffer-harness.ts";
import { bufferMechanisms } from "../src/editing-buffer.ts";
import { bufferOracles, bufferTraceOrder } from "./buffer-oracles.ts";
import { finishTrace, stageTrace } from "./buffer-runner.ts";

for (const trace of bufferTraceOrder) {
  for (const mechanism of bufferMechanisms) {
    for (const candidate of ["A", "B"] as const) {
      for (const order of bufferOracles[trace].orders) {
        test(`${trace} ${mechanism} candidate ${candidate} ${order}, including undo and selection`, () => {
          const harness = new BufferHarness(candidate, mechanism, bufferOracles[trace].seed);
          try {
            const names = stageTrace(harness, trace, order);
            if (trace === "T04") {
              const editor = harness.alice.editor.characters().filter(character => character.beat === "R1").map(character => character.value).join("");
              const network = harness.alice.network.characters().filter(character => character.beat === "R1").map(character => character.value).join("");
              assert.equal(editor, mechanism === "M2" ? "Zabc" : "abcd");
              assert.equal(network, mechanism === "M1" ? "abcd" : "Zabc");
              assert.equal(harness.alice.nativeValue, "abxycd");
              assert.equal(harness.alice.composing, true);
            }
            finishTrace(harness, trace, order, names);
          } finally {
            harness.destroy();
          }
        });
      }
    }
  }
}

for (const candidate of ["A", "B"] as const) {
  for (const mechanism of bufferMechanisms) {
    for (const path of ["delivery", "hydration", "recovery-restore"]) {
      test(`${candidate} ${mechanism}: the simulated ${path} ingress uses the same dirty gate`, () => {
        const harness = new BufferHarness(candidate, mechanism, bufferOracles.T04.seed);
        try {
          const alice = harness.alice;
          alice.paint("R1", 2);
          alice.dispatch({ type: "compositionstart", from: 2, to: 2 });
          alice.dispatch({ type: "compositionupdate", data: "xy" });
          harness.bob.editor.insert("R1", 0, "Z", ["b1"]);
          harness.bob.editor.deleteIdentities(["s4"]);
          for (const message of harness.queue.pending.filter(message => message.from === "B")) alice.receive(message.update, path);
          assert.equal(alice.editor.characters().filter(character => character.beat === "R1").map(character => character.value).join(""), mechanism === "M2" ? "Zabc" : "abcd");
          alice.dispatch({ type: "compositionend", names: ["a1", "a2"] });
          harness.queue.flush("dup");
          harness.check(bufferOracles.T04.expected);
          alice.undo();
          harness.queue.flush("dup");
          harness.check(bufferOracles.T04.undo);
        } finally {
          harness.destroy();
        }
      });
    }
    test(`${candidate} ${mechanism}: clean remote integration repaints before the next native input`, () => {
      const harness = new BufferHarness(candidate, mechanism, bufferOracles.T02.seed);
      try {
        harness.alice.paint("R1", 2);
        harness.bob.editor.insert("R1", 0, "X", ["b1"]);
        harness.queue.deliverFrom("B", "D3");
        assert.equal(harness.alice.nativeValue, "Xab");
        harness.alice.dispatch({ type: "beforeinput", from: 3, to: 3, data: "c", names: ["a1"] });
        harness.alice.commit(["a1"]);
        harness.queue.flush("D3");
        harness.check(bufferOracles.T02.expected);
        harness.alice.undo();
        harness.queue.flush("D3");
        harness.check(bufferOracles.T02.undo);
      } finally {
        harness.destroy();
      }
    });
  }
}
