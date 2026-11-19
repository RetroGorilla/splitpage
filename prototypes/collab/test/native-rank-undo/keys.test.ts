import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { ALL_RULES } from "../../src/native/variant.ts";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { load, outline, seed } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Cmd } from "../native-chosen/play.ts";
import { twoBeats } from "./histories.ts";

const withStatus = (): Spec => ({ ...twoBeats(), beats: { A: {}, B: { status: "todo", lens: "wide" } } });

function copiesOf(option: RankOption, spec: Spec): { copies: ChosenReplica[]; swap: () => void } {
  const make = makeOption(option), bytes = seed(spec, ALL_RULES, "cells", make);
  const copies = [load(bytes, 1, ALL_RULES, "cells", make), load(bytes, 2, ALL_RULES, "cells", make)];
  const swap = (): void => {
    for (const [from, to] of [[0, 1], [1, 0]] as const) {
      const source = copies[from], target = copies[to];
      if (!source || !target) throw new Error("copy");
      Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, Y.encodeStateVector(target.doc)), "remote");
      target.changes();
    }
  };
  return { copies, swap };
}

// why: Alice (client 1) and Bob (client 2) make one command each at the same moment, everything is delivered, Bob's
// write wins, and Bob undoes; the stored value and the rows are read on both copies
function race(option: RankOption, spec: Spec, alice: Cmd, bob: Cmd, read: (copy: ChosenReplica) => unknown): { value: unknown; rows: string[] } {
  const { copies, swap } = copiesOf(option, spec);
  try {
    const [a, b] = copies;
    if (!a || !b) throw new Error("copy");
    perform(a, alice); perform(b, bob); swap();
    perform(b, { op: "undo" }); swap();
    assert.deepEqual([read(a), outline(a)], [read(b), outline(b)], "both copies agree");
    return { value: read(a), rows: outline(a) };
  } finally { for (const copy of copies) copy.destroy(); }
}

// why: Bob writes, Alice sees it and replaces it, then Alice undoes and redoes; the value is read after each step
function seenReplacement(option: RankOption, bob: (copy: ChosenReplica) => void, alice: (copy: ChosenReplica) => void, read: (copy: ChosenReplica) => unknown): unknown[] {
  const { copies, swap } = copiesOf(option, twoBeats());
  try {
    const [a, b] = copies;
    if (!a || !b) throw new Error("copy");
    const values: unknown[] = [];
    bob(b); swap(); values.push(read(a));
    alice(a); swap(); values.push(read(b));
    perform(a, { op: "undo" }); swap(); values.push(read(b));
    perform(a, { op: "redo" }); swap(); values.push(read(b));
    return values;
  } finally { for (const copy of copies) copy.destroy(); }
}

const field = (key: string) => (copy: ChosenReplica): unknown => copy.beats.get("B")?.get(key);
const note = (copy: ChosenReplica): unknown => (copy.beats.get("B")?.get("note") as Y.Text | undefined)?.toString();
const setNote = (value: string) => (copy: ChosenReplica): void => {
  copy.transact(() => { const text = new Y.Text(); text.insert(0, value); copy.beats.get("B")?.set("note", text); });
  copy.changes();
};

test("E15 keys: after two writes at once and the winner's undo, which keys are left empty, and what a person sees", t => {
  const table: Record<string, Record<RankOption, unknown>> = {};
  const put = (key: string, option: RankOption, value: unknown): void => { (table[key] ??= {} as Record<RankOption, unknown>)[option] = value; };
  for (const option of OPTIONS) {
    put("status", option, race(option, withStatus(), { op: "field", id: "B", key: "status", value: "ready" }, { op: "field", id: "B", key: "status", value: "done" }, field("status")).value);
    put("lens", option, race(option, withStatus(), { op: "field", id: "B", key: "lens", value: "close" }, { op: "field", id: "B", key: "lens", value: "far" }, field("lens")).value);
    put("status, blank before", option, race(option, twoBeats(), { op: "field", id: "B", key: "status", value: "ready" }, { op: "field", id: "B", key: "status", value: "done" }, field("status")).value);
    put("joined", option, race(option, twoBeats(), { op: "join", id: "B" }, { op: "join", id: "B" }, field("joined")).rows.join(", "));
    put("removed", option, race(option, twoBeats(), { op: "removeHeading", id: "H" }, { op: "removeHeading", id: "H" }, copy => copy.headings.get("H")?.get("removed")).rows.join(", "));
  }
  t.diagnostic(JSON.stringify(table));
  // why: a value present before both writes comes back empty with plain undo, and as it was before with option B
  assert.deepEqual(table.status, { A: undefined, B: "todo", C: undefined, D: undefined, E: undefined });
  assert.deepEqual(table.lens, { A: undefined, B: "wide", C: undefined, D: undefined, E: undefined });
  assert.deepEqual(table["status, blank before"], { A: undefined, B: undefined, C: undefined, D: undefined, E: undefined });
  // why: a join and a removal have no value before them, so empty is the state before both writes in every option;
  // Alice's join or removal is gone after Bob undoes his own
  for (const option of OPTIONS) {
    assert.equal(table.joined?.[option], "A: a / , B: b / , #H h", option);
    assert.equal(table.removed?.[option], "A: a / , B: b / , #H h", option);
  }
});

test("E15 keys: Alice replaces a value she has seen, then undoes and redoes", t => {
  for (const option of OPTIONS) {
    const status = seenReplacement(option, copy => { perform(copy, { op: "field", id: "B", key: "status", value: "todo" }); }, copy => { perform(copy, { op: "field", id: "B", key: "status", value: "done" }); }, field("status"));
    const text = seenReplacement(option, setNote("todo"), setNote("done"), note);
    t.diagnostic(`${option}: status ${status.join(" -> ")}; nested text ${text.join(" -> ")}`);
    assert.deepEqual(status, ["todo", "done", "todo", "done"], `${option}: status`);
    assert.deepEqual(text, ["todo", "done", "todo", "done"], `${option}: a replaced nested text`);
  }
});
