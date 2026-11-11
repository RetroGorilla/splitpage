import assert from "node:assert/strict";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import type { DocumentShape } from "../../../src/core/document/validated.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { buildSplitpageFile } from "../../../src/adapters/formats/project-file.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision, observeSharedTransactions } from "../../../src/adapters/collab/document.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import "../../../src/test/_dom.mjs";

export function mergedProjectionSave(document: DocumentShape): string {
  const unused = (): never => { throw new Error("Unexpected project-file service"); };
  return buildSplitpageFile(buildExportDocument(migrateRows(structuredClone(document)), "2026-11-11T00:00:00Z", { production: [], commentNumbers: {}, broll: [] }), {
    migrateRows, migrateDocument: unused, sanitizeHtml: unused, tagFieldOccurrences: unused, inertBody: unused, askMarkdownRows: unused
  });
}

export function readPureMergedProjection(handle: SharedDocumentHandle) {
  const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
  let transactions = 0, updates = 0;
  const detach = observeSharedTransactions(handle, () => { transactions++; });
  const update = () => { updates++; };
  collabState(handle).doc.on("update", update);
  try {
    const view = projectSharedDocumentWithRecovery(handle);
    assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector);
    assert.equal(readSharedRevision(handle), revision); assert.equal(transactions, 0); assert.equal(updates, 0);
    return { view, save: mergedProjectionSave(view.document) };
  } finally { detach(); collabState(handle).doc.off("update", update); }
}

export function literalMergedDocument(audioText: string): DocumentShape {
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000",
    rows: [{ id: "R1", status: "todo", visualText: "", audioText, imageRef: null, updatedAt: "", updatedBy: null }],
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 };
}
