import assert from "node:assert/strict";
import test from "node:test";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { applyNativePeerUpdate } from "../../../../src/adapters/collab/native/peer-update.ts";
import { nativeCallbackGuard } from "../../../../src/adapters/collab/native/script.ts";
import { cells } from "./helpers.ts";
import { AT } from "./record-harness.ts";
import { structureScript } from "./structure-harness.ts";

const actor = "Editor";
const options = { actor, sanitize: (html: unknown) => String(html) };
const target = { beat: "A", cell: "narration" } as const;

function append(session: ReturnType<typeof openNativeSession>, offset: number, text: string) {
  const anchor = session.commands.anchorText(target, offset);
  assert.equal(anchor.kind, "anchored");
  return session.commands.typeText(anchor.range, text, {});
}

test("guarded transaction and session listeners deliver complete writes after a listener throws", async t => {
  const local = openNativeSession({
    kind: "document", document: structureScript({ A: "a", B: "b" }),
    conversion: { cells, creation: "seed", at: AT, by: actor }
  }, options);
  t.after(local.close);
  const peer = openNativeSession({ kind: "state", state: local.encodeState() }, options);
  t.after(peer.close);
  const failure = new Error("transaction listener");
  const guard = nativeCallbackGuard(local.ydoc);
  local.ydoc.once("afterTransactionCleanup", () => guard(() => { throw failure; }));

  const updates: Uint8Array[] = [], publications: string[][] = [];
  local.ydoc.on("update", (update: Uint8Array) => { updates.push(update); });
  local.subscribe(() => { throw new Error("session subscriber"); });
  local.subscribe(event => {
    if (event.kind === "changed") publications.push(local.document().rows.map(row => row.audioText ?? ""));
  });

  assert.equal(append(local, 1, "x").kind, "written");
  await Promise.resolve();
  assert.equal(updates.length, 1);
  assert.deepEqual(publications, [["ax", "b"]]);
  const first = updates[0];
  assert.ok(first);
  assert.equal(applyNativePeerUpdate(peer, first), true);
  assert.deepEqual(local.document(), peer.document());

  assert.throws(() => append(local, 2, "y"), error => error === failure);
  await Promise.resolve();
  assert.equal(updates.length, 1);
  assert.deepEqual(publications, [["ax", "b"]]);
  assert.equal(append(local, 2, "y").kind, "written");
  await Promise.resolve();
  assert.equal(updates.length, 2);
  assert.deepEqual(publications, [["ax", "b"], ["axy", "b"]]);
  const second = updates[1];
  assert.ok(second);
  assert.equal(applyNativePeerUpdate(peer, second), true);
  assert.deepEqual(local.document(), peer.document());
});
