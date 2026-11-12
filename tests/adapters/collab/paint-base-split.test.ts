import { structureIdentityFixture } from "../../collab/structure-identity.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { createSharedAnchor, sharedAnchorCharacterEnd } from "../../../src/adapters/collab/anchors.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedContentRef, SharedOperation, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import type { PaintedText } from "../../../src/application/editing/ports.ts";
import { agree, operation, ref, replicas } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const WHO = '<span class="who-anchor" data-who="Sam">@Sam</span>';
const NEW = structureIdentityFixture("1", "enter", "beat");
const SOURCE: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };
const CREATED: SharedTextAddress = { owner: ref(NEW), segment: ref("b:R1"), field: "audioText" };
const structurePorts = { cells: createFlowLoadRuntime().cells };

test("created visual text has one flow-shaped address for painted reads and executor writes", () => {
  const set = replicas(3, { rows: [{ id: "R1", audioText: "ab" }] });
  try {
    for (const handle of [set.a, set.b, set.c]) { registerSharedSplitHandlers(handle, structurePorts); registerSharedTextOperationHandlers(handle); }
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "segment-create", id: "enter", by: "Writer", beat: "new", segment: "new",
      at: { left: "R1", right: null, affinity: "after" }, fields: { visualText: "<strong>Visual</strong>" } })], { base: readSharedRevision(set.a) }), { ok: true });
    set.queue.flush("dup");
    const target = { owner: ref(NEW), segment: ref(NEW), field: "visualText" as const };
    agree("paint created visual", "dup", [set.a, set.b, set.c], handle => readSharedPaintedText(handle, target)?.text, "Visual");
    const first = readSharedPaintedText(set.b, target)?.identity(0); assert.ok(first);
    assert.deepEqual(executeSharedOperations(set.b, [operation({ kind: "text-insert", id: "visual-edit", by: "Writer", target,
      at: { left: null, right: first, affinity: "before" }, content: [{ value: "!", marks: [] }] })], { base: readSharedRevision(set.b) }), { ok: true });
    set.queue.flush("rev");
    agree("edit created visual through painted identity", "rev", [set.a, set.b, set.c], handle => readSharedPaintedText(handle, target)?.text, "!Visual");
  } finally { set.close(); }
});

function splitAtD(before: boolean) {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" + WHO + "cdef" }, { id: "R2", audioText: "gh" }] });
  for (const handle of [set.a, set.b]) { registerSharedSplitHandlers(handle, structurePorts); registerSharedTextOperationHandlers(handle); }
  const whole = readSharedPaintedText(set.a, SOURCE);
  assert.ok(whole);
  assert.deepEqual([whole.text, whole.revision], ["ab￼cdef", 1]);
  const right = createSharedAnchor(set.a, "b:R1", 4, "after"), observed = captureSharedTextRange(set.a, SOURCE, 0, 7);
  assert.ok(right && observed);
  assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: before ? "split-before" : "split", id: "enter", by: "Writer", target: SOURCE,
    at: { left: null, right, affinity: "before" }, observed: [observed], boundary: "same-boundary", beat: "same-beat", fields: { status: "todo" } })],
  { base: whole.revision }), { ok: true });
  set.queue.flush("D1");
  const record = collabState(set.a).roots.beats.get(NEW);
  assert.ok(record instanceof Y.Map);
  assert.deepEqual([record.get("segment"), record.get("splitBy")], ["b:R1", "Writer"]);
  return { set, whole, first: before ? CREATED : SOURCE, second: before ? SOURCE : CREATED };
}

function read(handle: SharedDocumentHandle, target: SharedTextAddress): PaintedText {
  const painted = readSharedPaintedText(handle, target);
  assert.ok(painted);
  return painted;
}

function units(painted: PaintedText): SharedContentRef[] {
  assert.equal(painted.identity(painted.text.length), null);
  return [...Array(painted.text.length).keys()].map(index => { const identity = painted.identity(index); assert.ok(identity); return identity; });
}

function locate(handle: SharedDocumentHandle, anchors: readonly SharedContentRef[]): string[] {
  const preparation = createSharedPreparation(handle);
  try {
    const text = preparation.view.text(["segments", "b:R1", "text"]);
    assert.ok(text);
    return anchors.map(anchor => { const found = text.resolveAnchor(anchor); return found.kind === "gone" ? "gone" : found.kind + " " + found.index; });
  } finally { preparation.close(); }
}

function fromPaintedBase(target: SharedTextAddress, painted: PaintedText, id: string): SharedOperation[] {
  const [first, second] = units(painted);
  assert.ok(first && second);
  const afterFirst = sharedAnchorCharacterEnd(first);
  assert.ok(afterFirst);
  return [operation({ kind: "text-delete", id: id + ":delete", by: "Alice", target, observed: [second] }),
    operation({ kind: "text-insert", id: id + ":insert", by: "Alice", target, at: { left: afterFirst, right: null, affinity: "after" }, content: [{ value: "Q", marks: [] }] })];
}

for (const before of [false, true]) test(`after a ${before ? "prefix " : ""}split each half's painted record holds its own units, counted from its first`, () => {
  const { set, whole, first, second } = splitAtD(before);
  try {
    const head = read(set.a, first), tail = read(set.a, second);
    assert.deepEqual([head.text, tail.text], ["ab￼c", "def"]);
    assert.deepEqual([head.revision, tail.revision, readSharedRevision(set.a)], [2, 2, 2]);
    const heads = units(head), tails = units(tail);
    assert.deepEqual(heads, [0, 1, 2, 3].map(index => createSharedAnchor(set.a, "b:R1", index, "after")));
    assert.deepEqual(tails, [5, 6, 7].map(index => createSharedAnchor(set.a, "b:R1", index, "after")));
    assert.deepEqual([...heads, ...tails], units(whole));
    assert.equal(readSharedPaintedText(set.a, { ...SOURCE, owner: ref("R2") }), null);
    assert.equal(read(set.a, { owner: ref("R2"), segment: ref("b:R2"), field: "audioText" }).text, "gh");
    const positions = (handle: SharedDocumentHandle) => ({ head: locate(handle, heads), tail: locate(handle, tails) });
    agree("painted halves", "D1", [set.a, set.b], positions, { head: ["index 0", "index 1", "index 2", "index 3"], tail: ["index 5", "index 6", "index 7"] });
    const b = heads[1], f = tails[2];
    assert.ok(b && f);
    const afterF = sharedAnchorCharacterEnd(f);
    assert.ok(afterF);
    assert.deepEqual(executeSharedOperations(set.b, [
      operation({ kind: "text-delete", id: "B:1", by: "Bob", target: first, observed: [b] }),
      operation({ kind: "text-insert", id: "B:2", by: "Bob", target: second, at: { left: afterF, right: null, affinity: "after" }, content: [{ value: "Z", marks: [] }] })
    ], { base: readSharedRevision(set.b) }), { ok: true });
    set.queue.flush("rev");
    assert.deepEqual([head.text, tail.text], ["ab￼c", "def"]);
    assert.deepEqual([units(head), units(tail)], [heads, tails]);
    agree("painted halves after an edit in each", "rev", [set.a, set.b], positions, { head: ["index 0", "gap 1", "index 1", "index 2"], tail: ["index 4", "index 5", "index 6"] });
    assert.deepEqual([read(set.a, first).text, read(set.a, second).text, read(set.b, first).text, read(set.b, second).text], ["a￼c", "defZ", "a￼c", "defZ"]);
  } finally { set.close(); }
});

for (const before of [false, true]) for (const half of ["first", "second"] as const) test(`a list built from the ${half} half of a ${before ? "prefix " : ""}split is accepted at the painted revision and refused whole once it moved`, () => {
  const expected = half === "first" ? ["aQ￼c", "def"] : ["ab￼c", "dQf"];
  const accepted = splitAtD(before);
  try {
    const target = accepted[half], painted = read(accepted.set.a, target);
    assert.deepEqual(executeSharedOperations(accepted.set.a, fromPaintedBase(target, painted, "A:1"), { base: painted.revision }), { ok: true });
    assert.deepEqual([read(accepted.set.a, accepted.first).text, read(accepted.set.a, accepted.second).text], expected);
    assert.equal(readSharedRevision(accepted.set.a), painted.revision + 1);
  } finally { accepted.set.close(); }
  const moved = splitAtD(before);
  try {
    const { set } = moved, target = moved[half], other = moved[half === "first" ? "second" : "first"], painted = read(set.a, target);
    const last = units(read(set.b, other)).at(-1);
    assert.ok(last);
    const end = sharedAnchorCharacterEnd(last);
    assert.ok(end);
    assert.deepEqual(executeSharedOperations(set.b, [operation({ kind: "text-insert", id: "B:1", by: "Bob", target: other,
      at: { left: end, right: null, affinity: "after" }, content: [{ value: "Z", marks: [] }] })], { base: readSharedRevision(set.b) }), { ok: true });
    set.queue.flush("D1");
    const bytes = encodeSharedState(set.a), revision = readSharedRevision(set.a);
    assert.equal(revision, painted.revision + 1);
    assert.deepEqual(executeSharedOperations(set.a, fromPaintedBase(target, painted, "A:1"), { base: painted.revision }), { ok: false, reason: "stale-base" });
    assert.deepEqual(encodeSharedState(set.a), bytes);
    assert.equal(readSharedRevision(set.a), revision);
    assert.equal(set.queue.pending.length, 0);
    const fresh = read(set.a, target);
    assert.deepEqual([fresh.text, fresh.revision], [painted.text, revision]);
    assert.deepEqual(executeSharedOperations(set.a, fromPaintedBase(target, fresh, "A:2"), { base: fresh.revision }), { ok: true });
    assert.deepEqual([read(set.a, moved.first).text, read(set.a, moved.second).text], half === "first" ? ["aQ￼c", "defZ"] : ["ab￼cZ", "dQf"]);
  } finally { moved.set.close(); }
});
