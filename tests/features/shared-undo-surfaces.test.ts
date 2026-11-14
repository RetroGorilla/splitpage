import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../application/session/shared-session-support.ts";
import { bufferedWriter } from "./writer/buffer-support.ts";
import { headedWriter } from "./writer/buffer-heading-support.ts";
import { bufferedSplit } from "./editing/cell-buffer-support.ts";
import { sharedRename } from "./rows/scene-name-support.ts";
import { sharedTitle } from "./title/title-buffer-support.ts";
import { createSharedBufferedText, sharedBufferedTarget } from "../../src/adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../src/adapters/collab/paint-base.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { registerSharedUndoOperationHandlers } from "../../src/adapters/collab/undo-handlers.ts";
import type { SharedUndo } from "../../src/application/editing/undo/shared-undo.ts";
import { sharedUndoActions } from "../../src/application/editing/undo/shared-undo-actions.ts";
import type { SharedDocumentSession } from "../../src/application/session/shared-session.ts";
import { headingFieldKey, TITLE_FIELD_KEY } from "../../src/application/editing/buffered-field-key.ts";
import { bufferedFieldKey } from "../../src/core/collab/buffer.ts";
import { sharedUndoOwner } from "../../src/bootstrap/wiring/ports/shared-undo.ts";
import { bufferReaders, bufferStamps } from "../collab/buffer-readers.ts";

type Hook = (h: Stage1ExecutorHarness) => Pick<SharedUndo, "perform">;

interface Opened {
  readonly h: Stage1ExecutorHarness;
  readonly session: SharedDocumentSession;
  readonly typeA: () => void;
  readonly close: () => void;
}

interface Surface {
  readonly name: string;
  readonly key: string;
  readonly start: string;
  readonly open: (undo: Hook) => Opened;
}

const SURFACES: readonly Surface[] = [
  { name: "Writer text", key: "R1", start: "ab", open: undo => {
    const page = bufferedWriter("ab", true, undefined, undefined, { undo });
    return { h: page.h, session: page.a.session, typeA: () => { assert.equal(page.native(2, 2, "x"), true); }, close: page.close };
  } },
  { name: "Writer heading", key: headingFieldKey("H1"), start: "Scene", open: undo => {
    const page = headedWriter("Scene", undefined, { undo });
    return { h: page.h, session: page.a.session, typeA: () => { assert.equal(page.typeHeading(5, 5, "x"), true); }, close: page.close };
  } },
  { name: "Split narration cell", key: "R1", start: "ab", open: undo => {
    const page = bufferedSplit([{ id: "R1", text: "ab" }], true, { undo });
    return { h: page.h, session: page.a.session, typeA: () => { assert.equal(page.key("R1", 2, 2, "insertText", "x"), true); }, close: page.close };
  } },
  { name: "Split visual column", key: bufferedFieldKey("R1", "visualText"), start: "", open: undo => {
    const page = bufferedSplit([{ id: "R1", text: "ab" }], true, { undo });
    return { h: page.h, session: page.a.session, typeA: () => { assert.equal(page.key("R1", 0, 0, "insertText", "x", { field: "visualText" }), true); }, close: page.close };
  } },
  { name: "rename form", key: headingFieldKey("H1"), start: "Scene", open: undo => {
    const page = sharedRename("Scene", { undo });
    return { h: page.h, session: page.a.session, typeA: () => { page.open(); page.edge.select(5); assert.equal(page.edge.type("x"), true); }, close: page.close };
  } },
  { name: "title", key: TITLE_FIELD_KEY, start: "Draft", open: undo => {
    const page = sharedTitle("Draft", { titleOrigin: "user" }, { undo });
    return { h: page.h, session: page.a.session, typeA: () => { page.main.focus(); page.edge.select(5); assert.equal(page.edge.type("x"), true); }, close: page.close };
  } }
];

function field(handle: SharedDocumentHandle, key: string): string | undefined {
  return readSharedPaintedText(handle, sharedBufferedTarget(handle, key))?.text;
}

function typeB(h: Stage1ExecutorHarness, key: string, start: string): string {
  const b = sharedHarness(adapterReplica(h.b));
  try {
    let serial = 0;
    const port = createSharedBufferedText(h.b, b.session, { target: id => sharedBufferedTarget(h.b, id), author: () => ({ id: "bob" + ++serial, by: "Bob" }),
      readers: bufferReaders, stamps: bufferStamps("Bob") });
    const painted = readSharedPaintedText(h.b, sharedBufferedTarget(h.b, key));
    assert.ok(painted);
    const edit = port.open(key, painted);
    assert.ok(edit);
    edit.replace(0, 0, "Y");
    return edit.commit([{ text: "Y" + start, marks: {} }]).kind;
  } finally { b.session.dispose(); }
}

for (const surface of SURFACES) {
  for (const order of ["D1", "rev"] as const) {
    test(`D32 on real replicas, ${surface.name}: A and B type in the same field at once; A's undo takes back only A's typing and redo puts it back on every copy, a late joiner included: ${order}`, () => {
      const held: { owner: SharedUndo | null } = { owner: null };
      let reversals = 0;
      const opened = surface.open(h => {
        registerSharedUndoOperationHandlers(h.a);
        const owner = sharedUndoOwner(h.a, () => ({ id: "undo" + ++reversals, by: "Alice" }), () => 0, error => { throw error; });
        held.owner = owner;
        return owner;
      });
      try {
        const owner = held.owner;
        assert.ok(owner);
        const { h } = opened, copies = (): (string | undefined)[] => [field(h.a, surface.key), field(h.b, surface.key)];
        opened.typeA();
        assert.equal(typeB(h, surface.key, surface.start), "applied");
        h.queue.flush(order);
        const both = field(h.a, surface.key);
        assert.deepEqual([copies(), [...(both ?? "")].sort().join("")], [[both, both], [...("Y" + surface.start + "x")].sort().join("")]);
        assert.equal(owner.sizes().undo, 1);
        assert.equal(sharedUndoActions(opened.session, owner).undo().ok, true);
        h.queue.flush(order);
        assert.deepEqual(copies(), ["Y" + surface.start, "Y" + surface.start]);
        assert.equal(sharedUndoActions(opened.session, owner).redo().ok, true);
        h.queue.flush(order);
        h.join();
        h.queue.flush(order);
        assert.deepEqual([...copies(), field(h.c, surface.key)], [both, both, both]);
      } finally { opened.close(); }
    });
  }
}
