import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { instanceRequest } from "../../../src/service/instance/client.ts";
import { workspace } from "../harness.ts";
import { OWNER, INVITE, checkpoint, createFixture } from "./harness.ts";
import { assertInvitation, assertSingleCreation, inspectInstance, recoverIndependently } from "./oracle.ts";

export async function rejectInstanceDefects(): Promise<void> {
  const work = await workspace();
  let source: Y.Doc | undefined;
  try {
    const server = await work.start({ INSTANCE_OWNER: OWNER });
    const first = await createFixture(server);
    source = first.source;
    const duplicate = await instanceRequest(server.port, OWNER, { action: "create", operation: "defective-retry-new-k", invite: INVITE });
    assert.throws(() => assertSingleCreation(work.path, [first.id, String(duplicate.id)]), /second instance/);
    assert.throws(() => assertInvitation(work.path, String(duplicate.id), "defective-visible-invite", String(duplicate.id)), /preceded server commit/);
    assert.throws(() => assertInvitation(work.path, first.id, "defective-visible-invite", null), /preceded local commit/);
    await checkpoint(server, first.id);
    const db = new DatabaseSync(work.path);
    const changed = new Y.Doc();
    try {
      Y.applyUpdate(changed, Y.encodeStateAsUpdate(source));
      changed.clientID = 11;
      const vector = Y.encodeStateVector(changed);
      changed.getText("R1").insert(4, "X");
      const update = Y.encodeStateAsUpdate(changed, vector);
      const sequence = Number(db.prepare("INSERT INTO updates(document, payload) VALUES (?, ?)").run(first.id, update).lastInsertRowid);
      const saved = inspectInstance(work.path, first.id).checkpoint;
      assert.ok(saved);
      db.prepare("INSERT INTO instance_checkpoints VALUES (?, ?, ?, ?)")
        .run(first.id, sequence, saved.payload, createHash("sha256").update(JSON.stringify([first.id, sequence])).update(saved.payload).digest("hex"));
      assert.throws(() => recoverIndependently(work.path, first.id, [update]), /Acknowledged insertion missing/);
      db.prepare("DELETE FROM instance_checkpoints WHERE sequence = ?").run(sequence);
      db.prepare("DELETE FROM updates WHERE document = ? AND sequence > ?").run(first.id, saved.sequence);
      assert.throws(() => recoverIndependently(work.path, first.id, [update]), /Acknowledged insertion missing/);
    } finally { changed.destroy(); db.close(); }
  } finally { source?.destroy(); await work.clean(); }
}
