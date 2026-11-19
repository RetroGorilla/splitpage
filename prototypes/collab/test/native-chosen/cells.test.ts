import assert from "node:assert/strict";
import test from "node:test";
import { ALL_RULES } from "../../src/native/variant.ts";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { generated, histories } from "../native-delete/histories.ts";
import type { DeleteHistory } from "../native-delete/histories.ts";
import type { DeleteCommand } from "../native-delete/model.ts";
import { MODES } from "./engine.ts";
import { b, base, h, load, seed, specOf } from "./kit.ts";
import type { Spec } from "./kit.ts";
import { perform, play } from "./play.ts";
import type { Cmd, PlayResult, Step } from "./play.ts";

const act = (by: number, cmd: Cmd): Step => ({ by, cmd });
const SYNC: Step[] = [{ from: 0, to: 1 }, { from: 1, to: 0 }];
const typeIn = (by: number, id: string, at: number, text: string, field: "audio" | "visual" | "name" = "audio"): Step => act(by, { op: "type", id, field, at, text });
const cells = (spec: Spec, steps: readonly Step[], mode: (typeof MODES)[number] = "forward", writers = 2): PlayResult =>
  play({ spec, steps, writers, mode, seed: 1, names: "cells" });

const withBeatBelow = (): Spec => {
  const spec = base();
  spec.segments.T = { head: b("D"), units: ["jkl", h("H"), "mno", b("E"), "pqr", b("G"), "yz"] };
  spec.beats.G = {};
  spec.visuals.G = "7";
  return spec;
};
const headingFirst = (): Spec => ({
  order: ["P", "R"],
  segments: { P: { head: h("P"), units: ["pp", b("A"), "abc", h("Q"), "qq"] }, R: { head: b("B"), units: ["def"] } },
  beats: { A: {}, B: {} }, visuals: { A: "1", B: "2" }, headings: { P: {}, Q: {} }
});

const unseenTyping = (row: string): Step[] => [act(0, { op: "delete", rows: [row] }), typeIn(1, row, 1, "Ω")];
const remove = (id: string): Step => act(0, { op: "removeHeading", id });

const RULE_F: { name: string; spec: () => Spec; steps: Step[]; rows: string[] }[] = [
  {
    name: "the scene still has a beat below: the text starts that beat",
    spec: withBeatBelow, steps: unseenTyping("E"),
    rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "G: Ωyz / 7", "#I stu", "F: vwx / 6"]
  },
  {
    name: "the same with the heading removed",
    spec: withBeatBelow, steps: [act(0, { op: "delete", rows: ["E"] }), remove("H"), typeIn(1, "E", 1, "Ω")],
    rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "G: Ωyz / 7", "#I stu", "F: vwx / 6"]
  },
  {
    name: "the scene has no beat left: the text ends the beat above",
    spec: base, steps: unseenTyping("E"),
    rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jklΩ / 4", "#H mno", "#I stu", "F: vwx / 6"]
  },
  {
    name: "the same with the heading removed, which was the never-acceptable case",
    spec: base, steps: [act(0, { op: "delete", rows: ["E"] }), remove("H"), typeIn(1, "E", 1, "Ω")],
    rows: ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jklΩ / 4", "#I stu", "F: vwx / 6"]
  },
  {
    name: "no beat in the scene and none above: the text starts the next beat further down",
    spec: headingFirst, steps: unseenTyping("A"),
    rows: ["#P pp", "#Q qq", "B: Ωdef / 2"]
  }
];

test("E11 part B rule (f): text after a heading's boundary shows in a beat, in every delivery", () => {
  for (const item of RULE_F) for (const mode of ["forward", "reverse", "state"] as const) {
    const result = cells(item.spec(), item.steps, mode);
    assert.deepEqual([result.never, result.local], [[], []], `${item.name} ${mode}`);
    assert.deepEqual(result.lines, item.rows, `${item.name} ${mode}`);
    assert.ok((result.uses.headless ?? 0) > 0, `${item.name}: rule (f) was used`);
  }
});

test("E11 part B rule (f) control: with the rule off, the text is shown nowhere", () => {
  for (const item of RULE_F) {
    const result = play({ spec: item.spec(), steps: item.steps, writers: 2, mode: "forward", seed: 1, names: "cells", rules: { ...ALL_RULES, headless: false } });
    assert.ok(result.never.some(problem => /shown nowhere/.test(problem)), item.name);
  }
});

test("E11 part B rule (f): the text is editable in the row that shows it", () => {
  const settled = [...unseenTyping("E"), ...SYNC];
  const cases: { name: string; steps: Step[]; rows: string[] }[] = [
    { name: "type after it", steps: [typeIn(0, "D", 4, "X")], rows: ["D: jklΩX / 4"] },
    { name: "erase it", steps: [act(0, { op: "erase", id: "D", field: "audio", from: 3, to: 4 })], rows: ["D: jkl / 4"] },
    { name: "bold it", steps: [act(0, { op: "format", id: "D", field: "audio", from: 2, to: 4, key: "b", on: true })], rows: ["D: jk[l|b][Ω|b] / 4"] },
    { name: "split before it", steps: [act(0, { op: "split", id: "D", at: 3, created: "N" })], rows: ["D: jkl / 4", "N: Ω / ", "#H mno"] },
    { name: "delete the row", steps: [act(0, { op: "delete", rows: ["D"] })], rows: ["#H mno"] }
  ];
  for (const item of cases) {
    const result = cells(base(), [...settled, ...item.steps]);
    assert.deepEqual([result.never, result.local], [[], []], item.name);
    const shown = result.lines.filter(line => item.rows.some(row => row.split(":")[0] === line.split(":")[0] || row === line));
    assert.deepEqual(shown, item.rows, item.name);
  }
});

// why: E5's heading findings, run with names inline and in cells; the option must not change any of them
const E5: { name: string; steps: Step[]; writers?: number }[] = [
  { name: "two people renaming at once", steps: [typeIn(0, "H", 1, "X", "name"), typeIn(1, "H", 1, "Y", "name")] },
  { name: "rename against remove", steps: [typeIn(0, "H", 3, "X", "name"), act(1, { op: "removeHeading", id: "H" })] },
  { name: "remove and restore against a rename", steps: [remove("H"), act(0, { op: "restoreHeading", id: "H" }), typeIn(1, "H", 0, "Y", "name")] },
  { name: "two people creating a heading at the same place", steps: [act(0, { op: "heading", above: "C", id: "J", text: "X" }), act(1, { op: "heading", above: "C", id: "K", text: "Y" })] },
  { name: "undo of a rename", steps: [typeIn(0, "H", 1, "X", "name"), typeIn(1, "H", 3, "Y", "name"), ...SYNC, act(0, { op: "undo" })] },
  { name: "undo of a remove", steps: [remove("H"), typeIn(1, "H", 0, "Y", "name"), ...SYNC, act(0, { op: "undo" })] },
  { name: "undo of a restore", steps: [remove("H"), ...SYNC, act(1, { op: "restoreHeading", id: "H" }), act(1, { op: "undo" })] },
  { name: "undo of a creation, everything seen", steps: [act(0, { op: "heading", above: "C", id: "J", text: "X" }), ...SYNC, act(0, { op: "undo" })] },
  { name: "undo of one of two creations at the same place", steps: [act(0, { op: "heading", above: "C", id: "J", text: "X" }), act(1, { op: "heading", above: "C", id: "K", text: "Y" }), ...SYNC, act(1, { op: "undo" })] }
];

test("E11 part B: E5's heading findings hold with names in their own cells", () => {
  for (const item of E5) for (const mode of ["forward", "reverse", "state"] as const) {
    const inline = play({ spec: base(), steps: item.steps, writers: 2, mode, seed: 1 }), cell = cells(base(), item.steps, mode);
    assert.deepEqual([cell.never, cell.local], [[], []], `${item.name} ${mode}`);
    assert.deepEqual(cell.lines, inline.lines, `${item.name} ${mode}`);
  }
});

test("E11 part B: a heading's name cell goes only with an undo of its creation; what that loses", () => {
  const create = act(0, { op: "heading", above: "C", id: "J", text: "X" }), rename = typeIn(1, "J", 1, "Y", "name");
  const unseen = cells(base(), [create, ...SYNC, rename, act(0, { op: "undo" })]);
  assert.deepEqual([unseen.never, unseen.local, unseen.kinds], [[], [], { "typing in a new heading lost when its creator undoes the creation unseen": 1 }]);
  assert.deepEqual(unseen.lines.slice(0, 3), ["A: abc / 1", "B: def / 2", "C: ghi / 3"]);
  const inline = play({ spec: base(), steps: [create, ...SYNC, rename, act(0, { op: "undo" })], writers: 2, mode: "forward", seed: 1 });
  // why: with names inline the same letter survived as narration of the row above; with cells it goes with the cell
  assert.equal(inline.lines[1], "B: defY / 2");
  const seen = cells(base(), [create, ...SYNC, rename, ...SYNC, act(0, { op: "undo" })]);
  assert.deepEqual([seen.never, seen.local, seen.kinds], [[], [], { "typing removed by a creation undo the creator saw": 1 }]);
  const redone = cells(base(), [create, ...SYNC, rename, ...SYNC, act(0, { op: "undo" }), act(0, { op: "redo" })]);
  assert.deepEqual([redone.never, redone.local, redone.kinds], [[], [], {}], "a redo brings back what the creator had seen");
  assert.equal(redone.lines[2], "#J XY");
});

function translate(command: DeleteCommand, by: number, writer: ChosenReplica): Step[] {
  switch (command.op) {
    case "rows": return [act(by, { op: "delete", rows: command.ids })];
    case "scene": {
      const outline = writer.outline(), start = outline.findIndex(entry => entry.kind === "heading" && entry.id === command.id), rows: string[] = [];
      for (const entry of outline.slice(start + 1)) { if (entry.kind === "heading") break; rows.push(entry.row.id); }
      return [act(by, { op: "delete", rows }), act(by, { op: "removeHeading", id: command.id })];
    }
    case "heading": return [act(by, { op: "removeHeading", id: command.id })];
    case "type": return [typeIn(by, command.id, command.at, command.value, command.field)];
    case "erase": return [act(by, { op: "erase", id: command.id, field: command.field, from: command.from, to: command.to })];
    case "mark": return [act(by, { op: "format", id: command.id, field: command.field, from: command.from, to: command.to, key: command.key, on: true })];
    case "field": return [act(by, { op: "field", id: command.id, key: "status", value: command.value })];
    case "split": return [act(by, { op: "split", id: command.id, at: command.at, created: command.created })];
    case "insert": return [act(by, { op: "insert", before: command.before, id: command.created, text: command.value })];
    case "join": case "unjoin": return [act(by, { op: command.op, id: command.id })];
    case "create": return [act(by, { op: "heading", above: command.above, id: command.id, text: command.value })];
  }
}

// why: E9's forks work offline from the same start, so each fork's scene rows are read on a copy that ran its own steps
function e9(history: DeleteHistory, mode: (typeof MODES)[number], number: number): PlayResult {
  const spec = specOf(history.initial), steps: Step[] = [];
  for (const [by, commands] of history.forks.entries()) {
    const writer = load(seed(spec, ALL_RULES, "cells"), 900 + by, ALL_RULES, "cells");
    try {
      for (const command of commands) for (const step of translate(command, by, writer)) { steps.push(step); if ("by" in step) perform(writer, step.cmd); }
    } finally { writer.destroy(); }
  }
  return play({ spec, steps, writers: history.forks.length, mode, seed: number, names: "cells" });
}

test("E11 part B: E9's named and generated histories with names in their own cells", t => {
  const kinds: Record<string, number> = {}, rows: Record<string, string[]> = {};
  let count = 0;
  for (const history of histories(1)) {
    const result = e9(history, "reverse", 1);
    count++;
    assert.deepEqual([result.never, result.local], [[], []], history.name);
    if (["scene beat", "scene name", "embedded heading delete versus rename", "head heading delete versus rename"].includes(history.name)) rows[history.name] = result.lines;
    for (const [kind, n] of Object.entries(result.kinds)) kinds[kind] = (kinds[kind] ?? 0) + n;
  }
  for (const [index, mode] of MODES.entries()) for (let number = 0; number < 12; number++) for (const history of generated(12 * index + number)) {
    const result = e9(history, mode, 12 * index + number);
    count++;
    assert.deepEqual([result.never, result.local], [[], []], `${history.name} ${mode}`);
    for (const [kind, n] of Object.entries(result.kinds)) kinds[kind] = (kinds[kind] ?? 0) + n;
  }
  t.diagnostic(JSON.stringify({ count, kinds, rows }));
  // why: E9's scene-beat letter, which the first version showed only in a removed heading's name
  assert.ok(rows["scene beat"]?.some(line => line.startsWith("D: jkl") && line.includes("Ω")), JSON.stringify(rows["scene beat"]));
});
