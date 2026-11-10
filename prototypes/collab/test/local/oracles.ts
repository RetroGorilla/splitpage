import * as Y from "yjs";
import { checkModel, IdentityBook } from "../../src/model.ts";
import type { ScriptOracle } from "../../src/model.ts";
import { readReplica } from "../../src/reader.ts";
import { SchemaReplica } from "../../src/schema.ts";

export interface LocalBrowserSnapshot {
  writable: boolean;
  explanation: string;
  status: string;
  sequence: number;
  saved: number[];
  errors: string[];
  editor: number[];
  network: number[];
  manifest: string[];
  probe: { opened: number; completed: number; aborted: number; durability: string[]; errors: string[] } | null;
  synced: boolean | null;
  largeSize: number;
}

export interface LocalHydrationObservation {
  entered: string;
  during: LocalBrowserSnapshot;
  editRefused: boolean;
}

export function checkLocalHydrationRefusal(observation: LocalHydrationObservation): void {
  if (observation.during.writable || !observation.editRefused) throw new Error("Editing allowed before hydration completed");
}

export const localLiteralOracles: ScriptOracle[] = [
  { rows: [{ id: "R1", characters: [["s1", "a", {}]] }], carets: {}, recovery: [] },
  { rows: [{ id: "R1", characters: [["s1", "a", {}], ["a1", "b", {}]] }], carets: {}, recovery: [] },
  { rows: [{ id: "R1", characters: [["s1", "a", {}], ["a1", "b", {}], ["a2", "c", {}]] }], carets: {}, recovery: [] },
  { rows: [{ id: "R1", characters: [["s1", "a", {}], ["a2", "c", {}]] }], carets: {}, recovery: [] }
];

export function localFixture(): { updates: number[][]; identities: IdentityBook } {
  const identities = new IdentityBook();
  const replica = new SchemaReplica("A", 10, identities);
  replica.seed([{ id: "R1", text: "a" }]);
  const updates = [[...Y.encodeStateAsUpdate(replica.doc)]];
  replica.doc.clientID = 1;
  replica.insert("R1", 1, "b", ["a1"]);
  updates.push([...Y.encodeStateAsUpdate(replica.doc)]);
  replica.insert("R1", 2, "c", ["a2"]);
  updates.push([...Y.encodeStateAsUpdate(replica.doc)]);
  replica.deleteIdentities(["a1"]);
  updates.push([...Y.encodeStateAsUpdate(replica.doc)]);
  replica.doc.destroy();
  return { updates, identities };
}

export function checkLocalBytes(bytes: number[], sequence: number): void {
  const oracle = localLiteralOracles[sequence - 1];
  if (!oracle) throw new Error(`Unknown harness sequence ${sequence}`);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Uint8Array.from(bytes));
    const { identities } = localFixture();
    checkModel(readReplica(doc, "A", identities), oracle, identities, `local sequence ${sequence}`);
  } finally { doc.destroy(); }
}

export function checkLocalReceipts(receipts: readonly number[], recovered: LocalBrowserSnapshot): void {
  for (const receipt of receipts) {
    if (receipt > recovered.sequence) throw new Error(`Saved ${receipt}, recovered only ${recovered.sequence}`);
  }
  checkLocalBytes(recovered.editor, recovered.sequence);
  checkLocalBytes(recovered.network, recovered.sequence);
}
