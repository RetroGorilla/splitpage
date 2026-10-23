import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { restoreDesktop, useDesktopForTest } from "../../src/adapters/desktop/desktop-port.ts";
import type { RecentFileOpenRequest, RecentFiles } from "../../src/application/files/recent-files.ts";
import { sharedPorts } from "../../src/bootstrap/wiring/shared-ports.ts";

test("the recent files port forwards each call and follows the current desktop", async () => {
  useDesktopForTest(null);
  const recents: RecentFiles = sharedPorts().recents;
  const request: RecentFileOpenRequest = { kind: "file", fileId: "file-1" };
  try {
    assert.equal(recents.list(), undefined);
    assert.equal(recents.remove("file-1"), undefined);
    assert.equal(recents.clear(), undefined);
    assert.equal(recents.read("file-1"), undefined);
    assert.equal(recents.routeOpen(request), undefined);
    for (const id of ["first", "second"]) {
      const calls: unknown[][] = [];
      const listed = Promise.resolve([{ fileId: id, name: id + ".splitpage" }]);
      const removed = Promise.resolve([{ fileId: id + "-kept" }]);
      const cleared = Promise.resolve([]);
      const read = Promise.resolve({ id, name: id + ".splitpage", bytes: new Uint8Array([1, 2]), lastModified: 123 });
      const routed = Promise.resolve({ where: "this-tab" });
      const desktop = {
        listRecents() { assert.equal(this, desktop); calls.push(["listRecents"]); return listed; },
        removeRecent(fileId: string) { assert.equal(this, desktop); calls.push(["removeRecent", fileId]); return removed; },
        clearRecents() { assert.equal(this, desktop); calls.push(["clearRecents"]); return cleared; },
        readFile(fileId: string) { assert.equal(this, desktop); calls.push(["readFile", fileId]); return read; },
        routeOpen(input: RecentFileOpenRequest) { assert.equal(this, desktop); calls.push(["routeOpen", input]); return routed; }
      };
      useDesktopForTest(desktop);
      assert.equal(sharedPorts().recents, recents);
      assert.deepEqual(calls, []);
      assert.equal(recents.list(), listed);
      assert.equal(recents.remove(id + "-removed"), removed);
      assert.equal(recents.clear(), cleared);
      assert.equal(recents.read(id), read);
      assert.equal(recents.routeOpen(request), routed);
      const serverRequest: RecentFileOpenRequest = {
        kind: "server", serverDocId: "doc-1", serverUrl: "https://example.test", token: "token", tunnel: { localPort: 1234 }
      };
      assert.equal(recents.routeOpen(serverRequest), routed);
      assert.deepEqual(calls, [
        ["listRecents"], ["removeRecent", id + "-removed"], ["clearRecents"], ["readFile", id],
        ["routeOpen", request], ["routeOpen", serverRequest]
      ]);
      assert.equal(calls[4]?.[1], request);
      assert.equal(calls[5]?.[1], serverRequest);
    }
    const failure = new Error("file missing");
    const rejected = Promise.reject(failure);
    useDesktopForTest({ readFile: () => rejected, routeOpen: () => Promise.resolve(null) });
    assert.equal(recents.read("missing"), rejected);
    await assert.rejects(rejected, (error: unknown) => error === failure);
    assert.equal(await recents.routeOpen(request), null);
    useDesktopForTest(null);
    assert.equal(recents.list(), undefined);
    assert.equal(recents.remove("file-1"), undefined);
    assert.equal(recents.clear(), undefined);
    assert.equal(recents.read("file-1"), undefined);
    assert.equal(recents.routeOpen(request), undefined);
  } finally {
    restoreDesktop();
  }
});
