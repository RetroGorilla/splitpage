import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlowWriter } from "../../../src/features/writer/flow-writer.ts";
import { writerFlowCommands } from "../../../src/bootstrap/wiring/ports/writer-flow.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { replicas } from "../../adapters/collab/executor-support.ts";
import { sharedHarness, adapterReplica } from "../../application/session/shared-session-support.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { applySharedUpdate, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { writerPage } from "./painted-base-support.ts";
import { fakeFlowCommandEffects, fakeWriterBufferEffects, fakeNotices } from "../fakes.ts";
import { sharedCommandRefusalNotice } from "../../../src/bootstrap/wiring/ports/shared-command-notices.ts";
import { SHARED_SESSION_DISABLED } from "../../../src/application/session/ports.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";

test("the Writer uses its shared command ports for formatting and asks the author once per admitted command", () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "def" }] });
  registerSharedOperationFamilies(h.a, { cells: createFlowLoadRuntime().cells });
  const sessionNotices = fakeNotices();
  const a = sharedHarness(adapterReplica(h.a), { refused: sharedCommandRefusalNotice(sessionNotices.notices) }), b = sharedHarness(adapterReplica(h.b));
  const author = sharedAuthorPort({ handle: () => h.a, name: () => "Alice" });
  let requests = 0;
  const commands = writerFlowCommands({ cells: fromHtml, newId: () => "new", hasVisual: () => false }, { author: { next: () => { requests++; return author.next(); } }, writer: () => "1" });
  const { effects, notices } = fakeFlowCommandEffects();
  const buffer = sharedBufferPorts(h.a, a.session, { ...fakeWriterBufferEffects().effects,
    readers: bufferReaders, stamps: bufferStamps("Alice"), author: () => { const next = author.next(); assert.ok(next); return next; } });
  const writer = createFlowWriter({
    ...effects, ...commands, ...buffer, root: writerPage(), doc: () => a.session.read(doc => { assert.ok(doc); return doc; }),
    lifetime: a.session, heldSelection: createEditorSelection({ epoch: a.session.epoch, order: () => [], keys: () => null }),
    decode: fromHtml, storedHtml: html => html, run: a.session.run, shown: edit => edit(), editingBlocked: () => false,
    text: { cells: fromHtml, clock: { nowIso: () => "2026-11-13T12:00:00.000Z" }, editor: { name: () => "Alice" } },
    wholeFieldText: { commit: () => { throw new Error("Formatting reached a whole-field command"); } }
  });
  try {
    writer.repaint();
    writer.place({ anchor: beatPos("R1", 1), head: beatPos("R1", 2) });
    writer.format("bold");
    assert.equal(requests, 1);
    assert.deepEqual(a.executed.map(entry => entry.operations), [[
      { kind: "mark", id: "w1_1:0", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: ['["flow-base","R1","audioText",1,2]'], mark: { kind: "b", value: true } },
      { kind: "scalar", id: "w1_1_stamp_0:stamp", by: "Alice", target: { scope: "beat", record: "R1" }, field: "stamp", value: { at: "2026-11-13T12:00:00.000Z", by: "Alice" } }
    ]]);
    assert.equal(applySharedUpdate(h.b, encodeSharedState(h.a)).ok, true);
    for (const session of [a.session, b.session]) assert.equal(session.read(doc => doc?.rows[0]?.audioText), "a<strong>b</strong>c");
    assert.deepEqual(notices, []);
    assert.equal(commands.flow.operations, undefined);
    writer.caret("R1", 1);
    const root = document.getElementById("writer-doc"); assert.ok(root);
    root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    const created = "structure_1_00770031005f0032005f006f005f0030_beat_0";
    assert.equal(requests, 2);
    assert.deepEqual(writer.selection(), { anchor: beatPos(created, 0), head: beatPos(created, 0) });
    assert.deepEqual(a.undo.at(-1)?.selection?.after, { anchor: beatPos(created, 0), head: beatPos(created, 0) });
    assert.equal(applySharedUpdate(h.b, encodeSharedState(h.a)).ok, true);
    for (const session of [a.session, b.session]) assert.deepEqual(session.read(doc => doc?.rows.map(row => row.audioText)), ["a", "<strong>b</strong>c", "def"]);
    assert.deepEqual(notices, []);
    writer.caret("R1", 1);
    const before = encodeSharedState(h.a);
    const undoEntries = a.undo.length;
    root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(sessionNotices.shown.map(item => [item.message, item.kind]), [[SHARED_SESSION_DISABLED.moves, "warn"]]);
    assert.deepEqual(notices, []);
    assert.deepEqual(encodeSharedState(h.a), before);
    assert.equal(a.undo.length, undoEntries);
  } finally { writer.dispose(); a.session.dispose(); b.session.dispose(); h.close(); }
});
