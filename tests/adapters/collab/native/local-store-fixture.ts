import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import * as Y from "yjs";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import type { NativeLocalStoreOpen } from "../../../../src/adapters/collab/native/local-store.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { cells } from "./helpers.ts";
import { idbResult } from "./indexeddb-fixture.ts";
import { structureScript } from "./structure-harness.ts";

export const DB_NAME = "splitpage-native-replicas";
export const REPLICAS = "replicas";
export const STORE_OPTIONS = { actor: "Editor", sanitize: String };
export const STORED = { kind: "stored" };
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
  const connection = await idbResult(factory.open(DB_NAME));
  try {
    const value: unknown = await idbResult(connection.transaction(REPLICAS).objectStore(REPLICAS).get(name));
    assert.ok(value === undefined || value instanceof Uint8Array);
    return value;
  } finally { connection.close(); }
}
