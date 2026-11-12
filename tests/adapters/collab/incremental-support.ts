import assert from "node:assert/strict";
import * as Y from "yjs";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import type { SharedIncrementalProjection, SharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { projectSharedDocumentStep } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { expectedProjectionChanges } from "../../collab/projection-changes-oracle.ts";
import type { DocumentShape } from "../../../src/core/document/validated.ts";

const seen = new WeakMap<SharedIncrementalProjector, { step: SharedIncrementalProjection; full: DocumentShape }>();

export const incrementalReports = { compared: 0 };

export function assertIncremental(handle: SharedDocumentHandle, projector: SharedIncrementalProjector): void {
  const step = projector.read(), { document, recovery, revision } = step;
  assert.equal(revision, readSharedRevision(handle));
  const previous = seen.get(projector), fresh = projectSharedDocumentStep(handle, previous?.full ?? null);
  assertReplicasAgree("incremental and fresh full projection", [
    { order: "D1", replica: "A", output: { document, recovery } },
    { order: "late-C", replica: "C", output: { document: fresh.document, recovery: fresh.recovery } }
  ]);
  if (previous && previous.step !== step && revision === previous.step.revision + 1) {
    assertReplicasAgree("incremental report, fresh full comparison and slow comparison", [
      { order: "D1", replica: "A", output: step.changes },
      { order: "late-C", replica: "C", output: fresh.changes },
      { order: "D2", replica: "B", output: expectedProjectionChanges(previous.full, fresh.document) }
    ]);
    incrementalReports.compared++;
  }
  seen.set(projector, { step, full: fresh.document });
}

export function nativeMap(handle: SharedDocumentHandle, collection: "beats" | "segments" | "headings" | "visuals", key: string): Y.Map<unknown> {
  const value = collabState(handle).roots[collection].get(key); assert.ok(value instanceof Y.Map); return value;
}

export function nativeText(handle: SharedDocumentHandle, segment: string): Y.Text {
  const text = nativeMap(handle, "segments", segment).get("text"); assert.ok(text instanceof Y.Text); return text;
}

export function captureIncrementalReplica(handle: SharedDocumentHandle, count?: Parameters<typeof createSharedIncrementalProjector>[1]) {
  const descriptor = Object.getOwnPropertyDescriptor(Y.Doc.prototype, "get"); assert.ok(descriptor);
  const docs = new Set<Y.Doc>(), source = collabState(handle).doc;
  Object.defineProperty(Y.Doc.prototype, "get", { ...descriptor, value: function (this: Y.Doc, ...args: unknown[]) {
    if (this !== source) docs.add(this);
    return Reflect.apply(descriptor.value as (...args: unknown[]) => unknown, this, args);
  } });
  try {
    const projector = createSharedIncrementalProjector(handle, count);
    assert.equal(docs.size, 1);
    return { projector, docs: [...docs] };
  } finally { Object.defineProperty(Y.Doc.prototype, "get", descriptor); }
}
