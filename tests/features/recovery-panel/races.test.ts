import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, send, removeBeat, page, click } from "./support.ts";
import { agree } from "../../adapters/collab/executor-support.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { deleteRecord } from "../../adapters/collab/record-support.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { sharedRecoveryEntryName } from "../../../src/core/collab/recovery.ts";
import type { SharedUndoOutcome } from "../../../src/application/editing/undo/shared-undo.ts";

for (const order of ["D1", "rev"] as const) test("C9 rule 52: restore racing an unseen discard wins; undo retires that still-active discard: " + order, () => {
  const set = fixture(); send(set.a, removeBeat); set.queue.flush(order);
  const a = page(set.a, "Bob"), b = page(set.b, "Cara");
  try {
    a.open(); b.open(); click(a.host, "removed-beat", "Discard"); click(b.host, "removed-beat", "Restore");
    assert.deepEqual(a.h.executed.map(item => item.operations), [[{ kind: "discard", id: "action1", by: "Bob", entry: { kind: "removed-beat", key: "R1" }, removals: ["structure_1_0067006f006e0065_removal_0"] }]]);
    assert.deepEqual(b.h.executed.map(item => item.operations), [[{ kind: "restore", id: "action1", by: "Cara", removals: ["structure_1_0067006f006e0065_removal_0"] }]]);
    set.queue.flush(order);
    agree("C9 restore wins", order, [set.a, set.b], handle => {
      const { document, recovery } = projectSharedDocumentWithRecovery(handle);
      return { rows: document.rows.map(row => [row.id, row.audioText]), recovery };
    }, { rows: [["R1", "abcd"], ["R2", "ef"]], recovery: [] });
    const used = a.undo.undo();
    assert.deepEqual(used, { ok: true, effective: true, label: "recovery-discard", selection: null });
    assert.equal(a.undo.skipped(), 0); assert.deepEqual(a.undo.sizes(), { undo: 0, redo: 1, dropped: 0 });
    set.queue.flush(order);
    const undone = b.undo.undo(); assert.equal(undone.ok && undone.effective, true); set.queue.flush(order);
    agree("C9 restore undo leaves discard retired", order, [set.a, set.b], handle => {
      const { document, recovery } = projectSharedDocumentWithRecovery(handle);
      return { rows: document.rows.map(row => [row.id, row.audioText]), recovery: recovery.map(entry => entry.kind) };
    }, { rows: [["R2", "ef"]], recovery: ["removed-beat"] });
    agree("C9 restore/discard full state", order, [set.a, set.b], projectSharedDocumentWithRecovery);
  } finally { a.close(); b.close(); set.close(); }
});

for (const order of ["D1", "rev"] as const) test("C9 rule 52: a restore that observed the discard retires it, so panel discard undo is used up: " + order, () => {
  const set = fixture(); send(set.a, removeBeat); set.queue.flush(order);
  const a = page(set.a);
  try {
    a.open(); click(a.host, "removed-beat", "Discard"); set.queue.flush(order);
    send(set.b, { kind: "restore", id: "outside", by: "Cara", removals: ["structure_1_0067006f006e0065_removal_0"] }); set.queue.flush(order);
    const before = encodeSharedState(set.a);
    assert.deepEqual(a.undo.undo(), { ok: true, effective: false, label: "recovery-discard", selection: null, reason: "used-up" });
    assert.deepEqual(encodeSharedState(set.a), before); assert.equal(a.undo.skipped(), 0);
    assert.deepEqual(a.undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
    agree("C9 observed discard restore", order, [set.a, set.b], handle => {
      const { document, recovery } = projectSharedDocumentWithRecovery(handle);
      return { rows: document.rows.map(row => [row.id, row.audioText]), recovery };
    }, { rows: [["R1", "abcd"], ["R2", "ef"]], recovery: [] });
    agree("C9 observed discard restore full state", order, [set.a, set.b], projectSharedDocumentWithRecovery);
  } finally { a.close(); set.close(); }
});

test("C9 real refusals keep state unchanged for a missing author, stale entry or read-only session", () => {
  const set = fixture(); send(set.a, removeBeat); set.queue.flush("D1");
  const a = page(set.a), b = page(set.b);
  try {
    a.open(); b.open(); a.state.author = false; const before = encodeSharedState(set.a);
    click(a.host, "removed-beat", "Restore");
    assert.deepEqual(encodeSharedState(set.a), before); assert.deepEqual(a.h.executed, []);
    assert.deepEqual(a.notices.shown.map(notice => notice.message), ["This is not available in a shared session yet."]);
    a.state.author = true; a.state.badIdentity = true;
    assert.deepEqual(a.ports.restore({ kind: "removed-beat", key: "R1" }), { kind: "rejected", reason: "recovery-no-author" });
    a.state.badIdentity = false; a.state.parts = false;
    assert.deepEqual(a.ports.restore({ kind: "removed-beat", key: "R1" }), { kind: "rejected", reason: "recovery-no-author" });
    a.state.parts = true; a.state.shared = false;
    assert.deepEqual(a.ports.restore({ kind: "removed-beat", key: "R1" }), { kind: "rejected", reason: "recovery-no-session" });
    assert.equal(a.ports.reply('["C9","r1"]'), null); a.state.shared = true; a.h.deny("viewing-only");
    for (const action of ["restore", "discard"] as const) assert.deepEqual(a.ports[action]({ kind: "removed-beat", key: "R1" }), { kind: "rejected", reason: "viewing-only" });
    assert.deepEqual(encodeSharedState(set.a), before); a.h.deny(null);
    click(b.host, "removed-beat", "Restore"); set.queue.flush("D1");
    const restored = encodeSharedState(set.a);
    assert.deepEqual(a.ports.restore({ kind: "removed-beat", key: "R1" }), { kind: "rejected", reason: "recovery-entry-unavailable" });
    assert.deepEqual(encodeSharedState(set.a), restored);
    agree("C9 refused full state", "D1", [set.a, set.b], projectSharedDocumentWithRecovery);
  } finally { a.close(); b.close(); set.close(); }
});

test("C9 seeded three-writer restore, discard, undo and redo races converge without declared limits", t => {
  let random = 0x9c1414, checkpoints = 0;
  const kinds = new Set<string>(), actions = new Set<string>(), declaredLimits: readonly string[] = [];
  const accept = (outcome: SharedUndoOutcome) => { if (!outcome.ok && !("empty" in outcome)) assert.ok(declaredLimits.includes(outcome.reason), outcome.reason); };
  for (let seed = 0; seed < 12; seed++) for (const order of ["D1", "rev", "dup"] as const) {
    const set = fixture({ rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }],
      people: [{ id: "P1", name: "Pat" }], productionTags: [{ id: "t_1", cat: "prop", name: "Cup", status: "needed", owner: "P1" }] }, 3);
    send(set.a, removeBeat, deleteRecord("people", "P1", "Alice"), { kind: "heading-remove", id: "goneH", by: "Alice", heading: "H1",
      observed: [flowBaseReference("H1", "heading", 0, 5)], newBeat: null, nextBeat: null }); set.queue.flush(order);
    const pages = [page(set.a, "Alice"), page(set.b, "Bob"), page(set.c, "Cara")];
    try {
      for (const page of pages) page.open();
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const actors = [random % 3, (random + 1) % 3, (random + 2) % 3];
      const kind = ["removed-beat", "removed-heading", "deleted-person"][seed % 3]; assert.ok(kind);
      for (const [index, actor] of actors.entries()) {
        const page = pages[actor]; assert.ok(page);
        const entry = page.h.session.recovery().find(entry => entry.kind === kind); assert.ok(entry);
        const action = index === 1 ? "discard" : "restore";
        const outcome = page.ports[action](sharedRecoveryEntryName(entry)); assert.equal(outcome.kind, "applied"); actions.add(action);
        for (const operation of page.h.executed.flatMap(item => item.operations)) kinds.add(operation.kind);
      }
      set.queue.flush(order); agree("C9 seed " + seed + " command", order, [set.a, set.b, set.c], projectSharedDocumentWithRecovery); checkpoints++;
      for (const actor of actors.toReversed()) { const page = pages[actor]; assert.ok(page); accept(page.undo.undo()); actions.add("undo"); }
      set.queue.flush(order); agree("C9 seed " + seed + " undo", order, [set.a, set.b, set.c], projectSharedDocumentWithRecovery); checkpoints++;
      for (const actor of actors) { const page = pages[actor]; assert.ok(page); accept(page.undo.redo()); actions.add("redo"); }
      set.queue.flush(order); agree("C9 seed " + seed + " redo", order, [set.a, set.b, set.c], projectSharedDocumentWithRecovery); checkpoints++;
      for (const page of pages) assert.equal(page.undo.skipped(), 0);
    } finally { for (const page of pages) page.close(); set.close(); }
  }
  assert.deepEqual([...kinds].sort(), ["discard", "record-create", "restore"]);
  assert.deepEqual([...actions].sort(), ["discard", "redo", "restore", "undo"]); assert.equal(checkpoints, 108);
  t.diagnostic("seed 0x9c1414; 36 histories, 108 checkpoints; every checkpoint includes an encoded joiner");
});
