import { test } from "node:test";
import assert from "node:assert/strict";
import { LEGACY_SNAPSHOTS_KEY, createLegacySnapshots } from "../../src/application/recovery/legacy-snapshots.ts";
import type { KeyValueStorage } from "../../src/application/recovery/conflict-stash.ts";

function memoryStorage(): KeyValueStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items: items,
    getItem: function (key: string): string | null { return items.has(key) ? items.get(key) as string : null; },
    setItem: function (key: string, value: string): void { items.set(key, value); },
    removeItem: function (key: string): void { items.delete(key); }
  };
}

test("the legacy snapshots live under the 3.x local storage key", () => {
  assert.equal(LEGACY_SNAPSHOTS_KEY, "splitpage-snapshots");
});

test("the legacy snapshots read as the raw text stored, or none, and removing them clears only their key", () => {
  const storage = memoryStorage();
  const snapshots = createLegacySnapshots({ storage: () => storage });
  assert.equal(snapshots.readRaw(), null);
  storage.items.set(LEGACY_SNAPSHOTS_KEY, "[{\"id\":\"s1\"}]");
  storage.items.set("splitpage-autosave", "1");
  assert.equal(snapshots.readRaw(), "[{\"id\":\"s1\"}]", "the text is handed back unparsed");
  assert.equal(snapshots.remove(), true);
  assert.equal(snapshots.readRaw(), null);
  assert.deepEqual([...storage.items.keys()], ["splitpage-autosave"]);
  assert.equal(snapshots.remove(), true, "removing what is gone still succeeds");
});

test("a stored value that is not text reads as none", () => {
  const odd: KeyValueStorage = { getItem: () => 42 as unknown as string, setItem: () => {}, removeItem: () => {} };
  assert.equal(createLegacySnapshots({ storage: () => odd }).readRaw(), null);
});

test("missing or failing storage reads as none and a removal that fails says so", () => {
  const fail = function (): never { throw new Error("storage is off"); };
  const failing: KeyValueStorage = { getItem: fail, setItem: fail, removeItem: fail };
  for (const storage of [null, undefined, failing]) {
    const snapshots = createLegacySnapshots({ storage: () => storage });
    assert.equal(snapshots.readRaw(), null);
    assert.equal(snapshots.remove(), false);
  }
  const throwing = createLegacySnapshots({ storage: () => { throw new Error("no access"); } });
  assert.equal(throwing.readRaw(), null);
  assert.equal(throwing.remove(), false);
});
