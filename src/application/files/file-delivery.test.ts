import "../../test/_dom.mjs";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { restoreDesktop, useDesktopForTest } from "../../adapters/desktop/desktop-port.ts";
import { sharedPorts } from "../../bootstrap/wiring/shared-ports.ts";
import { startEffects } from "../../legacy/effects-bridge.ts";
import type { NoticeKind } from "../effects/ports.ts";
import type { DeliverOptions, FileDelivery } from "./file-delivery.ts";

function recordNotices(t: TestContext): [string, NoticeKind | undefined][] {
  const shown: [string, NoticeKind | undefined][] = [];
  const notice = { isConnected: true, dismiss: () => {}, removeEventListener: () => {} };
  t.after(startEffects({
    notices: {
      show: (message, kind) => { shown.push([message, kind]); return notice; },
      showAction: () => notice
    },
    menuItems: { setLabel: () => {}, setReason: () => {} },
    clipboard: { copyText: () => Promise.resolve(false) }
  }));
  t.after(restoreDesktop);
  return shown;
}

test("file delivery forwards desktop saves and preserves every saved-message option", async (t) => {
  const shown = recordNotices(t);
  const delivery: FileDelivery = sharedPorts().fileDelivery;
  const data = new Uint8Array([1, 2, 3]);
  const cases: readonly [DeliverOptions | null | undefined, string][] = [
    [undefined, "Saved notes.txt"],
    [null, "Saved notes.txt"],
    [{}, "Saved notes.txt"],
    [{ savedMsg: "" }, "Saved notes.txt"],
    [{ savedMsg: "Saved the host command." }, "Saved the host command."]
  ];
  for (const [options, message] of cases) {
    const calls: unknown[][] = [];
    useDesktopForTest({
      saveFileDialog: (input) => { calls.push(["saveFileDialog", input]); return Promise.resolve({ id: "picked", name: "notes.txt" }); },
      writeFile: (id, bytes) => { calls.push(["writeFile", id, bytes]); return Promise.resolve(null); }
    });
    assert.equal(sharedPorts().fileDelivery, delivery);
    assert.equal(await delivery.deliver("notes.txt", data, options), true);
    assert.deepEqual(calls, [
      ["saveFileDialog", { suggestedName: "notes.txt", filters: [{ name: "TXT file", extensions: ["txt"] }] }],
      ["writeFile", "picked", data]
    ]);
    assert.equal(calls[1]?.[2], data);
    assert.deepEqual(shown.splice(0), [[message, "ok"]]);
  }
});

test("file delivery returns false without a notice or write when the desktop dialog is cancelled", async (t) => {
  const shown = recordNotices(t);
  let writes = 0;
  useDesktopForTest({
    saveFileDialog: () => Promise.resolve(null),
    writeFile: () => { writes++; return Promise.resolve(null); }
  });
  assert.equal(await sharedPorts().fileDelivery.deliver("notes.txt", "hello", { savedMsg: "Saved the notes" }), false);
  assert.equal(writes, 0);
  assert.deepEqual(shown, []);
});

for (const failure of ["dialog", "write"]) {
  test("file delivery preserves the failed notice when the desktop " + failure + " fails", async (t) => {
    const shown = recordNotices(t);
    useDesktopForTest({
      saveFileDialog: () => failure === "dialog"
        ? Promise.reject(new Error("dialog failed"))
        : Promise.resolve({ id: "picked", name: "notes.txt" }),
      writeFile: () => Promise.reject(new Error("disk full"))
    });
    assert.equal(await sharedPorts().fileDelivery.deliver("notes.txt", "hello", { savedMsg: "Saved the notes" }), false);
    assert.deepEqual(shown, [["Could not save the file. Please try again.", "error"]]);
  });
}

test("file delivery forwards browser downloads through the adapter and shows the saved notice", async (t) => {
  const shown = recordNotices(t);
  useDesktopForTest(null);
  const data = new Blob(["hello"], { type: "text/plain" });
  const blobs: Blob[] = [];
  const downloads: unknown[][] = [];
  const revoked: string[] = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(URL, "createObjectURL", (blob: Blob) => { blobs.push(blob); return "blob:test/1"; });
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });
  t.mock.method(window.HTMLAnchorElement.prototype, "click", function (this: HTMLAnchorElement) {
    downloads.push([this.download, this.href, this.isConnected]);
  });
  assert.equal(await sharedPorts().fileDelivery.deliver("notes.txt", data), true);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0], data);
  assert.deepEqual(downloads, [["notes.txt", "blob:test/1", true]]);
  assert.equal(document.querySelector("a[download]"), null);
  assert.deepEqual(shown, [["Saved notes.txt", "ok"]]);
  t.mock.timers.tick(4000);
  assert.deepEqual(revoked, ["blob:test/1"]);
});

test("file delivery returns false and preserves the failed notice when a browser download fails", async (t) => {
  const shown = recordNotices(t);
  useDesktopForTest(null);
  t.mock.method(URL, "createObjectURL", () => { throw new Error("download failed"); });
  assert.equal(await sharedPorts().fileDelivery.deliver("notes.txt", "hello"), false);
  assert.deepEqual(shown, [["Could not save the file. Please try again.", "error"]]);
});
