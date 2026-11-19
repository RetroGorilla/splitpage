import assert from "node:assert/strict";
import test from "node:test";
import { ROW_MAKERS } from "../../src/native-row-record/variants.ts";
import { justTwo } from "../native-rank-undo/histories.ts";
import { COMMANDS, stateAfter, tryCommand } from "./commands.ts";
import { ROW_HISTORIES } from "./histories.ts";

// why: the outcome of each command on Alice's copy after the four steps; "done" means it wrote and threw nothing
const EXPECTED = {
  K: {
    "type narration in N": "done", "type in N's visual cell": "throws before writing", "bold N's narration": "done", "set N's status": "throws before writing",
    "move N to the top": "throws before writing", "split N": "throws before writing", "join N up to B": "throws before writing", "cut N": "done",
    "insert a row before N": "done", "create a heading above N": "throws after writing", "move B to the top": "throws after writing",
    "move A below B": "throws after writing", "type narration at the start of B": "done", "cut B": "done", "create a heading above B": "throws after writing"
  },
  R: {
    "type narration in N": "no write", "type in N's visual cell": "no write", "bold N's narration": "no write", "set N's status": "no write",
    "move N to the top": "no write", "split N": "no write", "join N up to B": "throws before writing", "cut N": "no write",
    "insert a row before N": "no write", "create a heading above N": "no write", "move B to the top": "done",
    "move A below B": "done", "type narration at the start of B": "done", "cut B": "done", "create a heading above B": "done"
  }
} as const;

test("E17 every command on the row the four steps leave, and on its neighbours", t => {
  const steps = ROW_HISTORIES[0]?.steps ?? [];
  const table: Record<string, Record<string, string>> = {};
  for (const option of ["K", "R", "U"] as const) {
    const state = stateAfter(ROW_MAKERS[option], justTwo(), steps, 2, 0);
    for (const { label, cmd } of COMMANDS) {
      const tried = tryCommand(ROW_MAKERS[option], state, label, cmd);
      (table[label] ??= {})[option] = `${tried.outcome}${tried.message ? ` (${tried.message})` : ""}: ${tried.rows.join(" | ")}`;
      const expected = option === "U" ? "done" : EXPECTED[option][label as keyof typeof EXPECTED.K];
      assert.equal(tried.outcome, expected, `${option} ${label}`);
    }
  }
  t.diagnostic(JSON.stringify(table));
  assert.equal(table["insert a row before N"]?.K, "done: M: m /  | A: a /  | B:  /  | N: b / ");
  assert.equal(table["insert a row before N"]?.U, "done: M: m /  | A: a /  | B:  /  | N: b / ");
  assert.equal(table["move A below B"]?.K, "throws after writing (Missing record b:N): B:  /  | N: b /  | A: a / ");
});
