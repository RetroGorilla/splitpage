import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runBufferTrace } from "./buffer-cases.ts";
import { ADAPTER_BUFFER_LIMIT_RUNS, runPendingUpdate, runTypedBesideRestored, undoLimits } from "./limits.ts";
import { ADAPTER_WORLD, BOLD, MODEL_WORLD, TAG_P } from "./scenario.ts";
import type { UndoReplica } from "./scenario.ts";

const TESTS = ["stage1-records.test.ts", "limits.test.ts", "../../application/editing/undo/shared-undo.test.ts"]
  .map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");

test("the declared limits are Stage 1's seven and two of the shared document, each carried, resolved or waiting", () => {
  assert.deepEqual(undoLimits.map(limit => [limit.id, limit.state]), [
    ["double-restore", "carried"],
    ["later-format", "resolved"],
    ["sequential-status", "resolved"],
    ["status-redo-conflict", "resolved"],
    ["redone-recovery", "waits"],
    ["redone-mark-reversed", "resolved"],
    ["pending-update", "carried"],
    ["insert-after-deleted-run", "carried"],
    ["typed-beside-restored", "carried"]
  ]);
});

test("carried limit typed-beside-restored: the literal history fails in the declared way", () => {
  const limit = undoLimits.find(candidate => candidate.id === "typed-beside-restored");
  assert.ok(limit?.literal);
  assert.throws(limit.literal.run, error => error instanceof Error && limit.literal !== undefined && limit.literal.failure.test(error.message));
  assert.deepEqual(runTypedBesideRestored(ADAPTER_WORLD, false), ["abX", "aXb", "aXb", "aXb"]);
  assert.deepEqual(runTypedBesideRestored(MODEL_WORLD, false), ["abX", "abX", "abX", "abX"]);
});

test("carried limit insert-after-deleted-run: the literal histories fail in the declared way", () => {
  assert.deepEqual(ADAPTER_BUFFER_LIMIT_RUNS, [{ trace: "T01", order: "late-C" }, { trace: "T01 composition", order: "late-C" }]);
  const limit = undoLimits.find(candidate => candidate.id === "insert-after-deleted-run");
  assert.ok(limit?.literal);
  assert.throws(limit.literal.run, error => error instanceof Error && limit.literal !== undefined && limit.literal.failure.test(error.message));
  assert.throws(() => runBufferTrace("T01 composition", "late-C", ADAPTER_WORLD),
    /^Error: T01 composition late-C undone\/A\.rows\[0\]\.characters\[2\]\.identity\.client: expected 2, got 1$/);
  runBufferTrace("T01", "late-C", MODEL_WORLD);
  runBufferTrace("T01 composition", "late-C", MODEL_WORLD);
});

test("every limit names the history that shows it and a test that exists", () => {
  for (const limit of undoLimits) {
    assert.ok(limit.history.length > 40, limit.id);
    assert.ok(TESTS.includes(`"${limit.shown}`) || TESTS.includes("`" + limit.shown.replace("remove", "${command}")), limit.id);
    assert.equal(limit.matches !== undefined || limit.literal !== undefined, limit.state === "carried", limit.id);
  }
});

test("carried limit double-restore: the literal history fails in the declared way", () => {
  const limit = undoLimits.find(candidate => candidate.id === "double-restore");
  assert.ok(limit?.literal);
  assert.throws(limit.literal.run, error => error instanceof Error && limit.literal !== undefined && limit.literal.failure.test(error.message));
});

test("carried limit insert-after-deleted-run: the smallest history ends equal on every copy, with nothing typed lost or twice", () => {
  const read = (kind: typeof ADAPTER_WORLD): string[] => {
    const world = kind.make([{ id: "R1", text: "abcd" }]), a = world.replica("A"), b = world.replica("B");
    const held = b.observe("R1", 2, 2);
    a.edit({ at: a.observe("R1", 1, 3), command: "cut" });
    world.queue.flush("D1");
    b.edit({ at: held, text: "X" });
    world.queue.flush("D1");
    const typed = [a, b, world.fresh("A")].map(replica => replica.snapshot().rows.map(row => row.characters.map(character => character.value).join("")).join("|"));
    const undone = a.undo.undo();
    assert.equal(undone.ok && undone.effective, true);
    world.queue.flush("D1");
    return [...typed, ...[a, b, world.fresh("A")].map(replica => replica.snapshot().rows.map(row => row.characters.map(character => character.value).join("")).join("|"))];
  };
  assert.deepEqual(read(ADAPTER_WORLD), ["aXd", "aXd", "aXd", "abcXd", "abcXd", "abcXd"]);
  assert.deepEqual(read(MODEL_WORLD), ["aXd", "aXd", "aXd", "abXcd", "abXcd", "abXcd"]);
});

test("waiting limits name the cut that examines them", () => {
  assert.deepEqual(undoLimits.filter(limit => limit.state === "waits").map(limit => [limit.id, /removal/.exec(limit.history)?.[0]]), [["redone-recovery", "removal"]]);
});

function marks(replica: UndoReplica): string {
  return replica.snapshot().rows.map(row => row.characters.map(character => character.value + "[" + character.marks.join(",") + "]").join(" ")).join("|");
}

test("former limit redone-mark-reversed: a redone tag stays when the writer's undo and redo arrive in reverse", () => {
  for (const kind of [ADAPTER_WORLD, MODEL_WORLD]) {
    const world = kind.make([{ id: "R1", text: "ab" }]), a = world.replica("A"), b = world.replica("B");
    a.mark(a.observe("R1", 0, 2), TAG_P);
    b.mark(b.observe("R1", 0, 1), BOLD);
    world.queue.flush("D1");
    const undone = a.undo.undo(), redone = a.undo.redo();
    assert.equal(undone.ok && undone.effective && redone.ok && redone.effective, true);
    const waiting = world.queue.pending.filter(message => message.to === "B").map(message => message.id);
    assert.equal(waiting.length, 2);
    for (const id of waiting.reverse()) world.queue.deliver(id);
    assert.deepEqual([a, b, world.fresh("A"), world.fresh("B")].map(marks),
      ["a[b:true,tag:P] b[tag:P]", "a[b:true,tag:P] b[tag:P]", "a[b:true,tag:P] b[tag:P]", "a[b:true,tag:P] b[tag:P]"], kind.suffix);
  }
});

test("carried limit pending-update: the literal history fails in the declared way", () => {
  const limit = undoLimits.find(candidate => candidate.id === "pending-update");
  assert.ok(limit?.literal);
  assert.throws(limit.literal.run, error => error instanceof Error && limit.literal !== undefined && limit.literal.failure.test(error.message));
  assert.deepEqual(runPendingUpdate(false), ["b", "YbX", "YbX", "YbX", "YbX", "YbX"]);
});

test("pending-update: a later update that only inserts is held whole, and the copy takes a command meanwhile", () => {
  const world = ADAPTER_WORLD.make([{ id: "R1", text: "ab" }], ["A", "B", "C"]), b = world.replica("B"), c = world.replica("C");
  b.edit({ at: b.observe("R1", 2, 2), text: "X", command: "paste" });
  b.edit({ at: b.observe("R1", 3, 3), text: "Y", command: "paste" });
  const waiting = world.queue.pending.filter(message => message.to === "C").map(message => message.id);
  assert.equal(waiting.length, 2);
  world.queue.deliver(waiting[1] ?? "");
  const sizes = c.undo.sizes();
  assert.equal(marks(c), "a[] b[]");
  c.edit({ at: c.observe("R1", 0, 0), text: "Z", command: "paste" });
  assert.equal(marks(c), "Z[] a[] b[]");
  world.queue.deliver(waiting[0] ?? "");
  assert.equal(marks(c), "Z[] a[] b[] X[] Y[]");
  assert.deepEqual(c.undo.sizes(), { ...sizes, undo: sizes.undo + 1 });
  world.queue.flush("D1");
  assert.deepEqual([world.replica("A"), b, c, world.fresh("A")].map(marks), ["Z[] a[] b[] X[] Y[]", "Z[] a[] b[] X[] Y[]", "Z[] a[] b[] X[] Y[]", "Z[] a[] b[] X[] Y[]"]);
});
