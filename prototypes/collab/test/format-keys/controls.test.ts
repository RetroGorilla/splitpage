import assert from "node:assert/strict";
import test from "node:test";
import type * as Y from "yjs";
import { drivePattern } from "../../src/format-keys/life.ts";
import { readCell } from "../../src/format-keys/model.ts";
import { generateRace, runRace } from "../../src/format-keys/race.ts";
import type { RaceStep } from "../../src/format-keys/race.ts";
import { CheckFailure, World } from "../../src/format-keys/world.ts";
import { nativeMarkName } from "../../src/native/variant.ts";
import type { NativeReplica } from "../../src/native/variant.ts";

type Fault = "format(value)" | "format(null)" | "insert";
const faults: Fault[] = ["format(value)", "format(null)", "insert"];

function intercept(text: Y.Text, mute: (fault: Fault, keys?: string[]) => boolean): void {
  const format = text.format.bind(text), insert = text.insert.bind(text);
  text.format = (at, length, attributes) => {
    if (!mute(Object.values(attributes).some(value => value === true) ? "format(value)" : "format(null)", Object.keys(attributes))) {
      format(at, length, attributes);
    }
  };
  text.insert = (at, value, attributes) => {
    if (!mute("insert")) insert(at, value, attributes);
  };
}

function selectionChanges(step: Extract<RaceStep, { first: string; kind: string }>, replica: NativeReplica): boolean {
  const chars = readCell(replica.block("R1").delta);
  const from = chars.findIndex(char => char.ch === step.first), to = chars.findIndex(char => char.ch === step.last);
  return chars.slice(from, to + 1).some(char => char.names.includes(step.kind) !== (step.op === "add"));
}

test("call-level controls catch every reached race command with a visible effect", t => {
  const counts = new Map(faults.map(fault => [fault, { reached: 0, used: 0, failed: 0 }]));
  for (const delivery of ["updates", "shuffled", "state"] as const) for (let seed = 1; seed <= 400; seed++) {
    const steps = generateRace(seed, 2, 20), reached = new Set<Fault>(), eligible = new Map<Fault, number>();
    let position = -1;
    const beforeStep = (_step: RaceStep, at: number) => { position = at; };
    const observe = (replica: NativeReplica) => {
      intercept(replica.cell("R1", "audioText").text, (fault, keys) => {
        const step = steps[position];
        if (!step) return false;
        if (fault === "insert" && step.op === "insert") {
          reached.add(fault);
          if (!eligible.has(fault)) eligible.set(fault, position);
        } else if ((fault === "format(value)" && step.op === "add") || (fault === "format(null)" && step.op === "remove")) {
          if (keys?.some(key => nativeMarkName(key) === step.kind)) {
            reached.add(fault);
            if (!eligible.has(fault) && selectionChanges(step, replica)) eligible.set(fault, position);
          }
        }
        return false;
      });
    };
    const baseline = runRace(steps, 2, delivery, undefined, observe, beforeStep);
    assert.equal(baseline.ineffective, 0, `${delivery}, seed ${seed}`);
    for (const fault of reached) {
      const count = counts.get(fault);
      assert.ok(count);
      count.reached++;
    }
    for (const [fault, target] of eligible) {
      const count = counts.get(fault);
      assert.ok(count);
      let muted = false;
      const patch = (replica: NativeReplica) => intercept(replica.cell("R1", "audioText").text, call => {
        if (position !== target || call !== fault) return false;
        muted = true;
        return true;
      });
      const result = runRace(steps, 2, delivery, undefined, patch, beforeStep);
      assert.ok(muted, `${delivery}, seed ${seed}, reached the muted ${fault} call`);
      count.used++;
      assert.equal(result.ineffective, 1, `${delivery}, seed ${seed}, ${fault}`);
      assert.equal(result.at, target, `${delivery}, seed ${seed}, ${fault}`);
      count.failed++;
    }
  }
  for (const [fault, count] of counts) {
    t.diagnostic(`race ${fault}: ${count.reached} reached, ${count.used} used with a visible effect, ${count.failed} failed`);
    assert.ok(count.used > 0);
    assert.equal(count.failed, count.used);
  }
});

test("muting Y.Text.format(null) fails punch before the following bold", t => {
  const world = new World({ rows: [{ id: "one", audioText: "o".repeat(400), visualText: "" }] }, "act", 1);
  t.after(() => world.destroy());
  const [writer] = world.writers;
  assert.ok(writer);
  let used = 0;
  intercept(writer.cell("one", "audioText").text, fault => {
    if (fault !== "format(null)") return false;
    used++;
    return true;
  });
  assert.throws(() => drivePattern(world, "punch", 10), CheckFailure);
  assert.equal(world.formatting, 2);
  assert.equal(used, 1);
  t.diagnostic("punch format(null): 1 used, 1 failed at the unbold");
});

test("seed 31 catches a muted insert after a restored letter occurs twice", t => {
  const steps = generateRace(31, 2, 20);
  let used = 0;
  for (const delivery of ["updates", "shuffled", "state"] as const) {
    assert.equal(runRace(steps, 2, delivery).same, true);
    const patch = (replica: NativeReplica) => intercept(replica.cell("R1", "audioText").text, fault => {
      if (fault !== "insert") return false;
      const original = readCell(replica.block("R1").delta).map(char => char.ch);
      assert.ok(new Set(original).size < original.length);
      used++;
      return true;
    });
    const run = runRace(steps, 2, delivery, undefined, patch);
    assert.equal(run.at, 17);
    assert.equal(run.ineffective, 1);
  }
  assert.equal(used, 6);
  t.diagnostic("seed 31 insert: 3 histories used, 3 failed");
});
