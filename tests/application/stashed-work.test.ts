import { test } from "node:test";
import assert from "node:assert/strict";
import { createStashedWork } from "../../src/application/recovery/stashed-work.ts";
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
