import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import type { FileDelivery } from "../../../src/application/files/file-delivery.ts";
import { useDesktopForTest, restoreDesktop } from "../../../src/adapters/desktop/desktop-port.ts";
import { sharedPorts } from "../../../src/bootstrap/wiring/shared-ports.ts";
import { startEffects } from "../../../src/legacy/effects-bridge.ts";
import { fakeNotices } from "../../features/fakes.ts";

test("file delivery forwards to the current desktop adapter and keeps saved, cancelled and failed notices", async () => {
  const delivery: FileDelivery = sharedPorts().fileDelivery;
  const notices = fakeNotices();
  const stop = startEffects({ notices: notices.notices, menuItems: { setLabel: () => {}, setReason: () => {} }, clipboard: { copyText: async () => true } });
  const dialogs: unknown[] = [];
  const writes: unknown[] = [];
  try {
    useDesktopForTest({
      saveFileDialog: async (options) => { dialogs.push(options); return { id: "picked", name: "host.cmd" }; },
      writeFile: async (id, data) => { writes.push([id, Array.from(data)]); return null; }
    });
    assert.equal(await delivery.deliver("host.cmd", new Uint8Array([65, 66]), { savedMsg: "Saved the host command." }), true);
    assert.deepEqual(dialogs, [{ suggestedName: "host.cmd", filters: [{ name: "CMD file", extensions: ["cmd"] }] }]);
    assert.deepEqual(writes, [["picked", [65, 66]]]);
    assert.equal(await delivery.deliver("host.cmd", new Uint8Array([67])), true);
    useDesktopForTest({ saveFileDialog: async () => null });
    assert.equal(await delivery.deliver("cancelled.cmd", "cancelled"), false);
    useDesktopForTest({ saveFileDialog: async () => { throw new Error("failed"); } });
    assert.equal(await delivery.deliver("failed.cmd", "failed"), false);
    assert.deepEqual(notices.shown.map(({ message, kind }) => [message, kind]), [
      ["Saved the host command.", "ok"], ["Saved host.cmd", "ok"], ["Could not save the file. Please try again.", "error"]
    ]);
    assert.deepEqual(writes, [["picked", [65, 66]], ["picked", [67]]]);
  } finally {
    restoreDesktop();
    stop();
  }
});
