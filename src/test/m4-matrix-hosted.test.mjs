import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import blobPolicy from "../../shared/blob-policy.js";
import { createHeldFetch, createHeldFileHandle, mockClock, rightToday } from "./_m4-matrix.mjs";
import { unsavedChanges } from "../legacy/save-bridge.ts";
import { documentLocation, serverStatus } from "../legacy/location-bridge.ts";

const { refsIn } = blobPolicy;

const { mergeBase, runCommand, sessionStamps } = await import("../legacy/session-bridge.ts");

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { confirmSavedNow, saveDoc } = await import("../legacy/save-bridge.ts");
const { flushEdits } = await import("../js/12a-undo.js");
const { intern } = await import("../adapters/storage/02c-blobs.js");
const { startNewScript } = await import("../js/18b-file-menu.js");
const { closeCollaborate, collaborateBlockedReason, openCollaborate } = await import("../js/13b-collaborate.js");
const { sceneStatusCommand } = await import("../application/commands/scene-status.ts");
const hosted = await import("../js/13-hosted.js");
const homeModule = await import("../legacy/location-bridge.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument } = await import("../legacy/transition-bridge.ts");
const { setHome } = homeModule;

after(closeApp);

function idOf(letter) {
  return "d" + letter.repeat(32);
}

function script(title, docId, audio) {
  const lines = audio || ["One.", "Two."];
  return migrateRows({
    schema: 5, title: title, docId: docId,
    rows: lines.map((text, i) => ({ id: "r" + (i + 1), visualText: "Shot " + (i + 1), audioText: text, status: "todo" }))
  });
}

function pngBytes(width, height) {
  const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
    ...be32(width), ...be32(height), 8, 6, 0, 0, 0, ...be32(0), ...be32(0), 0x49, 0x45, 0x4e, 0x44
  ]);
}

function copyOf(value) {
  return JSON.parse(JSON.stringify(value));
}

function createServer() {
  const docs = new Map();
  const blobs = new Set();
  const log = [];
  const server = {
    docs: docs,
    blobs: blobs,
    log: log,
    override: null,
    put: function (id, state, rev) {
      docs.set(id, { rev: rev || 1, state: copyOf(state) });
    },
    texts: function (id) {
      return docs.get(id).state.rows.map((r) => r.audioText);
    },
    answers: [],
    answer: function (r) {
      const path = r.url.replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "");
      log.push(r.method + " " + path);
      const reply = (server.override && server.override(r, path)) || route(r, path);
      server.answers.push({ method: r.method, path: path, status: reply.status });
      return reply;
    }
  };

  function refusedRefs(body) {
    const accepted = Array.isArray(body.acceptMissing) ? body.acceptMissing : [];
    return refsIn(body.state).filter((sha) => !blobs.has(sha) && !accepted.includes(sha));
  }

  function route(r, path) {
    const doc = /^api\/docs\/([^/]+)$/.exec(path);
    if (doc && r.method === "GET") {
      const found = docs.get(doc[1]);
      return found ? { status: 200, body: { id: doc[1], rev: found.rev, state: found.state } } : { status: 404, body: { error: "not-found" } };
    }
    if (doc && r.method === "PUT") {
      const found = docs.get(doc[1]);
      if (!found) return { status: 404, body: { error: "not-found" } };
      if (r.body.baseRev !== found.rev) return { status: 409, body: { error: "conflict", rev: found.rev, state: found.state } };
      const refused = refusedRefs(r.body);
      if (refused.length) return { status: 422, body: { error: "missing-blobs", missing: refused } };
      found.rev += 1;
      found.state = copyOf(r.body.state);
      return { status: 200, body: { id: doc[1], rev: found.rev } };
    }
    if (path === "api/docs" && r.method === "POST") {
      const refused = refusedRefs(r.body);
      if (refused.length) return { status: 422, body: { error: "missing-blobs", missing: refused } };
      const id = "srv-new-" + (docs.size + 1);
      docs.set(id, { rev: 1, state: copyOf(r.body.state) });
      return { status: 200, body: { id: id, rev: 1 } };
    }
    if (path === "api/blobs/missing" && r.method === "POST") {
      return { status: 200, body: { missing: r.body.shas.filter((sha) => !blobs.has(sha)) } };
    }
    const blob = /^api\/blobs\/([0-9a-f]{64})$/.exec(path);
    if (blob && r.method === "PUT") {
      blobs.add(blob[1]);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: "no-such-route" } };
  }

  return server;
}

async function settle(turns) {
  for (let turn = 0; turn < (turns || 30); turn++) await new Promise((resolve) => setImmediate(resolve));
}

function toastElements() {
  return Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)"));
}

function newToasts(before) {
  return toastElements().filter((el) => !before.has(el)).map((el) => el.textContent);
}

function resetTab() {
  if (homeModule.currentHome().kind === "server") {
    setHome("none");
    window.__hostedTest.setSession({ docId: null });
  }
  if (homeModule.currentConn().serverUrl) hosted.pointTabAt("");
  documentLocation().updateConnection({ token: "", role: "", scope: "" });
  serverStatus().recordMode({ readOnly: false });
  confirmSavedNow();
}

async function scenario(run) {
  const server = createServer();
  const held = createHeldFetch({ connection: () => homeModule.currentConn(), answer: server.answer });
  const uninstall = held.install();
  try {
    await run({ server: server, held: held });
  } finally {
    held.gates.releaseAll("fetch");
    await settle();
    uninstall();
    resetTab();
  }
}

function hostedCase(run) {
  return async (t) => {
    mockClock(t);
    await scenario(run);
  };
}

function openHosted(doc, id, rev, options) {
  const o = options || {};
  loadTestDocument(doc);
  flushEdits();
  confirmSavedNow();
  serverStatus().recordMode({ available: true, readOnly: false });
  setHome("none");
  window.__hostedTest.setSession({ docId: id, rev: rev === undefined ? 1 : rev, role: o.role, scope: o.scope, blobs: o.blobs });
  documentLocation().markWrittenOut(true);
  confirmSavedNow();
  return doc;
}

function startUnpublished(doc) {
  loadTestDocument(doc);
  flushEdits();
  confirmSavedNow();
  serverStatus().recordMode({ available: true, readOnly: false });
  documentLocation().markWrittenOut(false);
  setHome("none");
  documentLocation().updateConnection({ token: "", role: "edit", scope: "" });
  noteSessionEdit();
}

function editRow(index, text) {
  currentDocument().rows[index].audioText = text;
  noteSessionEdit();
}

function summary() {
  return {
    homeId: homeModule.currentHome().id,
    rev: homeModule.currentHome().rev,
    dirty: unsavedChanges(),
    texts: currentDocument().rows.map((r) => r.audioText),
    baseTexts: mergeBase() ? mergeBase().rows.map((r) => r.audioText) : null
  };
}

function puts(held, id) {
  return held.requests.filter((r) => r.method === "PUT" && r.url.endsWith("api/docs/" + id));
}

function holdFirst(held, method, fragment) {
  held.holdWhen((r) => r.method === method && r.url.includes(fragment));
}

rightToday("S1", "a hosted save whose document is switched for another acknowledges nothing in the new one", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  server.put("srv-b", script("B", idOf("b")), 4);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Typed in A.");
  holdFirst(held, "PUT", "api/docs/srv-a");
  const saving = saveDoc();
  await held.gates.arrived("fetch");
  assert.equal(await openDocument({ kind: "server", id: "srv-b" }), true, "the other document opened");
  const before = summary();
  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  assert.equal(currentDocument().title, "B", "the other document is still open");
  assert.deepEqual(summary(), before, "the save of A changed nothing in B");
  assert.equal(homeModule.currentHome().rev, 4, "B keeps its own revision");
  assert.equal(puts(held, "srv-b").length, 0, "nothing was sent for B");
}));

rightToday("S2", "a hosted save that completes after a same-id reopen does not move the reopened session's revision or baseline", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Typed before the save.");
  holdFirst(held, "PUT", "api/docs/srv-a");
  const saving = saveDoc();
  await held.gates.arrived("fetch");
  assert.equal(await openDocument({ kind: "server", id: "srv-a" }), true, "the document was reopened");
  const before = summary();
  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  assert.equal(server.docs.get("srv-a").rev, 2, "setup: the first save reached the server");
  assert.equal(server.texts("srv-a")[0], "Typed before the save.", "setup: the first save's text is on the server");
  const late = summary();
  editRow(1, "Typed after the reopen.");
  await saveDoc();
  await settle();
  assert.equal(late.rev, before.rev, "the reopened session's revision did not move");
  assert.deepEqual(late.baseTexts, before.baseTexts, "the reopened session's baseline did not move");
  assert.equal(server.texts("srv-a")[1], "Typed after the reopen.", "setup: the next save reached the server");
  assert.equal(server.texts("srv-a")[0], "Typed before the save.", "the server still holds the saved text after the next edit");
}));

rightToday("S3", "a tab pointed at another server mid-save sends none of the remaining uploads or the PUT there", hostedCase(async ({ server, held }) => {
  const first = intern(pngBytes(40, 30));
  const second = intern(pngBytes(41, 30));
  const doc = script("Pictures", idOf("a"));
  doc.rows[0].imageRef = first;
  doc.rows[1].imageRef = second;
  server.put("srv-a", doc, 1);
  openHosted(doc, "srv-a", 1, { blobs: true });
  editRow(0, "Typed with pictures.");
  holdFirst(held, "PUT", "api/blobs/");
  const saving = saveDoc();
  await held.gates.arrived("fetch");
  window.__hostedTest.pointTabAt("http://other.test/");
  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  const strays = held.requests.filter((r) => r.url.startsWith("http://other.test/")).map((r) => r.method + " " + r.url);
  assert.deepEqual(strays, [], "no request of the save reached the server the tab was pointed at later: " + strays.join(", "));
}));

async function requestsOfSaveChangedMidway(change) {
  let sent = [];
  await scenario(async ({ server, held }) => {
    const doc = script("Pictures", idOf("a"));
    doc.rows[0].imageRef = intern(pngBytes(42, 30));
    doc.rows[1].imageRef = intern(pngBytes(43, 30));
    server.put("srv-a", doc, 1);
    openHosted(doc, "srv-a", 1, { blobs: true });
    editRow(0, "Typed with pictures.");
    holdFirst(held, "PUT", "api/blobs/");
    const saving = saveDoc();
    await held.gates.arrived("fetch");
    documentLocation().updateConnection(change);
    held.gates.releaseAll("fetch");
    await saving;
    await settle();
    assert.ok(held.requests.some((r) => r.method === "PUT" && r.url.endsWith("api/docs/srv-a")), "setup: the save went on to the document PUT");
    sent = held.requests.slice();
  });
  return sent;
}

rightToday("S4", "a token, role or scope change mid-save is seen as a different connection", async (t) => {
  const changes = [
    ["token", { token: "another-token" }],
    ["role", { role: "review" }],
    ["scope", { scope: "srv-a" }]
  ];
  mockClock(t);
  for (const [name, change] of changes) {
    const sent = await requestsOfSaveChangedMidway(change);
    const used = new Set(sent.map((r) => r.connection));
    assert.equal(used.size, 2, "a token, role or scope change mid-save is a different connection (" + name + ")");
  }
});

rightToday("S4-token", "a token changed mid-save is carried by no request of that save", async (t) => {
  mockClock(t);
  const sent = await requestsOfSaveChangedMidway({ token: "another-token" });
  const carrying = sent.filter((r) => r.headers["x-splitpage-token"] === "another-token").map((r) => r.method + " " + r.url);
  assert.deepEqual(carrying, [], "no request of the save carries the token set mid-save: " + carrying.join(", "));
});

rightToday("S5", "an edit during a hosted save leaves the document dirty", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Saved text.");
  holdFirst(held, "PUT", "api/docs/srv-a");
  const saving = saveDoc();
  await held.gates.arrived("fetch");
  editRow(1, "Typed while saving.");
  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  const after = summary();
  assert.equal(after.rev, 2, "the save moved the revision");
  assert.equal(after.dirty, true, "the edit made during the save is still unsaved");
  assert.deepEqual(after.baseTexts, ["Saved text.", "Two."], "the baseline is what the server accepted, without the later edit");
  assert.deepEqual(server.texts("srv-a"), ["Saved text.", "Two."], "the server holds the saved text only");
}));

function collaboratorChange(server, id, rev, lines) {
  server.put(id, script("A", idOf("a"), lines), rev);
}

rightToday("S6", "a 409 merges into the session that sent the save and the retry carries the merge", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Mine.");
  collaboratorChange(server, "srv-a", 2, ["One.", "Theirs."]);
  await saveDoc();
  await settle();
  const sent = puts(held, "srv-a");
  assert.equal(sent.length, 2, "the save was retried once");
  assert.equal(sent[1].body.baseRev, 2, "the retry is based on the collaborator's revision");
  assert.deepEqual(sent[1].body.state.rows.map((r) => r.audioText), ["Mine.", "Theirs."], "the retry carries the merge");
  assert.deepEqual(server.texts("srv-a"), ["Mine.", "Theirs."]);
  assert.deepEqual(summary().texts, ["Mine.", "Theirs."]);
  assert.equal(summary().dirty, false);
  assert.equal(summary().rev, 3);
}));

rightToday("S6-switch", "a 409 that arrives after the document was switched merges nothing", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  server.put("srv-b", script("B", idOf("b")), 4);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Mine.");
  collaboratorChange(server, "srv-a", 2, ["One.", "Theirs."]);
  holdFirst(held, "PUT", "api/docs/srv-a");
  const saving = saveDoc();
  await held.gates.arrived("fetch");
  assert.equal(await openDocument({ kind: "server", id: "srv-b" }), true);
  const before = summary();
  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  assert.deepEqual(summary(), before, "the other document was not touched by the conflict");
  assert.equal(puts(held, "srv-a").length, 1, "no retry was sent");
}));

rightToday("S6-reopen", "a 409 that arrives after a same-id reopen merges nothing and sends no retry", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Mine.");
  collaboratorChange(server, "srv-a", 2, ["One.", "Theirs."]);
  holdFirst(held, "PUT", "api/docs/srv-a");
  const saving = saveDoc();
  await held.gates.arrived("fetch");
  assert.equal(await openDocument({ kind: "server", id: "srv-a" }), true, "the document was reopened");
  const before = summary();
  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  const conflicts = server.answers.filter((a) => a.method === "PUT" && a.path === "api/docs/srv-a" && a.status === 409);
  assert.equal(conflicts.length, 1, "setup: the first save was answered 409");
  assert.equal(puts(held, "srv-a").length, 1, "no retry was sent for the save of the replaced session");
  assert.deepEqual(summary(), before, "the reopened session was not touched by the conflict");
}));

rightToday("S7", "overlapping manual and automatic saves send one PUT at a time per document", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Typed once.");
  held.holdWhen((r) => r.method === "PUT" && r.url.includes("api/docs/srv-a"), 2);
  const first = saveDoc({ auto: true });
  await held.gates.arrived("fetch");
  editRow(1, "Typed again.");
  document.getElementById("save-error-retry").click();
  await settle();
  const sent = puts(held, "srv-a").length;
  held.gates.releaseAll("fetch");
  await first;
  await settle();
  assert.equal(sent, 1, "only one PUT was sent while the first was still in flight, got " + sent);
}));

rightToday("S8", "a failed upload or PUT writes no record and keeps the document dirty", async (t) => {
  const failures = [
    ["PUT 500", (r) => (r.method === "PUT" && r.url.includes("api/docs/srv-a") ? { status: 500, body: { error: "boom" } } : null)],
    ["offline", (r) => { if (r.method === "PUT" && r.url.includes("api/docs/srv-a")) throw new Error("offline"); return null; }],
    ["missing-blobs", (r) => (r.method === "PUT" && r.url.includes("api/docs/srv-a") ? { status: 422, body: { error: "missing-blobs", missing: ["a".repeat(64)] } } : null)],
    ["upload 500", (r) => (r.method === "PUT" && r.url.includes("api/blobs/") ? { status: 500, body: { error: "boom" } } : null)]
  ];
  mockClock(t);
  for (const [name, override] of failures) {
    await scenario(async ({ server }) => {
      const doc = script("A", idOf("a"));
      doc.rows[0].imageRef = intern(pngBytes(44, 30));
      server.put("srv-a", doc, 1);
      openHosted(doc, "srv-a", 1, { blobs: true });
      editRow(0, "Typed, not saved.");
      const before = summary();
      server.override = override;
      await saveDoc();
      await settle();
      const after = summary();
      assert.equal(after.rev, before.rev, name + ": the revision did not move");
      assert.deepEqual(after.baseTexts, before.baseTexts, name + ": the baseline did not move");
      assert.equal(after.dirty, true, name + ": the document is still unsaved");
      assert.deepEqual(after.texts, before.texts, name + ": the typed text is still there");
      assert.deepEqual(server.texts("srv-a"), ["One.", "Two."], name + ": the server holds what it held");
    });
  }
});

rightToday("S9", "a role lowered mid-save authorizes no write and the work stays unsaved", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Typed before the role changed.");
  server.override = (r) => (r.method === "PUT" && r.url.includes("api/docs/srv-a") ? { status: 403, body: { error: "review-only" } } : null);
  holdFirst(held, "PUT", "api/docs/srv-a");
  const saving = saveDoc();
  await held.gates.arrived("fetch");
  documentLocation().updateConnection({ role: "review", scope: "srv-a" });
  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  const after = summary();
  assert.equal(after.rev, 1, "the revision did not move");
  assert.equal(after.dirty, true, "the document is still unsaved");
  assert.equal(after.texts[0], "Typed before the role changed.", "the typed text is still on screen");
  assert.deepEqual(server.texts("srv-a"), ["One.", "Two."]);
  await saveDoc();
  await settle();
  assert.equal(puts(held, "srv-a").length, 1, "no second document PUT was authorized");
}));

rightToday("P2", "a publish that completes after another document was opened leaves that document alone (#247)", hostedCase(async ({ held }) => {
  startUnpublished(script("To publish", idOf("a")));
  const before = new Set(toastElements());
  holdFirst(held, "POST", "api/docs");
  const publishing = hosted.publishToServer();
  await held.gates.arrived("fetch");
  startNewScript();
  assert.equal(currentDocument().title, "Untitled Script");
  const other = { dirty: unsavedChanges(), homeKind: homeModule.currentHome().kind, base: JSON.stringify(mergeBase()) };
  held.gates.releaseAll("fetch");
  assert.equal(await publishing, false, "the publish reports that it did not adopt the copy");
  await settle();
  assert.equal(homeModule.currentHome().kind, other.homeKind, "the new document has no server home");
  assert.equal(unsavedChanges(), other.dirty, "the new document's dirty state is unchanged");
  assert.equal(JSON.stringify(mergeBase()), other.base, "the new document's baseline is unchanged");
  assert.ok(newToasts(before).some((text) => /another script/.test(text)), "the user is told the copy was published and the other script left alone");
}));

rightToday("P3", "typing during a publish leaves the document dirty (#248)", hostedCase(async ({ held }) => {
  startUnpublished(script("To publish", idOf("a")));
  holdFirst(held, "POST", "api/docs");
  const publishing = hosted.publishToServer({ quiet: true });
  await held.gates.arrived("fetch");
  editRow(1, "Typed while publishing.");
  held.gates.releaseAll("fetch");
  assert.equal(await publishing, true);
  await settle();
  assert.equal(homeModule.currentHome().kind, "server", "the document was published");
  assert.equal(unsavedChanges(), true, "the edit made during the publish is still unsaved");
  assert.deepEqual(mergeBase().rows.map((r) => r.audioText), ["One.", "Two."], "the baseline is what the server accepted");
}));

rightToday("P1", "a publish whose connection changed reports the document it created on the old server", hostedCase(async ({ server, held }) => {
  startUnpublished(script("To publish", idOf("a")));
  const before = new Set(toastElements());
  holdFirst(held, "POST", "api/docs");
  const publishing = hosted.publishToServer();
  await held.gates.arrived("fetch");
  hosted.pointTabAt("http://other.test/");
  held.gates.releaseAll("fetch");
  assert.equal(await publishing, false);
  await settle();
  assert.equal(server.docs.size, 1, "the old server did create the document");
  assert.ok(newToasts(before).some((text) => text.includes("To publish") || text.includes("srv-new-1")), "the document created on the old server is reported");
}));

rightToday("P1-token", "a publish that lands after a token change on the same server says the sign-in changed, not that another script was opened", hostedCase(async ({ server, held }) => {
  startUnpublished(script("To publish", idOf("a")));
  const before = new Set(toastElements());
  holdFirst(held, "POST", "api/docs");
  const publishing = hosted.publishToServer();
  await held.gates.arrived("fetch");
  documentLocation().updateConnection({ token: "a-new-token" });
  held.gates.releaseAll("fetch");
  assert.equal(await publishing, false);
  await settle();
  assert.equal(server.docs.size, 1, "the server did create the document");
  const toasts = newToasts(before);
  assert.ok(toasts.some((text) => text.includes("sign-in changed") && text.includes("To publish")), "the toast names the script and says the sign-in changed: " + toasts.join(" | "));
  assert.equal(toasts.some((text) => text.includes("opened another script")), false, "it does not claim another script was opened");
  assert.equal(currentDocument().title, "To publish", "the open document is untouched");
}));

rightToday("C1", "hosted Save As acknowledges no server edit and keeps the merge ancestor", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Typed before Save As.");
  const baseBefore = JSON.stringify(mergeBase());
  const target = createHeldFileHandle({ name: "copy.md" });
  window.showSaveFilePicker = async () => target.handle;
  try {
    await saveDoc({ saveAs: true });
  } finally {
    delete window.showSaveFilePicker;
  }
  await settle();
  assert.equal(target.commits.length, 1, "the copy was written once");
  assert.ok(target.text().includes("Typed before Save As."), "the copy holds the unsaved text");
  assert.equal(held.requests.filter((r) => r.method === "PUT" || r.method === "POST").length, 0, "nothing was sent to the server");
  assert.equal(JSON.stringify(mergeBase()), baseBefore, "the merge ancestor is the one the server last sent");
  assert.equal(homeModule.currentHome().kind, "server", "the document is still on the server");
  assert.equal(homeModule.currentHome().id, "srv-a");
  assert.equal(homeModule.currentHome().rev, 1, "the server revision did not move");
  assert.equal(unsavedChanges(), true, "the edit is still unsaved on the server");
}));

function collabBody() {
  return document.getElementById("collab-body").innerHTML;
}

function collabScenario(answerFor, setup) {
  return () => scenario(async ({ server, held }) => {
    server.override = answerFor;
    loadTestDocument(script("Collab", idOf("a")));
    flushEdits();
    confirmSavedNow();
    serverStatus().recordMode({ available: true, readOnly: false, checked: true });
    setHome("none");
    const run = await setup({ server, held });
    try {
      await run();
    } finally {
      closeCollaborate();
    }
  });
}

rightToday("C2", "a collaboration step that completes after the modal closed changes nothing", async (t) => {
  mockClock(t);
  await collabScenario(
    (r, path) => (path === "api/health" ? { status: 200, body: { ok: true, links: 1, version: "9.9.9", authRequired: false } } : null),
    async ({ held }) => async () => {
      const modeBefore = JSON.stringify(serverStatus().mode());
      holdFirst(held, "GET", "api/health");
      const opening = openCollaborate();
      await held.gates.arrived("fetch");
      closeCollaborate();
      const bodyAfterClose = collabBody();
      const requestsAfterClose = held.requests.length;
      held.gates.releaseAll("fetch");
      await opening;
      await settle();
      assert.equal(JSON.stringify(serverStatus().mode()), modeBefore, "connect: the server facts did not change");
      assert.equal(collabBody(), bodyAfterClose, "connect: the modal body was not redrawn");
      assert.equal(held.requests.length, requestsAfterClose, "connect: no further request was sent");
      assert.equal(document.getElementById("collab-modal").hidden, true, "connect: the modal stayed closed");
    }
  )();

  await collabScenario(
    (r, path) => {
      if (path === "api/health") return { status: 200, body: { ok: true, links: 1, authRequired: true } };
      if (path === "api/join") return { status: 200, body: { token: "owner-token", role: "edit" } };
      return null;
    },
    async ({ held }) => async () => {
      const opening = openCollaborate();
      await opening;
      await settle();
      const key = document.getElementById("collab-key");
      assert.ok(key, "the sign-in step is showing");
      key.value = "the owner key";
      holdFirst(held, "POST", "api/join");
      document.querySelector('[data-collab-action="sign-in"]').click();
      await held.gates.arrived("fetch");
      closeCollaborate();
      const requestsAfterClose = held.requests.length;
      held.gates.releaseAll("fetch");
      await settle();
      assert.equal(homeModule.currentConn().token, "", "sign-in: no token was adopted");
      assert.equal(held.requests.length, requestsAfterClose, "sign-in: no further request was sent");
    }
  )();

  await collabScenario(
    (r, path) => {
      if (path === "api/health") return { status: 200, body: { ok: true, links: 1, authRequired: false } };
      if (path === "api/docs/srv-a/links" && r.method === "GET") return { status: 200, body: { links: [] } };
      return null;
    },
    async ({ server, held }) => async () => {
      server.put("srv-a", script("Collab", idOf("a")), 1);
      openHosted(script("Collab", idOf("a")), "srv-a", 1);
      holdFirst(held, "GET", "api/docs/srv-a/links");
      const opening = openCollaborate();
      await held.gates.arrived("fetch");
      closeCollaborate();
      const requestsAfterClose = held.requests.length;
      held.gates.releaseAll("fetch");
      await opening;
      await settle();
      assert.equal(held.requests.filter((r) => r.method === "POST" && r.url.endsWith("/links")).length, 0, "links: no link was made");
      assert.equal(held.requests.length, requestsAfterClose, "links: no further request was sent");
    }
  )();
});

function driveAnswer(files) {
  return (r) => {
    if (!r.url.startsWith("https://www.googleapis.com/")) return null;
    if (/\/files\/folder-id-12345\?/.test(r.url)) return { status: 200, body: { id: "folder-id-12345", name: "Scripts", mimeType: "application/vnd.google-apps.folder" } };
    if (/\/files\?q=/.test(r.url)) return { status: 200, body: { files: files } };
    return { status: 200, body: {} };
  };
}

function withDriveCredentials() {
  localStorage.setItem("splitpage-drive-api-key", "key-for-tests");
  localStorage.setItem("splitpage-drive-client-id", "client-for-tests");
}

const DRIVE_FILES = [{ id: "file-aaaaaaaaaa", name: "clip.txt", mimeType: "text/plain", size: "5" }];

rightToday("C3", "a Drive listing that completes after the modal closed changes nothing", hostedCase(async ({ server, held }) => {
  withDriveCredentials();
  server.override = driveAnswer(DRIVE_FILES);
  hosted.openDriveModal();
  await hosted.driveConnect("folder-id-12345");
  await settle();
  assert.ok(document.getElementById("drive-list").innerHTML.includes("clip.txt"), "the folder was listed");
  holdFirst(held, "GET", "/files?q=");
  const listing = hosted.driveListCurrent();
  await held.gates.arrived("fetch");
  hosted.closeDriveModal();
  const afterClose = document.getElementById("drive-list").innerHTML;
  server.override = driveAnswer([{ id: "file-bbbbbbbbbb", name: "later.txt", mimeType: "text/plain", size: "5" }]);
  held.gates.releaseAll("fetch");
  await listing;
  await settle();
  assert.equal(document.getElementById("drive-list").innerHTML, afterClose, "the Drive list was not redrawn after the modal closed");
}));

rightToday("C3-download", "a Drive download started before the modal closed is still delivered after it closes", hostedCase(async ({ server, held }) => {
  withDriveCredentials();
  server.override = driveAnswer(DRIVE_FILES);
  hosted.openDriveModal();
  await hosted.driveConnect("folder-id-12345");
  await settle();
  const made = [];
  const make = URL.createObjectURL;
  URL.createObjectURL = (blob) => { made.push(blob); return "blob:m4-matrix/drive"; };
  try {
    const before = new Set(toastElements());
    holdFirst(held, "GET", "alt=media");
    const downloading = hosted.driveOpenItem("file-aaaaaaaaaa");
    await held.gates.arrived("fetch");
    hosted.closeDriveModal();
    held.gates.releaseAll("fetch");
    await downloading;
    await settle();
    assert.equal(made.length, 1, "the Drive download was delivered after the modal closed");
    assert.ok(newToasts(before).includes("Saved clip.txt"), "the user is told the download was saved");
  } finally {
    URL.createObjectURL = make;
  }
}));

rightToday("S10", "copying a share link on a dirty document while a save runs sends one PUT at a time", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Typed once.");
  held.holdWhen((r) => r.method === "PUT" && r.url.includes("api/docs/srv-a"), 2);
  const saving = saveDoc({ auto: true });
  await held.gates.arrived("fetch");
  editRow(1, "Typed again.");
  const sharing = hosted.publishAndCopyShareLink();
  await settle();
  const sent = puts(held, "srv-a").length;
  held.gates.releaseAll("fetch");
  await saving;
  await sharing;
  await settle();
  assert.equal(sent, 1, "only one PUT was sent while the first was still in flight, got " + sent);
}));

test("INV-20: while a share-link save waits behind a save and then runs, both Save buttons stay busy", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1);
  editRow(0, "Typed once.");
  held.holdWhen((r) => r.method === "PUT" && r.url.includes("api/docs/srv-a"), 2);
  const saving = saveDoc({ auto: true });
  await held.gates.arrived("fetch");
  editRow(1, "Typed again.");
  const sharing = hosted.publishAndCopyShareLink();
  held.gates.release("fetch");
  await saving;
  await held.gates.arrived("fetch");
  const busy = ["btn-save", "wr-save"].map((id) => {
    const btn = document.getElementById(id);
    return { text: btn.textContent, disabled: btn.disabled };
  });
  held.gates.releaseAll("fetch");
  await sharing;
  await settle();
  assert.deepEqual(busy, [{ text: "Saving…", disabled: true }, { text: "Saving…", disabled: true }]);
}));

async function capabilityRecord(role, scope) {
  let record = null;
  await scenario(async ({ server, held }) => {
    server.put("srv-a", script("A", idOf("a")), 1);
    openHosted(script("A", idOf("a")), "srv-a", 1, { role: role, scope: scope });
    const outcome = runCommand(sceneStatusCommand(currentDocument().rows[0].id, sessionStamps));
    const edit = outcome.kind;
    await settle();
    const started = held.requests.length;
    if (currentDocument().rows[1].audioText === "Two.") editRow(1, "Typed by " + role);
    await saveDoc();
    await settle();
    const save = held.requests.slice(started).filter((r) => r.method === "PUT" && r.url.endsWith("api/docs/srv-a")).length;
    const publishRefused = hosted.serverPublishItemState();
    const openRefused = hosted.serverOpenItemState();
    const collaborate = collaborateBlockedReason();
    const before = held.requests.length;
    documentLocation().markWrittenOut(false);
    await hosted.publishToServer({ quiet: true });
    await settle();
    const publish = held.requests.slice(before).filter((r) => r.method === "POST" && r.url.endsWith("api/docs")).length;
    record = {
      edit: edit,
      documentPuts: save,
      publishMenuDisabled: publishRefused.disabled,
      openMenuDisabled: openRefused.disabled,
      collaborate: collaborate,
      publishPosts: publish
    };
  });
  return record;
}

rightToday("A1", "owner, scoped editor and reviewer each get exactly today's client capability", async (t) => {
  mockClock(t);
  const owner = await capabilityRecord("edit", "");
  const guest = await capabilityRecord("edit", "srv-a");
  const reviewer = await capabilityRecord("review", "srv-a");
  assert.deepEqual(owner, {
    edit: "applied", documentPuts: 1, publishMenuDisabled: false, openMenuDisabled: false, collaborate: "", publishPosts: 1
  }, "the owner can edit, save, publish, open and invite");
  assert.deepEqual(guest, {
    edit: "applied", documentPuts: 1, publishMenuDisabled: true, openMenuDisabled: true,
    collaborate: "Only the script's owner can invite people", publishPosts: 0
  }, "a scoped editor can edit and save, and nothing more");
  assert.deepEqual(reviewer, {
    edit: "rejected", documentPuts: 0, publishMenuDisabled: true, openMenuDisabled: true,
    collaborate: "Only the script's owner can invite people", publishPosts: 0
  }, "a reviewer cannot edit, save or publish");
});

rightToday("S9-link", "a link turned off mid-save authorizes no write and the work stays unsaved", hostedCase(async ({ server, held }) => {
  server.put("srv-a", script("A", idOf("a")), 1);
  openHosted(script("A", idOf("a")), "srv-a", 1, { role: "edit", scope: "srv-a" });
  editRow(0, "Typed before the link went off.");
  server.override = (r) => (r.method === "PUT" && r.url.includes("api/docs/srv-a") ? { status: 403, body: { error: "link-off" } } : null);
  holdFirst(held, "PUT", "api/docs/srv-a");
  const saving = saveDoc();
  await held.gates.arrived("fetch");
  held.gates.releaseAll("fetch");
  await saving;
  await settle();
  const after = summary();
  assert.equal(serverStatus().linkTurnedOff(), true, "the app knows the link is off");
  assert.equal(after.rev, 1, "the revision did not move");
  assert.equal(after.dirty, true, "the document is still unsaved");
  assert.equal(after.texts[0], "Typed before the link went off.", "the typed text is still on screen");
  server.override = null;
  await saveDoc();
  await settle();
  assert.equal(puts(held, "srv-a").length, 1, "no second document PUT was authorized");
  assert.deepEqual(server.texts("srv-a"), ["One.", "Two."]);
}));