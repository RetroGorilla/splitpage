import { test } from "node:test";
import assert from "node:assert/strict";
import { createConflictStash } from "../../src/application/recovery/conflict-stash.ts";
import type { KeyValueStorage, StashedWork } from "../../src/application/recovery/conflict-stash.ts";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

function memoryStorage(): KeyValueStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items: items,
    getItem: function (key: string): string | null { return items.has(key) ? items.get(key) as string : null; },
    setItem: function (key: string, value: string): void { items.set(key, value); },
    removeItem: function (key: string): void { items.delete(key); }
  };
}

function failingStorage(): KeyValueStorage {
  const fail = function (): never { throw new Error("storage is off"); };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function stashWith(storage: KeyValueStorage | null, interned: string[] = []) {
  return createConflictStash({ storage: () => storage, internImage: (dataUrl: string) => { interned.push(dataUrl); } });
}

test("a saved stash reads back as written, under the conflict-stash key in session storage, until it is cleared", () => {
  const storage = memoryStorage();
  const stash = stashWith(storage);
  assert.equal(stash.read(), null, "nothing stashed reads as none");
  const payload = { at: "2026-10-21T00:00:00.000Z", by: "Sam", base: { rows: [] }, mine: { rows: [{ id: "r1" }] } };
  assert.equal(stash.save(payload), true);
  assert.deepEqual([...storage.items.keys()], ["splitpage-conflict-stash"]);
  assert.deepEqual(stash.read(), payload);
  stash.clear();
  assert.equal(stash.read(), null);
  assert.equal(storage.items.size, 0);
  stash.clear();
  assert.equal(storage.items.size, 0, "clearing twice is harmless");
});

test("a stash that is not JSON, or storage that is missing or throws, reads as none and never throws", () => {
  const storage = memoryStorage();
  storage.items.set("splitpage-conflict-stash", "{ not json");
  assert.equal(stashWith(storage).read(), null);
  storage.items.set("splitpage-conflict-stash", "");
  assert.equal(stashWith(storage).read(), null, "an empty value reads as none");
  for (const broken of [null, failingStorage()]) {
    const stash = stashWith(broken);
    assert.equal(stash.save({ mine: { rows: [] } }), false, "a write that fails says so");
    assert.equal(stash.read(), null);
    assert.doesNotThrow(() => stash.clear());
    assert.doesNotThrow(() => stash.dropReloadGuard());
  }
  const throwing = createConflictStash({ storage: () => { throw new Error("no access"); }, internImage: () => {} });
  assert.equal(throwing.save({}), false, "a storage getter that throws is a failed write");
  assert.equal(throwing.read(), null);
});

test("a payload that cannot be written as JSON is a failed save and leaves the stash that was there", () => {
  const storage = memoryStorage();
  const stash = stashWith(storage);
  stash.save({ mine: { rows: [] }, by: "first" });
  const loop: StashedWork = { mine: null };
  loop.mine = loop;
  assert.equal(stash.save(loop), false);
  assert.equal(stash.read()?.by, "first");
});

test("dropping the reload guard removes only the guard key", () => {
  const storage = memoryStorage();
  storage.items.set("splitpage-conflict-reloaded", "1");
  const stash = stashWith(storage);
  stash.save({ mine: { rows: [] } });
  stash.dropReloadGuard();
  assert.deepEqual([...storage.items.keys()], ["splitpage-conflict-stash"]);
});

test("accepting a stash interns each carried picture whose key is a SHA-256, and nothing else", () => {
  const interned: string[] = [];
  const stash = stashWith(memoryStorage(), interned);
  const work = { mine: { rows: [] }, blobs: { [SHA]: "data:image/png;base64,AAA", [OTHER_SHA]: 7, "not-a-sha": "data:image/png;base64,BBB" } };
  assert.equal(stash.accept(work, { rows: [] }), work, "the same stash comes back");
  assert.deepEqual(interned, ["data:image/png;base64,AAA"]);
  for (const blobs of [undefined, null, "x", 3]) {
    stash.accept({ mine: { rows: [] }, blobs: blobs }, null);
  }
  assert.equal(interned.length, 1, "blobs that are not a table intern nothing");
});

test("accepting an older stash replaces its picture sentinels with their picture, in mine and in base", () => {
  const stash = stashWith(memoryStorage());
  const ref = { sha256: SHA, mime: "image/png", width: 4, height: 3 };
  const theirs = { rows: [{ id: "r1", imageRef: ref }, { id: "r2", imageRef: null }] };
  const work = {
    imagesStripped: true,
    base: { rows: [{ id: "r1", visualImage: "__IMAGE__" }] },
    mine: { rows: [{ id: "r1", visualImage: "__IMAGE__" }, { id: "r2", visualImage: "__IMAGE__" }, { id: "r3", visualImage: "__IMAGE__" }, { id: "r4", visualImage: null }, null] }
  };
  stash.accept(work, theirs);
  assert.equal("imagesStripped" in work, false);
  assert.deepEqual(work.base.rows[0], { id: "r1", imageRef: ref });
  assert.deepEqual(work.mine.rows[0], { id: "r1", imageRef: ref });
  assert.notEqual(work.mine.rows[0]?.imageRef, ref, "the picture reference is a copy");
  assert.deepEqual(work.mine.rows[1], { id: "r2", imageRef: null }, "their row without a picture gives none");
  assert.deepEqual(work.mine.rows[2], { id: "r3", imageRef: null }, "a row they do not have gives none");
  assert.deepEqual(work.mine.rows[3], { id: "r4", visualImage: null }, "a row without the sentinel is untouched");
});

test("accepting with stripped pictures and no usable documents leaves the rows alone and still clears the marker", () => {
  const stash = stashWith(memoryStorage());
  const work = { imagesStripped: true, mine: { rows: "nope" }, base: null };
  stash.accept(work, null);
  assert.equal("imagesStripped" in work, false);
  assert.deepEqual(work.mine, { rows: "nope" });
  const sentinel = { imagesStripped: true, mine: { rows: [{ id: "r1", visualImage: "__IMAGE__" }] } };
  stash.accept(sentinel, { rows: "not rows" });
  assert.deepEqual(sentinel.mine.rows[0], { id: "r1", imageRef: null }, "theirs without rows gives no picture");
});

test("accepting something that is not a stash hands it back untouched", () => {
  const interned: string[] = [];
  const stash = stashWith(memoryStorage(), interned);
  for (const value of [null, undefined, 0, "", "text", false]) assert.equal(stash.accept(value, null), value);
  assert.deepEqual(interned, []);
});
