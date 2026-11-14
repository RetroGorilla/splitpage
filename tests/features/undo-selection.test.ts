import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
import { bufferedWriter } from "./writer/buffer-support.ts";
import { bufferedSplit } from "./editing/cell-buffer-support.ts";
import { resolveSharedBufferedSelection } from "../../src/adapters/collab/buffer-selection.ts";
import { readSharedPaintedText } from "../../src/adapters/collab/paint-base.ts";
import { resolveSharedAnchor } from "../../src/adapters/collab/anchors.ts";
import { registerSharedUndoOperationHandlers } from "../../src/adapters/collab/undo-handlers.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import type { SharedUndo, SharedUndoOutcome } from "../../src/application/editing/undo/shared-undo.ts";
import { sharedUndoActions } from "../../src/application/editing/undo/shared-undo-actions.ts";
import type { SharedDocumentSession } from "../../src/application/session/shared-session.ts";
import { sharedUndoOwner } from "../../src/bootstrap/wiring/ports/shared-undo.ts";

type Peer = "none" | "inside" | "before" | "after";
type Kind = "delete" | "replace" | "composition";
type Caret = readonly [number, number];

interface Literal {
  readonly edited: string;
  readonly undone: string;
  readonly restored: number;
  readonly caret: number;
}

const PEER_AT: Record<Peer, number | null> = { none: null, inside: 2, before: 0, after: 4 };
const INSERT: Record<Kind, string> = { delete: "", replace: "Z", composition: "β" };

const UNDONE: Record<Peer, { readonly undone: string; readonly restored: number }> = {
  none: { undone: "abcd", restored: 3 },
  inside: { undone: "abXcd", restored: 4 },
  before: { undone: "Xabcd", restored: 4 },
  after: { undone: "abcdX", restored: 3 }
};

function literal(kind: Kind, peer: Peer): Literal {
  const typed = INSERT[kind];
  const edited = { none: "a" + typed + "d", inside: "a" + typed + "Xd", before: "Xa" + typed + "d", after: "a" + typed + "dX" }[peer];
  return { edited, ...UNDONE[peer], caret: (peer === "before" ? 2 : 1) + typed.length };
}

interface Opened {
  readonly h: Stage1ExecutorHarness;
  readonly session: SharedDocumentSession;
  readonly owner: () => SharedUndo;
  readonly close: () => void;
}

function withUndo(open: (undo: (h: Stage1ExecutorHarness) => SharedUndo) => Omit<Opened, "owner">): Opened {
  let made: SharedUndo | null = null, serial = 0;
  const opened = open(h => {
    registerSharedUndoOperationHandlers(h.a); registerSharedUndoOperationHandlers(h.b);
    made = sharedUndoOwner(h.a, () => ({ id: "undo" + ++serial, by: "Alice" }), () => 0, error => { throw error; });
    return made;
  });
  return { ...opened, owner: () => { assert.ok(made); return made; } };
}

function checks(page: Opened) {
  const h = page.h, actions = sharedUndoActions(page.session, page.owner());
  const text = (handle: SharedDocumentHandle): string => h.characters(handle, "R1").map(char => char.value).join("");
  const painted = readSharedPaintedText(h.b, h.target("R1")); assert.ok(painted);
  const own = painted.identity(3); assert.ok(own);
  const peerCaret = (): number => { const at = resolveSharedAnchor(h.b, own); return at === "gone" ? -1 : at.offset; };
  const peer = (at: number | null): void => {
    if (at === null) return;
    h.execute("B", [h.insertion("B", "R1", h.point("B", "R1", at), "X")], ["b1"]);
    h.queue.flush("D1");
  };
  const step = (outcome: SharedUndoOutcome): Caret | null => {
    h.queue.flush("D1");
    assert.ok(outcome.ok && outcome.effective, JSON.stringify(outcome));
    if (!outcome.ok || !outcome.effective || !outcome.selection) return null;
    const range = resolveSharedBufferedSelection(h.a, [outcome.selection.anchor, outcome.selection.focus]); assert.ok(range);
    assert.deepEqual([range.anchor, range.head].map(pos => pos.kind === "beat" ? pos.rowId : pos.kind), ["R1", "R1"]);
    return [range.anchor.offset, range.head.offset];
  };
  const all = (): string[] => [text(h.a), text(h.b), text(h.c)];
  const cycle = (expected: Literal, caret: Caret): void => {
    const restored: Caret = [expected.restored, expected.restored];
    h.queue.flush("D1"); h.join();
    assert.deepEqual(all(), [expected.edited, expected.edited, expected.edited]);
    assert.equal(peerCaret(), expected.edited.indexOf("d"));
    assert.deepEqual([step(actions.undo()), all()], [restored, [expected.undone, expected.undone, expected.undone]]);
    assert.equal(peerCaret(), expected.undone.indexOf("d"));
    assert.deepEqual([step(actions.redo()), all()], [caret, [expected.edited, expected.edited, expected.edited]]);
    assert.deepEqual([step(actions.undo()), all()], [restored, [expected.undone, expected.undone, expected.undone]]);
    assert.deepEqual([peerCaret(), page.owner().sizes()], [expected.undone.indexOf("d"), { undo: 0, redo: 1, dropped: 0 }]);
  };
  return { peer, cycle };
}

for (const kind of ["delete", "replace", "composition"] as const) for (const peer of Object.keys(PEER_AT) as Peer[]) for (const order of ["D1", "D3"] as const) {
  for (const backward of [false, true]) {
    if (backward && peer !== "inside") continue;
    test(`Writer undo leaves the caret after what came back, as standalone does, ${kind}${backward ? " backward" : ""}, peer ${peer}: ${order}`, () => {
      let writer: ReturnType<typeof bufferedWriter> | null = null;
      const page = withUndo(undo => { writer = bufferedWriter("abcd", true, undefined, undefined, { undo }); return { h: writer.h, session: writer.a.session, close: writer.close }; });
      const w = writer as ReturnType<typeof bufferedWriter> | null; assert.ok(w);
      try {
        const c = checks(page), at = PEER_AT[peer], typed = INSERT[kind], [from, to] = backward ? [3, 1] : [1, 3];
        const during = order === "D3" ? () => { c.peer(at); } : undefined;
        if (kind === "composition") {
          w.start(from, to);
          assert.equal(w.native(from, to, typed, undefined, "insertCompositionText"), true);
          during?.();
          w.end(typed);
        } else assert.equal(w.native(from, to, typed, during, kind === "delete" ? "deleteContentBackward" : "insertText"), true);
        if (order === "D1") c.peer(at);
        const expected = literal(kind, peer);
        c.cycle(expected, [expected.caret, expected.caret]);
        assert.deepEqual(w.reports, []);
      } finally { page.close(); }
    });
  }
}

for (const order of ["D1", "D3"] as const) test(`Writer typing at a caret: undo leaves the caret before the typing, redo after it: ${order}`, () => {
  let writer: ReturnType<typeof bufferedWriter> | null = null;
  const page = withUndo(undo => { writer = bufferedWriter("abcd", true, undefined, undefined, { undo }); return { h: writer.h, session: writer.a.session, close: writer.close }; });
  const w = writer as ReturnType<typeof bufferedWriter> | null; assert.ok(w);
  try {
    const c = checks(page);
    assert.equal(w.native(1, 1, "Z", order === "D3" ? () => { c.peer(0); } : undefined), true);
    if (order === "D1") c.peer(0);
    c.cycle({ edited: "XaZbcd", undone: "Xabcd", restored: 2, caret: 3 }, [3, 3]);
  } finally { page.close(); }
});

for (const kind of ["delete", "replace"] as const) for (const peer of ["none", "inside"] as const) for (const order of ["D1", "D3"] as const) {
  test(`Split cell undo leaves the caret after what came back, as standalone does, ${kind}, peer ${peer}: ${order}`, () => {
    let split: ReturnType<typeof bufferedSplit> | null = null;
    const page = withUndo(undo => { split = bufferedSplit([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], true, { undo }); return { h: split.h, session: split.a.session, close: split.close }; });
    const s = split as ReturnType<typeof bufferedSplit> | null; assert.ok(s);
    try {
      const c = checks(page), typed = INSERT[kind], at = PEER_AT[peer];
      assert.equal(s.key("R1", 1, 3, kind === "delete" ? "deleteContentBackward" : "insertText", typed || null, order === "D3" ? { during: () => { c.peer(at); } } : {}), true);
      if (order === "D1") c.peer(at);
      const expected = literal(kind, peer);
      c.cycle(expected, [expected.caret, expected.caret]);
      assert.deepEqual(s.reports, []);
    } finally { page.close(); }
  });
}
