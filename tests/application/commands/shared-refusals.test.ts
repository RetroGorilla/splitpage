import test from "node:test";
import assert from "node:assert/strict";
import type { Command, DocumentView, Replay, Stamp } from "../../../src/application/session/document-session.ts";
import { cellRuns, cellTextCommand } from "../../../src/application/commands/cell-text.ts";
import { moveBeatCommand, swapBeatsCommand } from "../../../src/application/commands/rows.ts";
import { addSceneCommand, moveSceneCommand, renameSceneCommand } from "../../../src/application/commands/scenes.ts";
import { pasteBeatsCommand } from "../../../src/application/commands/beats.ts";
import { galleryCommand } from "../../../src/application/commands/gallery.ts";
import type { GalleryEdit } from "../../../src/application/commands/gallery.ts";
import { addGalleryPicture, addGalleryVideo, moveGallerySlot, removeGallerySlot } from "../../../src/core/document/gallery.ts";
import { sharedGalleryPorts } from "../../../src/bootstrap/wiring/ports/shared-gallery.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { importRowsCommand } from "../../../src/application/commands/import-rows.ts";
import { restoreConflictCommand } from "../../../src/application/commands/comments.ts";
import { fileTitleCommand, titleCommand } from "../../../src/application/commands/title.ts";
import { documentIdStamp, editStamp } from "../../../src/application/commands/save-stamps.ts";
import { flowCommand, initializeFlowParagraphs, standaloneFlowCommand } from "../../../src/application/commands/flow.ts";
import { rewriteCellsCommand } from "../../../src/application/commands/document-edit.ts";
import { deleteTagsCommand, gearQuickAddCommand, retagCommand, tagCellsCommand } from "../../../src/application/commands/production-records.ts";
import { sharedRecordPorts } from "../../../src/bootstrap/wiring/ports/shared-records.ts";
import { SHARED_SESSION_DISABLED } from "../../../src/application/session/ports.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import { sharedCommandRefusalNotice } from "../../../src/bootstrap/wiring/ports/shared-command-notices.ts";
import { encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { beatPos, caretAt, typeWithMarks } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { builderOperationCoverage } from "../../core/collab/coverage-fixture.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { replicas, operation } from "../../adapters/collab/executor-support.ts";
import { adapterReplica, sharedHarness } from "../session/shared-session-support.ts";
import { fakeNotices } from "../../features/fakes.ts";

const runtime = createFlowLoadRuntime();
const stamps = { clock: { nowIso: () => "2026-11-13T12:00:00.000Z" }, editor: { name: () => "Editor" } };
const text = { ...stamps, cells: runtime.cells };
const rewrites = () => [{ rowId: "R1", field: "visualText", html: "Changed" }];
const paragraph = () => {};
const flowEdit = (doc: FlowDoc) => typeWithMarks(doc, beatPos("R1", 1), "Z", {}, runtime.ports);
const asCommand = (task: Replay | Stamp): Command => ({ name: task.name, needs: "nothing", plan: doc => task.plan(runtime.load(doc)) });
const factories: Record<string, (doc: DocumentView) => Command> = {
  cellTextCommand: () => cellTextCommand("R1", "audioText", cellRuns([{ text: "Changed", marks: {} }]), text),
  moveBeatCommand: () => moveBeatCommand("R1", "R2", true),
  swapBeatsCommand: () => swapBeatsCommand("R1", 1),
  moveSceneCommand: () => moveSceneCommand("H1", "H2", true),
  addSceneCommand: () => addSceneCommand("R2", "H3", "New scene"),
  renameSceneCommand: () => renameSceneCommand("H1", "Changed"),
  pasteBeatsCommand: () => pasteBeatsCommand({ plan: () => ({ inserted: ["R3"], replaced: null, title: false, saveNow: true }), apply: () => { assert.fail("paste wrote"); } }),
  titleCommand: () => titleCommand("Changed"),
  fileTitleCommand: doc => fileTitleCommand({ before: { title: doc.title, titleOrigin: doc.titleOrigin, titleVersion: doc.titleVersion }, title: "Changed", titleOrigin: "file", titleVersion: undefined }),
  tagCellsCommand: () => tagCellsCommand("tag", rewrites, { cat: "prop", name: "Cup" }, stamps),
  retagCommand: () => retagCommand({ cat: "prop", name: "Cup" }, "Mug", rewrites, stamps),
  rewriteCellsCommand: () => rewriteCellsCommand("rewrite", rewrites, stamps, { needs: "edit", stamped: true }),
  importRowsCommand: () => importRowsCommand({ rows: [{ id: "R3", audioText: "Imported" }], replace: false, scan: () => { assert.fail("import scanned"); } }, stamps).command,
  restoreConflictCommand: () => restoreConflictCommand("C1", { kind: "title", title: "Changed" }, stamps),
  editStamp: () => asCommand(editStamp({ rev: 7, lastEditedAt: "later", lastEditedBy: "Editor" })),
  documentIdStamp: () => asCommand(documentIdStamp(null, "new-id")),
  initializeFlowParagraphs: () => asCommand(initializeFlowParagraphs(runtime.ports, () => true, paragraph)),
  standaloneFlowCommand: () => standaloneFlowCommand("type", flowEdit, stamps, caretAt(beatPos("R1", 1)))
};

const refused = builderOperationCoverage.filter(row => row[0] !== "createBulkTagRows" && (row.shared === "refuse" || row.shared === "could not classify"));

test("C5d refusal cases cover the existing builder decision table exactly", () => {
  assert.deepEqual(Object.keys(factories).sort(), refused.map(row => row[0]).sort());
});

for (const [builder] of refused) {
  test(`rule 73: ${builder} refuses once, preserves encoded shared state and records no standalone undo`, () => {
    const set = replicas(2, { title: "Title", rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "def" }],
      sections: [{ id: "H1", name: "First", firstSceneId: "R1" }], comments: [{ id: "C1", rowId: "R1", field: "audioText", body: "Conflict" }] });
    const notices = fakeNotices();
    const h = sharedHarness(adapterReplica(set.a), { refused: sharedCommandRefusalNotice(notices.notices) });
    try {
      const before = encodeSharedState(set.a);
      const doc = h.session.read(doc => doc); assert.ok(doc);
      const make = factories[builder]; assert.ok(make);
      const outcome = h.session.run(make(doc));
      assert.equal(outcome.kind, "rejected");
      const move = ["moveBeatCommand", "swapBeatsCommand", "moveSceneCommand"].includes(builder);
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [[move ? SHARED_SESSION_DISABLED.moves : "This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(encodeSharedState(set.a), before);
      assert.deepEqual([h.undo, h.executed, h.published], [[], [], []]);
      assert.equal(h.session.generation(), 0);
    } finally { h.session.dispose(); set.close(); }
  });
}

const picture = (key: string) => ({ sha256: key.padStart(64, "0"), mime: "image/png", width: 1, height: 1 });
const galleryCases: readonly { readonly reason: string | null; readonly beat: string; readonly edit: () => GalleryEdit; readonly joined?: true }[] = [
  { reason: null, beat: "R2", edit: () => row => addGalleryPicture(row, picture("4"), "New") !== -1 },
  { reason: "gallery-local-file", beat: "R2", edit: () => row => addGalleryVideo(row, { name: "clip.mp4", size: 3, location: { kind: "bundled", name: "clip.mp4" } }) !== -1 },
  { reason: "gallery-embedded-image", beat: "R2", edit: () => row => { row.visualImage = "data:image/png;base64,iVBORw0KGgo="; return true; } },
  { reason: "gallery-joined-beat", beat: "R1", joined: true, edit: () => row => removeGallerySlot(row, 0) },
  { reason: "gallery-overflow", beat: "R2", edit: () => row => { row.moreImages = Array.from({ length: 62 }, (_, index) => ({ imageRef: picture(index.toString(16)) })); return true; } },
  { reason: "gallery-order-unavailable", beat: "R1", edit: () => row => moveGallerySlot(row, 2, 0) },
  { reason: "gallery-slot-unknown", beat: "R2", edit: () => { let calls = 0; return row => { if (++calls === 1) row.imageRef = picture("4"); return true; }; } }
];

for (const literal of galleryCases) test(`rule 73: served gallery ${literal.reason ?? "picture creation"} uses the real shared command`, () => {
  const set = replicas(2, { rows: [
    { id: "R1", audioText: "ab", imageRef: picture("1"), moreImages: [{ imageRef: picture("2") }, { imageRef: picture("3") }] },
    { id: "R2", audioText: "cd", imageRef: null }, { id: "R3", audioText: "ef", imageRef: picture("5") }
  ] });
  registerSharedOperationFamilies(set.a, { cells: runtime.cells });
  if (literal.joined) assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Editor", from: "R3", into: "R1", glue: " " })]), { ok: true });
  const notices = fakeNotices(), h = sharedHarness(adapterReplica(set.a), { refused: sharedCommandRefusalNotice(notices.notices) });
  const author = sharedAuthorPort({ handle: () => set.a, name: stamps.editor.name });
  try {
    const before = encodeSharedState(set.a);
    const ports = sharedGalleryPorts({ handle: () => set.a, author: author.next, stamps });
    const outcome = h.session.run(galleryCommand(literal.beat, literal.edit(), stamps, ports));
    if (literal.reason === null) {
      assert.equal(outcome.kind, "applied");
      assert.equal(notices.shown.length, 0);
      assert.deepEqual(h.session.read(doc => doc?.rows.find(row => row.id === "R2")?.imageRef), picture("4"));
    } else {
      assert.deepEqual(outcome, { kind: "rejected", reason: literal.reason, notified: true });
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(encodeSharedState(set.a), before);
      assert.deepEqual([h.undo, h.executed, h.published], [[], [], []]);
    }
  } finally { h.session.dispose(); set.close(); }
});

for (const reason of ["flow-clipboard-records-unavailable", "move-in-shared-session", "unhandled-kind", "flow-operations-empty", "flow-operations-unavailable", "visual-selection-unavailable", "buffer-heading-changed"]) {
  test(`rule 73: named refusal ${reason} maps to the warning sentence once`, () => {
    const set = replicas();
    const notices = fakeNotices();
    const h = sharedHarness(adapterReplica(set.a), { refused: sharedCommandRefusalNotice(notices.notices) });
    try {
      const before = encodeSharedState(set.a);
      assert.equal(h.session.run({ name: "served-command", needs: "edit", plan: () => ({ refused: reason }) }).kind, "rejected");
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(encodeSharedState(set.a), before);
      assert.deepEqual(h.undo, []);
    } finally { h.session.dispose(); set.close(); }
  });
}

for (const reason of ["tag-text-rewrite", "records-without-id"]) {
  test(`rule 73: served record builder refusal ${reason} warns once without writes or standalone undo`, () => {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "abc", visualText: "Cup" }] }), notices = fakeNotices();
    const h = sharedHarness(adapterReplica(set.a), { refused: sharedCommandRefusalNotice(notices.notices) });
    const author = sharedAuthorPort({ handle: () => set.a, name: stamps.editor.name });
    const shared = sharedRecordPorts({ handle: () => set.a, author: author.next });
    try {
      const before = encodeSharedState(set.a);
      const command = reason === "tag-text-rewrite"
        ? deleteTagsCommand([{ cat: "prop", name: "Cup", unlabel: true }], rewrites, stamps, shared)
        : gearQuickAddCommand(() => ({ remove: [], register: [{ id: "", cat: "gear", name: "Cup", owner: "", notes: "", status: "needed" }], added: 1, removed: 0 }), shared);
      assert.deepEqual(h.session.run(command), { kind: "rejected", reason, notified: true });
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(encodeSharedState(set.a), before);
      assert.deepEqual([h.undo, h.executed, h.published], [[], [], []]);
    } finally { h.session.dispose(); set.close(); }
  });
}

test("D23: a swap at an absent beat still asks moves and shows its reason", () => {
  const set = replicas();
  const notices = fakeNotices();
  const h = sharedHarness(adapterReplica(set.a), { refused: sharedCommandRefusalNotice(notices.notices) });
  try {
    const before = encodeSharedState(set.a);
    assert.equal(h.session.run(swapBeatsCommand("absent", 1)).kind, "rejected");
    assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [[SHARED_SESSION_DISABLED.moves, "warn"]]);
    assert.deepEqual(encodeSharedState(set.a), before);
    assert.deepEqual(h.undo, []);
  } finally { h.session.dispose(); set.close(); }
});

test("served flow commands still write, and an executor refusal is visible", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abc" }] });
  registerSharedOperationFamilies(set.a, { cells: runtime.cells });
  const notices = fakeNotices();
  const h = sharedHarness(adapterReplica(set.a), { refused: sharedCommandRefusalNotice(notices.notices) });
  try {
    const operations = { id: "typing", by: "Editor" };
    const ports = { ...runtime.ports, operations };
    const command = flowCommand("type", doc => typeWithMarks(doc, beatPos("R1", 1), "Z", {}, ports), { ...stamps, operations,
      beatStamp: () => { const op = readOperation({ kind: "scalar", id: "stamp", by: "Editor", target: { scope: "beat", record: "R1" }, field: "stamp", value: { at: stamps.clock.nowIso(), by: "Editor" } }); assert.ok(op); return op; } });
    assert.equal(h.session.run(command).kind, "applied");
    assert.equal(h.session.read(doc => doc?.rows[0]?.audioText), "aZbc");
    assert.equal(notices.shown.length, 0);
    const before = encodeSharedState(set.a);
    const move = readOperation({ kind: "segment-move", id: "move", by: "Editor", segments: ["R1"], observedOrder: ["order-R1"], at: { left: null, right: "order-R1", affinity: "before" } }); assert.ok(move);
    assert.equal(h.session.run({ name: "move", needs: "edit", plan: () => ({ changes: changeSet({}), apply: () => { assert.fail(); }, shared: { operations: [move] } }) }).kind, "rejected");
    assert.deepEqual(encodeSharedState(set.a), before);
    assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
  } finally { h.session.dispose(); set.close(); }
});
