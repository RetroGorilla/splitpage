import * as Y from "yjs";
import { beforeEach } from "node:test";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { applySharedUpdate, observeSharedUpdates, shouldDeliverSharedUpdate, createSharedDocument as createAdapterDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import type { DeliveryReplica } from "../../collab/delivery.ts";
import { formattingLibraryControl, formattingLibraryControls } from "./formatting-controls.ts";
import { readSharedMarkRecord } from "../../../src/adapters/collab/mark-record.ts";

let currentTestName = "";
beforeEach(context => { currentTestName = context.name; });

export function validatedFixture(value: Record<string, unknown>): ValidatedDocument {
  return migrateRows({ schema: 2, docId: "d00000000000000000000000000000000", ...value }, fakeMigration().ports);
}

export function storedValue(value: unknown): unknown {
  if (value instanceof Y.Text) return storedValue(value.toDelta());
  if (value instanceof Y.Map) return Object.fromEntries([...value.keys()].sort().map(key => {
    const entry: unknown = value.get(key), text: unknown = value.get(key === "titleMarks" ? "title" : "text");
    return [key, (key === "markRecords" || key === "titleMarks") && entry instanceof Y.Map && text instanceof Y.Text ? storedMarks(entry, text) : storedValue(entry)];
  }));
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value) || value instanceof Y.Array) {
    const items: unknown[] = value instanceof Y.Array ? value.toArray() : value as unknown[];
    const result: unknown[] = [];
    for (let index = 0; index < items.length; index++) result.push(storedValue(items[index]));
    return result;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, storedValue(record[key])]));
  }
  return "invalid-stored-value";
}

export function readRoots(handle: SharedDocumentHandle): unknown {
  return Object.fromEntries(Object.entries(collabState(handle).roots).map(([key, value]) => [key, storedValue(value)]));
}

export function deliveryReplica(handle: SharedDocumentHandle): DeliveryReplica<Uint8Array> {
  let receiving = 0;
  const generated: (() => void)[] = [];
  return {
    onLocalUpdate: listener => observeSharedUpdates(handle, (update, origin) => {
      if (!shouldDeliverSharedUpdate(origin)) return;
      if (receiving) generated.push(() => listener(update));
      else listener(update);
    }),
    apply: update => {
      receiving++;
      try { if (!applySharedUpdate(handle, update).ok) throw new Error("Queue delivered an invalid update"); }
      finally { receiving--; }
    },
    afterDelivery: () => { for (const publish of generated.splice(0)) publish(); }
  };
}

export function monitorSharedFormatting(handle: SharedDocumentHandle): () => void {
  return monitorNativeFormatting(collabState(handle).doc);
}

function monitorNativeFormatting(doc: Y.Doc): () => void {
  const check = (update: Uint8Array): void => {
    if (Y.decodeUpdate(update).structs.some(item => item instanceof Y.Item && item.content instanceof Y.ContentFormat)) throw new Error("Shared text created a formatting item");
  };
  check(Y.encodeStateAsUpdate(doc));
  const observe = (transaction: Y.Transaction): void => check(Y.encodeStateAsUpdate(doc, Y.encodeStateVector(transaction.beforeState)));
  doc.on("beforeObserverCalls", observe);
  return () => doc.off("beforeObserverCalls", observe);
}

export function createMonitoredSharedDocument(): SharedDocumentHandle {
  const handle = createAdapterDocument();
  monitorSharedFormatting(handle);
  return handle;
}

function requireLibraryControl(): void {
  if (!formattingLibraryControls.some(name => formattingLibraryControl(name) === currentTestName)) throw new Error("Native formatting is allowed only in a named library control");
}
export function createLibraryControlDocument(): SharedDocumentHandle { requireLibraryControl(); return createAdapterDocument(); }
export function createMonitoredNativeDocument(options?: ConstructorParameters<typeof Y.Doc>[0]): Y.Doc {
  const doc = new Y.Doc(options); monitorNativeFormatting(doc); return doc;
}
export function createLibraryControlNativeDocument(options?: ConstructorParameters<typeof Y.Doc>[0]): Y.Doc { requireLibraryControl(); return new Y.Doc(options); }

function storedMarks(store: Y.Map<unknown>, text: Y.Text): unknown[] {
  const result: unknown[] = [];
  const position = (anchor: string): number | "gone" => {
    const value = JSON.parse(anchor) as { relative: number[] };
    const absolute = text.doc && Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Uint8Array.from(value.relative)), text.doc);
    return absolute && absolute.type === text ? absolute.index : "gone";
  };
  for (const key of [...store.keys()].sort()) {
    const record = readSharedMarkRecord(key, store.get(key));
    if (!record) continue;
    const start = position(record.start), end = position(record.end);
    result.push(record.type === "add" ? { type: record.type, operation: record.operation, writer: record.writer, start, end, mark: record.mark, born: record.born }
      : record.type === "remove" ? { type: record.type, operation: record.operation, writer: record.writer, start, end, observed: record.observed }
      : { type: record.type, operation: record.operation, writer: record.writer, start, end, observed: record.observed, born: record.born });
  }
  return result;
}
