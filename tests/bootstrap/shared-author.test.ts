import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedAuthorPort } from "../../src/bootstrap/wiring/ports/shared-author.ts";
import { replicas } from "../adapters/collab/executor-support.ts";
import { registerSharedOperationFamilies } from "../../src/adapters/collab/operation-families.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../src/adapters/collab/document.ts";
import { sharedStructureIdentity } from "../../src/adapters/collab/structure-identity.ts";
import { bufferedRecoveryOperations } from "../../src/core/collab/buffer-operations.ts";
import { createFlowLoadRuntime } from "../core/flow/load.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";

test("the author port answers null in a standalone session, and asking does not use up an id", () => {
  const port = sharedAuthorPort({ handle: () => null, name: () => "Ada" });
  assert.deepEqual([port.next(), port.next()], [null, null]);
});

test("in a shared session the author id is the writer prefix, the replica's client number, and a serial; by is the editor name", () => {
  const set = replicas(3);
  try {
    collabState(set.a).doc.clientID = 7; collabState(set.b).doc.clientID = 9;
    let handle: SharedDocumentHandle | null = null, name = "Ada";
    const port = sharedAuthorPort({ handle: () => handle, name: () => name });
    assert.equal(port.next(), null);
    handle = set.a;
    assert.deepEqual([port.next(), port.next()], [{ id: "w7_1", by: "Ada" }, { id: "w7_2", by: "Ada" }]);
    name = "Bo"; handle = set.b;
    assert.deepEqual(port.next(), { id: "w9_3", by: "Bo" });
    handle = null;
    assert.equal(port.next(), null);
  } finally { set.close(); }
});

test("an id from the author port is one the structure executor accepts, where an id outside letters, digits, _ and - is refused before anything is written", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    registerSharedOperationFamilies(set.a, { cells: createFlowLoadRuntime().cells });
    const port = sharedAuthorPort({ handle: () => set.a, name: () => "Ada" });
    const draft = (author: { readonly id: string; readonly by: string }) => bufferedRecoveryOperations({ owner: "R1", base: 1, html: "typed", units: 5, segment: "b:R1" },
      author, { rows: 2, visual: sharedStructureIdentity(String(collabState(set.a).doc.clientID), author.id, "visual") });
    assert.throws(() => draft({ id: "native:1", by: "Ada" }), /^Error: invalid-structure-operation-id$/);
    const author = port.next(); assert.ok(author);
    assert.deepEqual([author, executeSharedOperations(set.a, draft(author), { base: readSharedRevision(set.a) })], [{ id: "w1_1", by: "Ada" }, { ok: true }]);
  } finally { set.close(); }
});
