import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
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
import { edgeInput } from "./edge-input.ts";
import type { EdgeInput } from "./edge-input.ts";
import { sharedBufferPorts } from "../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { createPaintedBeats } from "../../src/application/editing/painted-beats.ts";
import { createBufferedField } from "../../src/application/editing/buffered-field.ts";
import { bindBufferedInput } from "../../src/features/common/buffered-input.ts";
import { beatPos, headingPos } from "../../src/core/flow/flow.ts";
import { createMonitoredSharedDocument } from "../adapters/collab/helpers.ts";
import { applySharedUpdate, encodeSharedState, destroySharedDocument } from "../../src/adapters/collab/document.ts";
import { sharedBufferedInputHistory } from "../../src/bootstrap/wiring/buffered-input.ts";

type Hook = (h: Stage1ExecutorHarness) => SharedUndo;

interface Opened {
  readonly h: Stage1ExecutorHarness;
  readonly session: SharedDocumentSession;
  readonly typeA: () => void;
  readonly close: () => void;
  readonly box?: {
    readonly input: () => HTMLInputElement;
    readonly edge: EdgeInput;
    readonly paint: () => void;
    readonly reports: readonly unknown[];
    readonly operations: () => readonly (readonly string[])[];
  };
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
    page.open();
    return { h: page.h, session: page.a.session, typeA: () => { page.edge.select(5); assert.equal(page.edge.type("x"), true); }, close: page.close,
      box: { input: page.input, edge: page.edge, paint: page.paint, reports: page.reports, operations: () => page.a.executed.map(list => list.operations.map(op => op.kind)) } };
  } },
  { name: "title", key: TITLE_FIELD_KEY, start: "Draft", open: undo => {
    const page = sharedTitle("Draft", { titleOrigin: "user" }, { undo });
    page.main.focus();
    return { h: page.h, session: page.a.session, typeA: () => { page.edge.select(5); assert.equal(page.edge.type("x"), true); }, close: page.close,
      box: { input: () => page.main, edge: page.edge, paint: page.paint, reports: page.reports, operations: () => page.a.executed.map(list => list.operations.map(op => op.kind)) } };
  } }
];

function field(handle: SharedDocumentHandle, key: string): string | undefined {
  return readSharedPaintedText(handle, sharedBufferedTarget(handle, key))?.text;
}

function typeB(h: Stage1ExecutorHarness, key: string, start: string, inserted = "Y", remove = 0): string {
  const b = sharedHarness(adapterReplica(h.b));
  try {
    let serial = 0;
    const port = createSharedBufferedText(h.b, b.session, { target: id => sharedBufferedTarget(h.b, id), author: () => ({ id: "bob" + ++serial, by: "Bob" }),
      readers: bufferReaders, stamps: bufferStamps("Bob") });
    const painted = readSharedPaintedText(h.b, sharedBufferedTarget(h.b, key));
    assert.ok(painted);
    const edit = port.open(key, painted);
    assert.ok(edit);
    edit.replace(0, remove, inserted);
    return edit.commit([{ text: inserted + start.slice(remove), marks: {} }]).kind;
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

for (const surface of SURFACES.filter(entry => entry.name === "rename form" || entry.name === "title")) {
  test(`rule 85 ${surface.name}: box, Writer and global replay consume one stack in execution order`, () => {
    let owner: SharedUndo | undefined, serial = 0;
    const opened = surface.open(h => {
      registerSharedUndoOperationHandlers(h.a);
      owner = sharedUndoOwner(h.a, () => ({ id: "undo" + ++serial, by: "Alice" }), () => 0, error => { throw error; });
      return owner;
    });
    assert.ok(owner && opened.box);
    const actions = sharedUndoActions(opened.session, owner), box = opened.box;
    const writer = bufferedWriter("ab", true, undefined, undefined, { h: opened.h, undo: () => owner!, history: actions });
    try {
      opened.typeA();
      writer.surface.paint();
      assert.equal(writer.native(2, 2, "q"), true);
      box.input().focus(); box.edge.select(6); box.edge.undo(null);
      assert.deepEqual([field(opened.h.a, "R1"), field(opened.h.a, surface.key), owner.sizes().undo], ["ab", surface.start + "x", 1]);
      writer.surface.paint();
      writer.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
      box.paint();
      assert.deepEqual([field(opened.h.a, "R1"), box.input().value, owner.sizes().undo], ["ab", surface.start, 0]);
      assert.equal(actions.redo().ok, true);
      writer.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
      opened.h.queue.flush("dup"); opened.h.join(); box.paint();
      for (const handle of [opened.h.a, opened.h.b, opened.h.c]) {
        assert.equal(field(handle, "R1"), "abq");
        assert.equal(field(handle, surface.key), surface.start + "x");
      }
      assert.deepEqual([owner.sizes(), box.reports, writer.reports, box.operations()],
        [{ undo: 2, redo: 0, dropped: 0 }, [], [], [["text-insert"]]]);
    } finally { writer.close(); opened.close(); }
  });
  for (const order of ["D1", "rev", "dup"] as const) {
    test(`rule 85 ${surface.name}: recorded input undo and redo use the owner once and preserve Bob's text on all copies: ${order}`, () => {
      let owner: SharedUndo | undefined, serial = 0;
      const opened = surface.open(h => {
        registerSharedUndoOperationHandlers(h.a);
        owner = sharedUndoOwner(h.a, () => ({ id: "undo" + ++serial, by: "Alice" }), () => 0, error => { throw error; });
        return owner;
      });
      try {
        const { h, box } = opened;
        assert.ok(box && owner);
        opened.typeA();
        assert.equal(typeB(h, surface.key, surface.start), "applied");
        h.queue.flush(order); box.paint();
        assert.equal(box.input().value, "Y" + surface.start + "x");
        box.edge.select(0);
        assert.equal(box.edge.undo("native history must never reach the DOM"), false);
        h.queue.flush(order); box.paint(); h.join();
        for (const handle of [h.a, h.b, h.c]) assert.equal(field(handle, surface.key), "Y" + surface.start);
        assert.deepEqual([box.input().value, box.input().selectionStart, box.input().selectionEnd, box.reports, owner.sizes()],
          ["Y" + surface.start, 6, 6, [], { undo: 0, redo: 1, dropped: 0 }]);
        assert.equal(box.edge.redo("native redo must never reach the DOM"), false);
        h.queue.flush(order); box.paint();
        for (const handle of [h.a, h.b, h.c]) assert.equal(field(handle, surface.key), "Y" + surface.start + "x");
        assert.deepEqual([box.input().value, box.input().selectionStart, box.input().selectionEnd, box.reports, owner.sizes(), box.operations()],
          ["Y" + surface.start + "x", 6, 6, [], { undo: 1, redo: 0, dropped: 0 }, [["text-insert"]]]);
      } finally { opened.close(); }
    });
  }
  test(`rule 85 ${surface.name}: typing, paste, cut, undo and redo share one ordered stack`, () => {
    let owner: SharedUndo | undefined, serial = 0;
    const opened = surface.open(h => {
      registerSharedUndoOperationHandlers(h.a);
      owner = sharedUndoOwner(h.a, () => ({ id: "undo" + ++serial, by: "Alice" }), () => 0, error => { throw error; });
      return owner;
    });
    try {
      const { h, box } = opened;
      assert.ok(box && owner);
      opened.typeA(); box.edge.select(6); box.edge.paste("P"); box.edge.select(6, 7); box.edge.cut();
      assert.equal(box.edge.copied(), "P");
      assert.deepEqual(owner.sizes(), { undo: 3, redo: 0, dropped: 0 });
      for (const [expected, size] of [[surface.start + "xP", 2], [surface.start + "x", 1], [surface.start, 0]] as const) {
        box.edge.undo(null); h.queue.flush("dup"); box.paint();
        assert.equal(box.input().value, expected);
        assert.equal(owner.sizes().undo, size);
        for (const handle of [h.a, h.b]) assert.equal(field(handle, surface.key), expected);
      }
      box.edge.redo(null); box.edge.redo(null); box.edge.redo(null);
      h.queue.flush("dup"); h.join(); box.paint();
      for (const handle of [h.a, h.b, h.c]) assert.equal(field(handle, surface.key), surface.start + "x");
      assert.deepEqual([box.reports, box.operations()], [[], [["text-insert"], ["text-insert"], ["text-delete"]]]);
    } finally { opened.close(); }
  });
}

for (const remote of [false, true] as const) {
  for (const order of ["D1", "rev", "dup"] as const) {
    test(`rule 85 Escape is one shared edit only while the form owns its name, remote ${remote}: ${order}`, () => {
      const page = sharedRename();
      try {
        const input = page.open(); page.edge.select(5); page.edge.type("x");
        if (remote) {
          assert.equal(typeB(page.h, headingFieldKey("H1"), "Scene"), "applied");
          page.h.queue.flush(order); page.paint(); page.edge.select(input.value.length); page.edge.type("z");
        }
        page.edge.escape();
        page.h.queue.flush(order); page.h.join();
        const expected = remote ? "YScenexz" : "Scene";
        for (const handle of [page.h.a, page.h.b, page.h.c]) assert.equal(field(handle, headingFieldKey("H1")), expected);
        assert.deepEqual([input.isConnected, input.value, input.selectionStart, input.selectionEnd, page.reports,
          page.a.executed.map(list => list.operations.map(op => op.kind)), page.owner.sizes()],
        remote ? [false, "YScenexz", 8, 8, [{ kind: "rejected", reason: "buffer-heading-changed" }], [["text-insert"], ["text-insert"]], { undo: 1, redo: 0, dropped: 0 }]
          : [false, "Scene", 5, 5, [], [["text-insert"], ["text-insert", "text-delete"]], { undo: 2, redo: 0, dropped: 0 }]);
        if (!remote) {
          assert.equal(sharedUndoActions(page.a.session, page.owner).undo().ok, true);
          page.h.queue.flush(order);
          for (const handle of [page.h.a, page.h.b, page.h.c]) assert.equal(field(handle, headingFieldKey("H1")), "Scenex");
        }
      } finally { page.close(); }
    });
  }
}

test("rule 85 the Writer title input uses the same owner, restores its recorded caret and refreshes both title inputs", () => {
  const page = sharedTitle();
  try {
    page.writer.focus(); page.writerEdge.select(5); page.writerEdge.type("x"); page.writerEdge.select(0);
    page.writerEdge.undo(null);
    assert.deepEqual([page.main.value, page.writer.value, page.writer.selectionStart, page.writer.selectionEnd, page.pageTitles(), page.reports],
      ["Draft", "Draft", 5, 5, 2, []]);
    page.writerEdge.redo(null); page.h.queue.flush("dup"); page.h.join();
    for (const handle of [page.h.a, page.h.b, page.h.c]) assert.equal(field(handle, TITLE_FIELD_KEY), "Draftx");
    assert.deepEqual([page.main.value, page.writer.value, page.writer.selectionStart, page.writer.selectionEnd, page.pageTitles(), page.reports,
      page.a.executed.map(list => list.operations.map(op => op.kind))], ["Draftx", "Draftx", 5, 5, 3, [], [["text-insert"]]]);
  } finally { page.close(); }
});

for (const change of ["name before repaint", "name during input", "another field", "no edit", "held empty"] as const) {
  test(`rule 85 Escape checks the stored identity without depending on repaint: ${change}`, () => {
    const page = sharedRename();
    try {
      const input = page.open();
      if (change === "held empty") { page.edge.selectAll(); page.edge.backspace(); }
      else if (change !== "no edit") {
        page.edge.select(5);
        page.edge.type("x", change === "name during input" ? () => {
          assert.equal(typeB(page.h, headingFieldKey("H1"), "Scene"), "applied");
          page.h.queue.deliverFrom("B", "D1");
        } : undefined);
      }
      if (change === "name before repaint") { typeB(page.h, headingFieldKey("H1"), "Scene"); page.h.queue.flush("dup"); }
      if (change === "another field") { typeB(page.h, "R1", "ab"); page.h.queue.flush("dup"); }
      page.edge.escape(); page.h.queue.flush("dup"); page.h.join();
      const changed = change === "name before repaint" || change === "name during input";
      for (const handle of [page.h.a, page.h.b, page.h.c]) assert.equal(field(handle, headingFieldKey("H1")), changed ? "YScenex" : "Scene");
      assert.deepEqual([input.isConnected, page.reports, page.owner.sizes().undo], [false,
        changed ? [{ kind: "rejected", reason: "buffer-heading-changed" }] : change === "held empty" ? [{ kind: "rejected", reason: "buffer-heading-empty" }] : [],
        changed ? 1 : change === "another field" ? 2 : 0]);
      if (change === "another field") for (const handle of [page.h.a, page.h.b, page.h.c]) assert.equal(field(handle, "R1"), "Yab");
    } finally { page.close(); }
  });
}

test("rule 85 Escape restores the stored opening name even when concurrent writers had taken it over the typing stop", () => {
  const page = sharedRename("a".repeat(200));
  try {
    typeB(page.h, headingFieldKey("H1"), "a".repeat(200)); page.h.queue.flush("dup"); page.paint();
    const input = page.open(); page.edge.select(201); page.edge.backspace();
    assert.equal(page.stored(), "Y" + "a".repeat(199));
    page.edge.escape(); page.h.queue.flush("dup"); page.h.join();
    for (const handle of [page.h.a, page.h.b, page.h.c]) assert.equal(field(handle, headingFieldKey("H1")), "Y" + "a".repeat(200));
    assert.deepEqual([input.isConnected, input.value, input.selectionStart, input.selectionEnd, page.reports, page.owner.sizes().undo],
      [false, "Y" + "a".repeat(200), 201, 201, [], 2]);
  } finally { page.close(); }
});

test("rule 85 Escape refuses a remote replacement with the same visible letters", () => {
  const page = sharedRename();
  try {
    const input = page.open(); page.edge.select(5); page.edge.type("x"); page.h.queue.flush("dup");
    assert.equal(typeB(page.h, headingFieldKey("H1"), "Scenex", "", 6), "applied");
    assert.equal(typeB(page.h, headingFieldKey("H1"), "", "Scenex"), "applied");
    page.h.queue.flush("dup"); page.edge.escape(); page.h.queue.flush("dup"); page.h.join();
    for (const handle of [page.h.a, page.h.b, page.h.c]) assert.equal(field(handle, headingFieldKey("H1")), "Scenex");
    assert.deepEqual([input.isConnected, input.value, page.reports, page.a.executed.length, page.owner.sizes().undo],
      [false, "Scenex", [{ kind: "rejected", reason: "buffer-heading-changed" }], 1, 1]);
  } finally { page.close(); }
});

for (const direction of ["undo", "redo"] as const) {
  test(`rule 85 a held empty name consumes ${direction} without using the owner's available entry`, () => {
    const page = sharedRename();
    try {
      const input = page.open(); page.edge.select(5); page.edge.type("x");
      if (direction === "redo") page.edge.undo(null);
      page.edge.selectAll(); page.edge.backspace(); page.edge[direction](null);
      assert.deepEqual([input.value, input.selectionStart, input.selectionEnd, page.reports, page.owner.sizes()],
        [direction === "undo" ? "Scenex" : "Scene", 0, 0, [{ kind: "rejected", reason: "buffer-heading-empty" }],
          direction === "undo" ? { undo: 1, redo: 0, dropped: 0 } : { undo: 0, redo: 1, dropped: 0 }]);
      page.edge[direction](null); page.h.queue.flush("dup"); page.h.join();
      for (const handle of [page.h.a, page.h.b, page.h.c]) assert.equal(field(handle, headingFieldKey("H1")), direction === "undo" ? "Scene" : "Scenex");
      assert.equal(page.reports.length, 1);
    } finally { page.close(); }
  });
}

test("rule 85 Escape releases an empty hold before checking a queued foreign name", () => {
  const page = sharedRename();
  try {
    const input = page.open(); page.edge.selectAll(); page.edge.backspace();
    typeB(page.h, headingFieldKey("H1"), "Scene"); page.h.queue.deliverFrom("B", "D1");
    page.edge.escape(); page.h.queue.flush("dup"); page.h.join();
    for (const handle of [page.h.a, page.h.b, page.h.c]) assert.equal(field(handle, headingFieldKey("H1")), "YScene");
    assert.deepEqual([input.isConnected, input.value, page.a.executed, page.reports, page.owner.sizes().undo],
      [false, "YScene", [], [{ kind: "rejected", reason: "buffer-heading-empty" }, { kind: "rejected", reason: "buffer-heading-changed" }], 0]);
  } finally { page.close(); }
});

function undoPeer(handle: SharedDocumentHandle, key: string, by: string) {
  let serial = 0, reversal = 0;
  const reports: unknown[] = [];
  registerSharedUndoOperationHandlers(handle);
  const owner = sharedUndoOwner(handle, () => ({ id: by + "_undo" + ++reversal, by }), () => 0, error => { throw error; });
  const session = sharedHarness(adapterReplica(handle, owner));
  const shared = sharedBufferPorts(handle, session.session, { readers: bufferReaders, stamps: bufferStamps(by),
    author: () => ({ id: by + "_" + ++serial, by }), report: outcome => reports.push(outcome),
    recovered: value => reports.push(value), missingBase: value => reports.push(value) });
  const input = document.body.appendChild(document.createElement("input"));
  let painted = () => {}, check = () => {};
  const paint = () => { check(); painted(); };
  const bound = bindBufferedInput({ inputs: [input], key, stored: () => field(handle, key) ?? null, pasteLimit: key === TITLE_FIELD_KEY ? 300 : 200,
    position: offset => key === TITLE_FIELD_KEY ? beatPos(key, offset) : headingPos("H1", offset),
    owns: pos => key === TITLE_FIELD_KEY ? pos.kind === "beat" && pos.rowId === key : pos.kind === "heading" && pos.sceneId === "H1"
  }, { field: surface => createBufferedField(shared.bufferedText, surface), painted: createPaintedBeats(shared.paintedText),
    report: outcome => reports.push(outcome), shown: edit => edit(), repaint: paint, history: sharedBufferedInputHistory(handle, session.session, owner),
    onPainted: listener => { painted = listener; return () => {}; }, beforePaint: listener => { check = listener; return () => {}; } });
  return { input, edge: edgeInput(() => input), paint, reports, owner,
    close: () => { bound.dispose(); session.session.dispose(); input.remove(); } };
}

for (const key of [TITLE_FIELD_KEY, headingFieldKey("H1")]) {
  test(`rule 85 seeded three-writer input histories keep ordinary edits and per-writer undo in one order: ${key}`, () => {
    let seed = 0x85ca12;
    const limits: readonly string[] = [], violations: string[] = [];
    for (let round = 0; round < 24; round++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const h = new Stage1ExecutorHarness([{ id: "R1", text: "beat" }], { title: "abcdef", sections: [{ id: "H1", name: "abcdef", firstSceneId: "R1" }] });
      h.join();
      const peers = [undoPeer(h.a, key, "Alice"), undoPeer(h.b, key, "Bob"), undoPeer(h.c, key, "Carol")];
      const late = createMonitoredSharedDocument();
      try {
        const [a, b, c] = peers;
        assert.ok(a && b && c);
        const order = (["D1", "rev", "dup"] as const)[seed % 3]!;
        const actions = [() => { a.input.focus(); a.edge.select(6); a.edge.type("x"); },
          () => { b.input.focus(); b.edge.select(0); b.edge.paste("Y"); },
          () => { c.input.focus(); c.edge.select(2, 4); c.edge.cut(); }];
        for (const at of seed & 1 ? [2, 0, 1] : [1, 2, 0]) actions[at]!();
        assert.deepEqual(peers.map(peer => [peer.input.value, peer.input.selectionStart, peer.input.selectionEnd]), [["abcdefx", 7, 7], ["Yabcdef", 1, 1], ["abef", 2, 2]]);
        h.queue.flush(order); for (const peer of peers) { peer.input.focus(); peer.paint(); }
        assert.deepEqual(peers.map(peer => [peer.input.value, peer.input.selectionStart, peer.input.selectionEnd]), [["Yabefx", 6, 6], ["Yabefx", 1, 1], ["Yabefx", 3, 3]]);
        for (const [at, expected, carets] of [[0, "Yabef", [5, 1, 3]], [1, "abef", [4, 0, 2]], [2, "abcdef", [6, 0, 2]]] as const) {
          const peer = peers[at]!; peer.input.focus(); peer.edge.undo(null); h.queue.flush(order); for (const peer of peers) { peer.input.focus(); peer.paint(); }
          assert.deepEqual(peers.map(peer => [peer.input.value, peer.input.selectionStart, peer.input.selectionEnd]), carets.map(caret => [expected, caret, caret]));
          for (const handle of [h.a, h.b, h.c]) assert.equal(field(handle, key), expected);
        }
        for (const peer of seed & 2 ? [c, a, b] : [b, c, a]) { peer.input.focus(); peer.edge.redo(null); }
        h.queue.flush(order); for (const peer of peers) peer.paint();
        assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
        for (const handle of [h.a, h.b, h.c, late]) assert.equal(field(handle, key), "Yabefx");
        assert.deepEqual(peers.map(peer => [peer.input.value, peer.reports, peer.owner.sizes()]),
          [["Yabefx", [], { undo: 1, redo: 0, dropped: 0 }], ["Yabefx", [], { undo: 1, redo: 0, dropped: 0 }], ["Yabefx", [], { undo: 1, redo: 0, dropped: 0 }]]);
      } catch (error) { violations.push("round " + round); throw error; }
      finally { for (const peer of peers) peer.close(); destroySharedDocument(late); h.destroy(); }
    }
    assert.deepEqual(violations, limits);
  });
}
