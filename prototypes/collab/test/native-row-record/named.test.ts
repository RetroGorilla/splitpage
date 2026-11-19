import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { ROW_MAKERS, ROW_OPTIONS } from "../../src/native-row-record/variants.ts";
import { MODES } from "../native-chosen/engine.ts";
import type { Step } from "../native-chosen/play.ts";
import { NAMED, act, justTwo, redo, remove, split, sync, undo } from "../native-rank-undo/histories.ts";
import { drive } from "./drive.ts";

const headRace: Step[] = [remove(0, "A"), remove(1, "A"), undo(0), undo(1), redo(1), ...sync(2)];

test("E17 E15's 21 named histories and the segment-head race read the same in K, R and U", t => {
  const differ: string[] = [];
  const histories = [...NAMED.map((history, index) => ({ label: `${index + 1}`, spec: history.spec, steps: history.steps, writers: history.writers })),
    { label: "head race", spec: justTwo(), steps: headRace, writers: 2 }];
  for (const history of histories) {
    const settled = new Map<string, string>();
    for (const option of ROW_OPTIONS) for (const [at, mode] of MODES.entries()) {
      const result = drive(ROW_MAKERS[option], history.spec, history.steps, history.writers, mode, at);
      assert.deepEqual([result.never, result.threw, result.disagree], [[], [], false], `${history.label} ${option} ${mode}`);
      assert.ok(result.settled.every(view => !view.missing.length));
      settled.set(`${option} ${mode}`, JSON.stringify(result.settled[0]?.rows));
    }
    if (new Set(settled.values()).size !== 1) differ.push(history.label);
    if (history.label === "12") assert.equal(settled.get("U forward"), JSON.stringify(["A: a / ", "B: b / "]));
    if (history.label === "head race") assert.equal(settled.get("R state"), JSON.stringify(["B: ab / "]));
  }
  t.diagnostic(JSON.stringify({ histories: histories.length, differ }));
  assert.deepEqual(differ, []);
});

// why: Bob writes N's status and visual, then cuts N; Alice undoes her split; Bob undoes his cut. Expected rows are
// written from the commands: K shows N with neither, R reads N's text in B, U brings N back with Bob's two edits
const edits: Step[] = [
  split(0, "B", 0, "N"), ...sync(2), act(1, { op: "field", id: "N", key: "status", value: "done" }), act(1, { op: "type", id: "N", field: "visual", at: 0, text: "v" }),
  remove(1, "N"), ...sync(2), undo(0), ...sync(2), undo(1), ...sync(2)
];

test("E17 what is kept of Bob's own edits to N", () => {
  const expected = {
    K: { rows: ["A: a / ", "B:  / ", "N: b / "], status: undefined, missing: ["N"] },
    R: { rows: ["A: a / ", "B: b / "], status: undefined, missing: [] },
    U: { rows: ["A: a / ", "B:  / ", "N: b / v"], status: "done", missing: [] }
  };
  for (const option of ROW_OPTIONS) for (const [at, mode] of MODES.entries()) {
    const result = drive(ROW_MAKERS[option], justTwo(), edits, 2, mode, at), settled = result.settled[0];
    assert.deepEqual([result.threw, result.never.filter(problem => !/has no (record|visual cell)$/.test(problem)), result.disagree], [[], [], false]);
    assert.deepEqual([settled?.rows, settled?.missing], [expected[option].rows, expected[option].missing], `${option} ${mode}`);
    assert.equal(settled?.rank, false, `${option} ${mode}`);
    const copy = ROW_MAKERS[option](9);
    try {
      Y.applyUpdate(copy.doc, result.state ?? new Uint8Array(), "remote");
      assert.equal(copy.beats.get("N")?.get("status"), expected[option].status, `${option} ${mode}`);
    } finally { copy.destroy(); }
  }
});
