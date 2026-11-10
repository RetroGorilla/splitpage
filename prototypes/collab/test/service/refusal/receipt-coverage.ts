import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { OutgoingMessage } from "@hocuspocus/server";
import * as Y from "yjs";
import { ConnectionReceipts } from "../../../src/service/receipts.ts";
import { fixture } from "../harness.ts";
import { frame } from "./harness.ts";

export async function observeRefusedCoverage(t: TestContext): Promise<void> {
  for (const change of ["insertion", "deletion"] as const) {
    await t.test(`temporary ${change} refusal clears only after its own insertion/deletion coverage is acknowledged`, () => {
      const document = fixture();
      const tracker = new ConnectionReceipts();
      const lifetime = tracker.open();
      const initial = Y.encodeStateAsUpdate(document);
      const applied = new OutgoingMessage("fixture").writeSyncStatus(true).toUint8Array();
      const refused = new OutgoingMessage("fixture").writeSyncStatus(false).toUint8Array();
      try {
        tracker.sent(lifetime, frame(1, initial)); tracker.received(lifetime, applied);
        const vector = Y.encodeStateVector(document);
        if (change === "insertion") document.getText("R1").insert(4, "e");
        else document.getText("R1").delete(1, 1);
        const update = Y.encodeStateAsUpdate(document, vector);
        tracker.localUpdate(update);
        tracker.sent(lifetime, frame(2, update)); tracker.received(lifetime, refused);
        assert.equal(tracker.outstanding, 0);
        assert.equal(tracker.status, "Saved on this device, sending");
        tracker.sent(lifetime, frame(1, initial)); tracker.received(lifetime, applied);
        assert.equal(tracker.outstanding, 0);
        assert.equal(tracker.status, "Saved on this device, sending", "An unrelated positive receipt cannot cover refused work");
        tracker.sent(lifetime, frame(1, Y.encodeStateAsUpdate(document)));
        assert.equal(tracker.outstanding, 1);
        assert.equal(tracker.status, "Saved on this device, sending");
        tracker.received(lifetime, applied);
        assert.equal(tracker.outstanding, 0);
        assert.equal(tracker.status, "Your changes saved to server");
      } finally { document.destroy(); }
    });
  }
}
