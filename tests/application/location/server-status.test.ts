import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_BOOKMARKS_KEY, createServerStatus } from "../../../src/application/location/server-status.ts";
import type { ServerStatusChange } from "../../../src/application/location/server-status.ts";
import type { KeyValueStorage } from "../../../src/application/recovery/conflict-stash.ts";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { readonly items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items: items,
    getItem: (key) => items.has(key) ? items.get(key) as string : null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); }
  };
}

const UNCHECKED = { available: false, readOnly: false, checked: false, authRequired: false,
                    reviewAvailable: false, version: null, links: false, linksPersist: false };

test("a tab starts knowing nothing about its server", () => {
  const status = createServerStatus({ storage: () => memoryStorage() });
  assert.deepEqual(status.mode(), UNCHECKED);
  assert.ok(Object.isFrozen(status.mode()));
  assert.equal(status.linkTurnedOff(), false);
  assert.equal(status.sessionExpired(), false);
  assert.deepEqual(status.bookmarks(), []);
});

test("a health answer sets every server fact at once and marks the server checked", () => {
  const status = createServerStatus({ storage: () => null });
  status.applyHealth({ ok: true, readOnly: true, authRequired: true, reviewAvailable: true, version: "4.1.0", links: 2, linksPersist: true });
  assert.deepEqual(status.mode(), { available: true, readOnly: true, checked: true, authRequired: true,
                                    reviewAvailable: true, version: "4.1.0", links: true, linksPersist: true });
  status.applyHealth({ ok: true, links: 0, linksPersist: "yes" });
  assert.deepEqual(status.mode(), { ...UNCHECKED, available: true, checked: true },
    "a later answer replaces the earlier one, and a fact must be stated exactly to count");
  status.applyHealth(null);
  assert.deepEqual(status.mode(), { ...UNCHECKED, checked: true }, "no answer is a checked server that is not there");
});

test("recordMode changes the named facts and refuses anything else", () => {
  const status = createServerStatus({ storage: () => null });
  status.recordMode({ available: true, checked: true });
  assert.deepEqual(status.mode(), { ...UNCHECKED, available: true, checked: true });
  const loose = status.recordMode as (fields: Record<string, unknown>) => void;
  assert.throws(() => loose({ online: true }), /no field "online"/);
  assert.throws(() => loose({ available: "yes" }), /available is true or false/);
  assert.throws(() => loose({ version: 4 }), /version is a string or null/);
  assert.deepEqual(status.mode(), { ...UNCHECKED, available: true, checked: true }, "a refused change leaves the facts as they were");
  status.forgetMode();
  assert.deepEqual(status.mode(), UNCHECKED);
});

test("a link turned off and a sign-in that expired each happen once", () => {
  const status = createServerStatus({ storage: () => null });
  assert.equal(status.turnLinkOff(), true);
  assert.equal(status.turnLinkOff(), false, "the second report changes nothing");
  assert.equal(status.linkTurnedOff(), true);
  assert.equal(status.expireSession(), true);
  assert.equal(status.expireSession(), false);
  assert.equal(status.sessionExpired(), true);
});

test("bookmarks load from storage, keep only entries with an address, and save back", () => {
  const store = memoryStorage({ [SERVER_BOOKMARKS_KEY]: JSON.stringify([{ id: "a", name: "A", url: "http://a/" }, { id: "b" }, null, "x"]) });
  const status = createServerStatus({ storage: () => store });
  status.loadBookmarks();
  assert.deepEqual(status.bookmarks(), [{ id: "a", name: "A", url: "http://a/" }]);
  assert.ok(Object.isFrozen(status.bookmarks()));
  status.addBookmarks([{ id: "c", name: "C", url: "http://c/" }]);
  assert.deepEqual(status.bookmarkById("c"), { id: "c", name: "C", url: "http://c/" });
  assert.equal(status.bookmarkById("zz"), null);
  assert.equal(status.saveBookmarks(), true);
  const saved = JSON.parse(store.items.get(SERVER_BOOKMARKS_KEY) as string) as { id: string }[];
  assert.deepEqual(saved.map((b) => b.id), ["a", "c"]);
  status.removeBookmark("a");
  assert.deepEqual(status.bookmarks().map((b) => b.id), ["c"]);
  const looseAdd = status.addBookmarks as (added: readonly unknown[]) => void;
  assert.throws(() => looseAdd([{ id: "d" }]), /a bookmark is an object with a url/);
});

test("bookmarks that cannot be read start empty, and a save that cannot be written says so", () => {
  for (const raw of [null, "not json", "{\"url\":\"x\"}"]) {
    const status = createServerStatus({ storage: () => memoryStorage(raw === null ? {} : { [SERVER_BOOKMARKS_KEY]: raw }) });
    status.addBookmarks([{ id: "old", url: "http://old/" }]);
    status.loadBookmarks();
    assert.deepEqual(status.bookmarks(), [], String(raw));
  }
  const refusing = createServerStatus({
    storage: () => ({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => {} })
  });
  refusing.loadBookmarks();
  assert.deepEqual(refusing.bookmarks(), []);
  assert.equal(refusing.saveBookmarks(), false);
  const none = createServerStatus({ storage: () => { throw new Error("no storage"); } });
  assert.equal(none.saveBookmarks(), false);
});

test("each change is announced", () => {
  const status = createServerStatus({ storage: () => memoryStorage() });
  const seen: ServerStatusChange[] = [];
  const stop = status.onChange((change) => seen.push(change));
  status.applyHealth({ ok: true });
  status.recordMode({ readOnly: true });
  status.forgetMode();
  status.turnLinkOff();
  status.turnLinkOff();
  status.expireSession();
  status.loadBookmarks();
  status.addBookmarks([{ id: "a", url: "http://a/" }]);
  status.removeBookmark("a");
  stop();
  status.forgetMode();
  assert.deepEqual(seen, ["mode", "mode", "mode", "link", "session", "bookmarks", "bookmarks", "bookmarks"]);
});
