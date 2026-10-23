import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalWorkStash, createStashedWork } from "../../src/application/recovery/stashed-work.ts";
import type { StashMerged } from "../../src/application/recovery/stashed-work.ts";
import type { ConflictStash, StashedWork } from "../../src/application/recovery/conflict-stash.ts";
import { SERVER_RESUME_KEY } from "../../src/application/location/server-status.ts";

interface Doc {
  docId: string;
  title: string;
  rows: unknown[];
}

const MINE_ID = "d" + "7".repeat(32);

function doc(title: string, docId = "d" + "1".repeat(32)): Doc {
  return { docId: docId, title: title, rows: [{ id: "r1" }] };
}

interface World {
  readonly calls: string[];
  readonly merges: Readonly<Record<string, unknown>>[];
  readonly apply: ReturnType<typeof createStashedWork<Doc, string>>;
}

function world(stashed: StashedWork | null, options: { resume?: string | null; storageThrows?: boolean; merged?: (request: Readonly<Record<string, unknown>>) => StashMerged<Doc, string> | Promise<StashMerged<Doc, string>> } = {}): World {
  const calls: string[] = [];
  const merges: Readonly<Record<string, unknown>>[] = [];
  const stash: ConflictStash = {
    save: () => { calls.push("save"); return true; },
    read: () => { calls.push("read"); return stashed; },
    clear: () => { calls.push("clear"); },
    accept: (given) => { calls.push("accept"); return given; },
    dropReloadGuard: () => { calls.push("dropReloadGuard"); }
  };
  const apply = createStashedWork<Doc, string>({
    stash: stash,
    sessionStorage: () => {
      if (options.storageThrows) throw new Error("storage is off");
      return { getItem: (key) => (key === SERVER_RESUME_KEY ? options.resume ?? null : null), setItem: () => {}, removeItem: () => {} };
    },
    markWrittenOut: () => { calls.push("markWrittenOut"); },
    copy: (d) => ({ ...d, title: d.title + " (copy)" }),
    merge: (request) => {
      calls.push("merge");
      merges.push(request);
      return options.merged ? options.merged(request) : { state: doc("Merged"), result: "report", snapshot: "snap", replaced: true };
    }
  });
  return { calls, merges, apply };
}

test("no stash, or a stash without rows, answers the loaded document untouched and merges nothing", () => {
  for (const stashed of [null, {}, { mine: { title: "no rows" } }]) {
    const w = world(stashed);
    const loaded = doc("Loaded");
    assert.deepEqual(w.apply(loaded, null), { state: loaded, report: null, snapshot: null });
    assert.deepEqual(w.calls, ["read", "dropReloadGuard"], JSON.stringify(stashed));
    assert.equal(loaded.docId, "d" + "1".repeat(32));
  }
});

test("a stash read at startup takes the stash's id, marks it written out, clears the stash and merges the stashed work into the loaded document", () => {
  const mine = { ...doc("Mine", MINE_ID), title: "Mine" };
  const base = doc("Base");
  const w = world({ mine: mine, base: base });
  const loaded = doc("Loaded");
  const out = w.apply(loaded, null);
  assert.deepEqual(out, { state: doc("Merged"), report: "report", snapshot: "snap", replaced: true });
  assert.equal(loaded.docId, MINE_ID);
  assert.deepEqual(w.calls, ["read", "dropReloadGuard", "accept", "markWrittenOut", "clear", "merge"]);
  assert.deepEqual(w.merges, [{ theirs: loaded, source: "stash", mergeOnly: true, base: base, mine: mine, undoPoint: { ...loaded, title: "Loaded (copy)" } }]);
});

test("a stash whose id is not a document id leaves the loaded id alone", () => {
  const w = world({ mine: { ...doc("Mine"), docId: "not an id" } });
  const loaded = doc("Loaded");
  w.apply(loaded, null);
  assert.equal(loaded.docId, "d" + "1".repeat(32));
  assert.deepEqual(w.calls, ["read", "dropReloadGuard", "accept", "clear", "merge"]);
});

test("a server resume in progress leaves the stash for the resume and merges nothing", () => {
  const w = world({ mine: doc("Mine", MINE_ID) }, { resume: "1" });
  const loaded = doc("Loaded");
  assert.deepEqual(w.apply(loaded, null), { state: loaded, report: null, snapshot: null });
  assert.deepEqual(w.calls, ["read", "dropReloadGuard", "accept"]);
  assert.equal(loaded.docId, "d" + "1".repeat(32));
});

test("storage that throws counts as no resume in progress", () => {
  const w = world({ mine: doc("Mine", MINE_ID) }, { storageThrows: true });
  w.apply(doc("Loaded"), null);
  assert.deepEqual(w.calls, ["read", "dropReloadGuard", "accept", "markWrittenOut", "clear", "merge"]);
});

test("an override is merged as given: the stash is not read, cleared or guarded, the id is kept, and the apply options win", () => {
  const mine = doc("Mine", MINE_ID);
  const w = world(null);
  const loaded = doc("Loaded");
  w.apply(loaded, { mine: mine, base: null }, { recovery: true, mergeOnly: "theirs" });
  assert.deepEqual(w.calls, ["accept", "merge"]);
  assert.equal(loaded.docId, "d" + "1".repeat(32));
  assert.deepEqual(w.merges, [{ theirs: loaded, source: "stash", mergeOnly: "theirs", base: null, mine: mine, undoPoint: { ...loaded, title: "Loaded (copy)" }, recovery: true }]);
});

test("stashed work that equals the loaded document merges as unchanged, with no base, mine or undo point", () => {
  const loaded = doc("Same", MINE_ID);
  const w = world(null);
  w.apply(loaded, { mine: { ...loaded } }, { recovery: true });
  assert.deepEqual(w.merges, [{ theirs: loaded, source: "stash", mergeOnly: false, unchanged: true, recovery: true }]);
});

test("a merge that waits answers a promise of the same answer", async () => {
  const w = world(null, { merged: () => Promise.resolve({ state: doc("Later"), result: null, snapshot: null }) });
  const out = w.apply(doc("Loaded"), { mine: doc("Mine", MINE_ID) }, { awaitUndoPoint: true });
  assert.ok(out instanceof Promise);
  assert.deepEqual(await out, { state: doc("Later"), report: null, snapshot: null, replaced: false });
});

function localStash(mine: Record<string, unknown> | null, base: Record<string, unknown> | null, durable: readonly string[] = []): { readonly saved: StashedWork[]; readonly stashLocal: () => boolean } {
  const saved: StashedWork[] = [];
  const stash: ConflictStash = {
    save: (payload) => { saved.push(payload); return true; },
    read: () => null,
    clear: () => {},
    accept: (given) => given,
    dropReloadGuard: () => {}
  };
  const stashLocal = createLocalWorkStash<Record<string, unknown>>({
    stash: stash,
    current: () => mine,
    base: () => base,
    now: () => "2026-10-23T00:00:00.000Z",
    editor: () => "Ann",
    durable: (sha) => durable.includes(sha),
    dataUrl: (sha) => (sha.startsWith("a") ? "data:image/png;base64," + sha.slice(0, 4) : null)
  });
  return { saved, stashLocal };
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "a".repeat(63) + "c";

function pictured(sha: string): Record<string, unknown> {
  return { docId: MINE_ID, rows: [{ id: "r1", imageRef: { sha256: sha, mime: "image/png", w: 1, h: 1, bytes: 1 } }] };
}

test("local work stash: with no document nothing is saved", () => {
  const w = localStash(null, null);
  assert.equal(w.stashLocal(), false);
  assert.deepEqual(w.saved, []);
});

test("local work stash: saves when, who, the merge base and my document, with the bytes of pictures that are not durable and that have bytes", () => {
  const mine = pictured(SHA_A);
  const base = { docId: MINE_ID, rows: [pictured(SHA_C)["rows"], pictured(SHA_B)["rows"]].flat() };
  const w = localStash(mine, base);
  assert.equal(w.stashLocal(), true);
  assert.equal(w.saved.length, 1);
  const payload = w.saved[0];
  assert.deepEqual(Object.keys(payload ?? {}), ["at", "by", "base", "mine", "blobs"]);
  assert.equal(payload?.["at"], "2026-10-23T00:00:00.000Z");
  assert.equal(payload?.["by"], "Ann");
  assert.equal(payload?.mine, mine);
  assert.equal(payload?.["base"], base);
  assert.deepEqual(payload?.["blobs"], { [SHA_A]: "data:image/png;base64,aaaa", [SHA_C]: "data:image/png;base64,aaaa" });
});

test("local work stash: durable pictures carry no bytes, and with none left the payload has no blobs", () => {
  const w = localStash(pictured(SHA_A), null, [SHA_A]);
  assert.equal(w.stashLocal(), true);
  assert.deepEqual(Object.keys(w.saved[0] ?? {}), ["at", "by", "base", "mine"]);
  assert.equal(w.saved[0]?.["base"], null);
});
