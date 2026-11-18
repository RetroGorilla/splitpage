import assert from "node:assert/strict";
import test from "node:test";
import type { World } from "../../src/native-undo/harness.ts";
import { records, settled, stacks, world } from "./kit.ts";

interface Kind {
  readonly name: string;
  readonly before?: (world: World) => void;
  readonly act: (world: World) => void;
  readonly remote: (world: World) => void;
  readonly done: readonly string[];
  readonly undone: readonly string[];
  readonly fields?: { done: unknown; undone: unknown };
}

const KINDS: readonly Kind[] = [
  {
    name: "typing", act: w => { w.type("A", "R1", "audioText", 2, "XY"); }, remote: w => { w.type("B", "R1", "audioText", 0, "Q"); },
    done: ["R1: QabXYcd / vw (todo)", "R2: efg (todo)"], undone: ["R1: Qabcd / vw (todo)", "R2: efg (todo)"]
  },
  {
    name: "deleting", act: w => { w.erase("A", "R1", "audioText", 1, 3); }, remote: w => { w.type("B", "R1", "audioText", 1, "Q"); },
    done: ["R1: aQd / vw (todo)", "R2: efg (todo)"], undone: ["R1: abcQd / vw (todo)", "R2: efg (todo)"]
  },
  {
    name: "formatting", act: w => { w.command("A", [{ do: "format", beat: "R1", field: "audioText", from: 1, to: 3, mark: "b", on: true }]); },
    remote: w => { w.type("B", "R1", "audioText", 4, "Q"); },
    done: ["R1: a[bc|b]dQ / vw (todo)", "R2: efg (todo)"], undone: ["R1: abcdQ / vw (todo)", "R2: efg (todo)"]
  },
  {
    name: "unformatting", before: w => { w.command("A", [{ do: "format", beat: "R1", field: "audioText", from: 0, to: 4, mark: "b", on: true }]); },
    act: w => { w.command("A", [{ do: "format", beat: "R1", field: "audioText", from: 1, to: 3, mark: "b", on: false }]); },
    remote: w => { w.type("B", "R2", "audioText", 3, "Q"); },
    done: ["R1: [a|b]bc[d|b] / vw (todo)", "R2: efgQ (todo)"], undone: ["R1: [abcd|b] / vw (todo)", "R2: efgQ (todo)"]
  },
  {
    name: "split", act: w => { w.command("A", [{ do: "split", beat: "R1", at: 2, created: "S1" }]); },
    remote: w => { w.type("B", "S1", "visualText", 0, "V"); w.type("B", "S1", "audioText", 0, "Q"); },
    done: ["R1: ab / vw (todo)", "S1: Qcd / V (todo)", "R2: efg (todo)"], undone: ["R1: abQcd / vw (todo)", "R2: efg (todo)", "recovery S1:  / V"]
  },
  {
    name: "join", act: w => { w.command("A", [{ do: "set", beat: "R2", key: "joined", value: { into: "R1", glue: " " } }]); },
    remote: w => { w.type("B", "R2", "audioText", 0, "Q"); },
    done: ["R1: abcd Qefg / vw (todo)"], undone: ["R1: abcd / vw (todo)", "R2: Qefg (todo)"]
  },
  {
    name: "remove", act: w => { w.command("A", [{ do: "set", beat: "R2", key: "removed", value: { by: "A", at: 1, seen: {} } }]); },
    remote: w => { w.type("B", "R2", "audioText", 0, "Q"); },
    done: ["R1: abcd / vw (todo)", "recovery R2: Qefg (unseen Qefg)"], undone: ["R1: abcd / vw (todo)", "R2: Qefg (todo)"]
  },
  {
    name: "restore", before: w => { w.command("A", [{ do: "set", beat: "R2", key: "removed", value: { by: "A", at: 1, seen: {} } }]); },
    act: w => { w.command("A", [{ do: "clear", beat: "R2", key: "removed" }]); }, remote: w => { w.type("B", "R2", "audioText", 0, "Q"); },
    done: ["R1: abcd / vw (todo)", "R2: Qefg (todo)"], undone: ["R1: abcd / vw (todo)", "recovery R2: Qefg (unseen Qefg)"]
  },
  {
    name: "status", act: w => { w.command("A", [{ do: "set", beat: "R1", key: "status", value: "ready" }]); },
    remote: w => { w.command("B", [{ do: "set", beat: "R2", key: "status", value: "shot" }]); },
    done: ["R1: abcd / vw (ready)", "R2: efg (shot)"], undone: ["R1: abcd / vw (todo)", "R2: efg (shot)"]
  },
  {
    name: "tag", act: w => { w.command("A", [{ do: "format", beat: "R1", field: "audioText", from: 0, to: 2, mark: "t:T1", on: true }]); },
    remote: w => { w.type("B", "R1", "audioText", 1, "Q", ["t:T1"]); },
    done: ["R1: [aQb|t:T1]cd / vw (todo)", "R2: efg (todo)"], undone: ["R1: aQbcd / vw (todo)", "R2: efg (todo)"]
  },
  {
    name: "record creation", act: w => { w.command("A", [{ do: "record", root: "people", id: "P1", fields: { name: "Ada", colour: "red" } }]); },
    remote: w => { w.command("B", [{ do: "field", root: "people", id: "P1", key: "note", value: "lead" }]); },
    done: ["R1: abcd / vw (todo)", "R2: efg (todo)"], undone: ["R1: abcd / vw (todo)", "R2: efg (todo)"],
    fields: { done: { P1: { name: "Ada", colour: "red", note: "lead" } }, undone: { P1: { note: "lead" } } }
  },
  {
    name: "record edit", before: w => { w.command("A", [{ do: "record", root: "people", id: "P1", fields: { name: "Ada", colour: "red" } }]); },
    act: w => { w.command("A", [{ do: "field", root: "people", id: "P1", key: "colour", value: "blue" }]); },
    remote: w => { w.command("B", [{ do: "field", root: "people", id: "P1", key: "name", value: "Bea" }]); },
    done: ["R1: abcd / vw (todo)", "R2: efg (todo)"], undone: ["R1: abcd / vw (todo)", "R2: efg (todo)"],
    fields: { done: { P1: { name: "Bea", colour: "blue" } }, undone: { P1: { name: "Bea", colour: "red" } } }
  }
];

for (const kind of KINDS) test(`${kind.name} alone, with another person's change in between, through undo, redo, undo`, () => {
  const w = world();
  if (kind.before) { kind.before(w); settled(w, "setup"); }
  const base = stacks(w, "A")[0];
  kind.act(w); settled(w, "command");
  kind.remote(w);
  assert.deepEqual(settled(w, "remote change"), kind.done);
  assert.deepEqual(stacks(w, "A"), [base + 1, 0]);
  const updates = w.copy("A").layer.updates;
  for (const [press, expected, after] of [["undo", kind.undone, [base, 1]], ["redo", kind.done, [base + 1, 0]], ["undo", kind.undone, [base, 1]]] as const) {
    assert.ok(press === "undo" ? w.undo("A") : w.redo("A"), `${press} applied`);
    assert.deepEqual(settled(w, press), expected, press);
    assert.deepEqual(stacks(w, "A"), after, `${press} stacks`);
    if (kind.fields) assert.deepEqual(records(w).people, press === "redo" ? kind.fields.done : kind.fields.undone, `${press} fields`);
  }
  assert.equal(w.copy("A").layer.updates - updates, 3, "one Yjs update event per press");
});
