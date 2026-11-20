import assert from "node:assert/strict";
import * as Y from "yjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { convertedScript } from "./helpers.ts";
import { noticeDeliver } from "./notice-harness.ts";
import type { noticeCopy } from "./notice-harness.ts";
import { structureScript } from "./structure-harness.ts";

type Copy = ReturnType<typeof noticeCopy>;

export function compoundSeed(narration: Record<string, string>, visual: Record<string, string> = {}): Uint8Array {
  const seed = convertedScript(structureScript(narration, visual));
  try { return Y.encodeStateAsUpdate(seed.doc); }
  finally { seed.doc.destroy(); }
}

export function settleCompound(first: Copy, second: Copy, expected: readonly string[]): void {
  noticeDeliver(first, second);
  noticeDeliver(second, first);
  const document = first.document();
  assert.deepEqual(second.document(), document);
  assert.deepEqual(document.rows.map(row => row.audioText ?? ""), expected, "issued narration");
  assert.deepEqual(migrateRows(structuredClone(document)), {
    ...document,
    rows: document.rows.map(row => ({
      imageRef: null, status: "todo", updatedAt: "", updatedBy: null, ...row,
      id: row.id === "~stray" ? "stray" : row.id
    }))
  });
}
