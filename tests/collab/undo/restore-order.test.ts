import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_WORLD, MODEL_WORLD, UNDO_WORLDS } from "./scenario.ts";
import type { UndoReplica, UndoWorld } from "./scenario.ts";

function text(replica: UndoReplica): string {
  return replica.snapshot().rows.map(row => row.characters.map(character => character.value).join("")).join("|");
}

function undo(replica: UndoReplica): void {
  const outcome = replica.undo.undo();
  assert.equal(outcome.ok && outcome.effective, true);
}

function everywhere(world: UndoWorld): string[] {
  world.queue.flush("D1");
  return [world.replica("A"), world.replica("B"), world.fresh("A")].map(text);
}

for (const kind of UNDO_WORLDS) {
  test("two cuts next to each other, the right one first, are undone into the order they had" + kind.suffix, () => {
    const world = kind.make([{ id: "R1", text: "abcdef" }]), a = world.replica("A");
    a.edit({ at: a.observe("R1", 3, 5), command: "cut" });
    a.edit({ at: a.observe("R1", 1, 2 + 1), command: "cut" });
    assert.equal(text(a), "af");
    undo(a);
    assert.equal(text(a), "abcf");
    undo(a);
    assert.deepEqual(everywhere(world), ["abcdef", "abcdef", "abcdef"]);
  });

  test("two single cuts, the right one first, are undone into the order they had" + kind.suffix, () => {
    const world = kind.make([{ id: "R1", text: "abcd" }]), a = world.replica("A");
    a.edit({ at: a.observe("R1", 2, 3), command: "cut" });
    a.edit({ at: a.observe("R1", 1, 2), command: "cut" });
    undo(a);
    undo(a);
    assert.deepEqual(everywhere(world), ["abcd", "abcd", "abcd"]);
  });

  test("a character restored, then cut again with text typed before it, comes back behind that text" + kind.suffix, () => {
    const world = kind.make([{ id: "R1", text: "abc" }]), a = world.replica("A");
    a.edit({ at: a.observe("R1", 1, 2), command: "cut" });
    undo(a);
    a.edit({ at: a.observe("R1", 1, 1), text: "X", command: "paste" });
    assert.equal(text(a), "aXbc");
    a.edit({ at: a.observe("R1", 1, 3), command: "cut" });
    assert.equal(text(a), "ac");
    undo(a);
    assert.deepEqual(everywhere(world), ["aXbc", "aXbc", "aXbc"]);
  });

  test("text pasted in front of redone text is undone and redone in front of it" + kind.suffix, () => {
    const world = kind.make([{ id: "R1", text: "g" }]), a = world.replica("A");
    a.edit({ at: a.observe("R1", 0, 1), text: "uv", command: "paste" });
    undo(a);
    const redone = a.undo.redo();
    assert.equal(redone.ok && redone.effective, true);
    a.edit({ at: a.observe("R1", 0, 0), text: "klm", command: "paste" });
    assert.equal(text(a), "klmuv");
    undo(a);
    assert.equal(text(a), "uv");
    const again = a.undo.redo();
    assert.equal(again.ok && again.effective, true);
    assert.deepEqual(everywhere(world), ["klmuv", "klmuv", "klmuv"]);
  });

  test("part of redone text cut with the character before it is undone into the order it had" + kind.suffix, () => {
    const world = kind.make([{ id: "R1", text: "ij" }]), a = world.replica("A");
    a.edit({ at: a.observe("R1", 1, 1), text: "klm", command: "paste" });
    undo(a);
    const redone = a.undo.redo();
    assert.equal(redone.ok && redone.effective, true);
    a.edit({ at: a.observe("R1", 0, 3), command: "cut" });
    assert.equal(text(a), "mj");
    undo(a);
    assert.deepEqual(everywhere(world), ["iklmj", "iklmj", "iklmj"]);
  });

  test("two backspaces over bold text in one typing entry are undone into bold characters in their order" + kind.suffix, () => {
    const world = kind.make([{ id: "R1", text: "abcdef" }]), a = world.replica("A");
    a.mark(a.observe("R1", 1, 3), { kind: "b", value: true });
    a.edit({ at: a.observe("R1", 2, 3) });
    a.typing = true;
    a.edit({ at: a.observe("R1", 1, 2) });
    a.typing = false;
    assert.equal(a.undo.sizes().undo, 2);
    undo(a);
    world.queue.flush("D1");
    assert.deepEqual([world.replica("A"), world.replica("B"), world.fresh("A")].map(copy => copy.snapshot().rows[0]?.characters.map(character => [character.value, character.marks])),
      Array.from({ length: 3 }, () => [["a", []], ["b", ["b:true"]], ["c", ["b:true"]], ["d", []], ["e", []], ["f", []]]));
  });

  test("a cut undone while the text after it is still cut stays before what the other writer put into that text" + kind.suffix, () => {
    const world = kind.make([{ id: "R1", text: "abcdef" }]), a = world.replica("A"), b = world.replica("B");
    a.edit({ at: a.observe("R1", 3, 6), command: "cut" });
    a.edit({ at: a.observe("R1", 2, 3), command: "cut" });
    b.edit({ at: b.observe("R1", 5, 6), text: "q", command: "paste" });
    assert.equal(text(b), "abcdeq");
    undo(a);
    assert.equal(text(a), "abc");
    assert.deepEqual(everywhere(world), ["abcq", "abcq", "abcq"]);
  });
}

test("two cuts undone after the other writer typed where they were: the cut text is whole and in order on every copy", () => {
  const read = (kind: typeof ADAPTER_WORLD): string[] => {
    const world = kind.make([{ id: "R1", text: "abcdef" }]), a = world.replica("A"), b = world.replica("B");
    a.edit({ at: a.observe("R1", 3, 5), command: "cut" });
    a.edit({ at: a.observe("R1", 1, 3), command: "cut" });
    world.queue.flush("D1");
    b.edit({ at: b.observe("R1", 1, 1), text: "X", command: "paste" });
    world.queue.flush("D1");
    undo(a);
    undo(a);
    return everywhere(world);
  };
  assert.deepEqual(read(ADAPTER_WORLD), ["abcdeXf", "abcdeXf", "abcdeXf"]);
  assert.deepEqual(read(MODEL_WORLD), ["abcdeXf", "abcdeXf", "abcdeXf"]);
});
