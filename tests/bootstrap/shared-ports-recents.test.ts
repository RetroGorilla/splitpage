import type { MalformedDesktopReply } from "../../src/adapters/desktop/desktop-port.ts";
import "../../src/test/_dom.mjs";
import { recents as portRecents } from "../../src/bootstrap/wiring/ports/desktop.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { restoreDesktop, useDesktopForTest } from "../../src/adapters/desktop/desktop-port.ts";
import type { DesktopPort } from "../../src/adapters/desktop/desktop-port.ts";
import type { RecentFileOpenRequest, RecentFiles } from "../../src/application/files/recent-files.ts";

test("the recent files port forwards each call and follows the current desktop", async () => {
  useDesktopForTest(null);
  const recents: RecentFiles = portRecents;
  const request: RecentFileOpenRequest = { kind: "file", fileId: "file-1" };
  try {
    assert.equal(recents.available(), false);
    assert.equal(recents.canRemove(), false);
    assert.equal(recents.canClear(), false);
    assert.equal(recents.list(), undefined);
    assert.equal(recents.remove("file-1"), undefined);
    assert.equal(recents.clear(), undefined);
    assert.equal(recents.read("file-1"), undefined);
    assert.equal(recents.routeOpen(request), undefined);
    for (const id of ["first", "second"]) {
      const calls: unknown[][] = [];
      const listed = Promise.resolve([{ fileId: id, name: id + ".splitpage" }] as unknown as MalformedDesktopReply);
      const removed = Promise.resolve([{ fileId: id + "-kept" }] as unknown as MalformedDesktopReply);
      const cleared = Promise.resolve([]);
      const read = Promise.resolve({ id, name: id + ".splitpage", bytes: new Uint8Array([1, 2]), lastModified: 123 } as unknown as MalformedDesktopReply);
      const routed: ReturnType<DesktopPort["routeOpen"]> = Promise.resolve({ where: "this-tab" });
      const desktop = {
        listRecents() { assert.equal(this, desktop); calls.push(["listRecents"]); return listed; },
        removeRecent(fileId: string) { assert.equal(this, desktop); calls.push(["removeRecent", fileId]); return removed; },
        clearRecents() { assert.equal(this, desktop); calls.push(["clearRecents"]); return cleared; },
        readFile(fileId: string) { assert.equal(this, desktop); calls.push(["readFile", fileId]); return read; },
        routeOpen(input: unknown) { assert.equal(this, desktop); calls.push(["routeOpen", input]); return routed; }
      };
      useDesktopForTest(desktop);
      assert.equal(recents.available(), true);
      assert.equal(recents.canRemove(), true);
      assert.equal(recents.canClear(), true);
      assert.equal(portRecents, recents);
      assert.deepEqual(calls, []);
      assert.equal(recents.list(), listed);
      assert.equal(recents.remove(id + "-removed"), removed);
      assert.equal(recents.clear(), cleared);
      assert.equal(recents.read(id), read);
      assert.equal(recents.routeOpen(request), routed);
      assert.deepEqual(calls, [
        ["listRecents"], ["removeRecent", id + "-removed"], ["clearRecents"], ["readFile", id],
        ["routeOpen", request]
      ]);
      assert.equal(calls[4]?.[1], request);
    }
    const failure = new Error("file missing");
    const rejected = Promise.reject(failure);
    useDesktopForTest({ readFile: () => rejected, routeOpen: () => Promise.resolve(null as unknown as MalformedDesktopReply) });
    assert.equal(recents.available(), false);
    assert.equal(recents.canRemove(), false);
    assert.equal(recents.canClear(), false);
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
