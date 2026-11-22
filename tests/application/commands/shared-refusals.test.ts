import test from "node:test";
import assert from "node:assert/strict";
import type { Command, DocumentView, Replay, Stamp } from "../../../src/application/session/document-session.ts";
import { cellRuns, cellTextCommand } from "../../../src/application/commands/cell-text.ts";
import { moveBeatCommand, swapBeatsCommand } from "../../../src/application/commands/rows.ts";
import { addSceneCommand, moveSceneCommand, renameSceneCommand } from "../../../src/application/commands/scenes.ts";
import { pasteBeatsCommand } from "../../../src/application/commands/beats.ts";
import { importRowsCommand } from "../../../src/application/commands/import-rows.ts";
import { restoreConflictCommand } from "../../../src/application/commands/comments.ts";
import { fileTitleCommand, titleCommand } from "../../../src/application/commands/title.ts";
import { documentIdStamp, editStamp } from "../../../src/application/commands/save-stamps.ts";
import { initializeFlowParagraphs, standaloneFlowCommand } from "../../../src/application/commands/flow.ts";
import { rewriteCellsCommand } from "../../../src/application/commands/document-edit.ts";
import { deleteTagsCommand, gearQuickAddCommand, retagCommand, tagCellsCommand } from "../../../src/application/commands/production-records.ts";
import { recordCommandRun } from "../../../src/application/commands/shared-records.ts";
import { SHARED_SESSION_DISABLED } from "../../../src/application/session/ports.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import { sharedCommandRefusalNotice } from "../../../src/bootstrap/wiring/ports/shared-command-notices.ts";
import { beatPos, caretAt, typeWithMarks } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { builderOperationCoverage } from "../../core/collab/coverage-fixture.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { fakeReplica, sharedCommand, sharedHarness } from "../session/shared-session-support.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeNotices } from "../../features/fakes.ts";

const replicaOf = (raw: Record<string, unknown>) => fakeReplica(migrateRows(raw, fakeMigration().ports));
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
  test(`rule 73: ${builder} refuses once, preserves the replica document and records no standalone undo`, () => {
    const replica = replicaOf({ title: "Title", rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "def" }],
      sections: [{ id: "H1", name: "First", firstSceneId: "R1" }], comments: [{ id: "C1", rowId: "R1", field: "audioText", body: "Conflict" }] });
    const notices = fakeNotices();
    const h = sharedHarness(replica.port, { refused: sharedCommandRefusalNotice(notices.notices) });
    try {
      const before = replica.port.project();
      const doc = h.session.read(doc => doc); assert.ok(doc);
      const make = factories[builder]; assert.ok(make);
      const outcome = h.session.run(make(doc));
      assert.equal(outcome.kind, "rejected");
      const move = ["moveBeatCommand", "swapBeatsCommand", "moveSceneCommand"].includes(builder);
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [[move ? SHARED_SESSION_DISABLED.moves : "This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(replica.port.project(), before);
      assert.deepEqual([h.undo, h.executed, h.published], [[], [], []]);
      assert.equal(h.session.generation(), 0);
    } finally { h.session.dispose(); }
  });
}

for (const reason of ["flow-clipboard-records-unavailable", "move-in-shared-session", "unhandled-kind", "flow-operations-empty", "flow-operations-unavailable", "visual-selection-unavailable", "buffer-heading-changed"]) {
  test(`rule 73: named refusal ${reason} maps to the warning sentence once`, () => {
    const replica = replicaOf({ rows: [{ id: "R1", audioText: "abc" }] });
    const notices = fakeNotices();
    const h = sharedHarness(replica.port, { refused: sharedCommandRefusalNotice(notices.notices) });
    try {
      const before = replica.port.project();
      assert.equal(h.session.run({ name: "served-command", needs: "edit", plan: () => ({ refused: reason }) }).kind, "rejected");
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(replica.port.project(), before);
      assert.deepEqual(h.undo, []);
    } finally { h.session.dispose(); }
  });
}

for (const reason of ["tag-text-rewrite", "records-without-id"]) {
  test(`rule 73: served record builder refusal ${reason} warns once without writes or standalone undo`, () => {
    const replica = replicaOf({ rows: [{ id: "R1", audioText: "abc", visualText: "Cup" }] }), notices = fakeNotices();
    const h = sharedHarness(replica.port, { refused: sharedCommandRefusalNotice(notices.notices) });
    const shared = { author: () => ({ id: "w1_1", by: "Editor" }), ranks: () => [], heads: () => [] };
    try {
      const before = replica.port.project();
      const command = reason === "tag-text-rewrite"
        ? deleteTagsCommand([{ cat: "prop", name: "Cup", unlabel: true }], rewrites, stamps, shared)
        : gearQuickAddCommand(() => ({ remove: [], register: [{ id: "", cat: "gear", name: "Cup", owner: "", notes: "", status: "needed" }], added: 1, removed: 0 }), shared);
      assert.deepEqual(h.session.run(command), { kind: "rejected", reason, notified: true });
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(replica.port.project(), before);
      assert.deepEqual([h.undo, h.executed, h.published], [[], [], []]);
    } finally { h.session.dispose(); }
  });
}

test("D23: a swap at an absent beat still asks moves and shows its reason", () => {
  const replica = replicaOf({ rows: [{ id: "R1", audioText: "abc" }] });
  const notices = fakeNotices();
  const h = sharedHarness(replica.port, { refused: sharedCommandRefusalNotice(notices.notices) });
  try {
    const before = replica.port.project();
    assert.equal(h.session.run(swapBeatsCommand("absent", 1)).kind, "rejected");
    assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [[SHARED_SESSION_DISABLED.moves, "warn"]]);
    assert.deepEqual(replica.port.project(), before);
    assert.deepEqual(h.undo, []);
  } finally { h.session.dispose(); }
});

test("a served command still writes, and an executor refusal is visible", () => {
  const replica = replicaOf({ rows: [{ id: "R1", audioText: "abc" }] });
  const notices = fakeNotices();
  const h = sharedHarness(replica.port, { refused: sharedCommandRefusalNotice(notices.notices) });
  try {
    const insert = readOperation({ kind: "text-insert", id: "typing", by: "Editor", target: { owner: "R1", segment: "R1", field: "audioText" },
      at: { left: null, right: '["flow-base","R1","audioText",1]', affinity: "before" }, content: [{ value: "Z", marks: [] }] });
    const stamp = readOperation({ kind: "scalar", id: "stamp", by: "Editor", target: { scope: "beat", record: "R1" },
      field: "stamp", value: { at: stamps.clock.nowIso(), by: "Editor" } });
    assert.ok(insert && stamp);
    const command = sharedCommand("type", [insert, stamp]);
    replica.script(operations => {
      assert.deepEqual(operations.map(operation => operation.kind), ["text-insert", "scalar"]);
      replica.write("local-command", { rows: [{ id: "R1", audioText: "aZbc" }] });
      return { ok: true };
    });
    assert.equal(h.session.run(command).kind, "applied");
    assert.equal(h.session.read(doc => doc?.rows[0]?.audioText), "aZbc");
    assert.equal(notices.shown.length, 0);
    const before = replica.port.project();
    const move = readOperation({ kind: "segment-move", id: "move", by: "Editor", segments: ["R1"], observedOrder: ["order-R1"], at: { left: null, right: "order-R1", affinity: "before" } }); assert.ok(move);
    replica.script(operations => {
      assert.deepEqual(operations, [move]);
      return { ok: false, reason: "unhandled-kind" };
    });
    assert.equal(h.session.run({ name: "move", needs: "edit", plan: () => ({ changes: changeSet({}), apply: () => { assert.fail(); }, shared: { operations: [move] } }) }).kind, "rejected");
    assert.deepEqual(replica.port.project(), before);
    assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
  } finally { h.session.dispose(); }
});

test("held and no-op record commands use the isolated shared runner and report only refusal", () => {
  const replica = replicaOf({ rows: [{ id: "R1", audioText: "abc" }] }), notices = fakeNotices();
  const h = sharedHarness(replica.port);
  const refusal = sharedCommandRefusalNotice(notices.notices);
  const recordPorts = { author: () => ({ id: "w1_1", by: "Editor" }), ranks: () => [], heads: () => [] };
  const records = { ports: () => recordPorts, refused: outcome => {
    if (outcome.kind === "rejected") refusal(outcome.reason);
  } } satisfies Parameters<typeof recordCommandRun<typeof recordPorts>>[1];
  const edits = { run: h.session.run, edit: () => assert.fail("record command used the silent edit route") };
  try {
    const before = replica.port.project();
    const noOp = { name: "No record change", needs: "edit", plan: () => null } as const;
    assert.deepEqual(recordCommandRun(edits, records, () => noOp), { changed: false, held: false });
    assert.deepEqual(notices.shown, []);
    const release = h.session.beforeCommand(() => false);
    try {
      assert.deepEqual(recordCommandRun(edits, records, () => noOp), { changed: false, held: true });
    } finally { release(); }
    assert.deepEqual(notices.shown.map(({ message, kind }) => [message, kind]), [["This is not available in a shared session yet.", "warn"]]);
    assert.deepEqual(replica.port.project(), before);
    assert.deepEqual([h.undo, h.executed, h.published], [[], [], []]);
  } finally { h.session.dispose(); }
});
