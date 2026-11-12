import test from "node:test";
import assert from "node:assert/strict";
import type { OracleCharacter, ScriptOracle } from "../checker.ts";
import { deliveryOrders } from "../delivery.ts";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { ref } from "../../adapters/collab/executor-support.ts";
import { scalarTarget } from "../../../src/adapters/collab/scalar-executor.ts";
import { ModelWorld } from "./model-world.ts";
import type { ModelReplica } from "./model-world.ts";
import { BOLD, TAG_P, UndoScenario } from "./scenario.ts";

const ABC = [{ id: "R1", text: "abc" }];
const AB = [{ id: "R1", text: "ab" }];
const LENGTH = { scope: "beat", record: ref("R1") } as const;

function r1(...characters: OracleCharacter[]): ScriptOracle {
  return { rows: [{ id: "R1", characters }], carets: {}, recovery: [] };
}

function modelOwners(replica: ModelReplica): [string, string[]][] {
  return replica.view.visible("R1").map(id => [replica.view.characters.get(id)?.value ?? "", replica.view.occurrences(id).map(mark => mark.by.charAt(0))]);
}

function adapterOwners(h: Stage1ExecutorHarness, writer: "A" | "B"): [string, string[]][] {
  return h.characters(h.handle(writer), "R1").map(char => [char.value, char.marks.flatMap(group => group.additions.map(addition => {
    const named = JSON.parse(addition.operation) as [string, string, number];
    return named[1].charAt(0);
  }))]);
}

test("mirrors prepareSharedMarkChange: a later bold over text that is partly bold writes its own occurrence over the whole range", () => {
  const expected: [string, string[]][] = [["a", ["A"]], ["b", ["A", "B"]], ["c", ["B"]]];
  const h = new Stage1ExecutorHarness(ABC);
  try {
    h.execute("A", [h.mark("A", "R1", h.range("A", "R1", 0, 2), BOLD)]);
    h.queue.flush("D1");
    h.execute("B", [h.mark("B", "R1", h.range("B", "R1", 1, 3), BOLD)]);
    h.queue.flush("D1");
    assert.deepEqual(adapterOwners(h, "A"), expected);
    assert.deepEqual(adapterOwners(h, "B"), expected);
  } finally { h.destroy(); }
  const world = new ModelWorld(ABC), a = world.replica("A"), b = world.replica("B");
  a.mark(a.observe("R1", 0, 2), BOLD);
  world.queue.flush("D1");
  b.mark(b.observe("R1", 1, 3), BOLD);
  world.queue.flush("D1");
  assert.deepEqual(modelOwners(a), expected);
  assert.deepEqual(modelOwners(b), expected);
});

test("Alice bolds ab, Bob then bolds bc: Alice's undo leaves bc bold, and Bob's undo then leaves none", () => {
  for (const order of deliveryOrders) {
    const s = new UndoScenario(ABC, order);
    s.format(s.a, "R1", 0, 2, BOLD);
    s.deliver();
    s.format(s.b, "R1", 1, 3, BOLD);
    s.check("both bold", r1(["s1", "a", { b: true }], ["s2", "b", { b: true }], ["s3", "c", { b: true }]));
    s.effective(s.a.undo.undo());
    s.check("Alice undone", r1(["s1", "a", {}], ["s2", "b", { b: true }], ["s3", "c", { b: true }]));
    s.effective(s.b.undo.undo());
    s.check("Bob undone", r1(["s1", "a", {}], ["s2", "b", {}], ["s3", "c", {}]));
    s.effective(s.a.undo.redo());
    s.check("Alice redone", r1(["s1", "a", { b: true }], ["s2", "b", { b: true }], ["s3", "c", {}]));
    assert.equal(s.checks, 4);
  }
});

const TAGGED = r1(["s1", "a", { tag: "P" }], ["s2", "b", { tag: "P" }]);
const UNTAGGED = r1(["s1", "a", {}], ["s2", "b", {}]);

for (const first of ["Alice", "Bob"] as const) {
  test(`Beyond Stage 1: the same tag by two writers, ${first} undoes before the other's tag arrives: untagged on every copy, the other's undo is used up`, () => {
    for (const order of deliveryOrders) {
      const s = new UndoScenario(AB, order), [one, two] = first === "Alice" ? [s.a, s.b] : [s.b, s.a];
      s.format(s.a, "R1", 0, 2, TAG_P);
      s.format(s.b, "R1", 0, 2, TAG_P);
      s.effective(one.undo.undo());
      s.check("undone before arrival", UNTAGGED);
      s.usedUp(two);
      s.check("the other's undo used up", UNTAGGED);
      assert.deepEqual(two.undo.redo(), { ok: false, empty: true });
      s.effective(one.undo.redo());
      s.check("redone", TAGGED);
      assert.equal(s.checks, 3);
    }
  });
  test(`Beyond Stage 1: the same tag by two writers, both undo before anything arrives, ${first} first: untagged on every copy`, () => {
    for (const order of deliveryOrders) {
      const s = new UndoScenario(AB, order), [one, two] = first === "Alice" ? [s.a, s.b] : [s.b, s.a];
      s.format(s.a, "R1", 0, 2, TAG_P);
      s.format(s.b, "R1", 0, 2, TAG_P);
      s.effective(one.undo.undo());
      s.effective(two.undo.undo());
      s.check("both undone", UNTAGGED);
      assert.equal(s.checks, 1);
    }
  });
}

test("Beyond Stage 1: the same tag by three writers, one undoes before the others' arrive: untagged on every copy and both other undos are used up", () => {
  for (const order of ["D1", "dup", "rev"] as const) for (const undoer of ["A", "B", "C"] as const) {
    const world = new ModelWorld(AB, ["A", "B", "C"]), all = (["A", "B", "C"] as const).map(name => world.replica(name));
    for (const replica of all) replica.mark(replica.observe("R1", 0, 2), TAG_P);
    const outcome = world.replica(undoer).undo.undo();
    assert.deepEqual(outcome.ok && outcome.effective, true);
    world.queue.flush(order);
    for (const replica of all) assert.deepEqual(replica.snapshot().rows[0]?.characters.map(character => [character.value, character.marks]), [["a", []], ["b", []]]);
    for (const replica of all) if (replica.name !== undoer) {
      const used = replica.undo.undo();
      assert.deepEqual(used.ok && used.effective, false);
      assert.deepEqual(replica.undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
    }
    world.queue.flush(order);
    for (const replica of all) assert.deepEqual(replica.snapshot().rows[0]?.characters.map(character => [character.value, character.marks]), [["a", []], ["b", []]]);
  }
});

test("a tag over other words, or one made after seeing the first, is another change and stays when the first is undone", () => {
  for (const order of deliveryOrders) {
    const wider = new UndoScenario(ABC, order);
    wider.format(wider.a, "R1", 0, 2, TAG_P);
    wider.format(wider.b, "R1", 0, 3, TAG_P);
    wider.effective(wider.a.undo.undo());
    wider.check("wider tag stays", r1(["s1", "a", { tag: "P" }], ["s2", "b", { tag: "P" }], ["s3", "c", { tag: "P" }]));
    const later = new UndoScenario(AB, order);
    later.format(later.a, "R1", 0, 2, TAG_P);
    later.deliver();
    later.format(later.b, "R1", 0, 2, TAG_P);
    later.effective(later.a.undo.undo());
    later.check("later tag stays", TAGGED);
    later.effective(later.b.undo.undo());
    later.check("its own undo removes it", UNTAGGED);
  }
});

interface ScalarCase { readonly name: string; readonly steps: readonly (readonly ["A" | "B", number | null] | "deliver")[]; readonly order: "D1" | "rev"; readonly value: number | null }

const SCALARS: readonly ScalarCase[] = [
  { name: "unseen sets, Alice then Bob, delivered in reverse: the higher client's stays", steps: [["A", 1], ["B", 2]], order: "rev", value: 2 },
  { name: "unseen sets, Bob then Alice: the higher client's stays", steps: [["B", 2], ["A", 1]], order: "D1", value: 2 },
  { name: "a set made after seeing the other's replaces it", steps: [["B", 2], "deliver", ["A", 1]], order: "D1", value: 1 },
  { name: "a clear removes only the value it saw; an unseen set stays", steps: [["A", 5], "deliver", ["A", null], ["B", 7]], order: "rev", value: 7 },
  { name: "a clear by the higher client leaves the lower client's unseen set", steps: [["B", 5], "deliver", ["B", null], ["A", 7]], order: "D1", value: 7 }
];

for (const scalar of SCALARS) test(`mirrors prepareScalar on a Y.Map key: ${scalar.name}`, () => {
  const h = new Stage1ExecutorHarness(AB);
  try {
    h.execute("A", [h.insertion("A", "R1", h.point("A", "R1", 2), "xyz")], ["x", "y", "z"]);
    for (const step of scalar.steps) {
      if (step === "deliver") { h.queue.flush("D1"); continue; }
      const [writer, value] = step;
      h.execute(writer, [h.command(writer, { kind: "scalar", target: LENGTH, field: "lengthSeconds", ...(value === null ? { clear: true } : { value }) })]);
    }
    h.queue.flush(scalar.order);
    for (const writer of ["A", "B"] as const) assert.equal(scalarTarget(h.handle(writer), LENGTH)?.get("lengthSeconds") ?? null, scalar.value, writer);
  } finally { h.destroy(); }
  const world = new ModelWorld(AB), a = world.replica("A");
  a.edit({ at: a.observe("R1", 2, 2), text: "xyz" });
  for (const step of scalar.steps) {
    if (step === "deliver") { world.queue.flush("D1"); continue; }
    world.replica(step[0]).scalar("R1", "lengthSeconds", step[1] ?? undefined);
  }
  world.queue.flush(scalar.order);
  for (const writer of ["A", "B"] as const) {
    const now = world.replica(writer).view.scalar("R1", "lengthSeconds");
    assert.equal(now.clear ? null : now.value, scalar.value, writer);
  }
});

test("unseen sets of one field: the undo of the set that lost is used up and the other's value stays; the winner's undo clears it", () => {
  for (const order of deliveryOrders) {
    const s = new UndoScenario(AB, order), fields = (): (string | undefined)[] => [s.a, s.b].map(replica => replica.snapshot().rows[0]?.scalars.lengthSeconds);
    s.type(s.a, "R1", 2, "xyz", ["a1", "a2", "a3"]);
    s.a.scalar("R1", "lengthSeconds", 1);
    s.b.scalar("R1", "lengthSeconds", 2);
    s.deliver();
    assert.deepEqual(fields(), ["2", "2"]);
    s.usedUp(s.a);
    s.deliver();
    assert.deepEqual(fields(), ["2", "2"]);
    assert.deepEqual(s.a.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    s.effective(s.b.undo.undo());
    s.deliver();
    assert.deepEqual(fields(), [undefined, undefined]);
    s.effective(s.b.undo.redo());
    s.deliver();
    assert.deepEqual(fields(), ["2", "2"]);
  }
});
