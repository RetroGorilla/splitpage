import { test } from "node:test";
import * as Y from "yjs";
import assert from "node:assert/strict";
import { bufferedSplit } from "./cell-buffer-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { observeSharedTransactions, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { sharedCommand } from "../../application/session/shared-session-support.ts";
import { operation } from "../../adapters/collab/executor-support.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { setCellSelection } from "../../../src/features/common/cell-selection.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

type Page = ReturnType<typeof bufferedSplit>;

const BEAT = "structure_1_007200310037_beat_0", VISUAL = "structure_1_007200310037_visual_0";
const SOURCE = [{ beat: BEAT, metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 1 } }];

function recovering(text: string, structure = true): Page {
  return bufferedSplit([{ id: "R1", text }, { id: "R2", text: "next" }], true, { author: serial => "r" + (structure ? 15 + serial : serial), structure });
}

function stale(page: Page): void {
  const other = collabState(page.h.a).roots.beats.get("R2"); assert.ok(other instanceof Y.Map);
  transactSharedDocument(page.h.a, "local-command", () => { other.set("lengthSeconds", 7); });
}

function compose(page: Page, from: number, to: number, data: string): void {
  const cell = page.cell("R1"); cell.focus(); setCellSelection(cell, from, to);
  cell.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
  assert.equal(page.key("R1", from, to, "insertCompositionText", data), true);
}

function end(page: Page, data: string): void {
  page.cell("R1").dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data }));
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

test("rule 29 in the Split view: a composition that cannot be committed is kept in recovery once, with no undo step, announced once, and the cell is repainted", () => {
  const page = recovering("abcd");
  try {
    compose(page, 1, 3, "Z");
    stale(page);
    const undone = page.a.undo.length;
    let transactions = 0;
    const stop = observeSharedTransactions(page.h.a, () => { transactions++; });
    try { end(page, "Z"); } finally { stop(); }
    assert.deepEqual([page.recovered, page.reports], [["R1"], []]);
    assert.deepEqual([page.text(), page.cell("R1").textContent, page.caret()], ["abcd", "abcd", { from: 2, to: 2 }]);
    assert.deepEqual([[...collabState(page.h.a).ingress.holds], transactions, page.a.undo.length], [[], 1, undone]);
    assert.deepEqual(page.a.executed[1]?.operations, [
      { kind: "segment-create", id: "r17", by: "Alice", segment: "draft_segment_r17", beat: "draft_r17",
        at: { left: "b:R1", right: null, affinity: "after" }, fields: { audioText: "aZd", bufferSourceOwner: "R1", bufferPaintedBase: 1 } },
      { kind: "remove", id: "r17_remove", by: "Alice", removalKind: "beat", targets: ["draft_r17"], observed: ['["flow-base","draft_r17","audioText",0,3]'],
        boundaries: ["draft_r17"], components: [VISUAL], gallery: [], comments: [], at: 2 }
    ]);
    assert.deepEqual([page.painted.base("R1")?.text, page.painted.base("R1")?.revision], ["abcd", 3]);
    copies(page, { rows: [{ id: "R1", text: "abcd" }, { id: "R2", text: "next" }], recovery: [{ id: BEAT, text: "aZd", members: [BEAT], buffer: SOURCE }] });
    assert.equal(page.key("R1", 4, 4, "insertText", "Q"), true);
    assert.deepEqual([page.text(), page.recovered, page.reports], ["abcdQ", ["R1"], []]);
  } finally { page.close(); }
});

test("rule 29 in the Split view: ordinary typing refused on a stale base is kept at its input event, and the caret is clamped to the repainted cell", () => {
  const page = recovering("ab");
  try {
    assert.equal(page.key("R1", 2, 2, "insertText", "XYZ", { during: () => { stale(page); } }), true);
    assert.deepEqual([page.recovered, page.reports], [["R1"], []]);
    assert.deepEqual([page.text(), page.cell("R1").textContent, page.caret(), [...collabState(page.h.a).ingress.holds]], ["ab", "ab", { from: 2, to: 2 }, []]);
    copies(page, { rows: [{ id: "R1", text: "ab" }, { id: "R2", text: "next" }], recovery: [{ id: BEAT, text: "abXYZ", members: [BEAT], buffer: SOURCE }] });
  } finally { page.close(); }
});

test("rules 29 and 55: the recovery entry keeps the cell as shown, so a typed space the browser shows as U+00A0 is kept as U+00A0", () => {
  const page = recovering("ab");
  try {
    assert.equal(page.key("R1", 2, 2, "insertText", " ", { during: () => { stale(page); }, shown: cell => {
      const node = [...cell.childNodes].find(child => child instanceof window.Text && child.data === " "); assert.ok(node instanceof window.Text); node.data = " ";
    } }), true);
    assert.deepEqual([page.recovered, page.reports, page.text()], [["R1"], [], "ab"]);
    copies(page, { rows: [{ id: "R1", text: "ab" }, { id: "R2", text: "next" }], recovery: [{ id: BEAT, text: "ab&nbsp;", members: [BEAT], buffer: SOURCE }] });
  } finally { page.close(); }
});

test("rule 38 in the Split view: the local command whose admission found the stale edit plans on the repainted document after the recovery write", () => {
  const page = recovering("ab");
  try {
    page.key("R1", 2, 2, "insertText", "Z", { input: false });
    stale(page);
    let plans = 0;
    const command = sharedCommand("status", [page.h.command("A", { kind: "status", target: { scope: "beat", record: "R1" }, value: "ready", parents: [] })]);
    const outcome = page.a.session.run({ ...command, plan: (doc, capabilities) => {
      plans++;
      assert.equal(doc.rows[0]?.audioText, "ab");
      assert.deepEqual([page.recovered, [...collabState(page.h.a).ingress.holds], page.cell("R1").textContent], [["R1"], [], "ab"]);
      return command.plan(doc, capabilities);
    } });
    assert.deepEqual([outcome.kind, plans, page.reports], ["applied", 1, []]);
    assert.deepEqual(page.a.executed.map(command => command.operations.map(operation => operation.kind)), [["text-insert", "scalar"], ["segment-create", "remove"], ["status"]]);
    copies(page, { rows: [{ id: "R1", text: "ab" }, { id: "R2", text: "next" }], recovery: [{ id: BEAT, text: "abZ", members: [BEAT], buffer: SOURCE }] });
  } finally { page.close(); }
});

test("rule 29 in the Split view: unmounting over a stale edit keeps the typing in recovery and stops listening", () => {
  const page = recovering("ab");
  try {
    page.key("R1", 2, 2, "insertText", "Z", { input: false });
    stale(page);
    assert.equal(page.buffer.dispose(), true);
    assert.deepEqual([page.recovered, page.reports, [...collabState(page.h.a).ingress.holds]], [["R1"], [], []]);
    const revision = readSharedRevision(page.h.a);
    page.cell("R1").textContent = "abQ";
    page.cell("R1").dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Q" }));
    assert.deepEqual([readSharedRevision(page.h.a), page.reports, page.missing], [revision, [], []]);
    copies(page, { rows: [{ id: "R1", text: "ab" }, { id: "R2", text: "next" }], recovery: [{ id: BEAT, text: "abZ", members: [BEAT], buffer: SOURCE }] });
  } finally { page.close(); }
});

test("rule 29 in the Split view: a paint during the drain of a successful recovery write leaves the cell repainted and reports nothing", () => {
  const page = recovering("abcd");
  try {
    let paints = 0;
    const stop = page.a.session.subscribe(() => { paints++; page.paint(); });
    compose(page, 1, 3, "Z");
    const remote = collabState(page.h.b).roots.beats.get("R2"); assert.ok(remote instanceof Y.Map);
    transactSharedDocument(page.h.b, "local-command", () => { remote.set("lengthSeconds", 9); });
    page.h.queue.deliverFrom("B", "D1");
    assert.equal(collabState(page.h.a).ingress.held.length, 1);
    stale(page);
    const before = paints;
    try { end(page, "Z"); } finally { stop(); }
    assert.ok(paints - before >= 2);
    assert.deepEqual([page.recovered, page.reports, page.text(), page.cell("R1").textContent], [["R1"], [], "abcd", "abcd"]);
    assert.deepEqual([[...collabState(page.h.a).ingress.holds], collabState(page.h.a).ingress.held.length], [[], 0]);
    assert.deepEqual(read(page.h.a).recovery.map(entry => entry.text), ["aZd"]);
    assert.equal(page.key("R1", 4, 4, "insertText", "Q"), true);
    assert.deepEqual([page.text(), page.recovered, page.reports], ["abcdQ", ["R1"], []]);
  } finally { page.close(); }
});

test("rule 38 in the Split view: a refused recovery write shows its refusal and keeps the typed text and the hold, including at unmount", () => {
  const page = recovering("abcd", false);
  try {
    compose(page, 1, 3, "Z");
    stale(page);
    end(page, "Z");
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "unhandled-kind" }]);
    assert.deepEqual([page.text(), page.cell("R1").textContent, [...collabState(page.h.a).ingress.holds]], ["abcd", "aZd", ["buffer"]]);
    assert.equal(page.buffer.dispose(), false);
    assert.deepEqual([page.cell("R1").textContent, [...collabState(page.h.a).ingress.holds], page.reports[1]],
      ["aZd", ["buffer"], { kind: "rejected", reason: "unhandled-kind" }]);
    assert.deepEqual([page.recovered, projectSharedDocumentWithRecovery(page.h.a).recovery], [[], []]);
    assert.deepEqual(page.a.session.run({ name: "must-wait", needs: "edit", plan: () => {
      assert.fail("A pending native edit must stop another command before planning");
    } }), { kind: "rejected", reason: "buffer-pending" });
    end(page, "");
    assert.deepEqual([[...collabState(page.h.a).ingress.holds], page.cell("R1").textContent], [[], "abcd"]);
  } finally { page.close(); }
});

test("rule 38, T01 in the Split view: typing over a held removal joins that beat's recovery, with no recovery write and no announcement", () => {
  const page = recovering("ab");
  try {
    registerSharedRemovalHandlers(page.h.b);
    assert.equal(page.key("R1", 2, 2, "insertText", "Z", { during: () => {
      assert.deepEqual(executeSharedOperations(page.h.b, [operation({ kind: "remove", id: "gone", by: "Bob", removalKind: "beat", targets: ["R1"],
        observed: [flowBaseReference("R1", "audioText", 0, 2)], boundaries: ["R1"], components: [], gallery: [], at: 0 })], { base: readSharedRevision(page.h.b) }), { ok: true });
      page.h.queue.deliverFrom("B", "D1");
    } }), true);
    assert.deepEqual([page.recovered, page.reports, page.root.querySelector('.row[data-id="R1"]')], [[], [], null]);
    assert.deepEqual(page.a.executed.map(command => command.operations.map(operation => operation.kind)), [["text-insert", "scalar"]]);
    copies(page, { rows: [{ id: "R2", text: "next" }], recovery: [{ id: "R1", text: "abZ", members: ["R1"] }] });
  } finally { page.close(); }
});
