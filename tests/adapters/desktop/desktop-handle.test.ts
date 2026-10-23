import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeDesktopHandle } from "../../../src/adapters/desktop/desktop-handle.ts";
import { restoreDesktop, useDesktopForTest } from "../../../src/adapters/desktop/desktop-port.ts";

afterEach(() => { restoreDesktop(); });

function fakeDesktop(answers: { name?: string; lastModified?: number; written?: unknown } = {}): { calls: string[]; writes: Uint8Array[] } {
  const calls: string[] = [];
  const writes: Uint8Array[] = [];
  useDesktopForTest({
    readFile: (id: string) => {
      calls.push("read " + id);
      return Promise.resolve({ id, name: answers.name ?? "renamed.md", bytes: new TextEncoder().encode("hello"), lastModified: answers.lastModified ?? 1234 });
    },
    writeFile: (id: string, data: Uint8Array) => {
      calls.push("write " + id);
      writes.push(data);
      return Promise.resolve(answers.written as { lastModified?: number } | null);
    }
  });
  return { calls, writes };
}

test("getFile reads the desktop file into a File and takes the name the desktop answers", async () => {
  const desk = fakeDesktop({ name: "renamed.md", lastModified: 99 });
  const handle = makeDesktopHandle({ id: "f1", name: "old.md" });
  const file = await handle.getFile();
  assert.deepEqual(desk.calls, ["read f1"]);
  assert.equal(file.name, "renamed.md");
  assert.equal(file.lastModified, 99);
  assert.equal(await file.text(), "hello");
  assert.equal(handle.name, "renamed.md");
});

test("a writable collects strings, blobs, buffers and views, and close writes them in one call", async () => {
  const desk = fakeDesktop({ written: { lastModified: 777 } });
  const handle = makeDesktopHandle({ id: "f2", name: "a.md" });
  const writable = await handle.createWritable();
  await writable.write("ab");
  await writable.write(new Blob(["cd"]));
  await writable.write(new TextEncoder().encode("ef").buffer);
  await writable.write(new TextEncoder().encode("xgh").subarray(1));
  await writable.write(5);
  assert.deepEqual(desk.calls, [], "nothing is written before close");
  assert.deepEqual(await writable.close(), { lastModified: 777 });
  assert.deepEqual(desk.calls, ["write f2"]);
  assert.equal(new TextDecoder().decode(desk.writes[0]), "abcdefgh5");
});

test("close answers no time when the desktop gives none or an unusable one", async () => {
  for (const written of [null, {}, { lastModified: Number.NaN }, { lastModified: "1" }]) {
    fakeDesktop({ written });
    const writable = await makeDesktopHandle({ id: "f3", name: "a.md" }).createWritable();
    await writable.write("x");
    assert.equal(await writable.close(), undefined, JSON.stringify(written));
  }
});

test("the handle is granted, and is the same entry as another handle for the same desktop file only", async () => {
  const handle = makeDesktopHandle({ id: "f4", name: "a.md" });
  assert.equal(handle.kind, "file");
  assert.equal(handle._desktopId, "f4");
  assert.equal(await handle.queryPermission(), "granted");
  assert.equal(await handle.requestPermission(), "granted");
  assert.equal(handle.isSameEntry(makeDesktopHandle({ id: "f4", name: "b.md" })), true);
  assert.equal(handle.isSameEntry(makeDesktopHandle({ id: "f5", name: "a.md" })), false);
  assert.equal(handle.isSameEntry(null), false);
});
