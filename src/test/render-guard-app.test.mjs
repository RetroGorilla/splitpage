import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { table304Document } from "../../tests/application/raw-inputs.ts";

await bootApp();

const { liveSession } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { applyMerge, cloneState, pushSnapshot, restoreSnapshotFromCard } = await import("../js/03-sync.js");
const { render } = await import("../js/05-render.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const autosave = await import("../js/14-export.js");
const { openServerDoc } = await import("../js/13-hosted.js");
const { openProjectFile, reloadFileFromDisk } = await import("../js/18-local-files.js");
const { openLongDemo } = await import("../js/18b-file-menu.js");
const { applyTakenDraft } = await import("../js/20g-drafts.js");

const REDRAW = "Couldn't redraw the script after the update. Your changes are saved.";
const BROKE = "render broke (#418)";

const session = liveSession();
const heard = [];
session.subscribe((c) => heard.push(c.kind));
const held = () => session.read((doc) => doc);
const toastHost = () => document.getElementById("toast-host");
const idle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function reply(status, body) {
  return { status: status, ok: status >= 200 && status < 300, redirected: false, headers: { get: () => "application/json" }, json: async () => body };
}

const asked = [];
let answer = () => null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const ask = ((init && init.method) || "GET") + " " + String(url).replace(/^.*?(?=api\/)/, "");
  asked.push(ask);
  return answer(ask) || reply(404, { error: "not-found" });
};

after(() => {
  globalThis.fetch = realFetch;
  closeApp();
});

function toastText(el) {
  return el.classList.contains("has-action") ? el.firstChild.nodeValue : el.textContent;
}

const shown = () => Array.from(toastHost().querySelectorAll(".toast:not(.is-leaving)"));
const redrawToasts = () => shown().filter((el) => toastText(el) === REDRAW);

function breakRender(where) {
  if (where === "early") {
    document.querySelectorAll = function (selector) {
      if (String(selector).indexOf("#rows .gutter-btn") === 0) throw new Error(BROKE);
      return Document.prototype.querySelectorAll.call(this, selector);
    };
    return () => { delete document.querySelectorAll; };
  }
  const box = document.getElementById("doc-title");
  const real = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(box, "value", { configurable: true, get() { return real.get.call(this); }, set() { throw new Error(BROKE); } });
  return () => { delete box.value; };
}

async function logging(run) {
  const consoles = [...new Set([window.console, globalThis.console])];
  const was = consoles.map((c) => c.error);
  const logged = [];
  consoles.forEach((c) => { c.error = (e) => { logged.push((e && e.message) || String(e)); }; });
  let value, threw = null;
  try { value = await run(); } catch (e) { threw = e; } finally { consoles.forEach((c, i) => { c.error = was[i]; }); }
  return { value: value, threw: threw, logged: logged };
}

function quiet() {
  toastHost().textContent = "";
  heard.length = 0;
  asked.length = 0;
}

function fresh(title) {
  window.__hostedTest.setSession({ docId: null });
  answer = () => null;
  S.state = migrateRows(table304Document(title));
  flushEdits();
  render();
  clearDirty();
  S.lastMergeUndo = null;
  for (const id of ["merge-banner", "merge-undo", "merge-review"]) document.getElementById(id).hidden = true;
  document.querySelectorAll("#rows .just-merged").forEach((el) => el.classList.remove("just-merged"));
  quiet();
  return S.state;
}

function bookkeeping() {
  return {
    dirty: S.dirty,
    saveButton: document.getElementById("btn-save").textContent,
    saveStatus: document.getElementById("save-status").textContent,
    halted: autosave.autoSaveHalt,
    timer: autosave.autoSaveIdleTimer !== null,
    banner: document.getElementById("merge-banner").hidden ? null : document.getElementById("merge-summary").textContent,
    review: !document.getElementById("merge-review").hidden,
    undoButton: !document.getElementById("merge-undo").hidden,
    undoPoint: !!S.lastMergeUndo,
    highlighted: Array.from(document.querySelectorAll("#rows .row.just-merged")).map((el) => el.getAttribute("data-id")),
    sessionHoldsIt: held() === S.state,
    heard: heard.slice(),
    server: asked.filter((a) => /^(GET|PUT) api\/docs\//.test(a)),
    title: S.state.title,
    rows: S.state.rows.map((r) => r.audioText),
    toasts: shown().map(toastText).filter((t) => t !== REDRAW).map((t) => t.replace(/\d+/g, "#"))
  };
}

async function bothWays(where, prepare, run, how = "late") {
  const seen = [];
  for (const broken of [false, true]) {
    const ctx = await prepare();
    const label = where + (broken ? ", render throwing " + how : ", clean");
    const unbreak = broken ? breakRender(how) : () => {};
    let out;
    try { out = await logging(() => run(ctx)); } finally { unbreak(); }
    await idle();
    assert.equal(out.threw, null, label + " threw: " + (out.threw && out.threw.stack));
    assert.deepEqual(out.logged, broken ? [BROKE] : [], label + ": logged");
    assert.equal(redrawToasts().length, broken ? 1 : 0, label + ": the redraw toast");
    seen.push({ value: out.value, book: bookkeeping(), more: ctx && ctx.observe ? ctx.observe() : null });
  }
  assert.deepEqual(seen[1], seen[0], where + ": with render throwing, the same bookkeeping as a clean render");
  window.__hostedTest.setSession({ docId: null });
  return seen[0];
}

function serverMerge() {
  const doc = fresh("Guard");
  window.__hostedTest.setSession({ docId: "doc-guard", rev: 1 });
  answer = (ask) => ask === "PUT api/docs/doc-guard" ? reply(200, { id: "doc-guard", rev: 2 }) : null;
  quiet();
  const base = cloneState(doc);
  const mine = cloneState(doc);
  mine.rows[0].audioText = "Mine.";
  mine.rows[1].audioText = "Mine too.";
  const theirs = cloneState(doc);
  theirs.rows[0].audioText = "Theirs.";
  theirs.title = "Theirs";
  return { base: base, mine: mine, theirs: theirs, undoPoint: cloneState(doc), observe: () => window.__hostedTest.home().rev };
}

function mergeOn(ctx) {
  const out = applyMerge({ base: ctx.base, mine: ctx.mine, theirs: ctx.theirs, source: "server-conflict", report: true, undoPoint: ctx.undoPoint });
  return { stats: out.result.stats, conflicts: out.result.conflicts.map((c) => c.rowId + "." + c.field) };
}

for (const how of ["late", "early"]) {
  test("a merge whose render throws (" + how + ") still reports the merge, marks it unsaved and saves it, as a clean merge does, and logs the error (#418)", async () => {
    const seen = await bothWays("server-conflict merge", serverMerge, mergeOn, how);
    assert.ok(seen.book.banner, "the merge was reported");
    assert.deepEqual(seen.book.highlighted, ["r1"], "the conflicting row is highlighted");
    assert.equal(seen.book.undoButton, true);
    assert.ok(seen.book.server.includes("PUT api/docs/doc-guard"), "the merged document was saved: " + JSON.stringify(seen.book.server));
    assert.equal(seen.more, 2);
  });
}

test("a recovery merge whose render throws still reports the merge, marks it unsaved and pauses autosave, as a clean one does (#418)", async () => {
  const seen = await bothWays("recovery merge", () => {
    const doc = fresh("Recovered");
    const mine = cloneState(doc);
    mine.rows[1].audioText = "Typed before the reload.";
    const theirs = cloneState(doc);
    theirs.rows[0].audioText = "Theirs.";
    return { base: cloneState(doc), mine: mine, theirs: theirs };
  }, (ctx) => {
    applyMerge({ base: ctx.base, mine: ctx.mine, theirs: ctx.theirs, source: "server-resume", report: true, noAutoSave: true });
  });
  assert.equal(seen.book.dirty, true);
  assert.ok(seen.book.banner);
  assert.match(seen.book.halted, /^Autosave is paused/);
  assert.deepEqual(seen.book.heard, ["recovery"]);
});

test("a server update whose render throws still takes the new rev, reports the merge and says whose changes came in (#418)", async () => {
  const seen = await bothWays("server update", () => {
    const doc = fresh("Pulled");
    window.__hostedTest.setSession({ docId: "doc-pull", rev: 1 });
    const theirs = cloneState(doc);
    theirs.rows[0].audioText = "Theirs, pulled.";
    answer = (ask) => ask === "GET api/docs/doc-pull" ? reply(200, { id: "doc-pull", rev: 2, state: theirs, updatedBy: "Ann" }) : null;
    quiet();
    return { observe: () => window.__hostedTest.home().rev };
  }, async () => {
    window.__hostedTest.noteRev({ docId: "doc-pull", rev: 2 });
    await idle();
  });
  assert.deepEqual(seen.book.heard, ["server"]);
  assert.deepEqual(seen.book.toasts, ["Merged in changes from Ann"]);
  assert.ok(seen.book.banner);
  assert.equal(seen.more, 2);
});

let disk = null;
const fileHandle = { kind: "file", name: "guard.txt", getFile: async () => disk };

test("a reload in place whose render throws still marks the reload unsaved and says it reloaded (#418)", async () => {
  const seen = await bothWays("reload", async () => {
    fresh("Before reload");
    disk = new File(["Wide\tOne.\nClose\tTwo."], "guard.txt", { lastModified: 1 });
    await openProjectFile(disk, fileHandle, { skipSnapshot: true });
    flushEdits();
    quiet();
    disk = new File(["# Reloaded\n\nWide\tOne, again.\nClose\tTwo.\nTight\tThree."], "guard.txt", { lastModified: 2 });
    return null;
  }, () => reloadFileFromDisk());
  assert.deepEqual(seen.book.heard, ["reload"]);
  assert.equal(seen.book.title, "Reloaded");
  assert.deepEqual(seen.book.toasts, ["Reloaded guard.txt — # rows"]);
  assert.equal(seen.book.dirty, true);
});

test("a draft adoption whose render throws is applied and marked unsaved, not reported as failed with the draft already on screen (#418)", async () => {
  const seen = await bothWays("draft adoption", () => { fresh("Before the draft"); return null; },
    () => applyTakenDraft({ header: { origin: { kind: "untitled" } }, stateJson: JSON.stringify(table304Document("Draft")) }));
  assert.equal(seen.value, "applied");
  assert.equal(seen.book.title, "Draft");
  assert.equal(seen.book.dirty, true);
  assert.equal(seen.book.toasts.length, 1);
  assert.match(seen.book.toasts[0], /^Restored your unsaved script/);
});

test("a draft of an imported file whose render throws still opens as an unsaved copy and is marked unsaved (#418)", async () => {
  const seen = await bothWays("import draft", () => { fresh("Before the import draft"); return null; },
    () => applyTakenDraft({ header: { origin: { kind: "import", importName: "notes.txt" } }, stateJson: JSON.stringify(table304Document("Imported draft")) }));
  assert.equal(seen.value, "untitled-copy");
  assert.equal(seen.book.title, "Imported draft");
  assert.equal(seen.book.dirty, true);
  assert.equal(seen.book.toasts.length, 1);
  assert.match(seen.book.toasts[0], /^Your unsaved changes to notes\.txt were recovered/);
});

test("a new blank script whose render throws still replaces the document, as a clean one does (#418)", async () => {
  const seen = await bothWays("new blank script", () => { fresh("Before the blank"); return { observe: () => S.baseState && S.baseState.docId === S.state.docId }; }, async () => {
    document.querySelector('#newtab-page [data-newtab-action="new"]').click();
    await idle();
  });
  assert.equal(seen.more, true);
  assert.notEqual(seen.book.title, "Before the blank");
  assert.deepEqual(seen.book.heard, ["adopt"]);
  assert.equal(seen.book.dirty, false);
});

test("reopening a server document after a reload whose render throws still reopens it and says so (#418)", async () => {
  const { SERVER_RESUME_KEY, finishServerDetect } = await import("../js/13-hosted.js");
  const seen = await bothWays("server reopen", () => {
    fresh("Before the reopen");
    sessionStorage.setItem(SERVER_RESUME_KEY, JSON.stringify({ id: "doc-again", rev: 1 }));
    answer = (ask) => ask === "GET api/me" ? reply(200, { role: "edit" })
      : ask === "GET api/docs/doc-again" ? reply(200, { id: "doc-again", rev: 2, state: table304Document("Again") }) : null;
    quiet();
    return { observe: () => [window.__hostedTest.home().kind, window.__hostedTest.home().id, sessionStorage.getItem(SERVER_RESUME_KEY)] };
  }, async () => {
    await finishServerDetect();
    await idle();
  });
  assert.deepEqual(seen.more, ["server", "doc-again", null]);
  assert.equal(seen.book.title, "Again");
  assert.deepEqual(seen.book.toasts, ["Signed back in — reopened Again"]);
});

test("opening a .splitpage file whose render throws still opens it: the chips, the toast and the answer are a clean open's (#418)", async () => {
  const seen = await bothWays("open file", () => { fresh("Before the file"); return null; },
    () => openProjectFile(new File([JSON.stringify(table304Document("From disk"))], "guard.splitpage", { lastModified: 3 }), null, { skipSnapshot: true }));
  assert.equal(seen.value, true);
  assert.equal(seen.book.title, "From disk");
  assert.equal(seen.book.dirty, false);
  assert.deepEqual(seen.book.toasts, ["Opened From disk — # rows, # comment"]);
});

test("opening a server document whose render throws still opens it and says so (#418)", async () => {
  const seen = await bothWays("server open", () => {
    fresh("Before the server");
    answer = (ask) => ask === "GET api/docs/doc-open" ? reply(200, { id: "doc-open", rev: 4, state: table304Document("Hosted") }) : null;
    quiet();
    return { observe: () => [window.__hostedTest.home().kind, window.__hostedTest.home().id] };
  }, () => openServerDoc("doc-open"));
  assert.equal(seen.value, true);
  assert.deepEqual(seen.more, ["server", "doc-open"]);
  assert.deepEqual(seen.book.toasts, ["Opened Hosted from the server — # scenes"]);
});

test("restoring a snapshot whose render throws still restores it, closes the history and says so (#418)", async () => {
  const seen = await bothWays("restore", async () => {
    const doc = fresh("Before restore");
    const older = cloneState(doc);
    older.rows[0].audioText = "Older.";
    const ticket = pushSnapshot("Guard snapshot", older);
    await ticket.done;
    quiet();
    const btn = document.createElement("button");
    btn.setAttribute("data-id", ticket.id);
    return { btn: btn };
  }, (ctx) => restoreSnapshotFromCard(ctx.btn));
  assert.equal(seen.value, "restored");
  assert.equal(seen.book.rows[0], "Older.");
  assert.equal(seen.book.dirty, true);
  assert.equal(seen.book.toasts.length, 1);
  assert.match(seen.book.toasts[0], /^Restored the version from /);
});

test("opening the long demo whose render throws still opens it as a new, saved-nowhere document (#418)", async () => {
  const seen = await bothWays("long demo", () => { fresh("Before the demo"); return null; }, () => openLongDemo());
  assert.equal(seen.value, true);
  assert.equal(seen.book.toasts.length, 1);
  assert.match(seen.book.toasts[0], /^The long demo — # scenes/);
});

test("the redraw toast is a sticky error with a Redraw button: Redraw while render still throws logs it and offers it once more, and Redraw after the fault draws the update (#418)", async () => {
  const doc = fresh("Redraw");
  const theirs = cloneState(doc);
  theirs.title = "Redrawn";
  theirs.rows[0].audioText = "Theirs, redrawn.";
  const cell = () => document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
  const unbreak = breakRender("early");
  try {
    const first = await logging(() => applyMerge({ theirs: theirs, source: "server-conflict", unchanged: true, report: false }));
    assert.equal(first.threw, null);
    assert.deepEqual(first.logged, [BROKE]);
    assert.equal(held(), S.state);
    assert.equal(S.state.title, "Redrawn");
    assert.notEqual(document.getElementById("doc-title").value, "Redrawn", "nothing was drawn");
    const toasts = redrawToasts();
    assert.equal(toasts.length, 1);
    assert.ok(toasts[0].classList.contains("error"));
    assert.ok(toasts[0].classList.contains("is-sticky"));
    assert.equal(toasts[0].querySelector(".toast-action").textContent, "Redraw");
    const second = await logging(() => applyMerge({ theirs: cloneState(theirs), source: "server-conflict", unchanged: true, report: false }));
    assert.deepEqual(second.logged, [BROKE]);
    assert.equal(redrawToasts().length, 1, "a second failure while the toast is up does not stack another");
    const again = await logging(() => redrawToasts()[0].querySelector(".toast-action").click());
    assert.deepEqual(again.logged, [BROKE], "Redraw retried render and it threw again");
    assert.equal(redrawToasts().length, 1, "and the toast is offered again");
  } finally {
    unbreak();
  }
  const fixed = await logging(() => redrawToasts()[0].querySelector(".toast-action").click());
  assert.deepEqual(fixed.logged, []);
  assert.equal(redrawToasts().length, 0);
  assert.equal(document.getElementById("doc-title").value, "Redrawn");
  assert.equal(cell().textContent, "Theirs, redrawn.");
});
