import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { createFlowWriter } from "../../../src/features/writer/flow-writer.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import { createPaintGuard, createUndoGuard } from "../../../src/application/editing/paint-guard.ts";
import { startRowsRender } from "../../../src/features/rows/render.ts";
import { fakeDocument, fakeFlowCommandEffects, fakeNotices, fakePictures, fakeTextServices, fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { setCellSelection } from "../../../src/features/common/cell-selection.ts";
import { replicas, operation } from "../../adapters/collab/executor-support.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";
import type { emptyScriptHistories } from "./literals.ts";

export function removedEmptyScript(name: typeof emptyScriptHistories[number], order: DeliveryOrder) {
  const two = name === "two last beats" || name === "only scene";
  const h = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, ...two ? [{ id: "R2", audioText: "cd" }] : []],
    ...name === "only scene" ? { sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] } : {} });
  for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, createFlowLoadRuntime());
  const send = (handle: SharedDocumentHandle, values: readonly unknown[]) => assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
  const remove = (id: string, beat: string, by: string) => ({ kind: "remove", id, by, removalKind: "beat", targets: [beat], boundaries: [beat],
    observed: [flowBaseReference(beat, "audioText", 0, 2)], components: [], gallery: [], at: beat === "R1" ? 0 : 1 });
  send(h.a, [remove("cutA", "R1", "Alice"), ...name === "only scene" ? [remove("cutA2", "R2", "Alice")] : []]);
  if (name === "two last beats") send(h.b, [remove("cutB", "R2", "Bob")]);
  if (name === "removal and typing") send(h.b, [{ kind: "text-insert", id: "typed", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
    at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, content: [{ value: "X", marks: [] }] }]);
  if (name === "removal and split") send(h.b, [{ kind: "split", id: "splitB", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
    at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, observed: [flowBaseReference("R1", "audioText", 0, 2)], boundary: "fresh", beat: "fresh",
    fields: { visualText: "", imageRef: null, status: "todo" } }]);
  h.queue.flush(order);
  return h;
}

export function inspectEmptyScriptViews(handle: SharedDocumentHandle, exercise?: (ui: {
  readonly session: ReturnType<typeof sharedHarness>["session"];
  readonly writer: ReturnType<typeof createFlowWriter>;
  readonly writerRoot: HTMLElement;
  readonly splitRoot: HTMLElement;
  readonly place: (mode: "writer" | "split", rowId: string, offset: number) => boolean;
}) => void) {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (value: string) => value } });
  document.body.innerHTML = '<div class="writer-bar"></div><section><div id="writer-doc" contenteditable="true"></div></section><div id="rows"></div><input id="doc-title">';
  const h = sharedHarness(adapterReplica(handle)), view = h.session.read(doc => doc); assert.ok(view);
  const root = document.getElementById("writer-doc"); assert.ok(root);
  const { effects } = fakeWriterBufferEffects(), { effects: writerEffects } = fakeFlowCommandEffects();
  const shared = sharedBufferPorts(handle, h.session, { ...effects, readers: bufferReaders, stamps: bufferStamps("Alice"), author: () => ({ id: "view", by: "Alice" }) });
  const writer = createFlowWriter({ ...writerEffects, ...shared, root, doc: () => { const current = h.session.read(doc => doc); assert.ok(current); return current; }, lifetime: h.session,
    heldSelection: createEditorSelection({ epoch: h.session.epoch, order: () => [], keys: () => null }),
    flow: createFlowLoadRuntime().ports, decode: fromHtml, storedHtml: html => html, shown: edit => edit(), editingBlocked: () => false,
    run: h.session.run, text: { cells: fromHtml, ...bufferStamps("Alice") }, wholeFieldText: { commit: () => { assert.fail("A view wrote the document"); } } });
  const doc = fakeDocument(view), paint = createPaintGuard();
  const selection = createEditorSelection<Element, Range, Element>({ epoch: () => 0, order: () => [], keys: () => [] });
  const split = startRowsRender({ document: doc.document, edits: { allowed: () => true },
    text: { ...fakeTextServices(document).text, productionReaders: bufferReaders },
    video: { card: () => document.createElement("a"), hostLabel: () => "File" },
    editing: { cells: () => ({ edit: () => null, sync: () => {} }), selection: () => selection, paint: () => paint, undo: () => createUndoGuard() },
    draft: { appendMedia: () => null, model: () => ({ cell: [], media: { markThroughout: () => false, toggleMark: () => [] } }), edit: () => null, isDraft: () => false, isScript: () => false },
    undo: { track: () => {} }, hiding: () => ({ groups: rows => rows.map((row, index) => ({ row, index })) }), scenes: () => ({ folded: () => false }),
    pictures: fakePictures().pictures, personColors: { personColor: () => "#000000" }, preferences: () => ({ clock: () => "24h" }), view: () => ({ writerOpen: () => false }),
    notices: fakeNotices().notices, actions: { invoke: id => ({ kind: "unknown", id }) }, deletes: () => ({ disarm: () => {} }), tagPanel: { setTagAddingPerson: () => {} },
    ids: { id: () => "view" }, production: { stats: () => ({ derived: 0, flushes: 0 }), resetStats: () => {}, scan: () => {}, occurrences: () => ({ html: "", hits: 0 }) } });
  try {
    writer.repaint(); assert.equal(split.renderFirstDraw(), true);
    const splitRoot = document.getElementById("rows"); assert.ok(splitRoot);
    exercise?.({ session: h.session, writer, writerRoot: root, splitRoot, place: (mode, rowId, offset) => {
      const next = h.session.read(doc => doc); assert.ok(next); doc.replace(next);
      writer.repaint(); split.renderFirstDraw();
      if (mode === "writer") { writer.caret(rowId, offset); const at = writer.selection(); return at?.head.kind === "beat" && at.head.rowId === rowId; }
      const cell = splitRoot.querySelector<HTMLElement>('.cell-editable[data-id="' + rowId + '"][data-field="audioText"]');
      if (!cell) return false;
      cell.focus(); setCellSelection(cell, offset); return true;
    } });
    return { writerBeats: root.querySelectorAll(".wr-beat").length, writerHeadings: root.querySelectorAll(".wr-heading").length,
      writerSelection: writer.selection(), splitCells: document.querySelectorAll("#rows .cell-editable").length,
      splitHeadings: document.querySelectorAll("#rows .scene-header").length,
      splitAdd: document.querySelectorAll('#rows [data-action="add-row"]').length };
  } finally { split.dispose(); writer.dispose(); h.session.dispose(); }
}
