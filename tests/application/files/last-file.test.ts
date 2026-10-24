import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import type { LastFile } from "../../../src/application/files/last-file.ts";
import { sharedPorts } from "../../../src/bootstrap/wiring/shared-ports.ts";
import { rememberLastFileHandle } from "../../../src/js/00-prelude.js";

test("last file reads the handle stored by the legacy prelude at call time", async () => {
  const last: LastFile = sharedPorts().lastFile;
  const factory = new FakeIDBFactory();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const previousWindow = Object.getOwnPropertyDescriptor(window, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  Object.defineProperty(window, "indexedDB", { configurable: true, value: factory });
  try {
    assert.equal(await last.load(), null);
    await rememberLastFileHandle({ kind: "file", name: "first.splitpage" });
    assert.deepEqual(await last.load(), { kind: "file", name: "first.splitpage" });
    await rememberLastFileHandle({ kind: "file", name: "second.splitpage" });
    assert.deepEqual(await last.load(), { kind: "file", name: "second.splitpage" });
  } finally {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else Reflect.deleteProperty(globalThis, "indexedDB");
    if (previousWindow) Object.defineProperty(window, "indexedDB", previousWindow);
    else Reflect.deleteProperty(window, "indexedDB");
  }
});
