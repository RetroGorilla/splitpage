import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { KeptReplica } from "../../src/native-kept/replica.ts";
import { ALL_RULES } from "../../src/native/variant.ts";
import { MODES, watch } from "../native-chosen/engine.ts";
import { b, base, h, outline, seed, sync } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { need } from "../native-delete/model.ts";
import { openCopy, replay, runCommand } from "./replay.ts";
import type { KeptCommand, KeptStep } from "./replay.ts";

const act = (by: number, cmd: KeptCommand): KeptStep => ({ by, cmd });
const cut = (by: number, ...rows: string[]): KeptStep => act(by, { op: "delete", rows });
const undo = (by: number): KeptStep => act(by, { op: "undo" });
const move = (by: number, id: string, target: string, after = false): KeptStep =>
  act(by, { op: "move", drop: { unit: "row", first: id, target, after } });
const enter = (by: number, id: string): KeptStep =>
  act(by, { op: "move", drop: { unit: "row", first: id, target: null, after: false, intoScene: "H" } });
const send = (from: number, to: number): KeptStep => ({ from, to });

const short: Spec = {
  order: ["S", "T"],
  segments: { S: { head: b("A"), units: ["abc", b("B"), "def"] }, T: { head: h("H"), units: ["title"] } },
  beats: { A: {}, B: { status: "todo" } },
  visuals: { A: "1", B: "2" },
  headings: { H: {} }
};

test("E14 shortest offline visual race and the latest content in the notice", () => {
  const bytes = seed(short, undefined, "cells");
  for (const keep of [false, true]) for (const restoreFirst of [false, true]) {
    const a = openCopy(bytes, 1, keep), b = openCopy(bytes, 2, keep);
    try {
      b.splice("B", "visualText", 1, 1, [{ text: "Ω", marks: {} }]);
      a.deleteRows(["B"]);
      if (restoreFirst) assert.ok(a.undoPress());
      sync([a, b]);
      if (!restoreFirst) {
        assert.deepEqual(outline(a), ["A: abc / 1", "#H title"]);
        assert.equal(a.visuals.get("B")?.toString(), keep ? "2Ω" : undefined);
        if (a instanceof KeptReplica) {
          const notice = a.readOrphan("B");
          assert.deepEqual(notice?.visual, [{ insert: "2Ω" }]);
          assert.equal(notice?.fields.status, "todo");
          assert.equal(a.unownedNarration().length, 0);
        }
        assert.ok(a.undoPress());
        sync([a, b]);
      }
      for (const copy of [a, b]) assert.deepEqual(outline(copy), ["A: abc / 1", `B: def / 2${keep ? "Ω" : ""}`, "#H title"]);
    } finally { a.destroy(); b.destroy(); }
  }
});

test("E14 reruns the three rule (e) fixtures, including with rule (e) off", () => {
  const cases = [
    { id: "F", steps: [cut(0, "F"), move(1, "F", "A"), send(1, 0), undo(0)], to: "A" },
    { id: "C", steps: [cut(0, "C"), move(1, "C", "F"), send(1, 0), undo(0)], to: "F" },
    { id: "F", steps: [move(0, "F", "D"), send(0, 1), send(1, 0), cut(0, "F"), move(1, "F", "A"), send(1, 0), undo(0)], to: "A" }
  ];
  const original = ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"];
  for (const item of cases) for (const [number, mode] of MODES.entries()) {
    const built = replay(base(), item.steps, 2, false, mode, number);
    assert.deepEqual(built.problems, []);
    assert.deepEqual(built.lines, original);
    assert.ok(built.rankUse && built.missingRank);
    for (const rank of [true, false]) {
      const kept = replay(base(), item.steps, 2, true, mode, number, { ...ALL_RULES, rank });
      assert.deepEqual(kept.problems, []);
      assert.ok(!kept.rankUse && !kept.missingRank);
      const expected = original.filter(line => !line.startsWith(`${item.id}:`));
      expected.splice(expected.findIndex(line => line.startsWith(`${item.to}:`)), 0, need(original.find(line => line.startsWith(`${item.id}:`)), "original line"));
      assert.deepEqual(kept.lines, expected);
    }
  }
});

test("E14 a single unseen move is stable, but undoing competing moves can still remove the rank and cause the same drift", t => {
  const oneMove = [enter(0, "A"), cut(0, "B"), enter(1, "B"), send(1, 0), undo(0), cut(0, "A")];
  const twoMoves = [enter(0, "A"), send(0, 1), send(0, 2), cut(0, "B"), move(1, "B", "A", true), enter(2, "B"),
    send(1, 2), undo(2), send(2, 0), undo(0), cut(0, "A")];
  for (const [number, mode] of MODES.entries()) for (const keep of [false, true]) {
    for (const [steps, writers] of [[oneMove, 2], [twoMoves, 3]] as const) {
      const drift = !keep || writers === 3;
      const before = replay(short, steps.slice(0, -1), writers, keep, mode, number);
      const after = replay(short, steps, writers, keep, mode, number);
      assert.deepEqual(before.lines, ["#H title", "A: abc / 1", "B: def / 2"]);
      assert.deepEqual(before.problems, []);
      assert.deepEqual(after.lines, drift ? ["B: def / 2", "#H title"] : ["#H title", "B: def / 2"]);
      assert.equal(after.rankUse, drift);
      assert.deepEqual(after.problems, drift ? [`step ${steps.length - 1} delete: untouched beats changed scene: B`] : []);
    }
  }
  t.diagnostic("Single unseen move: drift 5/5 built, 0/5 kept. Two competing moves and winning move undo: drift 5/5 in both.");
});

test("E14 second-review rank fixtures: a split can keep the restored beat's rank, while redoing heading creation keeps the old failure", () => {
  const split = [cut(0, "F"), move(1, "F", "A", true), send(1, 0), undo(0), act(0, { op: "split", id: "F", at: 1, created: "N" })];
  const heading = [
    act(0, { op: "heading", above: "C", id: "J", text: "Q" }), send(0, 1),
    act(1, { op: "move", drop: { unit: "scene", first: "J", target: "I", after: false } }), undo(0), send(1, 0),
    act(0, { op: "redo" }), act(0, { op: "type", id: "J", field: "name", at: 1, text: "X" })
  ];
  for (const mode of MODES) for (const keep of [false, true]) {
    const beat = replay(base(), split, 2, keep, mode, 1);
    assert.deepEqual(beat.problems, []);
    assert.equal(beat.rankUse, !keep);
    assert.equal(typeof beat.state?.beats.N?.e10Rank, keep ? "string" : "undefined");
    const title = replay(base(), heading, 2, keep, mode, 1);
    assert.deepEqual(title.problems, []);
    assert.ok(title.rankUse);
    assert.deepEqual(title.lines, ["A: abc / 1", "B: def / 2", "#J QX", "#H mno", "E: pqr / 5", "C: ghi / 3", "D: jkl / 4", "#I stu", "F: vwx / 6"]);
  }
});

test("E14 same and neighbouring split, join, unjoin and move against deletion", t => {
  const expectedTail = ["D: jkl / 4", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"];
  const cases: { name: string; spec: Spec; steps: KeptStep[]; rows: string[]; orphans: string[]; joins?: Record<string, unknown> }[] = [
    { name: "split same", spec: base(), steps: [cut(0, "B"), act(1, { op: "split", id: "B", at: 1, created: "N" })],
      rows: ["A: abc / 1", "N:  / ", "C: ghi / 3", ...expectedTail], orphans: ["B"] },
    { name: "split neighbour", spec: base(), steps: [cut(0, "B"), act(1, { op: "split", id: "C", at: 1, created: "N" })],
      rows: ["A: abc / 1", "C: g / 3", "N: hi / ", ...expectedTail], orphans: ["B"] },
    { name: "join same", spec: base(), steps: [cut(0, "B"), act(1, { op: "join", id: "B" })],
      rows: ["A: abc / 1", "C: ghi / 3", ...expectedTail], orphans: ["B"], joins: { B: { into: "A", glue: " " } } },
    { name: "join neighbour", spec: base(), steps: [cut(0, "B"), act(1, { op: "join", id: "C" })],
      rows: ["A: abc / 1", "C: ghi / 3", ...expectedTail], orphans: ["B"], joins: { C: { into: "B", glue: " " } } },
    { name: "move same", spec: base(), steps: [cut(0, "B"), move(1, "B", "C", true)],
      rows: ["A: abc / 1", "C: ghi / 3", ...expectedTail], orphans: ["B"] },
    { name: "move neighbour", spec: base(), steps: [cut(0, "B"), move(1, "C", "A")],
      rows: ["C: ghi / 3", "A: abc / 1", ...expectedTail], orphans: ["B"] }
  ];
  const joined = base();
  joined.beats.C = { joined: { into: "B", glue: " " } };
  cases.push(
    { name: "unjoin selected member", spec: joined, steps: [cut(0, "B"), act(1, { op: "unjoin", id: "C" })],
      rows: ["A: abc / 1", ...expectedTail], orphans: ["B", "C"] },
    { name: "unjoin neighbouring member", spec: joined, steps: [cut(0, "A"), act(1, { op: "unjoin", id: "C" })],
      rows: ["B: def / 2", "C: ghi / 3", ...expectedTail], orphans: ["A"] }
  );
  for (const item of cases) for (const mode of MODES) for (const keep of [false, true]) {
    const result = replay(item.spec, item.steps, 2, keep, mode, 1);
    assert.deepEqual(result.problems, [], item.name);
    assert.deepEqual(result.lines, item.rows, item.name);
    assert.deepEqual(result.orphans, keep ? item.orphans : [], item.name);
    assert.ok(result.state);
    const { beats: fields, visuals: cells } = result.state;
    for (const id of item.orphans) {
      assert.equal(cells[id]?.map(run => run.insert).join(""), keep ? item.spec.visuals[id] : undefined, item.name);
      assert.equal(typeof fields[id]?.e10Rank === "string", keep, item.name);
    }
    if (item.name.startsWith("unjoin")) assert.equal(fields.C?.joined, undefined, item.name);
    for (const [id, join] of Object.entries(item.joins ?? {})) assert.deepEqual(fields[id]?.joined, keep || !item.orphans.includes(id) ? join : undefined, item.name);
  }
  t.diagnostic(JSON.stringify(cases.map(({ name, rows, orphans }) => ({ name, rows, orphans }))));
});

test("E14 the join of a restored beat can now take effect without another join command", () => {
  const joined = [cut(0, "B"), act(1, { op: "join", id: "B" }), send(1, 0), undo(0)];
  const unjoined = base();
  unjoined.beats.C = { joined: { into: "B", glue: " " } };
  const separated = [cut(0, "B"), act(1, { op: "unjoin", id: "C" }), send(1, 0), undo(0)];
  for (const mode of MODES) for (const keep of [false, true]) {
    const joins = replay(short, joined, 2, keep, mode, 1);
    const splits = replay(unjoined, separated, 2, keep, mode, 1);
    assert.deepEqual(joins.problems, []);
    assert.deepEqual(joins.lines, keep ? ["A(A+B): abc def / 1\n2", "#H title"] : ["A: abc / 1", "B: def / 2", "#H title"]);
    assert.deepEqual(joins.orphans, []);
    assert.deepEqual(splits.problems, []);
    assert.deepEqual(splits.lines.slice(0, 3), keep
      ? ["A: abc / 1", "B: def / 2", "C: ghi / 3"]
      : ["A: abc / 1", "B(B+C): def ghi / 2\n3", "D: jkl / 4"]);
    assert.deepEqual(splits.orphans, []);
  }
});

test("E14 whole scene deletion keeps unseen typing editable and exposes only visual and fields by orphan id", () => {
  const steps = [act(0, { op: "sceneDelete", id: "H" }), act(1, { op: "type", id: "E", field: "audio", at: 1, text: "Ω" }),
    act(1, { op: "type", id: "E", field: "visual", at: 1, text: "Ψ" })];
  for (const mode of MODES) for (const keep of [false, true]) {
    const result = replay(base(), steps, 2, keep, mode, 1);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.lines, ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jklΩ / 4", "#I stu", "F: vwx / 6"]);
    assert.deepEqual(result.orphans, keep ? ["E"] : []);
    assert.deepEqual(result.state?.visuals.E, keep ? [{ insert: "5Ψ" }] : undefined);
  }
  const edited = [...steps, send(1, 0), act(0, { op: "erase", field: "audio", id: "D", from: 3, to: 4 })];
  assert.deepEqual(replay(base(), edited, 2, true, "forward", 1).lines, ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#I stu", "F: vwx / 6"]);
});

test("E14 stale writers refuse an orphan and a split or insert cannot reuse its id", () => {
  const a = new KeptReplica(1), b = new KeptReplica(2), initial = seed(short, undefined, "cells");
  try {
    for (const copy of [a, b]) Y.applyUpdate(copy.doc, initial, "remote");
    const record = a.beats.get("B"), cell = a.visuals.get("B");
    a.deleteRows(["B"]);
    sync([a, b]);
    const write = (copy: KeptReplica): void => {
      copy.splice("B", "visualText", 0, 0, [{ text: "x", marks: {} }]);
      copy.splice("B", "audioText", 0, 0, [{ text: "x", marks: {} }]);
      copy.format("B", "visualText", 0, 1, { b: true });
      copy.format("B", "audioText", 0, 1, { b: true });
      copy.setField("B", "status", "ready");
      copy.join("A", "B", " ");
      copy.join("B", "A", " ");
      copy.unjoin("B");
      copy.remove("B");
      copy.restore("B");
      copy.split("B", 1, "N");
      copy.split("A", 1, "B");
      copy.insertBeat("B", "N", "text");
      copy.insertBeat("A", "B", "text");
      copy.materialize("B");
      copy.createHeading("B", "J", "heading");
      assert.equal(copy.drop({ unit: "row", first: "A", target: "B", after: true }), false);
      assert.equal(copy.moveRefs("b:B", "b:B", null), false);
      copy.deleteRows(["B"]);
      copy.deleteBeat("B");
    };
    for (const copy of [a, b]) assert.deepEqual(watch(copy, () => write(copy)), []);
    assert.ok(a.undoPress());
    assert.equal(a.beats.get("B"), record);
    assert.equal(a.visuals.get("B"), cell);
    sync([a, b]);
    for (const copy of [a, b]) {
      assert.deepEqual(outline(copy), ["A: abc / 1", "B: def / 2", "#H title"]);
      assert.equal(copy.beats.get("B")?.get("status"), "todo");
      assert.equal(copy.readOrphan("B"), null);
    }
    b.split("A", 1, "N");
    sync([a, b]);
    for (const copy of [a, b]) assert.deepEqual(outline(copy), ["A: a / 1", "N: bc / ", "B: def / 2", "#H title"]);
  } finally { a.destroy(); b.destroy(); }
});

test("E14 a late copy can read an orphan, while the author can still undo its own edits in the hidden cell", () => {
  const bytes = seed(short, undefined, "cells");
  const cutCopy = openCopy(bytes, 1, true) as KeptReplica, writer = openCopy(bytes, 2, true) as KeptReplica;
  try {
    writer.splice("B", "visualText", 1, 1, [{ text: "Ω", marks: {} }]);
    cutCopy.deleteRows(["B"]);
    sync([cutCopy, writer]);
    const late = openCopy(cutCopy.encode(), 3, true) as KeptReplica;
    try {
      assert.deepEqual(late.readOrphan("B")?.visual, [{ insert: "2Ω" }]);
      assert.equal(late.undoPress(), false);
      assert.ok(writer.undoPress());
      sync([cutCopy, writer, late]);
      for (const copy of [cutCopy, writer, late]) assert.deepEqual(copy.readOrphan("B")?.visual, [{ insert: "2" }]);
      assert.ok(writer.redoPress());
      sync([cutCopy, writer, late]);
      assert.ok(cutCopy.undoPress());
      sync([cutCopy, writer, late]);
      for (const copy of [cutCopy, writer, late]) assert.deepEqual(outline(copy), ["A: abc / 1", "B: def / 2Ω", "#H title"]);
      assert.ok(cutCopy.redoPress());
      sync([cutCopy, writer, late]);
      for (const copy of [cutCopy, writer, late]) {
        assert.deepEqual(outline(copy), ["A: abc / 1", "#H title"]);
        assert.deepEqual(copy.readOrphan("B")?.visual, [{ insert: "2Ω" }]);
      }
    } finally { late.destroy(); }
  } finally { cutCopy.destroy(); writer.destroy(); }
});

test("E14 controls cover an empty head, disjoint cuts, a whole scene and both orphan lookup components", t => {
  const spec = base();
  need(spec.segments.S, "segment S").units[0] = "";
  const bytes = seed(spec, undefined, "cells");
  const cases: { cmd: KeptCommand; rows: string[] }[] = [
    { cmd: { op: "delete", rows: ["A"] }, rows: ["B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"] },
    { cmd: { op: "delete", rows: ["B", "D", "F"] }, rows: ["A:  / 1", "C: ghi / 3", "#H mno", "E: pqr / 5", "#I stu"] },
    { cmd: { op: "sceneDelete", id: "H" }, rows: ["A:  / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#I stu", "F: vwx / 6"] }
  ];
  const counts: Record<string, number> = {};
  const using = (run: (replica: KeptReplica) => void): void => {
    const replica = openCopy(bytes, 1, true) as KeptReplica;
    try { run(replica); } finally { replica.destroy(); }
  };
  for (const { cmd, rows } of cases) {
    const apply = (replica: ChosenReplica): void => runCommand(replica, cmd);
    let calls: string[] = [];
    const check = (replica: KeptReplica): void => assert.deepEqual(outline(replica), rows);
    using(replica => { calls = watch(replica, () => apply(replica)); check(replica); });
    for (const [index, call] of calls.entries()) using(replica => {
      assert.deepEqual(watch(replica, () => apply(replica), index), calls);
      assert.throws(() => check(replica), { code: "ERR_ASSERTION" });
      counts[call] = (counts[call] ?? 0) + 1;
    });
  }
  using(replica => {
    replica.deleteRows(["B"]);
    const verify = (): void => {
      const reading = replica.readOrphan("B");
      assert.equal(typeof reading?.fields.e10Rank, "string");
      assert.deepEqual(reading?.visual, [{ insert: "2" }]);
    };
    verify();
    assert.deepEqual(watch(replica, verify), []);
    for (const map of [replica.beats, replica.visuals]) {
      Object.defineProperty(map, "get", { value: (): undefined => undefined, configurable: true });
      try { assert.throws(verify, { code: "ERR_ASSERTION" }); } finally { Reflect.deleteProperty(map, "get"); }
      counts["read lookup"] = (counts["read lookup"] ?? 0) + 1;
    }
  });
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(counts).map(([call, n]) => [call, { used: n, effective: n, failed: n }]))));
});
