import { test } from "node:test";
import * as Y from "yjs";
import assert from "node:assert/strict";
import { bufferedWriter } from "./buffer-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { observeSharedTransactions, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { registerSplits, sharedCommand } from "../../application/session/shared-session-support.ts";
import { operation } from "../../adapters/collab/executor-support.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

type Page = ReturnType<typeof bufferedWriter>;

const BEAT = "structure_1_007200310037_beat_0", VISUAL = "structure_1_007200310037_visual_0";

function recovering(text: string): Page {
  const page = bufferedWriter(text, true, undefined, undefined, { author: serial => "r" + (15 + serial) });
  registerSplits(page.h.a); registerSharedRemovalHandlers(page.h.a);
  return page;
}

function stale(page: Page): void {
  const other = collabState(page.h.a).roots.beats.get("R2"); assert.ok(other instanceof Y.Map);
  transactSharedDocument(page.h.a, "local-command", () => { other.set("lengthSeconds", 7); });
}

function read(handle: SharedDocumentHandle) {
  const value = projectSharedDocumentWithRecovery(handle);
  return { rows: value.document.rows.map(row => ({ id: row.id, text: row.audioText })), recovery: value.recovery.map(entry => {
    assert.equal(entry.kind, "removed-beat"); if (entry.kind !== "removed-beat") throw new Error("Unexpected recovery entry");
    return { id: entry.row.id, text: entry.row.audioText, members: entry.members, ...(Object.hasOwn(entry, "buffer") ? { buffer: entry.buffer } : {}) };
  }) };
}

function copies(page: Page, expected: ReturnType<typeof read>): void {
  page.h.queue.flush("dup"); page.h.join();
  for (const handle of [page.h.a, page.h.b, page.h.c]) assert.deepEqual(read(handle), expected);
}

test("rule 29: a composition that cannot be committed is kept in recovery once, announced once, and the field is repainted from the document", () => {
  const page = recovering("abcd");
  try {
    page.start(1, 3); page.native(1, 3, "Z", undefined, "insertCompositionText");
    stale(page);
    const undone = page.a.undo.length, generation = page.a.session.generation();
    let transactions = 0;
    const stop = observeSharedTransactions(page.h.a, () => { transactions++; });
    try { page.end("Z"); } finally { stop(); }
    assert.deepEqual([page.recovered, page.reports], [["R1"], []]);
    assert.deepEqual([page.text(), page.beat().textContent], ["abcd", "abcd"]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    assert.deepEqual([transactions, page.a.undo.length, page.a.session.generation()], [1, undone, generation + 1]);
    assert.deepEqual(page.a.executed.map(command => command.base), [1, 2]);
    assert.deepEqual(page.a.executed[1]?.operations, [
      { kind: "segment-create", id: "r17", by: "Alice", segment: "draft_segment_r17", beat: "draft_r17",
        at: { left: "b:R1", right: null, affinity: "after" }, fields: { audioText: "aZd", bufferSourceOwner: "R1", bufferPaintedBase: 1 } },
      { kind: "remove", id: "r17_remove", by: "Alice", removalKind: "beat", targets: ["draft_r17"], observed: ['["flow-base","draft_r17","audioText",0,3]'],
        boundaries: ["draft_r17"], components: [VISUAL], gallery: [], comments: [], at: 2 }
    ]);
    assert.deepEqual(page.surface.selection(), { anchor: { kind: "beat", rowId: "R1", offset: 2 }, head: { kind: "beat", rowId: "R1", offset: 2 } });
    assert.deepEqual([page.surface.paintedBase("R1")?.text, page.surface.paintedBase("R1")?.revision], ["abcd", 3]);
    copies(page, { rows: [{ id: "R1", text: "abcd" }, { id: "R2", text: "next" }], recovery: [{
      id: BEAT, text: "aZd", members: [BEAT], buffer: [{ beat: BEAT, metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 1 } }] }] });
    assert.equal(page.native(4, 4, "Q"), true);
    assert.deepEqual([page.text(), page.recovered, page.reports], ["abcdQ", ["R1"], []]);
    copies(page, { rows: [{ id: "R1", text: "abcdQ" }, { id: "R2", text: "next" }], recovery: [{
      id: BEAT, text: "aZd", members: [BEAT], buffer: [{ beat: BEAT, metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 1 } }] }] });
  } finally { page.close(); }
});

test("rule 29: a paint during the drain of a successful recovery write resets the field and reports nothing", () => {
  const page = recovering("abcd");
  try {
    let paints = 0;
    const stop = page.a.session.subscribe(() => { paints++; page.surface.paint(); });
    page.start(1, 3); page.native(1, 3, "Z", undefined, "insertCompositionText");
    const remote = collabState(page.h.b).roots.beats.get("R2"); assert.ok(remote instanceof Y.Map);
    transactSharedDocument(page.h.b, "local-command", () => { remote.set("lengthSeconds", 9); });
    page.h.queue.deliverFrom("B", "D1");
    assert.equal(collabState(page.h.a).ingress.held.length, 1);
    stale(page);
    const before = paints;
    try { page.end("Z"); } finally { stop(); }
    assert.ok(paints - before >= 2);
    assert.deepEqual([page.recovered, page.reports], [["R1"], []]);
    assert.deepEqual([page.text(), page.beat().textContent], ["abcd", "abcd"]);
    assert.deepEqual([[...collabState(page.h.a).ingress.holds], collabState(page.h.a).ingress.held.length], [[], 0]);
    assert.deepEqual(read(page.h.a).recovery.map(entry => entry.text), ["aZd"]);
    assert.equal(page.native(4, 4, "Q"), true);
    assert.deepEqual([page.text(), page.recovered, page.reports], ["abcdQ", ["R1"], []]);
  } finally { page.close(); }
});

test("rule 29: ordinary typing refused on a stale base is kept in recovery at its input event, and the caret is clamped to the repainted field", () => {
  const page = recovering("ab");
  try {
    assert.equal(page.native(2, 2, "XYZ", () => { stale(page); }), true);
    assert.deepEqual([page.recovered, page.reports], [["R1"], []]);
    assert.deepEqual([page.text(), page.beat().textContent], ["ab", "ab"]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    assert.deepEqual(page.surface.selection(), { anchor: { kind: "beat", rowId: "R1", offset: 2 }, head: { kind: "beat", rowId: "R1", offset: 2 } });
    copies(page, { rows: [{ id: "R1", text: "ab" }, { id: "R2", text: "next" }], recovery: [{
      id: BEAT, text: "abXYZ", members: [BEAT], buffer: [{ beat: BEAT, metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 1 } }] }] });
  } finally { page.close(); }
});

test("rule 29: the local command whose admission found the stale edit plans on the repainted document after the recovery write", () => {
  const page = recovering("ab");
  try {
    page.native(2, 2, "Z", undefined, "insertText", "R1", false);
    stale(page);
    let plans = 0;
    const command = sharedCommand("status", [page.h.command("A", { kind: "status", target: { scope: "beat", record: "R1" }, value: "ready", parents: [] })]);
    const outcome = page.a.session.run({ ...command, plan: (doc, capabilities) => {
      plans++;
      assert.equal(doc.rows[0]?.audioText, "ab");
      assert.deepEqual([page.recovered, [...collabState(page.h.a).ingress.holds], page.beat().textContent], [["R1"], [], "ab"]);
      return command.plan(doc, capabilities);
    } });
    assert.deepEqual([outcome.kind, plans, page.reports], ["applied", 1, []]);
    assert.deepEqual(page.a.executed.map(command => command.operations.map(operation => operation.kind)), [["text-insert", "scalar"], ["segment-create", "remove"], ["status"]]);
    assert.equal(page.a.session.read(doc => doc?.rows[0]?.status), "ready");
    copies(page, { rows: [{ id: "R1", text: "ab" }, { id: "R2", text: "next" }], recovery: [{
      id: BEAT, text: "abZ", members: [BEAT], buffer: [{ beat: BEAT, metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 1 } }] }] });
  } finally { page.close(); }
});

test("rule 29: closing the Writer over a stale edit keeps the typing in recovery and unmounts", () => {
  const page = recovering("ab");
  try {
    page.native(2, 2, "Z", undefined, "insertText", "R1", false);
    stale(page);
    page.surface.dispose();
    assert.deepEqual([page.recovered, page.reports, [...collabState(page.h.a).ingress.holds]], [["R1"], [], []]);
    const revision = readSharedRevision(page.h.a);
    page.beat().textContent = "abQ";
    page.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Q" }));
    assert.deepEqual([readSharedRevision(page.h.a), page.reports, page.missing], [revision, [], []]);
    copies(page, { rows: [{ id: "R1", text: "ab" }, { id: "R2", text: "next" }], recovery: [{
      id: BEAT, text: "abZ", members: [BEAT], buffer: [{ beat: BEAT, metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 1 } }] }] });
  } finally { page.close(); }
});

test("T01 in the Writer: typing over a held removal joins that beat's recovery, with no recovery write and no announcement", () => {
  const page = recovering("ab");
  try {
    registerSharedRemovalHandlers(page.h.b);
    assert.equal(page.native(2, 2, "Z", () => {
      assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind: "remove", id: "gone", by: "Bob", removalKind: "beat", targets: ["R1"],
        observed: [flowBaseReference("R1", "audioText", 0, 2)], boundaries: ["R1"], components: [], gallery: [], at: 0 })], { base: readSharedRevision(page.h.b) }), { ok: true });
      page.h.queue.deliverFrom("B", "D1");
    }), true);
    assert.deepEqual([page.recovered, page.reports], [[], []]);
    assert.deepEqual(page.a.executed.map(command => command.operations.map(operation => operation.kind)), [["text-insert", "scalar"]]);
    copies(page, { rows: [{ id: "R2", text: "next" }], recovery: [{ id: "R1", text: "abZ", members: ["R1"] }] });
  } finally { page.close(); }
});
