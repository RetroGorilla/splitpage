import { dom } from "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { S } = await import("../js/_state.js");
const homeMod = await import("../js/_home.js");
const { setHome } = homeMod;
const { publishToServer, publishAndCopyShareLink, saveToServer } = await import("../js/13-hosted.js");
const { setBaseState, cloneState } = await import("../js/03-sync.js");
const { markDirty, clearDirty } = await import("../js/12-dirty-toast.js");
const { setAutoSaveEnabled, autoSaveTiming } = await import("../js/14-export.js");

dom.window.document.body.innerHTML =
  '<div id="toast-host"></div>' +
  '<button id="menu-save-back"><span class="menu-item-label"></span></button>' +
  '<span id="file-chip"><span id="file-chip-name"></span><span id="file-chip-state"></span></span>';

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

const DOC_IDS = { "doc-a": "d" + "a".repeat(32), "doc-b": "d" + "b".repeat(32) };

function doc(name, title, audio) {
  return {
    title, docId: DOC_IDS[name], rev: 1, comments: [], productionTags: [], people: [], brollShots: [],
    rows: [{ id: "r1", status: "todo", visualText: "", audioText: audio }]
  };
}

let calls;
let postGate;
function stubServer() {
  calls = [];
  postGate = null;
  globalThis.fetch = (url, opts) => {
    const method = (opts && opts.method) || "GET";
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method, body });
    const answer = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "POST") {
      return new Promise((resolve) => { postGate = () => resolve(answer({ id: "server-a", rev: 1 })); });
    }
    if (method === "PUT") return Promise.resolve(answer({ id: "server-a", rev: 2 }));
    return Promise.resolve(answer({}));
  };
}
const flush = () => new Promise((r) => setImmediate(r));

let timers;
function stubTimers() {
  timers = [];
  globalThis.setTimeout = (fn, ms) => { timers.push(ms); return timers.length; };
}

function startOn(state, opts) {
  opts = opts || {};
  S.state = state;
  S.serverMode.readOnly = false;
  S.serverMode.available = true;
  S.docIdWrittenOut = !!opts.written;
  setHome("none");
  setBaseState(cloneState(state), "test: the document as opened");
  clearDirty();
  S.editSeq = 0;
  if (opts.dirty) markDirty();
  stubServer();
  stubTimers();
}

test.beforeEach(() => { setAutoSaveEnabled(true); });
test.after(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  setHome("none");
  S.state = null;
  clearDirty();
});

test("control: an undisturbed publish adopts the server copy and is clean", async () => {
  startOn(doc("doc-a", "A", "one"), { dirty: true });
  const p = publishToServer();
  await flush();
  postGate();
  assert.equal(await p, true);
  assert.equal(homeMod.home.kind, "server");
  assert.equal(homeMod.home.id, "server-a");
  assert.equal(S.dirty, false);
  assert.equal(S.baseState.rows[0].audioText, "one");
});

test("#247: a document opened during the upload keeps its own home, base, id and dirty flag", async () => {
  startOn(doc("doc-a", "A", "one"), { dirty: true });
  const p = publishToServer();
  await flush();
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);

  const b = doc("doc-b", "B", "bee");
  S.state = b;
  const bHome = setHome("file", { handle: { name: "b.md" }, format: "md", name: "b.md" });
  const bBase = setBaseState(cloneState(b), "test: B as opened");
  S.docIdWrittenOut = true;
  S.dirty = true;

  postGate();
  const ok = await p;

  assert.equal(ok, false, "publishToServer says the copy was not adopted");
  assert.equal(homeMod.home, bHome, "B's home is still B's file");
  assert.equal(S.baseState, bBase, "B's base is untouched");
  assert.equal(S.state, b);
  assert.equal(S.state.docId, DOC_IDS["doc-b"]);
  assert.equal(S.dirty, true, "B's unsaved work is still unsaved");
  assert.equal(S.docIdWrittenOut, true);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "nothing was saved anywhere on B's behalf");
});

test("#247: a server document opened during the upload is not re-homed onto the published one", async () => {
  startOn(doc("doc-a", "A", "one"), { dirty: true });
  const p = publishToServer();
  await flush();

  const b = doc("doc-b", "B", "bee");
  S.state = b;
  const bHome = setHome("server", { id: "server-b", rev: 7 });
  const bBase = setBaseState(cloneState(b), "test: B as the server sent it");
  clearDirty();

  postGate();
  assert.equal(await p, false);
  assert.equal(homeMod.home, bHome);
  assert.equal(homeMod.home.id, "server-b");
  assert.equal(homeMod.home.rev, 7);
  assert.equal(S.baseState, bBase);
  assert.equal(S.dirty, false);
});

test("#247: the fork's new id is not put on the document that replaced this one", async () => {
  startOn(doc("doc-a", "A", "one"), { written: true, dirty: true });
  const p = publishToServer();
  await flush();

  const b = doc("doc-b", "B", "bee");
  S.state = b;
  setHome("none");
  setBaseState(cloneState(b), "test: B as opened");
  S.dirty = true;

  postGate();
  assert.equal(await p, false);
  assert.equal(S.state.docId, DOC_IDS["doc-b"]);
});

test("#247: a share link is not made for the document that replaced the one published", async () => {
  startOn(doc("doc-a", "A", "one"), { dirty: true });
  const copied = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } }
  });
  const p = publishAndCopyShareLink();
  await flush();

  const b = doc("doc-b", "B", "bee");
  S.state = b;
  setHome("server", { id: "server-b", rev: 3 });
  setBaseState(cloneState(b), "test: B as the server sent it");
  clearDirty();

  postGate();
  assert.equal(await p, false);
  assert.deepEqual(copied, [], "no link copied, least of all one to B");
});

test("#248: text typed during the upload stays dirty, and the next save carries it", async () => {
  startOn(doc("doc-a", "A", "before"), { dirty: true });
  const p = publishToServer();
  await flush();

  S.state.rows[0].audioText = "typed DURING upload";
  markDirty();

  timers.length = 0;
  postGate();
  assert.equal(await p, true);

  assert.equal(homeMod.home.kind, "server", "the publish itself still succeeded");
  assert.equal(S.dirty, true, "the editor does not claim the newer text is saved");
  assert.equal(S.baseState.rows[0].audioText, "before", "the base is what the server was given");
  assert.ok(timers.includes(autoSaveTiming.hostedIdle), "an autosave to the new server home is scheduled");

  assert.equal(await saveToServer(), true);
  const put = calls.filter((c) => c.method === "PUT")[0];
  assert.ok(put, "a PUT went to the server document");
  assert.equal(put.body.state.rows[0].audioText, "typed DURING upload");
  assert.equal(put.body.baseRev, 1, "judged against the rev the publish came back with");
  assert.equal(S.dirty, false);
});
