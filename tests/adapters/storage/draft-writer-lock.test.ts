import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDraftBase } from "../../../src/adapters/storage/draft-store-idb.ts";
import { browserWriterId, browserWriterIsLive, holdBrowserWriterLock, releaseBrowserWriterLock } from "../../../src/adapters/storage/draft-writer-lock.js";

const PAGE = "https://script.example.test/app/index.html";

test("a draft base normalises to origin and path without trailing slashes, resolved against the page", () => {
  assert.equal(normalizeDraftBase("https://team.test/scripts/", PAGE), "https://team.test/scripts");
  assert.equal(normalizeDraftBase("  https://team.test///  ", PAGE), "https://team.test");
  assert.equal(normalizeDraftBase("../other/", PAGE), "https://script.example.test/other");
  assert.equal(normalizeDraftBase("https://team.test/a?x=1#y", PAGE), "https://team.test/a");
  assert.equal(normalizeDraftBase("", PAGE), "");
  assert.equal(normalizeDraftBase(null, PAGE), "");
  assert.equal(normalizeDraftBase("http://[bad/", PAGE), "http://[bad");
});

test("the writer id is 32 hex characters, and this page's own writer is always live", async () => {
  assert.match(browserWriterId, /^[0-9a-f]{32}$/);
  assert.equal(await browserWriterIsLive(browserWriterId), true);
  assert.equal(await browserWriterIsLive(""), false);
});

test("another writer is live only while the browser holds its lock", async () => {
  const nav = globalThis.navigator as unknown as { locks?: unknown };
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const held: string[] = [];
  const requested: string[] = [];
  const locks = {
    request: (name: string, run: () => unknown) => { requested.push(name); held.push(name); void run(); return Promise.resolve(); },
    query: () => Promise.resolve({ held: held.map((name) => ({ name })) })
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { ...nav, locks } });
  try {
    assert.equal(await browserWriterIsLive("other-writer"), false);
    held.push("splitpage-draft-writer-other-writer");
    assert.equal(await browserWriterIsLive("other-writer"), true);
    holdBrowserWriterLock();
    holdBrowserWriterLock();
    assert.deepEqual(requested, ["splitpage-draft-writer-" + browserWriterId], "the lock is asked for once while it is wanted");
    releaseBrowserWriterLock();
    holdBrowserWriterLock();
    assert.equal(requested.length, 2, "after a release it can be asked for again");
    releaseBrowserWriterLock();
  } finally {
    if (had) Object.defineProperty(globalThis, "navigator", had);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("without Web Locks, other writers are never live and holding the lock does nothing", async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    assert.equal(await browserWriterIsLive("other-writer"), false);
    holdBrowserWriterLock();
    releaseBrowserWriterLock();
  } finally {
    if (had) Object.defineProperty(globalThis, "navigator", had);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
