import "../../test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { sharedPorts } from "../../bootstrap/wiring/shared-ports.ts";
import { loadLastFileHandle } from "../../js/00-prelude.js";
import type { LastFile } from "./last-file.ts";

function successRequest<T>(result: T): { readonly result: T; onsuccess?: () => void } {
  const request: { readonly result: T; onsuccess?: () => void } = { result };
  queueMicrotask(() => { request.onsuccess?.(); });
  return request;
}

test("the last file port forwards to the legacy loader for stored handles, empty and unavailable storage", async (t) => {
  let stored: unknown;
  const factory = {
    open: () => successRequest({
      transaction: () => ({ objectStore: () => ({ get: () => successRequest(stored) }) })
    })
  };
  for (const target of [globalThis, window]) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "indexedDB");
    Object.defineProperty(target, "indexedDB", { configurable: true, value: factory });
    t.after(() => {
      if (descriptor) Object.defineProperty(target, "indexedDB", descriptor);
      else Reflect.deleteProperty(target, "indexedDB");
    });
  }

  const lastFile: LastFile = sharedPorts().lastFile;
  assert.equal(sharedPorts().lastFile, lastFile);
  assert.equal(lastFile.load, loadLastFileHandle);
  assert.equal(await lastFile.load(), null);

  const first = { kind: "file", name: "first.splitpage" };
  stored = first;
  assert.equal(await lastFile.load(), first);

  const second = { kind: "file", name: "second.splitpage" };
  stored = second;
  assert.equal(await lastFile.load(), second);

  t.mock.method(factory, "open", () => { throw new Error("storage unavailable"); });
  assert.equal(await lastFile.load(), null);

  Reflect.deleteProperty(window, "indexedDB");
  assert.equal(await lastFile.load(), null);
});
