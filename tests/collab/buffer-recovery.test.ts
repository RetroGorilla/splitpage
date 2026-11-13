import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
import { operation } from "../adapters/collab/executor-support.ts";
import { adapterReplica, registerSplits, sharedHarness } from "../application/session/shared-session-support.ts";
import type { SharedHarnessHooks } from "../application/session/shared-session-support.ts";
import { createSharedBufferedText } from "../../src/adapters/collab/buffer.ts";
import { bufferReaders, bufferStamps } from "./buffer-readers.ts";
import { readSharedPaintedText } from "../../src/adapters/collab/paint-base.ts";
import { executeSharedOperations } from "../../src/adapters/collab/execute.ts";
import { registerSharedRemovalHandlers } from "../../src/adapters/collab/removal-executor.ts";
import { encodeSharedState, encodeSharedStateVector, observeSharedTransactions, observeSharedUpdates, readSharedRevision, transactSharedDocument } from "../../src/adapters/collab/document.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { projectSharedDocumentWithRecovery } from "../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../src/core/collab/base-reference.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import type { Run } from "../../src/core/text/runs.ts";
import type { SharedTextAddress } from "../../src/core/collab/operations.ts";
import { assertReplicasAgree } from "./agreement.ts";

const BEAT = "structure_1_007200310037_beat_0", VISUAL = "structure_1_007200310037_visual_0", SPLIT = "structure_1_006300750074_beat_0";
const typed: readonly Run[] = [{ text: "aZd", marks: {} }];

function editing(h: Stage1ExecutorHarness, options: { handlers?: boolean; author?: (serial: number) => string; hooks?: SharedHarnessHooks;
  before?: () => { readonly row: string; readonly target: SharedTextAddress } } = {}) {
  for (let revision = readSharedRevision(h.a); revision < 7; revision++) {
    transactSharedDocument(h.a, "local-command", () => collabState(h.a).roots.meta.set("seed" + revision, true));
  }
  h.queue.flush("D1");
  if (options.handlers !== false) { registerSplits(h.a); registerSharedRemovalHandlers(h.a); }
  const opened = options.before?.() ?? { row: "R1", target: h.target("R1") };
  const session = sharedHarness(adapterReplica(h.a), options.hooks);
  let serial = 0;
  const port = createSharedBufferedText(h.a, session.session, { target: id => id === opened.row ? opened.target : h.target(id),
    author: () => { const next = ++serial; return { id: options.author?.(next) ?? "r" + (15 + next), by: "Alice" }; }, readers: bufferReaders,
    stamps: bufferStamps("Alice") });
  const painted = readSharedPaintedText(h.a, opened.target); assert.ok(painted);
  const edit = port.open(opened.row, painted); assert.ok(edit);
  return { ...session, edit, port, painted };
}

function stale(h: Stage1ExecutorHarness, writes = 2): void {
  for (let index = 0; index < writes; index++) transactSharedDocument(h.a, "local-command", () => collabState(h.a).roots.meta.set("probe" + index, true));
}

function read(handle: SharedDocumentHandle) {
  const value = projectSharedDocumentWithRecovery(handle);
  return { rows: value.document.rows.map(row => ({ id: row.id, text: row.audioText })), recovery: value.recovery.map(entry => {
    assert.equal(entry.kind, "removed-beat"); if (entry.kind !== "removed-beat") throw new Error("Unexpected recovery entry");
    return { id: entry.row.id, text: entry.row.audioText, members: entry.members, ...(Object.hasOwn(entry, "buffer") ? { buffer: entry.buffer } : {}) };
  }) };
}

function agree(h: Stage1ExecutorHarness, order: "D1" | "rev" | "dup" | "late-C", expected: ReturnType<typeof read>): void {
  h.queue.flush(order); h.join();
  assertReplicasAgree("buffer recovery", [{ order: "D2", replica: "A", output: expected }, ...[h.a, h.b, h.c].map((handle, index) => ({
    order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order,
    replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const, output: read(handle) }))]);
}

for (const order of ["D1", "rev", "dup", "late-C"] as const) {
  test(`rule 29 literal: a commit refused on a stale base is written to recovery as one create-and-remove list, ${order}`, () => {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]), a = editing(h);
    try {
      a.edit.replace(1, 3, "Z");
      assert.equal(a.edit.recover(typed), null);
      stale(h);
      assert.deepEqual([a.painted.revision, readSharedRevision(h.a)], [7, 9]);
      assert.deepEqual(a.edit.commit(typed), { kind: "rejected", reason: "stale-base" });
      const undone = a.undo.length, generation = a.session.generation();
      let transactions = 0, updates = 0;
      const stop = observeSharedTransactions(h.a, () => { transactions++; }), detach = observeSharedUpdates(h.a, () => { updates++; });
      let outcome: ReturnType<typeof a.edit.recover>;
      try { outcome = a.edit.recover(typed); } finally { stop(); detach(); }
      assert.equal(outcome?.kind, "applied");
      assert.deepEqual([transactions, updates], [1, 1]);
      assert.deepEqual(a.executed.at(-1), { base: 9, operations: [
        { kind: "segment-create", id: "r17", by: "Alice", segment: "draft_segment_r17", beat: "draft_r17",
          at: { left: "b:R1", right: null, affinity: "after" }, fields: { audioText: "aZd", bufferSourceOwner: "R1", bufferPaintedBase: 7 } },
        { kind: "remove", id: "r17_remove", by: "Alice", removalKind: "beat", targets: ["draft_r17"], observed: ['["flow-base","draft_r17","audioText",0,3]'],
          boundaries: ["draft_r17"], components: [VISUAL], gallery: [], comments: [], at: 2 }
      ] });
      assert.deepEqual([a.undo.length, a.session.generation(), a.log.slice(-6)], [undone, generation + 1,
        ["execute", "project", "dirty:" + (generation + 1), "draft:" + (generation + 1), "save:" + (generation + 1), "publish:edit"]]);
      assert.deepEqual([a.edit.isOpen(), [...collabState(h.a).ingress.holds]], [false, []]);
      assert.equal(a.edit.recover(typed), null);
      agree(h, order, { rows: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], recovery: [{
        id: BEAT, text: "aZd", members: [BEAT], buffer: [{ beat: BEAT, metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 7 } }] }] });
    } finally { a.session.dispose(); h.destroy(); }
  });
}

test("rule 29 is reached only by a list the document refused: closed, in-delivery and unadmitted commits leave nothing to recover", () => {
  let asked = 0;
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]), a = editing(h, { hooks: { asked: () => { asked++; } } });
  try {
    a.edit.replace(1, 3, "Z");
    const during: unknown[] = [];
    const stop = observeSharedTransactions(h.a, () => { during.push(a.edit.commit(typed), a.edit.recover(typed)); });
    transactSharedDocument(h.a, "local-command", () => {}); stop();
    assert.deepEqual(during, [{ kind: "rejected", reason: "buffer-delivery" }, null]);
    a.deny("read-only");
    assert.deepEqual([a.edit.commit(typed), a.edit.recover(typed), asked, a.executed.length], [{ kind: "rejected", reason: "read-only" }, null, 1, 0]);
    a.deny(null);
    assert.equal(a.edit.commit(typed).kind, "applied");
    assert.deepEqual([a.edit.recover(typed), a.edit.isOpen(), a.executed.length], [null, false, 1]);
    agree(h, "dup", { rows: [{ id: "R1", text: "aZd" }, { id: "R2", text: "ef" }], recovery: [] });
  } finally { a.session.dispose(); h.destroy(); }
});

test("rule 29: a refused recovery write changes nothing and keeps the edit and its hold; a later attempt can succeed", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]), a = editing(h, { handlers: false, author: serial => serial === 2 ? "r:17" : "r" + (14 + serial) });
  try {
    a.edit.replace(1, 3, "Z"); stale(h);
    assert.deepEqual(a.edit.commit(typed), { kind: "rejected", reason: "stale-base" });
    const bytes = encodeSharedState(h.a), vector = encodeSharedStateVector(h.a), executed = a.executed.length;
    assert.deepEqual(a.edit.recover(typed), { kind: "rejected", reason: "invalid-structure-operation-id" });
    assert.equal(a.executed.length, executed);
    assert.deepEqual(a.edit.recover(typed), { kind: "rejected", reason: "unhandled-kind" });
    a.deny("read-only");
    assert.deepEqual(a.edit.recover(typed), { kind: "rejected", reason: "read-only" });
    a.deny(null);
    assert.deepEqual([encodeSharedState(h.a), encodeSharedStateVector(h.a), readSharedRevision(h.a)], [bytes, vector, 9]);
    assert.deepEqual([a.edit.isOpen(), a.edit.text(), [...collabState(h.a).ingress.holds]], [true, "aZd", ["buffer"]]);
    registerSplits(h.a); registerSharedRemovalHandlers(h.a);
    assert.equal(a.edit.recover(typed)?.kind, "applied");
    agree(h, "dup", { rows: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], recovery: [{
      id: "structure_1_007200310039_beat_0", text: "aZd", members: ["structure_1_007200310039_beat_0"],
      buffer: [{ beat: "structure_1_007200310039_beat_0", metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 7 } }] }] });
  } finally { a.session.dispose(); h.destroy(); }
});

test("rule 29: a document adopted underneath the edit sends its field to recovery in the adopted document", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]), a = editing(h);
  try {
    a.edit.replace(1, 3, "Z");
    const epoch = a.session.epoch();
    transactSharedDocument(h.a, "hydration", () => collabState(h.a).roots.meta.set("adopted", true));
    assert.equal(a.session.epoch(), epoch + 1);
    assert.deepEqual(a.edit.commit(typed), { kind: "rejected", reason: "buffer-epoch" });
    assert.equal(a.executed.length, 0);
    assert.equal(a.edit.recover(typed)?.kind, "applied");
    assert.deepEqual([a.edit.isOpen(), [...collabState(h.a).ingress.holds]], [false, []]);
    agree(h, "dup", { rows: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], recovery: [{
      id: "structure_1_007200310036_beat_0", text: "aZd", members: ["structure_1_007200310036_beat_0"],
      buffer: [{ beat: "structure_1_007200310036_beat_0", metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 7 } }] }] });
  } finally { a.session.dispose(); h.destroy(); }
});

for (const [name, runs, html] of [
  ["an emptied field", [], ""],
  ["formatted text with a speaker marker", [{ text: "a", marks: {} }, { text: "Z", marks: { b: true } }, { atom: "who", name: "Ann", text: "@Ann", marks: {} }, { text: "d", marks: { i: true } }],
    'a<strong>Z</strong><span class="who-anchor" data-who="Ann" contenteditable="false">@Ann</span><em>d</em>']
] as const) {
  test(`rule 29: the recovery entry keeps the whole native field: ${name}`, () => {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]), a = editing(h);
    try {
      if (runs.length) { a.edit.replace(1, 3, "Z"); a.edit.replace(2, 2, "￼"); } else a.edit.replace(0, 4, "");
      stale(h);
      assert.deepEqual(a.edit.commit(runs), { kind: "rejected", reason: "stale-base" });
      assert.equal(a.edit.recover(runs)?.kind, "applied");
      const sent = a.executed.at(-1)?.operations[1];
      assert.deepEqual(sent?.kind === "remove" && sent.observed, runs.length ? ['["flow-base","draft_r17","audioText",0,4]'] : []);
      agree(h, "dup", { rows: [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }], recovery: [{
        id: BEAT, text: html, members: [BEAT], buffer: [{ beat: BEAT, metadata: { bufferSourceOwner: "R1", bufferPaintedBase: 7 } }] }] });
    } finally { a.session.dispose(); h.destroy(); }
  });
}

for (const order of ["D1", "rev", "dup", "late-C"] as const) {
  test(`T01 with the removal command: typing committed before a held removal joins that beat's recovery and adds no entry of its own, ${order}`, () => {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]), a = editing(h);
    try {
      registerSharedRemovalHandlers(h.b);
      a.edit.replace(1, 3, "Z");
      assert.deepEqual(executeSharedOperations(h.b, [operation({ kind: "remove", id: "gone", by: "Bob", removalKind: "beat", targets: ["R1"],
        observed: [flowBaseReference("R1", "audioText", 0, 4)], boundaries: ["R1"], components: [], gallery: [], at: 0 })], { base: readSharedRevision(h.b) }), { ok: true });
      h.queue.deliverFrom("B", order);
      assert.equal(readSharedRevision(h.a), 7);
      assert.equal(a.edit.commit(typed).kind, "applied");
      assert.equal(a.edit.recover(typed), null);
      agree(h, order, { rows: [{ id: "R2", text: "ef" }], recovery: [{ id: "R1", text: "aZd", members: ["R1"] }] });
    } finally { a.session.dispose(); h.destroy(); }
  });

  test(`T01 in a split-off beat: typing committed before a held removal of its source joins the split-off beat's recovery, ${order}`, () => {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]);
    const a = editing(h, { before: () => {
      assert.deepEqual(executeSharedOperations(h.a, [operation({ kind: "split", id: "cut", by: "Alice", target: h.target("R1"),
        at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" }, observed: [], boundary: "Rb", beat: "Rb", fields: {} })], { base: readSharedRevision(h.a) }), { ok: true });
      return { row: SPLIT, target: { ...h.target("R1"), owner: SPLIT as SharedTextAddress["owner"] } };
    } });
    try {
      registerSharedRemovalHandlers(h.b);
      a.edit.replace(1, 1, "Z");
      assert.deepEqual(executeSharedOperations(h.b, [operation({ kind: "remove", id: "gone", by: "Bob", removalKind: "beat", targets: ["R1"],
        observed: [flowBaseReference("R1", "audioText", 0, 4)], boundaries: ["R1"], components: [], gallery: [], at: 0 })], { base: readSharedRevision(h.b) }), { ok: true });
      h.queue.deliverFrom("B", order);
      assert.equal(readSharedRevision(h.a), 8);
      assert.equal(a.edit.commit([{ text: "cZd", marks: {} }]).kind, "applied");
      agree(h, order, { rows: [{ id: "R2", text: "ef" }], recovery: [{ id: "R1", text: "ab", members: ["R1"] }, { id: SPLIT, text: "cZd", members: [SPLIT] }] });
    } finally { a.session.dispose(); h.destroy(); }
  });
}
