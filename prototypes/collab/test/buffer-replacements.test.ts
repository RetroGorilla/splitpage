import assert from "node:assert/strict";
import { test } from "node:test";
import { BufferHarness } from "../src/buffer-harness.ts";
import { BufferMappingError, bufferMechanisms } from "../src/editing-buffer.ts";
import { replacementIntentFixtures } from "./buffer-replacements.ts";
import { runReplacementIntent } from "./buffer-replacement-runner.ts";

for (const fixture of replacementIntentFixtures) {
  for (const mechanism of bufferMechanisms) {
    for (const candidate of ["A", "B"] as const) {
      for (const order of fixture.orders) {
        test(`${fixture.name}: ${candidate} ${mechanism} ${order} preserves replacement identities and undo selection`, () => {
          const harness = new BufferHarness(candidate, mechanism, [{ id: "R1", text: "the the" }]);
          try {
            runReplacementIntent(harness, fixture, order);
          } finally {
            harness.destroy();
          }
        });
      }
    }
  }
}

for (const mechanism of bufferMechanisms) {
  test(`${mechanism}: disjoint targets never delete an untouched painted identity`, () => {
    const harness = new BufferHarness("A", mechanism, [{ id: "R1", text: "the the" }]);
    try {
      const alice = harness.alice;
      alice.paint("R1", 0, 1);
      alice.dispatch({ type: "beforeinput", from: 0, to: 1, data: "T", names: ["a1"] });
      alice.dispatch({ type: "beforeinput", from: 6, to: 7, data: "E", names: ["a2"] });
      assert.throws(() => alice.commit(["a1", "a2"]), BufferMappingError);
      assert.equal(alice.dirty, true);
      assert.equal(alice.nativeValue, "The thE");
      assert.deepEqual(alice.editor.characters().map(character => harness.identities.notation(character.identity)), ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    } finally {
      harness.destroy();
    }
  });
  test(`${mechanism}: identical text without target evidence remains ambiguous`, () => {
    const harness = new BufferHarness("A", mechanism, [{ id: "R1", text: "the the" }]);
    try {
      const alice = harness.alice;
      alice.paint("R1", 4, 7);
      alice.targetEvidence = false;
      alice.dispatch({ type: "beforeinput", from: 4, to: 7, data: "the", names: ["a1", "a2", "a3"] });
      assert.throws(() => alice.commit(["a1", "a2", "a3"]), /Ambiguous native diff: 8 minimal splices; target evidence absent/);
      assert.equal(alice.dirty, true);
      assert.equal(alice.nativeValue, "the the");
    } finally {
      harness.destroy();
    }
  });
}
