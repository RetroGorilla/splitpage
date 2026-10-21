import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { readBuiltCss } from "../../tools/css-colours.mjs";
import { S } from "../js/_state.js";
import { table304Document } from "../../tests/application/raw-inputs.ts";
import { cloneState } from "../core/document/clone.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { liveSession } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { applyMerge, pushSnapshot, restoreSnapshotFromCard } = await import("../js/03-sync.js");
const { renderAbsorbed, syncFieldFromDom } = await import("../js/05-render.js");
const { editCell, openCellEdit } = await import("../js/05b-cell-edit.js");
const { cellSelection } = await import("../features/editing/cell-selection.ts");
const { pasteIntoCell } = await import("../js/05c-clipboard.js");
const annotate = await import("../js/05w-annotate.js");
const { flushEdits, lastUndoEntry, nextRedoEntry, undo, undoSizes } = await import("../js/12a-undo.js");
const writer = await import("../js/19-writer.js");
const { focusMemory, mergeUndo } = await import("../legacy/editor-bridge.ts");
const find = await import("../js/09-find-replace.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const autosave = await import("../js/14-export.js");
const { openServerDoc } = await import("../js/13-hosted.js");
const { openProjectFile, reloadFileFromDisk, updateFileChip } = await import("../js/18-local-files.js");
const { openLongDemo } = await import("../js/18b-file-menu.js");
const { applyTakenDraft } = await import("../js/20g-drafts.js");

const REDRAW = "Could not redraw the script after the update. Nothing was lost — press Redraw before you keep editing.";
const BROKE = "render broke (#418)";

const session = liveSession();
const heard = [];
let stopHearing = session.subscribe((c) => heard.push(c.kind));

function hearReplacement() {
  stopHearing();
  stopHearing = session.subscribe((c) => heard.push(c.kind));
}
const held = () => session.read((doc) => doc);
const toastHost = () => document.getElementById("toast-host");
const announced = [];
const toastWatch = new window.MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) if (n.classList && n.classList.contains("toast")) announced.push(n);
});
toastWatch.observe(toastHost(), { childList: true });
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
  toastWatch.disconnect();
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
  toastWatch.takeRecords();
  announced.length = 0;
  heard.length = 0;
  asked.length = 0;
}

function fresh(title) {
  window.__hostedTest.setSession({ docId: null });
  answer = () => null;
  S.state = migrateRows(table304Document(title));
  flushEdits();
  renderAbsorbed();
  clearDirty();
  updateFileChip();
  document.getElementById("identity-name").textContent = "Stale name";
  mergeUndo().arm(null);
  for (const id of ["merge-banner", "merge-undo", "merge-review"]) document.getElementById(id).hidden = true;
  document.querySelectorAll("#rows .just-merged").forEach((el) => el.classList.remove("just-merged"));
  quiet();
  return S.state;
}

function chipText(chipId, partIds) {
  const chip = document.getElementById(chipId);
  return chip.hidden ? null : partIds.map((id) => document.getElementById(id).textContent).join(" ");
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
    undoPoint: !!mergeUndo().last(),
    highlighted: Array.from(document.querySelectorAll("#rows .row.just-merged")).map((el) => el.getAttribute("data-id")),
    sessionHoldsIt: held() === S.state,
    fileChip: chipText("file-chip", ["file-chip-name", "file-chip-state"]),
    identityChip: chipText("identity-chip", ["identity-name"]),
    heard: heard.slice(),
    server: asked.filter((a) => /^(GET|PUT) api\/docs\//.test(a)),
    title: S.state.title,
    rows: S.state.rows.map((r) => r.audioText),
    toasts: announced.map(toastText).filter((t) => t !== REDRAW).map((t) => t.replace(/\d+/g, "#"))
  };
}

async function bothWays(where, prepare, run, how = "late", renders = 1) {
  const seen = [];
  for (const broken of [false, true]) {
    const ctx = await prepare();
    const label = where + (broken ? ", render throwing " + how : ", clean");
    const unbreak = broken ? breakRender(how) : () => {};
    let out;
    try { out = await logging(() => run(ctx)); } finally { unbreak(); }
    await idle();
    assert.equal(out.threw, null, label + " threw: " + (out.threw && out.threw.stack));
    assert.deepEqual(out.logged, broken ? Array(renders).fill(BROKE) : [], label + ": logged");
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
    hearReplacement();
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
  assert.deepEqual(seen.book.heard, [], "the replaced script's listeners hear nothing of the new one (4.8)");
  assert.equal(seen.book.sessionHoldsIt, true);
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
  assert.equal(seen.book.fileChip, "On the server · v4, everyone sees this");
  assert.notEqual(seen.book.identityChip, "Stale name");
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

test("a redraw toast still on screen goes away when a later update draws cleanly, and a toast of another kind stays (#418)", async () => {
  const doc = fresh("Stale toast");
  const theirs = cloneState(doc);
  theirs.title = "Drawn later";
  const unbreak = breakRender("early");
  try {
    await logging(() => applyMerge({ theirs: theirs, source: "server-conflict", unchanged: true, report: false }));
  } finally {
    unbreak();
  }
  assert.equal(redrawToasts().length, 1);
  const other = document.createElement("div");
  other.className = "toast ok";
  other.textContent = "Another toast";
  toastHost().appendChild(other);
  const clean = await logging(() => applyMerge({ theirs: cloneState(theirs), source: "server-conflict", unchanged: true, report: false }));
  assert.deepEqual(clean.logged, []);
  assert.equal(document.getElementById("doc-title").value, "Drawn later");
  assert.equal(redrawToasts().length, 0, "the redraw toast is gone after a clean draw");
  assert.ok(shown().includes(other), "another toast is untouched");
  const unbreakAgain = breakRender("early");
  try {
    await logging(() => applyMerge({ theirs: cloneState(theirs), source: "server-conflict", unchanged: true, report: false }));
  } finally {
    unbreakAgain();
  }
  assert.equal(redrawToasts().length, 1, "a later failure offers Redraw again");
});

test("a desktop file draft over an untouched file whose render throws still restores the changes and marks them unsaved (#418)", async () => {
  const { setHome } = await import("../js/_home.js");
  const seen = await bothWays("file draft", () => {
    fresh("Before the file draft");
    const disk = table304Document("On disk");
    const mine = table304Document("On disk");
    mine.rows[0].audioText = "Typed before the crash.";
    const was = S.DESKTOP;
    S.DESKTOP = {
      readFile: async () => {
        S.DESKTOP = was;
        return { name: "guard.splitpage", bytes: new TextEncoder().encode(JSON.stringify(disk)), lastModified: 5 };
      }
    };
    return {
      draft: { header: { origin: { kind: "file", fileName: "guard.splitpage" }, docIdWrittenOut: true }, stateJson: JSON.stringify(mine), baseJson: JSON.stringify(disk), file: { id: "f-guard", name: "guard.splitpage" } },
      observe: () => { const book = S.dirty; clearDirty(); setHome("none"); return book; }
    };
  }, (ctx) => applyTakenDraft(ctx.draft), "late", 2);
  assert.equal(seen.value, "applied");
  assert.equal(seen.more, true);
  assert.equal(seen.book.rows[0], "Typed before the crash.");
  assert.equal(seen.book.toasts.length, 1);
  assert.match(seen.book.toasts[0], /^Restored your unsaved changes to On disk/);
});

const STALE_PARTS = ["#rows", ".add-row-bar", "#doc-title", "#writer-title", "#writer-doc", "#writer .wr-fmt",
  "#replace-input", "#find-replace", "#find-replace-all", "#find-tag-go", "#tag-ghost", "#tag-suggest"];
const THEIRS = "Theirs, not drawn yet.";
const cellOf = (id, field, root = "#rows") => document.querySelector(root + ' .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const inertParts = () => STALE_PARTS.flatMap((sel) => Array.from(document.querySelectorAll(sel)).map((el) => [sel, el.hasAttribute("inert")]));
const dimmedParts = () => STALE_PARTS.flatMap((sel) => Array.from(document.querySelectorAll(sel)).map((el) => [sel, el.classList.contains("is-stale-part")]));

function textNodes(el) {
  const walker = document.createTreeWalker(el, 4);
  const out = [];
  while (walker.nextNode()) out.push(walker.currentNode);
  return out;
}

function select(el, from, to) {
  const node = textNodes(el)[0];
  const r = document.createRange();
  r.setStart(node, from);
  r.setEnd(node, to === undefined ? from : to);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function typeChar(el, ch) {
  el.focus();
  const nodes = textNodes(el);
  const node = nodes[nodes.length - 1];
  node.data += ch;
  const r = document.createRange();
  r.setStart(node, node.data.length);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
}

function key(el, name, mods) {
  el.dispatchEvent(new window.KeyboardEvent("keydown", Object.assign({ key: name, bubbles: true, cancelable: true }, mods || {})));
}

function carrying(type, el, field, data) {
  const store = Object.assign({}, data);
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, field, {
    value: { getData: (t) => store[t] || "", setData: (t, v) => { store[t] = v; }, files: [], types: Object.keys(store) }
  });
  el.dispatchEvent(ev);
}

function retitle(el, value) {
  el.focus();
  el.value = value;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function findAndReplace(needle, replacement) {
  find.openFindBar();
  document.getElementById("find-input").value = needle;
  document.getElementById("find-input").dispatchEvent(new window.Event("input", { bubbles: true }));
  document.getElementById("replace-input").value = replacement;
}

function editState() {
  return {
    doc: JSON.stringify(S.state),
    undo: undoSizes(),
    top: JSON.stringify(lastUndoEntry() || null),
    redo: JSON.stringify(nextRedoEntry() || null),
    dirty: S.dirty,
    saving: autosave.autoSaveIdleTimer,
    heard: heard.slice()
  };
}

const untimed = (s) => Object.assign({}, s, { saving: null });

function sameEdits(now, before, label) {
  assert.equal(now.saving, before.saving, label + ": autosave");
  assert.deepEqual(untimed(now), untimed(before), label);
}

async function staleScreen(setup, change) {
  fresh("Stale screen");
  if (setup) await setup();
  const theirs = cloneState(S.state);
  theirs.title = "Theirs";
  if (change) change(theirs);
  else theirs.rows[1].audioText = THEIRS;
  const unbreak = breakRender("early");
  let out;
  try {
    out = await logging(() => applyMerge({ theirs: theirs, source: "server-conflict", unchanged: true, report: false }));
  } finally {
    unbreak();
  }
  await idle();
  assert.deepEqual(out.logged, [BROKE]);
  if (!change) assert.equal(S.state.rows[1].audioText, THEIRS);
  assert.notEqual(cellOf("r2", "audioText").textContent.indexOf("Mara mends nets."), -1, "r2 still shows the old text");
  assert.equal(redrawToasts().length, 1);
}

async function pressRedraw() {
  const out = await logging(() => redrawToasts()[0].querySelector(".toast-action").click());
  await idle();
  assert.deepEqual(out.logged, []);
  assert.equal(redrawToasts().length, 0);
}

function typedOnce() {
  typeChar(cellOf("r1", "visualText"), "!");
  flushEdits();
  assert.equal(undoSizes().undo, 1);
}

const inWriter = (id) => cellOf(id, "audioText", "#writer-doc");
const openTheWriter = () => { writer.openWriter(); };
const closeTheWriter = () => { if (writer.writerOpen) writer.closeWriter(); };
const rowsInert = () => document.getElementById("rows").hasAttribute("inert");

const EDITS = [
  { name: "typing into the scene the update changed", act: () => typeChar(cellOf("r2", "audioText"), "x") },
  { name: "pasting into a cell", act: () => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 5); carrying("paste", c, "clipboardData", { "text/plain": "Pasted " }); } },
  { name: "cutting from a cell", act: () => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 0, 6); carrying("cut", c, "clipboardData", {}); } },
  { name: "dropping text on a cell", act: () => carrying("drop", cellOf("r1", "audioText"), "dataTransfer", { "text/plain": "Dropped " }) },
  { name: "splitting a scene (Alt+Enter)", act: () => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 6); key(c, "Enter", { altKey: true }); } },
  { name: "moving a scene (Alt+Up)", act: () => { const c = cellOf("r2", "audioText"); c.focus(); select(c, 2); key(c, "ArrowUp", { altKey: true }); } },
  { name: "adding a scene (Ctrl+Enter)", act: () => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 2); key(c, "Enter", { ctrlKey: true }); } },
  { name: "a line break (Enter)", act: () => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 6); key(c, "Enter"); } },
  { name: "bold (Ctrl+B)", act: () => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 0, 5); key(c, "b", { ctrlKey: true }); } },
  { name: "the cell toolbar's Bold", act: () => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 0, 5); c.closest(".field-wrap").querySelector('.mini-toolbar [data-cmd="bold"]').click(); } },
  { name: "the add-scene bar", act: () => document.querySelector(".add-row-bar .add-row-btn").click() },
  { name: "typing a title", act: () => retitle(document.getElementById("doc-title"), "Typed title") },
  { name: "undo (Ctrl+Z)", setup: typedOnce, act: () => key(document.body, "z", { ctrlKey: true }) },
  { name: "redo (Ctrl+Y)", setup: () => { typedOnce(); undo(); }, act: () => key(document.body, "y", { ctrlKey: true }) },
  { name: "redo (Ctrl+Shift+Z)", setup: () => { typedOnce(); undo(); }, act: () => key(document.body, "Z", { ctrlKey: true, shiftKey: true }) },
  { name: "Replace in the find bar", act: () => { findAndReplace("Wide", "Far"); document.getElementById("find-replace").click(); }, teardown: () => find.closeFindBar() },
  { name: "Enter in the find bar's replace box", act: () => { findAndReplace("Wide", "Far"); key(document.getElementById("replace-input"), "Enter"); }, teardown: () => find.closeFindBar() },
  { name: "Replace all", act: () => { findAndReplace("Wide", "Far"); document.getElementById("find-replace-all").click(); }, teardown: () => find.closeFindBar() },
  { name: "Tag all as… in the find bar", act: () => { findAndReplace("Wide", ""); find.openBulkTag(); find.pickBulkTagCat("prop"); document.getElementById("find-tag-go").click(); }, teardown: () => find.closeFindBar() },
  { name: "typing in the Writer", setup: openTheWriter, act: () => typeChar(inWriter("r1"), "x"), teardown: closeTheWriter, closeRedraws: true },
  { name: "a new scene in the Writer (Enter)", setup: openTheWriter, act: () => { const p = inWriter("r1"); p.focus(); select(p, 6); key(p, "Enter"); }, teardown: closeTheWriter, closeRedraws: true },
  { name: "joining scenes in the Writer (Backspace)", setup: openTheWriter, act: () => { const p = inWriter("r2"); p.focus(); select(p, 0); key(p, "Backspace"); }, teardown: closeTheWriter, closeRedraws: true },
  { name: "the Writer's Bold", setup: openTheWriter, act: () => { const p = inWriter("r1"); p.focus(); select(p, 0, 5); focusMemory().focusedParagraph(p); document.querySelector('#writer .wr-fmt[data-cmd="bold"]').click(); }, teardown: closeTheWriter, closeRedraws: true },
  { name: "typing the Writer's title", setup: openTheWriter, act: () => retitle(document.getElementById("writer-title"), "Writer title"), teardown: closeTheWriter, closeRedraws: true }
];

for (const edit of EDITS) {
  test("while the screen is stale after a failed render, " + edit.name + " is refused and changes nothing; after Redraw it edits (#443)", async () => {
    try {
      await staleScreen(edit.setup);
      const before = editState();
      const refused = await logging(async () => { await edit.act(); await idle(); });
      assert.equal(refused.threw, null, edit.name + " threw: " + (refused.threw && refused.threw.stack));
      assert.deepEqual(refused.logged, []);
      sameEdits(editState(), before, edit.name + " on the stale screen");
      assert.equal(redrawToasts().length, 1, "Redraw is still offered");
      if (edit.teardown) edit.teardown();
      if (edit.closeRedraws) assert.deepEqual([redrawToasts().length, rowsInert()], [0, false], "closing the Writer redraws through the guard (#458)");
      else await pressRedraw();
      const drawn = editState();
      const allowed = await logging(async () => { await edit.act(); await idle(); });
      assert.equal(allowed.threw, null, edit.name + " threw after Redraw: " + (allowed.threw && allowed.threw.stack));
      const now = editState();
      assert.ok(now.saving !== drawn.saving || !isDeepStrictEqual(untimed(now), untimed(drawn)), edit.name + " edits once the screen is redrawn");
    } finally {
      if (edit.teardown) edit.teardown();
    }
  });
}

test("a stale screen makes the script, the titles and the editing controls inert and moves the focus from the script to Redraw, which keeps it until a Redraw draws and then gives it back (#443)", async () => {
  await staleScreen(() => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 3, 7); });
  const parts = inertParts();
  assert.equal(parts.length, STALE_PARTS.length + 4, "every part is on the page: " + JSON.stringify(parts));
  assert.deepEqual(parts.filter((p) => !p[1]), [], "every part is inert");
  assert.deepEqual(dimmedParts().filter((p) => !p[1]), [], "every part is dimmed");
  const toast = redrawToasts()[0];
  assert.equal(toast.getAttribute("role"), "alert");
  assert.equal(toast.hasAttribute("title"), false);
  assert.equal(document.activeElement, toast.querySelector(".toast-action"));
  toast.click();
  await idle();
  assert.deepEqual(redrawToasts(), [toast], "clicking the message does not dismiss it: only a Redraw that draws does");
  const unbreak = breakRender("early");
  let failed;
  try {
    failed = await logging(() => document.activeElement.click());
  } finally {
    unbreak();
  }
  assert.deepEqual(failed.logged, [BROKE]);
  const again = redrawToasts();
  assert.equal(again.length, 1);
  assert.equal(document.activeElement, again[0].querySelector(".toast-action"), "the focus moves to the Redraw offered again");
  assert.deepEqual(inertParts().filter((p) => !p[1]), [], "still inert");
  await pressRedraw();
  assert.deepEqual(inertParts().filter((p) => p[1]), [], "nothing is inert once Redraw draws");
  assert.deepEqual(dimmedParts().filter((p) => p[1]), [], "nothing is dimmed once Redraw draws");
  assert.equal(document.activeElement, cellOf("r1", "audioText"), "the focus is back in the cell it left");
  assert.deepEqual(cellSelection(cellOf("r1", "audioText")), { from: 14, to: 14 }, "with the caret at its end, not the selection it had");
  assert.equal(cellOf("r2", "audioText").textContent.indexOf(THEIRS), 0);
});

function caretAtEnd(cell, end, label) {
  assert.equal(document.activeElement, cell, label + ": the focus is in the scene's cell");
  assert.equal(window.getSelection().toString(), "", label + ": nothing is selected");
  assert.deepEqual(cellSelection(cell), { from: end, to: end }, label + ": a collapsed caret at the end");
}

const noCellFocused = () => !(document.activeElement && document.activeElement.closest && document.activeElement.closest(".cell-editable"));

function nothingInHiddenWriter() {
  const sel = window.getSelection();
  assert.ok(!sel.rangeCount || !document.getElementById("writer").contains(sel.getRangeAt(0).startContainer), "no range is in the hidden Writer");
  assert.ok(!document.getElementById("writer").contains(document.activeElement), "nothing in the hidden Writer has the focus");
}

const WRITER_CLOSED = [
  {
    name: "a cell the update left as it was gets a caret at its end, not the old selection",
    setup: () => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 3, 7); },
    check: () => caretAtEnd(cellOf("r1", "audioText"), 14, "unchanged cell")
  },
  {
    name: "a cell the update rewrote gets a caret at its end, so no range covers the collaborator's text",
    setup: () => { const c = cellOf("r2", "audioText"); c.focus(); select(c, 3, 7); },
    check: () => {
      assert.equal(cellOf("r2", "audioText").textContent.indexOf(THEIRS), 0);
      caretAtEnd(cellOf("r2", "audioText"), THEIRS.length, "rewritten cell");
    }
  },
  {
    name: "a cell where the update only added a line break before the selected words gets a caret at its end, so no range covers the line break",
    setup: () => { const c = cellOf("r2", "audioText"); c.focus(); select(c, 5, 10); },
    change: (t) => { t.rows[1].audioText = "Mara <br>mends nets."; },
    check: () => {
      assert.equal(cellOf("r2", "audioText").querySelectorAll("br").length, 1, "the line break is drawn");
      caretAtEnd(cellOf("r2", "audioText"), 17, "line break");
    }
  },
  {
    name: "a cell whose scene the update removed: nothing is focused and nothing throws",
    setup: () => { const c = cellOf("r2", "audioText"); c.focus(); select(c, 5, 10); },
    change: (t) => { t.rows.splice(1, 1); },
    check: () => {
      assert.equal(cellOf("r2", "audioText"), null);
      assert.ok(noCellFocused(), "no cell has the focus");
    }
  },
  {
    name: "a Writer paragraph, with the Writer closed since, gets the scene's narration cell with a caret at its end",
    setup: () => { openTheWriter(); const p = inWriter("r1"); p.focus(); select(p, 3, 7); },
    closeWriter: true,
    check: () => caretAtEnd(cellOf("r1", "audioText"), 14, "Writer paragraph")
  },
  {
    name: "a Writer paragraph whose scene the update removed, with the Writer closed since: nothing is focused",
    setup: () => { openTheWriter(); const p = inWriter("r2"); p.focus(); select(p, 3, 7); },
    change: (t) => { t.rows.splice(1, 1); },
    closeWriter: true,
    check: () => assert.ok(noCellFocused(), "no cell has the focus")
  }
];

for (const place of WRITER_CLOSED) {
  test("Redraw with the Writer closed: " + place.name + " (#443)", async () => {
    try {
      await staleScreen(place.setup, place.change);
      assert.equal(document.activeElement, redrawToasts()[0].querySelector(".toast-action"));
      if (place.closeWriter) {
        closeTheWriter();
        assert.deepEqual([redrawToasts().length, rowsInert()], [0, false], "closing the Writer redraws through the guard (#458)");
      } else {
        await pressRedraw();
      }
      place.check();
      nothingInHiddenWriter();
    } finally {
      closeTheWriter();
    }
  });
}

const WRITER_OPEN = [
  {
    name: "a cell in the script, with the Writer opened since",
    setup: () => { const c = cellOf("r1", "audioText"); c.focus(); select(c, 3, 7); },
    openWriter: true
  },
  {
    name: "a Writer paragraph the update left as it was",
    setup: () => { openTheWriter(); const p = inWriter("r1"); p.focus(); select(p, 3, 7); }
  }
];

for (const place of WRITER_OPEN) {
  test("Redraw with the Writer open leaves the focus to the Writer's own trap, which keeps it inside the Writer, and restores no range: " + place.name + " (#443)", async () => {
    try {
      await staleScreen(place.setup);
      if (place.openWriter) {
        openTheWriter();
        redrawToasts()[0].querySelector(".toast-action").focus();
      }
      await pressRedraw();
      const active = document.activeElement;
      assert.notEqual(active, document.body, "the focus is not left on the page");
      assert.ok(document.getElementById("writer").contains(active), "the focus is inside the Writer");
      assert.equal(window.getSelection().toString(), "", "no old range is put back");
      const sel = window.getSelection();
      assert.ok(!sel.rangeCount || !document.getElementById("rows").contains(sel.getRangeAt(0).startContainer), "no range is left in the script under the Writer");
    } finally {
      closeTheWriter();
    }
  });
}

const WRITER_CLOSES = [
  { name: "its close button", close: () => document.getElementById("wr-close").click() },
  { name: "Escape", close: () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })) },
  { name: "closeWriter", close: () => writer.closeWriter() }
];

for (const how of WRITER_CLOSES) {
  test("closing the Writer by " + how.name + " redraws through the guard: a redraw that throws is caught, offers Redraw and holds the part-drawn script (#458)", async () => {
    fresh("Writer close");
    try {
      openTheWriter();
      const p = inWriter("r1");
      p.focus();
      select(p, 2);
      const before = editState();
      const unbreak = breakRender("early");
      let out;
      try {
        out = await logging(() => how.close());
      } finally {
        unbreak();
      }
      assert.equal(out.threw, null, out.threw && out.threw.stack);
      assert.deepEqual(out.logged, [BROKE]);
      assert.equal(writer.writerOpen, false);
      assert.equal(document.getElementById("writer").hidden, true);
      sameEdits(editState(), before, "closing the Writer");
      assert.equal(redrawToasts().length, 1, "Redraw is offered");
      assert.equal(rowsInert(), true, "the script is held until a Redraw draws");
      await pressRedraw();
      assert.equal(rowsInert(), false);
    } finally {
      closeTheWriter();
    }
  });
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PASTE_REFUSED = "Could not paste — press Redraw first.";
const pasteRefusals = () => shown().filter((el) => toastText(el) === PASTE_REFUSED);

test("on a stale screen a paste that reaches the stale cell late changes nothing, even with words selected there (#443)", async () => {
  await staleScreen();
  const cell = cellOf("r2", "audioText");
  select(cell, 0, 4);
  const before = editState();
  let res;
  const out = await logging(async () => { res = pasteIntoCell(cell, "", "XYZ", {}); await idle(); });
  assert.equal(out.threw, null, out.threw && out.threw.stack);
  sameEdits(editState(), before, "a late paste on the stale screen");
  assert.equal(S.state.rows[1].audioText, THEIRS);
  assert.equal(res.done, false);
  let called = false;
  assert.equal(editCell(cell, () => { called = true; return null; }), null);
  assert.equal(called, false, "editCell does not run its edit on a stale cell");
  assert.equal(openCellEdit(cell), null);
  sameEdits(editState(), before, "editCell on the stale screen");
  await pressRedraw();
});

test("a paste with a file that is still being read when the screen goes stale changes nothing and says to press Redraw first (#443)", async () => {
  fresh("Late paste");
  const cell = cellOf("r2", "audioText");
  cell.focus();
  select(cell, 0, 4);
  const store = { "text/plain": "XYZ" };
  const ev = new window.Event("paste", { bubbles: true, cancelable: true });
  const file = new window.File(["not really a video"], "clip.mp4", { type: "video/mp4" });
  Object.defineProperty(ev, "clipboardData", { value: { getData: (t) => store[t] || "", files: [file], types: ["text/plain", "Files"] } });
  cell.dispatchEvent(ev);
  const theirs = cloneState(S.state);
  theirs.rows[1].audioText = THEIRS;
  const unbreak = breakRender("early");
  let merged;
  try {
    merged = logging(() => applyMerge({ theirs: theirs, source: "server-conflict", unchanged: true, report: false }));
  } finally {
    unbreak();
  }
  assert.deepEqual((await merged).logged, [BROKE]);
  assert.equal(redrawToasts().length, 1);
  const before = editState();
  for (let i = 0; i < 100 && !pasteRefusals().length; i++) await new Promise((r) => setTimeout(r, 50));
  await idle();
  sameEdits(editState(), before, "the late paste");
  assert.equal(S.state.rows[1].audioText, THEIRS);
  assert.equal(pasteRefusals().length, 1, "the refused paste says why: " + JSON.stringify(shown().map(toastText)));
  assert.equal(pasteRefusals()[0].classList.contains("error"), true);
  await pressRedraw();
});

function noCanvas() {
  const real = window.HTMLCanvasElement.prototype.getContext;
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 0 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  window.HTMLCanvasElement.prototype.getContext = () => ctx;
  const realUrl = URL.createObjectURL;
  URL.createObjectURL = () => "blob:annotate-test";
  return () => { window.HTMLCanvasElement.prototype.getContext = real; URL.createObjectURL = realUrl; };
}

function pointer(el, type) {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 });
  Object.defineProperty(ev, "pointerId", { value: 7 });
  Object.defineProperty(ev, "pointerType", { value: "pen" });
  el.dispatchEvent(ev);
}

test("on a stale screen the picture annotator's Ctrl+Z and Ctrl+Y still undo and redo its own strokes, while the script's undo is refused (#443)", async () => {
  const restore = noCanvas();
  try {
    await staleScreen(async () => {
      const doc = table304Document("Annotate on a stale screen");
      doc.rows[0].visualImage = PNG;
      S.state = migrateRows(doc);
      flushEdits();
      renderAbsorbed();
      clearDirty();
      quiet();
      typedOnce();
      assert.equal(annotate.openAnnotator("r1", 0), true);
      await idle();
      const img = document.getElementById("annotate-img");
      assert.equal(typeof img.onload, "function", "the picture is loading");
      img.onload();
      await idle();
      const frame = document.getElementById("annotate-frame");
      pointer(frame, "pointerdown");
      pointer(frame, "pointerup");
      assert.equal(window.__annotateTest.state().marks.length, 1, "one stroke drawn");
    });
    const tool = document.querySelector('#annotate-modal [data-aact="tool"]');
    tool.focus();
    const before = editState();
    key(tool, "z", { ctrlKey: true });
    assert.deepEqual([window.__annotateTest.state().marks.length, window.__annotateTest.state().redo], [0, 1], "Ctrl+Z took the stroke back");
    key(tool, "y", { ctrlKey: true });
    assert.deepEqual([window.__annotateTest.state().marks.length, window.__annotateTest.state().undo], [1, 1], "Ctrl+Y put it back");
    sameEdits(editState(), before, "the annotator's own undo");
    annotate.closeAnnotator();
    const save = document.getElementById("btn-save");
    save.focus();
    const held = editState();
    assert.equal(held.undo.undo, 1, "the script has a step to undo");
    key(save, "z", { ctrlKey: true });
    key(save, "y", { ctrlKey: true });
    sameEdits(editState(), held, "the script's undo and redo outside the script");
    await pressRedraw();
  } finally {
    annotate.closeAnnotator();
    restore();
  }
});

test("on a stale screen an open comment box keeps its own Ctrl+Z and Ctrl+Y (#443)", async () => {
  await staleScreen();
  const box = document.getElementById("comment-body-editable");
  box.innerHTML = "";
  box.focus();
  box.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  box.dispatchEvent(new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "Draft" }));
  box.textContent = "Draft";
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Draft" }));
  const before = editState();
  key(box, "z", { ctrlKey: true });
  assert.equal(box.textContent, "", "Ctrl+Z undid the typing in the comment box");
  key(box, "y", { ctrlKey: true });
  assert.equal(box.textContent, "Draft", "Ctrl+Y redid it");
  sameEdits(editState(), before, "the comment box's own undo");
  box.textContent = "";
  await pressRedraw();
});

test("on a stale screen no editing event reaches the script's parts, while one aimed elsewhere does, and undo keys still reach a text box (#443)", async () => {
  await staleScreen();
  const TYPES = ["keydown", "beforeinput", "input", "paste", "cut", "drop", "dragstart", "compositionstart", "pointerdown", "mousedown", "click"];
  const reached = [];
  const note = (e) => reached.push((e.currentTarget.id || e.currentTarget.className) + ":" + e.type);
  const outside = document.createElement("div");
  outside.id = "outside-the-script";
  document.body.appendChild(outside);
  const targets = STALE_PARTS.map((sel) => document.querySelector(sel)).concat([outside]);
  try {
    for (const el of targets) for (const type of TYPES) el.addEventListener(type, note);
    for (const el of targets) for (const type of TYPES) el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
    assert.deepEqual(reached, TYPES.map((type) => "outside-the-script:" + type), "only the element outside the script heard them");
  } finally {
    for (const el of targets) for (const type of TYPES) el.removeEventListener(type, note);
    outside.remove();
  }
  const box = document.getElementById("find-input");
  const bar = document.getElementById("findbar");
  const wasHidden = bar.hidden;
  bar.hidden = false;
  box.focus();
  const ev = new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
  box.dispatchEvent(ev);
  bar.hidden = wasHidden;
  assert.equal(ev.defaultPrevented, false, "a text box keeps its own undo");
  await pressRedraw();
});

test("a later update that draws cleanly lifts the block without Redraw, and neither a failure nor the clean draw takes focus the user put outside the script (#443)", async () => {
  await staleScreen(() => cellOf("r1", "audioText").focus());
  const save = document.getElementById("btn-save");
  save.focus();
  const theirs = cloneState(S.state);
  theirs.title = "Drawn by the next update";
  const unbreak = breakRender("early");
  try {
    await logging(() => applyMerge({ theirs: cloneState(theirs), source: "server-conflict", unchanged: true, report: false }));
  } finally {
    unbreak();
  }
  assert.equal(redrawToasts().length, 1);
  assert.equal(document.activeElement, save, "a second failure leaves the focus outside the script alone");
  const clean = await logging(() => applyMerge({ theirs: theirs, source: "server-conflict", unchanged: true, report: false }));
  await idle();
  assert.deepEqual(clean.logged, []);
  assert.equal(redrawToasts().length, 0);
  assert.deepEqual(inertParts().filter((p) => p[1]), []);
  assert.equal(document.activeElement, document.getElementById("btn-save"));
  typeChar(cellOf("r2", "audioText"), "x");
  await idle();
  assert.equal(S.state.rows[1].audioText, THEIRS + "x");
});

test("on a stale screen nothing copies a cell's stale text into the script, even a sync no refused event led to (#443)", async () => {
  await staleScreen();
  const cell = cellOf("r2", "audioText");
  cell.textContent = "Mara mends nets. And more.";
  const before = editState();
  syncFieldFromDom(cell);
  await idle();
  sameEdits(editState(), before, "syncing the stale cell");
  assert.equal(S.state.rows[1].audioText, THEIRS);
  await pressRedraw();
  assert.equal(cellOf("r2", "audioText").textContent, THEIRS);
});

test("a failed render marks the page as a stale screen, and Redraw or a later clean update takes the mark off (#443)", async () => {
  await staleScreen();
  assert.equal(document.body.classList.contains("is-stale-screen"), true, "the stale screen is marked on the page");
  await pressRedraw();
  assert.equal(document.body.classList.contains("is-stale-screen"), false, "Redraw takes the mark off");
  await staleScreen();
  assert.equal(document.body.classList.contains("is-stale-screen"), true, "marked again by the next failed render");
  const theirs = cloneState(S.state);
  theirs.title = "Cleared by a clean update";
  const clean = await logging(() => applyMerge({ theirs: cloneState(theirs), source: "server-conflict", unchanged: true, report: false }));
  await idle();
  assert.deepEqual(clean.logged, []);
  assert.equal(document.body.classList.contains("is-stale-screen"), false, "a later clean update takes the mark off");
});

test("the dimming in app.css follows the blocked parts the page marks, so the list of parts lives in one place (#443)", () => {
  const { css } = readBuiltCss();
  const rules = css.split("}").filter((r) => /is-stale/.test(r));
  assert.equal(rules.length, 1, "one stale-screen rule: " + JSON.stringify(rules));
  assert.match(rules[0], /^\s*\.is-stale-part\s*\{\s*opacity:\s*0\.5;\s*$/);
});
