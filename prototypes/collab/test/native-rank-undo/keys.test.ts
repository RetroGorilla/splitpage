import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { ALL_RULES } from "../../src/native/variant.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { load, outline, seed } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Cmd } from "../native-chosen/play.ts";
import { twoBeats } from "./histories.ts";

const withStatus = (): Spec => ({ ...twoBeats(), beats: { A: {}, B: { status: "todo", lens: "wide" } } });

// why: Alice (client 1) and Bob (client 2) make one command each at the same moment, everything is delivered, Bob's
// write wins, and Bob undoes; the stored value and the rows are read on both copies
function race(option: RankOption, spec: Spec, alice: Cmd, bob: Cmd, read: (copy: ReturnType<typeof load>) => unknown): { value: unknown; rows: string[] } {
  const make = makeOption(option), bytes = seed(spec, ALL_RULES, "inline", make);
  const copies = [load(bytes, 1, ALL_RULES, "inline", make), load(bytes, 2, ALL_RULES, "inline", make)];
  const swap = (): void => {
    for (const [from, to] of [[0, 1], [1, 0]] as const) {
      const source = copies[from], target = copies[to];
      if (!source || !target) throw new Error("copy");
      Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, Y.encodeStateVector(target.doc)), "remote");
      target.changes();
    }
  };
  try {
    const [a, b] = copies;
    if (!a || !b) throw new Error("copy");
    perform(a, alice); perform(b, bob); swap();
    perform(b, { op: "undo" }); swap();
    assert.deepEqual([read(a), outline(a)], [read(b), outline(b)], "both copies agree");
    return { value: read(a), rows: outline(a) };
  } finally { for (const copy of copies) copy.destroy(); }
}

const field = (key: string) => (copy: ReturnType<typeof load>): unknown => copy.beats.get("B")?.get(key);

test("E15 keys: after two writes at once and the winner's undo, which keys are left empty, and what a person sees", t => {
  const table: Record<string, Record<RankOption, unknown>> = {};
  for (const option of OPTIONS) {
    const status = race(option, withStatus(), { op: "field", id: "B", key: "status", value: "ready" }, { op: "field", id: "B", key: "status", value: "done" }, field("status"));
    const lens = race(option, withStatus(), { op: "field", id: "B", key: "lens", value: "close" }, { op: "field", id: "B", key: "lens", value: "far" }, field("lens"));
    const join = race(option, twoBeats(), { op: "join", id: "B" }, { op: "join", id: "B" }, field("joined"));
    const removed = race(option, twoBeats(), { op: "removeHeading", id: "H" }, { op: "removeHeading", id: "H" }, copy => copy.headings.get("H")?.get("removed"));
    (table.status ??= {} as Record<RankOption, unknown>)[option] = status.value;
    (table.lens ??= {} as Record<RankOption, unknown>)[option] = lens.value;
    (table.joined ??= {} as Record<RankOption, unknown>)[option] = join.rows.join(", ");
    (table.removed ??= {} as Record<RankOption, unknown>)[option] = removed.rows.join(", ");
  }
  t.diagnostic(JSON.stringify(table));
  // why: a value present before both writes comes back empty with plain undo, and as it was before with option B
  assert.deepEqual(table.status, { A: undefined, B: "todo", C: undefined, D: undefined });
  assert.deepEqual(table.lens, { A: undefined, B: "wide", C: undefined, D: undefined });
  // why: a join and a removal have no value before them, so empty is the state before both writes in every option;
  // Alice's join or removal is gone after Bob undoes his own
  for (const option of OPTIONS) {
    assert.equal(table.joined?.[option], "A: a / , B: b / , #H h", option);
    assert.equal(table.removed?.[option], "A: a / , B: b / , #H h", option);
  }
});
