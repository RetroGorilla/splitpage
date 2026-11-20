import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import * as Y from "yjs";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import type { NativeLocalStoreOpen } from "../../../../src/adapters/collab/native/local-store.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { cells } from "./helpers.ts";
import { idbResult } from "./indexeddb-fixture.ts";
import { structureScript } from "./structure-harness.ts";

globalThis.IDBKeyRange = IDBKeyRange;

export const DB_NAME = "splitpage-native-replica-log";
export const REPLICAS = "replicas";
export const STORE_OPTIONS = { actor: "Editor", sanitize: String };
export const STORED = { kind: "stored" };
export const stored = (generation: number) => ({ kind: "stored", generation });
export type OpenReplica = Extract<NativeLocalStoreOpen, { kind: "opened" }>;
export type StoreSession = OpenReplica["session"];

export function fixture() {
  const factory = new IDBFactory();
  return { factory, store: createBrowserNativeLocalStore({ indexedDB: factory, locks: navigator.locks }) };
}

export function seedSession(rows: Record<string, string>) {
  return openNativeSession({
    kind: "document", document: structureScript(rows), conversion: { cells, creation: "seed", at: "2026-01-01", by: "Editor" }
  }, STORE_OPTIONS);
}

export function seedReplica(session: StoreSession, rows = { A: "start" }): void {
  const source = seedSession(rows);
  try { Y.applyUpdate(session.ydoc, source.encodeState(), "initial copy"); }
  finally { source.close(); }
}

export function typeAt(session: StoreSession, offset: number, text: string, beat = "A"): void {
  const anchored = session.commands.anchorText({ beat, cell: "narration" }, offset);
  assert.equal(anchored.kind, "anchored");
  assert.deepEqual(session.commands.typeText(anchored.range, text, {}), { kind: "written" });
}

export async function storedBytes(factory: IDBFactory, name: string): Promise<Uint8Array | undefined> {
  const entries = await storedEntries(factory, name);
  if (entries.length === 0) return;
  const doc = new Y.Doc();
  try {
    doc.transact(() => { for (const entry of entries) Y.applyUpdate(doc, entry.bytes); });
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}

export interface TestReplicaEntry {
  readonly generation: number;
  readonly bytes: Uint8Array;
  readonly checkpoint: boolean;
}

export async function storedEntries(factory: IDBFactory, name: string): Promise<TestReplicaEntry[]> {
  const connection = await idbResult(factory.open(DB_NAME));
  try {
    const range = IDBKeyRange.bound([name, 0], [name, Number.MAX_SAFE_INTEGER]);
    return await idbResult(connection.transaction(REPLICAS).objectStore(REPLICAS).getAll(range)) as TestReplicaEntry[];
  } finally { connection.close(); }
}
