import assert from "node:assert/strict";
import test from "node:test";
import { readNotice } from "../../src/native-notice/yjs.ts";
import { MODES } from "../native-chosen/engine.ts";
import { outline } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Cmd, Step } from "../native-chosen/play.ts";
import { openCopy, replay } from "../native-kept/replay.ts";
import type { KeptStep } from "../native-kept/replay.ts";
import { NAMED, act, justTwo, redo, remove, split, sync, undo } from "../native-rank-undo/histories.ts";
import { missingContainers } from "./reachability.ts";

const online = (...commands: Step[]): KeptStep[] => commands.flatMap(command => [command, ...sync(2)]);
const makeSplit = split(0, "B", 0, "N");
const cutN = remove(1, "N");
const onlineRace = online(makeSplit, cutN, undo(0), undo(1));
const unavailable = ["N record", "N visual"];
const visual = { op: "type", id: "N", field: "visual", at: 0, text: "v" } as const;

test("E16 a fully delivered split and cut can restore a row without containers", () => {
  const bobUndo = onlineRace.findLastIndex(step => "by" in step);
  for (const mode of MODES) for (const kept of [true, false]) {
    const expected = kept ? unavailable : [];
    const findings: string[][] = [];
    const result = replay(justTwo(), onlineRace, 2, kept, mode, 1, undefined, {
      command(replica, index) {
        if (index === bobUndo) {
          assert.equal(replica.doc.clientID, 2);
          assert.deepEqual(missingContainers(replica), expected);
          assert.deepEqual(outline(replica), ["A: a / ", "B:  / ", "N: b / "]);
        } else assert.deepEqual(missingContainers(replica), []);
      },
      settled(replica) { findings.push(missingContainers(replica)); }
    });
    assert.deepEqual(result.lines, ["A: a / ", "B:  / ", "N: b / "]);
    assert.deepEqual(findings, Array.from({ length: 4 }, () => expected));
    assert.equal(result.problems.some(problem => problem.startsWith(`step ${bobUndo}:`)), kept);
    assert.ok(result.problems.every(problem => /beat N has no (record|visual cell)$/.test(problem)));
    if (!kept) assert.deepEqual(result.problems, []);
  }
});

test("E16 which alternatives leave a restored boundary without containers", () => {
  const narrationType: Cmd = { ...visual, field: "audio" };
  const narrationErase: Cmd = { op: "erase", id: "N", field: "audio", from: 0, to: 1 };
  const alternatives: [string, KeptStep[], boolean][] = [
    ["end split", online(split(0, "B", 1, "N"), cutN, undo(0), undo(1)), true],
    ["bulk cut", online(makeSplit, remove(1, "A", "B", "N"), undo(0), undo(1)), true],
    ["split undo before cut", [...online(makeSplit), undo(0), ...online(cutN, undo(1))], true],
    ["offline cut, split undo delivered before cut undo", [makeSplit, { from: 0, to: 1 }, cutN, ...online(undo(0), undo(1))], true],
    ["join", online(makeSplit, act(1, { op: "join", id: "N" }), undo(0), undo(1)), false],
    ["move", online(makeSplit, act(1, { op: "move", drop: { unit: "row", first: "N", target: "A", after: false } }), undo(0), undo(1)), false],
    ["type", online(makeSplit, act(1, narrationType), undo(0), undo(1)), false],
    ["erase", online(makeSplit, act(1, narrationErase), undo(0), undo(1)), false],
    ["cut A", online(makeSplit, remove(1, "A"), undo(0), undo(1)), false],
    ["cut B", online(makeSplit, remove(1, "B"), undo(0), undo(1)), false],
    ["insert", online(act(0, { op: "insert", before: "B", id: "N", text: "n" }), cutN, undo(0), undo(1)), false],
    ["heading", online(act(0, { op: "heading", above: "B", id: "N", text: "n" }),
      act(1, { op: "removeHeading", id: "N" }), undo(0), undo(1)), false],
    ["one writer", online(makeSplit, remove(0, "N"), undo(0), undo(0)), false]
  ];
  for (const [label, steps, missing] of alternatives) for (const mode of MODES) {
    const findings: string[][] = [];
    const result = replay(justTwo(), steps, 2, true, mode, 1, undefined, {
      settled(replica) { findings.push(missingContainers(replica)); }
    });
    assert.deepEqual(findings, Array.from({ length: 4 }, () => missing ? unavailable : []), `${label} ${mode}`);
    assert.ok(result.problems.every(problem => /beat N has no (record|visual cell)$/.test(problem)), `${label} ${mode}: ${result.problems.join("; ")}`);
    if (label === "end split") assert.ok(result.lines.includes("N:  / "), mode);
  }
});

test("E16 commands on a fresh copy of the containerless row", () => {
  let bytes: Uint8Array | undefined;
  replay(justTwo(), onlineRace, 2, true, "forward", 1, undefined, {
    settled(replica) { bytes = replica.encode(); }
  });
  assert.ok(bytes);
  const erase = { op: "erase", id: "N", from: 0, to: 1 } as const;
  const format = { op: "format", id: "N", from: 0, to: 1, key: "b", on: true } as const;
  const operations: [Cmd, "throws" | "partial" | "works"][] = [
    [visual, "throws"], [{ ...erase, field: "visual" }, "throws"], [{ ...format, field: "visual" }, "throws"],
    [{ op: "field", id: "N", key: "lens", value: "wide" }, "throws"],
    [{ op: "field", id: "N", key: "status", value: "ready" }, "throws"],
    [{ op: "join", id: "N" }, "throws"], [{ op: "unjoin", id: "N" }, "throws"],
    [{ op: "split", id: "N", at: 0, created: "P" }, "throws"],
    [{ op: "move", drop: { unit: "row", first: "N", target: "A", after: false } }, "throws"],
    [{ op: "move", drop: { unit: "row", first: "A", target: "N", after: true } }, "throws"],
    [{ op: "move", drop: { unit: "rows", first: "B", last: "N", target: "A", after: false } }, "partial"],
    [{ op: "heading", above: "N", id: "H", text: "title" }, "partial"],
    [{ ...visual, field: "audio" }, "works"], [{ ...erase, field: "audio" }, "works"], [{ ...format, field: "audio" }, "works"],
    [{ op: "delete", rows: ["N"] }, "works"]
  ];
  for (const [command, outcome] of operations) {
    const replica = openCopy(bytes, 91, true), before = replica.encode(), label = JSON.stringify(command);
    try {
      assert.deepEqual(missingContainers(replica), unavailable);
      assert.ok(replica.rows().some(row => row.id === "N"));
      assert.ok(!readNotice(replica).some(beat => beat.id === "N"));
      assert.deepEqual(replica.recovery(), []);
      if (outcome === "works") perform(replica, command);
      else assert.throws(() => perform(replica, command), outcome === "partial" ? /Missing record b:N/ : /Missing/, label);
      assert.equal(Buffer.from(replica.encode()).equals(before), outcome === "throws", label);
      if (command.op === "heading") {
        assert.ok(replica.headings.has("H"));
        assert.ok(outline(replica).includes("#H title"));
      }
      if (command.op === "move" && command.drop.unit === "rows") assert.deepEqual(outline(replica), ["B:  / ", "N: b / ", "A: a / "]);
      if (command.op === "delete") {
        assert.ok(!replica.rows().some(row => row.id === "N"));
        perform(replica, { op: "undo" });
        assert.deepEqual(missingContainers(replica), unavailable);
      }
    } finally { replica.destroy(); }
  }
});

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
