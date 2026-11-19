import assert from "node:assert/strict";
import test from "node:test";
import { MODES } from "../native-chosen/engine.ts";
import { outline } from "../native-chosen/kit.ts";
import { replay } from "../native-kept/replay.ts";
import type { KeptStep } from "../native-kept/replay.ts";
import { NAMED, act, justTwo, redo, remove, split, sync, undo } from "../native-rank-undo/histories.ts";
import { missingContainers } from "./reachability.ts";

test("E16 creation undo crosses an offline cut and cut undo", () => {
  const steps = [split(0, "B", 0, "N"), { from: 0, to: 1 }, remove(1, "N"), undo(1), undo(0)];
  for (const mode of MODES) {
    const findings: string[][] = [];
    const result = replay(justTwo(), steps, 2, true, mode, 1, undefined, {
      command: replica => assert.deepEqual(missingContainers(replica), []),
      settled: replica => findings.push(missingContainers(replica))
    });
    assert.deepEqual(findings, Array.from({ length: 4 }, () => ["N record", "N visual"]), mode);
    assert.deepEqual(result.lines, ["A: a / ", "B:  / ", "N: b / "], mode);
    assert.equal(result.problems.length, 8);
    assert.ok(result.problems.every(problem => /beat N has no (record|visual cell)$/.test(problem)));
    const edit = act(0, { op: "type", id: "N", field: "visual", at: 0, text: "v" });
    const extended = replay(justTwo(), [...steps, ...sync(2), edit], 2, true, mode, 1);
    assert.ok(extended.problems.some(problem => problem.endsWith("threw: Missing visual N")));
    for (const index of [0, 2, 3, 4]) {
      const shorter = replay(justTwo(), steps.filter((_, at) => at !== index), 2, true, mode, 1);
      assert.ok(!shorter.problems.some(problem => /beat N has no (record|visual cell)$/.test(problem)));
    }
  }
});

test("E16 replays the three record-loss histories and the segment-head race", () => {
  for (const n of [12, 17, 18]) {
    const history = NAMED[n - 1];
    assert.ok(history);
    for (const mode of MODES) {
      const result = replay(history.spec, history.steps, history.writers, true, mode, n, undefined, {
        command: replica => assert.deepEqual(missingContainers(replica), []),
        settled: replica => assert.deepEqual(missingContainers(replica), [])
      });
      assert.deepEqual(result.problems, [], `${n} ${mode}`);
      const expected = n === 12 ? ["A: a / ", "B: b / "] :
        n === 17 ? ["C: c / ", "A: a / ", "B: b / "] : ["A: a / ", "#H h", "B: b / "];
      assert.deepEqual(result.lines, expected);
    }
  }
  for (const visual of ["", "1"]) {
    const spec = justTwo();
    spec.visuals.A = visual;
    const steps: KeptStep[] = [remove(0, "A"), remove(1, "A"), undo(0), undo(1), redo(1)];
    for (const mode of MODES) {
      const result = replay(spec, steps, 2, true, mode, 1, undefined, {
        settled(replica) {
          assert.deepEqual(outline(replica), ["B: ab / "]);
          assert.equal(replica.segments.get("S")?.has("head"), false);
          assert.ok(replica.beats.has("A") && replica.visuals.has("A"));
          assert.deepEqual(replica.recovery().map(({ beat, reason, visual }) => ({ beat, reason, visual })),
            visual ? [{ beat: "A", reason: "unplaced", visual }] : []);
        }
      });
      assert.deepEqual(result.problems, []);
    }
  }
});
