import test from "node:test";
import assert from "node:assert/strict";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { destroySharedDocument, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedContentRef, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import type { PaintedText } from "../../../src/application/editing/ports.ts";
import { execute, ref, replicas } from "./executor-support.ts";

const WHO = '<span class="who-anchor" data-who="Sam">@Sam</span>';
const ROWS = [
  { id: "R1", audioText: "a😀b", visualText: "wxyz" },
  { id: "R2", audioText: "x " + WHO + " y" },
  { id: "R3", audioText: "pl<strong>bo</strong>ld" },
  { id: "R4", audioText: "" }
];

function fixture(): SharedDocumentHandle {
  const handle = createMonitoredSharedDocument();
  collabState(handle).doc.clientID = 1;
  hydrateSharedDocument(handle, validatedFixture({ rows: ROWS }));
  registerSharedTextOperationHandlers(handle);
  return handle;
}

function beat(row: string): SharedTextAddress { return { owner: ref(row), segment: ref("b:" + row), field: "audioText" }; }

function read(handle: SharedDocumentHandle, target: SharedTextAddress): PaintedText {
  const painted = readSharedPaintedText(handle, target);
  assert.ok(painted);
  return painted;
}

function identities(painted: PaintedText): (SharedContentRef | null)[] {
  return [...Array(painted.text.length).keys()].map(index => painted.identity(index));
}

function locate(handle: SharedDocumentHandle, target: SharedTextAddress, anchor: SharedContentRef | null): string {
  const preparation = createSharedPreparation(handle);
  try {
    const text = preparation.view.text(["segments", target.segment, "text"]);
    assert.ok(text);
    const found = text.resolveAnchor(anchor);
    return found.kind === "gone" ? "gone" : found.kind + " " + found.index;
  } finally { preparation.close(); }
}

test("the painted text of a beat has one unit per shared unit, an inline atom as one, at the revision read", () => {
  const handle = fixture();
  try {
    const expected: Record<string, string> = { R1: "a😀b", R2: "x ￼ y", R3: "plbold", R4: "" };
    for (const row of ["R1", "R2", "R3", "R4"]) {
      const target = beat(row), painted = read(handle, target), text = expected[row];
      assert.equal(painted.text, text);
      assert.equal(painted.revision, readSharedRevision(handle));
      assert.equal(Object.isFrozen(painted), true);
      const found = identities(painted);
      assert.equal(found.length, text?.length);
      found.forEach((identity, index) => {
        assert.equal(typeof identity, "string");
        assert.equal(identity, createSharedAnchor(handle, target, index, "after"));
        assert.equal(locate(handle, target, identity), "index " + index);
      });
    }
    assert.equal(read(handle, beat("R1")).revision, 1);
  } finally { destroySharedDocument(handle); }
});

test("an index outside the painted text, an absent beat and an empty beat give no identity", () => {
  const handle = fixture();
  try {
    const painted = read(handle, beat("R3"));
    assert.deepEqual([-1, 6, 7, 1.5, Number.NaN].map(index => painted.identity(index)), [null, null, null, null, null]);
    assert.equal(readSharedPaintedText(handle, beat("absent")), null);
    const empty = read(handle, beat("R4"));
    assert.deepEqual([empty.text, empty.identity(0)], ["", null]);
  } finally { destroySharedDocument(handle); }
});

test("a visual text is read through its own address and its identities resolve in that text", () => {
  const handle = fixture();
  try {
    const target: SharedTextAddress = { owner: ref("R1"), segment: ref("R1"), field: "visualText" };
    const painted = read(handle, target);
    assert.equal(painted.text, "wxyz");
    assert.deepEqual(identities(painted), [0, 1, 2, 3].map(index => createSharedAnchor(handle, target, index, "after")));
    assert.deepEqual(identities(painted).map(identity => resolveSharedAnchor(handle, identity)), [0, 1, 2, 3].map(offset => ({ segment: "R1", offset })));
    assert.equal(String(painted.identity(0)).startsWith('{"v":2,"target":'), true);
    assert.equal(readSharedPaintedText(handle, { ...target, owner: ref("R2") }), null);
  } finally { destroySharedDocument(handle); }
});

test("identity, not offset: a record read before an edit still names the units it was read from", () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "abcdef" }] });
  try {
    registerSharedTextOperationHandlers(h.a); registerSharedTextOperationHandlers(h.b);
    const target = beat("R1"), painted = read(h.a, target), before = identities(painted);
    assert.deepEqual(before.map(identity => locate(h.a, target, identity)), ["index 0", "index 1", "index 2", "index 3", "index 4", "index 5"]);
    execute(h.b, { kind: "text-insert", id: "B:1", by: "Bob", target, at: { left: createSharedAnchor(h.b, target, 3, "before"), right: null, affinity: "after" }, content: [{ value: "XY", marks: [] }] });
    execute(h.b, { kind: "text-delete", id: "B:2", by: "Bob", target, observed: [captureSharedTextRange(h.b, target, 6, 7)] });
    h.queue.flush("D1");
    assert.deepEqual(identities(painted), before);
    assert.equal(painted.text, "abcdef");
    assert.equal(painted.revision, 1);
    assert.deepEqual(before.map(identity => locate(h.a, target, identity)), ["index 0", "index 1", "index 2", "index 5", "gap 6", "index 6"]);
    const fresh = read(h.a, target), now = identities(fresh);
    assert.equal(fresh.text, "abcXYdf");
    assert.equal(fresh.revision, 3);
    assert.deepEqual(now, [0, 1, 2, 3, 4, 5, 6].map(index => createSharedAnchor(h.a, target, index, "after")));
    assert.deepEqual(now.map(identity => locate(h.a, target, identity)), ["index 0", "index 1", "index 2", "index 3", "index 4", "index 5", "index 6"]);
    assert.deepEqual([now[0], now[1], now[2], now[5], now[6]], [before[0], before[1], before[2], before[3], before[5]]);
  } finally { h.close(); }
});
