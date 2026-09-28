/* publishToServer() (13-hosted.js) while the upload is in the air (#247, #248).

 * The POST carries a clone of the document taken BEFORE the await, and the
 * page is not locked while it travels: the progress bar does not stop
 * typing, and File ▸ Open, the server picker and New script all still work.
 * So what comes back is an answer about the document that was sent, and two
 * things it used to do regardless of what was on screen now:
 *
 *   #247  re-home the page onto the new server document, rebase it and mark
 *         it clean when the user had already opened ANOTHER document in this
 *         tab — B stayed on screen with A's server id as its home and its
 *         unsaved work marked saved, and its next save went to A's document.
 *   #248  mark the page clean when the user had typed more during the
 *         upload — the server holds the earlier snapshot, the editor said
 *         the newer text was saved, and clearDirty() had also cancelled the
 *         autosave that would have uploaded it.
 *
 * The network is a `fetch` this file replaces, whose POST answer is a
 * promise the test resolves by hand, so "during the upload" is a line of
 * the test rather than a race. No server, no page (there is no #rows here):
 * the document is a small state set on S directly, and the "other document"
 * is the same thing swapped in.
 */
import { dom } from "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { S } = await import("../js/_state.js");
const homeMod = await import("../js/_home.js");
const { setHome } = homeMod;
const { publishToServer, publishAndCopyShareLink } = await import("../js/13-hosted.js");
const { setBaseState, cloneState } = await import("../js/03-sync.js");
const { markDirty, clearDirty } = await import("../js/12-dirty-toast.js");
const { setAutoSaveEnabled } = await import("../js/14-export.js");

/* The few elements the calls under test reach for by id: showToast()'s host
   (nothing reads it back) and the header's file chip, which
   updateFileChip() rewrites whenever a home changes. */
dom.window.document.body.innerHTML =
  '<div id="toast-host"></div>' +
  '<button id="menu-save-back"><span class="menu-item-label"></span></button>' +
  '<span id="file-chip"><span id="file-chip-name"></span><span id="file-chip-state"></span></span>';

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function doc(docId, title, audio) {
  return {
    title, docId, rev: 1, comments: [], productionTags: [], people: [], brollShots: [],
    rows: [{ id: "r1", status: "todo", visualText: "", audioText: audio }]
  };
}

/* Every call the page makes, and a POST that stays in the air until the
   test lets go of it. */
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
/* Lets the awaits between publishToServer() and its POST run. */
const flush = () => new Promise((r) => setImmediate(r));

/* Timers the page sets (autosave, toasts) are recorded, never run: nothing
   here may fire on its own later, and "an autosave was scheduled" is worth
   asserting. */
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

  /* The user opens document B in this tab — a local file — while A's POST
     is still on its way. B has unsaved work of its own. */
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
  assert.equal(S.state.docId, "doc-b");
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
  assert.equal(S.state.docId, "doc-b");
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

  /* B is a server document, so onServerDoc() is true — the caller's own
     "did it end up hosted" test cannot tell it from the one just published,
     and home.id would be B's. */
  const b = doc("doc-b", "B", "bee");
  S.state = b;
  setHome("server", { id: "server-b", rev: 3 });
  setBaseState(cloneState(b), "test: B as the server sent it");
  clearDirty();

  postGate();
  assert.equal(await p, false);
  assert.deepEqual(copied, [], "no link copied, least of all one to B");
});
