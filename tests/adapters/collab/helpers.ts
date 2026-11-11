import * as Y from "yjs";
import type { SharedDocumentHandle, SharedTransactionOrigin } from "../../../src/adapters/collab/types.ts";
import { applySharedUpdate, shouldDeliverSharedUpdate, createSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import type { DeliveryReplica } from "../../collab/delivery.ts";

export function validatedFixture(value: Record<string, unknown>): ValidatedDocument {
  return migrateRows({ schema: 2, docId: "d00000000000000000000000000000000", ...value }, fakeMigration().ports);
}

export function storedValue(value: unknown): unknown {
  if (value instanceof Y.Text) return storedValue(value.toDelta());
  if (value instanceof Y.Map) return Object.fromEntries([...value.keys()].sort().map(key => [key, storedValue(value.get(key))]));
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
  const { doc } = collabState(handle);
  let receiving = false;
  const generated: (() => void)[] = [];
  return {
    onLocalUpdate: listener => {
      const receive = (update: Uint8Array, origin: SharedTransactionOrigin | null): void => {
        if (!shouldDeliverSharedUpdate(origin)) return;
        if (receiving) generated.push(() => listener(update));
        else listener(update);
      };
      doc.on("update", receive);
      return () => doc.off("update", receive);
    },
    apply: update => {
      receiving = true;
      try { if (!applySharedUpdate(handle, update).ok) throw new Error("Queue delivered an invalid update"); }
      finally { receiving = false; }
    },
    afterDelivery: () => { for (const publish of generated.splice(0)) publish(); }
  };
}

export function monitorSharedFormatting(handle: SharedDocumentHandle): () => void {
  const { doc } = collabState(handle);
  const check = (update: Uint8Array): void => {
    if (Y.decodeUpdate(update).structs.some(item => item instanceof Y.Item && item.content instanceof Y.ContentFormat)) throw new Error("Shared text created a formatting item");
  };
  check(Y.encodeStateAsUpdate(doc));
  const observe = (transaction: Y.Transaction): void => check(Y.encodeStateAsUpdate(doc, Y.encodeStateVector(transaction.beforeState)));
  doc.on("beforeObserverCalls", observe);
  return () => doc.off("beforeObserverCalls", observe);
}

export function createMonitoredSharedDocument(): SharedDocumentHandle {
  const handle = createSharedDocument();
  monitorSharedFormatting(handle);
  return handle;
}
