import { test } from "node:test";
import assert from "node:assert/strict";
import { sceneCreationPages, createdDocument } from "./scene-create-support.ts";
import { structureIdentityFixture } from "../../collab/structure-identity.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { operation, replicas, agree, ref } from "../../adapters/collab/executor-support.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { executeSharedCommand, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";

const HA = structureIdentityFixture("1", "head", "heading"), HB = structureIdentityFixture("2", "head", "heading");

for (const kind of ["automatic", "add"] as const) {
  test(`shared ${kind}: the blank form stores nothing on submit or blur; its first nonblank input creates and binds one heading`, () => {
    const pages = sceneCreationPages(), { a } = pages;
    try {
      const input = a.open(kind, "R2");
      assert.deepEqual([input.value, input.selectionStart, input.selectionEnd, a.doc.activeElement === input], ["", 0, 0, true]);
      a.edge.enter();
      assert.deepEqual([input.isConnected, a.a.executed], [true, []]);
      a.doc.getElementById("away")?.focus();
      assert.deepEqual([input.isConnected, a.a.executed], [false, []]);
      a.open(kind, "R2"); a.edge.type(" ");
      assert.equal(a.a.executed.length, 0);
      a.edge.type("N");
      const beat = kind === "automatic" ? "R1" : "R2";
      assert.deepEqual(a.a.executed[0]?.operations, [
        { kind: "heading-create", id: "head", by: "Alice", segment: "scene_head", heading: "scene_head", firstBeat: beat, at: { left: null, right: beat, affinity: "before" } },
        { kind: "text-insert", id: "head_name", by: "Alice", target: { owner: "scene_head", segment: "scene_head", field: "heading" },
          at: { left: null, right: '["flow-base","scene_head","heading",0,0]', affinity: "before" }, content: [{ value: " N", marks: [] }] }
      ]);
      assert.deepEqual([a.input().value, a.input().selectionStart, a.input().selectionEnd, a.reports], [" N", 2, 2, []]);
      a.edge.type("x");
      assert.deepEqual(a.a.executed.map(command => command.operations.map(op => op.kind)), [["heading-create", "text-insert"], ["text-insert"]]);
      assert.deepEqual(a.a.undo.length, 2);
      pages.copies("dup", { document: createdDocument([{ id: HA, name: " Nx", firstSceneId: kind === "automatic" ? "R1" : "R2" }]), recovery: [] });
      a.edge.enter();
      assert.equal(a.doc.querySelector(".section-rename"), null);
      assert.equal(a.doc.activeElement?.className, "section-name");
    } finally { pages.close(); }
  });
}

for (const kind of ["automatic", "add"] as const) for (const order of ["D1", "rev", "dup"] as const) {
  test(`shared ${kind}: neighbouring typing stays in its beat, ${order}`, () => {
    const pages = sceneCreationPages(), { a, h } = pages;
    try {
      a.open(kind, "R2");
      const beat = kind === "automatic" ? "R1" : "R2";
      h.execute("B", [h.insertion("B", beat, h.point("B", beat, 0), "!")], ["b1"]);
      a.edge.type("N");
      const rows = createdDocument().rows.map(row => row.id === beat ? { ...row, audioText: "!" + row.audioText } : row);
      pages.copies(order, { document: createdDocument([{ id: HA, name: "N", firstSceneId: beat }], rows), recovery: [] });
      a.paint();
      assert.deepEqual([a.input().value, a.input().selectionStart, a.input().selectionEnd, a.reports], ["N", 1, 1, []]);
    } finally { pages.close(); }
  });

  test(`shared ${kind}: concurrent removal of the first beat keeps the name and removed text, ${order}`, () => {
    const pages = sceneCreationPages(), { a, h } = pages;
    try {
      a.open(kind); a.edge.type("N");
      h.execute("B", [operation({ kind: "remove", id: "gone", by: "Bob", removalKind: "beat", targets: ["R1"], observed: [h.range("B", "R1", 0, 2)],
        boundaries: ["R1"], components: [], gallery: [], at: 0 })]);
      pages.copies(order, { document: createdDocument([{ id: HA, name: "N", firstSceneId: "R2" }], createdDocument().rows.slice(1)),
        recovery: [{ kind: "removed-beat", removal: { ids: ["structure_2_0067006f006e0065_removal_0"], by: "Bob", edited: [] },
          row: createdDocument().rows[0], members: ["R1"] }] });
      a.paint();
      assert.deepEqual([a.input().value, a.input().selectionStart, a.reports], ["N", 1, []]);
    } finally { pages.close(); }
  });
}

for (const order of ["D1", "rev", "dup"] as const) test(`add-section above the last beat: its concurrent removal leaves the name in recovery and closes the form, ${order}`, async () => {
  const pages = sceneCreationPages(), { a, h } = pages;
  try {
    const input = a.open("add", "R2"); a.edge.type("N");
    h.execute("B", [operation({ kind: "remove", id: "gone", by: "Bob", removalKind: "beat", targets: ["R2"], observed: [h.range("B", "R2", 0, 4)],
      boundaries: ["R2"], components: [], gallery: [], at: 1 })]);
    pages.copies(order, { document: createdDocument([], createdDocument().rows.slice(0, 1)), recovery: [
      { kind: "removed-beat", removal: { ids: ["structure_2_0067006f006e0065_removal_0"], by: "Bob", edited: [] }, row: createdDocument().rows[1], members: ["R2"] },
      { kind: "scene-with-no-beats", heading: { id: HA, name: "N" }, beforeRowId: null }
    ] });
    a.paint(); await Promise.resolve();
    assert.deepEqual([input.isConnected, input.value, a.reports], [false, "N", []]);
  } finally { pages.close(); }
});

test("shared creation waits for compositionend, leaves a cancelled composition blank, then uses the normal empty hold and paste limit", () => {
  const pages = sceneCreationPages(), { a, h } = pages;
  try {
    a.open("automatic"); a.edge.imeSet("Q");
    assert.equal(a.a.executed.length, 0);
    a.edge.imeCancel(); assert.equal(a.a.executed.length, 0);
    a.edge.imeSet("N"); assert.equal(a.a.executed.length, 0);
    a.edge.imeCommit("N");
    assert.deepEqual([a.a.executed.length, a.input().value, a.input().selectionStart, a.reports], [1, "N", 1, []]);
    a.edge.selectAll(); a.edge.cut();
    assert.deepEqual([a.input().value, a.a.executed.length, [...collabState(h.a).ingress.holds]], ["", 1, ["buffer"]]);
    a.edge.paste("x".repeat(199) + "YZ");
    assert.deepEqual([a.input().value, a.input().selectionStart, a.reports, [...collabState(h.a).ingress.holds]], ["x".repeat(199) + "Y", 200, [], []]);
    a.edge.type("Z");
    assert.deepEqual(a.reports, [{ kind: "rejected", reason: "buffer-heading-length" }]);
    pages.copies("dup", { document: createdDocument([{ id: HA, name: "x".repeat(199) + "Y", firstSceneId: "R1" }]), recovery: [] });
  } finally { pages.close(); }
});

test("the two shared creation commands give the same complete document in one list or separate lists; creation is one refused undo step", () => {
  const pages = sceneCreationPages();
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "next" }] });
  try {
    pages.a.open("automatic"); pages.a.edge.type("N"); pages.a.edge.enter();
    pages.a.open("add", "R2"); pages.a.edge.type("M");
    const commands = pages.a.a.executed.map(command => command.operations);
    collabState(set.b).doc.clientID = 1;
    for (const handle of [set.a, set.b]) { registerSharedHeadingHandlers(handle); registerSharedTextOperationHandlers(handle); }
    assert.deepEqual(executeSharedOperations(set.a, commands.flat(), { base: readSharedRevision(set.a) }), { ok: true });
    const undo = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart, reverse: () => { throw new Error("Unsupported heading undo reached reversal"); } });
    undo.perform(() => {
      const execution = executeSharedCommand(set.b, commands[0] ?? [], { label: "add-section", selection: null, typing: null }, { base: readSharedRevision(set.b) });
      assert.deepEqual(execution.result, { ok: true }); return execution.record;
    });
    assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    assert.deepEqual(undo.undo(), { ok: false, reason: "undo-unsupported:heading-create" });
    assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    assert.deepEqual(executeSharedOperations(set.b, commands[1] ?? [], { base: readSharedRevision(set.b) }), { ok: true });
    agree("scene creation lists", "D1", [set.a, set.b], projectSharedDocumentWithRecovery,
      { document: createdDocument([{ id: HA, name: "N", firstSceneId: "R1" },
        { id: "structure_1_006e00610074006900760065005f0032_heading_0", name: "M", firstSceneId: "R2" }]), recovery: [] });
  } finally { set.close(); pages.close(); }
});

for (const kind of ["automatic", "add"] as const) for (const order of ["D1", "rev", "dup"] as const) {
  test(`rule 99 shared ${kind}: both names survive the same-place race, ${order}`, async () => {
    const pages = sceneCreationPages(), { a, b } = pages;
    try {
      const first = a.open(kind), second = b.open(kind);
      a.edge.type("A"); b.edge.type("B");
      pages.copies(order, { document: createdDocument([{ id: HB, name: "B", firstSceneId: "R1" }]),
        recovery: [{ kind: "scene-with-no-beats", heading: { id: HA, name: "A" }, beforeRowId: "R1" }] });
      a.paint(); b.paint(); await Promise.resolve();
      assert.deepEqual([first.isConnected, second.isConnected, second.value, second.selectionStart, a.reports, b.reports, a.recovered, b.recovered],
        [false, true, "B", 1, [], [], [], []]);
      b.edge.type("x");
      pages.copies(order, { document: createdDocument([{ id: HB, name: "Bx", firstSceneId: "R1" }]),
        recovery: [{ kind: "scene-with-no-beats", heading: { id: HA, name: "A" }, beforeRowId: "R1" }] });
    } finally { pages.close(); }
  });
}

for (const order of ["D1", "rev", "dup"] as const) {
  test(`rule 99: a name sent to recovery mid-key keeps that key there, refuses the stale next key and closes its form, ${order}`, async () => {
    const pages = sceneCreationPages(), { a, b, h } = pages;
    try {
      const first = a.open("automatic"), second = b.open("automatic");
      a.edge.type("A"); b.edge.type("B");
      a.edge.type("x", () => { h.queue.flush(order); });
      assert.equal(a.edge.type("z"), false);
      assert.deepEqual([first.value, first.selectionStart, a.reports.slice(), a.missing, a.recovered],
        ["Ax", 2, [
          { kind: "rejected", reason: "buffer-unavailable" }, { kind: "rejected", reason: "buffer-unavailable" },
          { kind: "rejected", reason: "buffer-unavailable" }
        ], [], []]);
      pages.copies(order, { document: createdDocument([{ id: HB, name: "B", firstSceneId: "R1" }]),
        recovery: [{ kind: "scene-with-no-beats", heading: { id: HA, name: "Ax" }, beforeRowId: "R1" }] });
      a.paint(); b.paint(); await Promise.resolve();
      assert.deepEqual([first.isConnected, second.isConnected, second.value, second.selectionStart, second.selectionEnd, b.reports], [false, true, "B", 1, 1, []]);
      assert.deepEqual([...collabState(h.a).ingress.holds], []);
    } finally { pages.close(); }
  });
}

test("shared creation refuses a drop and history before the first name, and a refused creation never falls through to a standalone submit", () => {
  const pages = sceneCreationPages(), { a } = pages;
  try {
    const input = a.open("automatic");
    assert.equal(a.edge.drop("N"), false); assert.equal(a.edge.undo("N"), false);
    assert.deepEqual([input.value, a.a.executed, a.reports], ["", [], [
      { kind: "rejected", reason: "buffer-unsupported-input" }, { kind: "rejected", reason: "buffer-unsupported-input" }
    ]]);
    a.a.deny("read-only"); a.edge.type("N");
    a.edge.enter(); a.doc.getElementById("away")?.focus();
    assert.deepEqual([input.isConnected, input.value, a.a.executed, a.reports.at(-1)], [true, "N", [], { kind: "rejected", reason: "read-only" }]);
    assert.deepEqual(a.standalone, []);
    pages.copies("dup", { document: createdDocument(), recovery: [] });
  } finally { pages.close(); }
});

for (const kind of ["automatic", "add"] as const) {
  test(`shared ${kind}: the first paste uses the native limit and stores exactly its plain text`, () => {
    const pages = sceneCreationPages(), { a } = pages;
    try {
      a.open(kind, "R2");
      a.edge.paste(" N\r\n\t\u0007" + "x".repeat(194) + "\u{1f600}Z");
      const name = " N \t\u0007" + "x".repeat(194);
      assert.deepEqual([a.input().value, a.input().selectionStart, a.input().selectionEnd, a.reports, a.standalone], [name, 199, 199, [], []]);
      assert.equal(a.a.executed.length, 1);
      pages.copies("dup", { document: createdDocument([{ id: HA, name, firstSceneId: kind === "automatic" ? "R1" : "R2" }]), recovery: [] });
    } finally { pages.close(); }
  });
}

test("seeded three-writer creation histories keep complete documents and recovery across reordered and duplicated delivery and encoded late join", () => {
  let seed = 990087;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const names = ["Ax", "X", "A "];
  for (let history = 0; history < 24; history++) {
    const kind = next() & 1 ? "automatic" : "add", mode = next() % 3, beat = kind === "automatic" ? "R1" : "R2";
    const order = (["D1", "rev", "dup"] as const)[next() % 3]; assert.ok(order);
    const pages = sceneCreationPages(), { a, b, h } = pages;
    try {
      h.join();
      a.open(kind, "R2"); b.open(kind, "R2");
      a.edge.type("A"); b.edge.type("B");
      if (mode === 0) a.edge.type("x");
      else if (mode === 1) { a.edge.selectAll(); a.edge.cut(); a.edge.paste("X"); }
      else a.edge.type(" ");
      h.execute("B", [h.insertion("B", "R1", h.point("B", "R1", 0), "!")], ["b1"]);
      const target = { owner: ref("R2"), segment: ref("b:R2"), field: "audioText" as const }, right = createSharedAnchor(h.c, target, 0, "before"); assert.ok(right);
      assert.deepEqual(executeSharedOperations(h.c, [operation({ kind: "text-insert", id: "carol", by: "Carol", target,
        at: { left: null, right, affinity: "before" }, content: [{ value: "?", marks: [] }] })]), { ok: true });
      h.queue.flush(order);
      const rows = [
        { id: "R1", status: "todo", visualText: "", audioText: "!ab", imageRef: null, updatedAt: "", updatedBy: null },
        { id: "R2", status: "todo", visualText: "", audioText: "?next", imageRef: null, updatedAt: "", updatedBy: null }
      ];
      agree("creation seed " + history, order, [h.a, h.b, h.c], projectSharedDocumentWithRecovery,
        { document: createdDocument([{ id: HB, name: "B", firstSceneId: beat }], rows),
          recovery: [{ kind: "scene-with-no-beats", heading: { id: HA, name: names[mode] }, beforeRowId: beat }] });
      assert.deepEqual([a.reports, b.reports, a.standalone, b.standalone], [[], [], [], []]);
    } finally { pages.close(); }
  }
});
