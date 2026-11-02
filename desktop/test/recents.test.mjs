import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createRecents } = require(path.join(here, "..", "recents.js"));
const { createFileRegistry } = require(path.join(here, "..", "file-service.js"));
const { LAST_KNOWN_TITLE_MAX, RECENTS_MAX } = require(path.join(here, "..", "desktop-state.ts"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const pathKey = (p) => p.toLowerCase();

function harness(saved) {
  const writes = [];
  let state = { recents: saved || [] };
  const store = {
    read: () => structuredClone(state),
    write: (mutator) => {
      const next = mutator(structuredClone(state));
      state = next;
      writes.push(structuredClone(next.recents));
      return Promise.resolve(true);
    }
  };
  const fileIds = createFileRegistry();
  const recents = createRecents({ store, pathKey, fileIds });
  return { recents, writes, fileIds, state: () => state };
}

test("recents load from the store and are described for the renderer by file id, name and title", () => {
  const h = harness([{ absPath: "/docs/One.splitpage", title: "One", at: 5 }]);
  h.recents.load();
  const [row] = h.recents.forRenderer();
  assert.deepEqual({ ...row, fileId: undefined }, { fileId: undefined, name: "One.splitpage", title: "One", at: 5 });
  assert.equal(h.fileIds.pathOf(row.fileId), "/docs/One.splitpage");
  assert.equal(h.recents.forRenderer()[0].fileId, row.fileId);
});

test("noting a new file puts it first and reports a change", () => {
  const h = harness([{ absPath: "/a", title: "A", at: 1 }]);
  h.recents.load();
  assert.equal(h.recents.note("/b", "B"), true);
  assert.deepEqual(h.recents.list().map((r) => r.absPath), ["/b", "/a"]);
});

test("noting the first file again changes only its time unless its title changed", () => {
  const h = harness([{ absPath: "/a", title: "A", at: 1 }]);
  h.recents.load();
  assert.equal(h.recents.note("/A", "A"), false);
  assert.ok(h.recents.list()[0].at > 1);
  assert.equal(h.recents.note("/a", ""), false);
  assert.equal(h.recents.note("/a", "Renamed"), true);
  assert.equal(h.recents.list()[0].title, "Renamed");
});

test("noting a later file moves it first and keeps its old title when given none", () => {
  const h = harness([{ absPath: "/a", title: "A", at: 1 }, { absPath: "/b", title: "B", at: 2 }]);
  h.recents.load();
  assert.equal(h.recents.note("/B", ""), true);
  assert.deepEqual(h.recents.list().map((r) => [r.absPath, r.title]), [["/B", "B"], ["/a", "A"]]);
});

test("noting ignores a missing path, trims long titles and keeps at most the limit", () => {
  const h = harness();
  h.recents.load();
  assert.equal(h.recents.note("", "x"), false);
  assert.equal(h.recents.note(null, "x"), false);
  h.recents.note("/long", "t".repeat(LAST_KNOWN_TITLE_MAX + 10));
  assert.equal(h.recents.list()[0].title.length, LAST_KNOWN_TITLE_MAX);
  for (let i = 0; i < RECENTS_MAX + 5; i++) h.recents.note("/f" + i, "");
  assert.equal(h.recents.list().length, RECENTS_MAX);
  assert.equal(h.recents.list()[0].absPath, "/f" + (RECENTS_MAX + 4));
});

test("a recent is removed by its file id, and an unknown id removes nothing", () => {
  const h = harness([{ absPath: "/a", title: "A", at: 1 }, { absPath: "/b", title: "B", at: 2 }]);
  h.recents.load();
  const [, b] = h.recents.forRenderer();
  assert.equal(h.recents.removeByFileId("nope"), false);
  assert.equal(h.recents.removeByFileId(42), false);
  assert.equal(h.recents.removeByFileId(b.fileId), true);
  assert.deepEqual(h.recents.list().map((r) => r.absPath), ["/a"]);
});

test("clearing reports whether there was anything to clear", () => {
  const h = harness([{ absPath: "/a", title: "A", at: 1 }]);
  h.recents.load();
  assert.equal(h.recents.clear(), true);
  assert.deepEqual(h.recents.list(), []);
  assert.equal(h.recents.clear(), false);
});

test("persisting writes a copy of the list into the stored state", async () => {
  const h = harness();
  h.recents.load();
  h.recents.note("/a", "A");
  assert.equal(await h.recents.persist(), true);
  h.recents.list()[0].title = "changed after";
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][0].title, "A");
  assert.equal(h.state().recents[0].absPath, "/a");
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
