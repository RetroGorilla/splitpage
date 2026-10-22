import { bootApp, closeApp, rewireApp, rewireRunningApp } from "./_app-boot.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { createHeldFetch, mockClock } from "./_m4-matrix.mjs";
import { documentLocation } from "../legacy/location-bridge.ts";
import { holdMergeBase, liveDocumentPort, mergeBase } from "../legacy/session-bridge.ts";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { clearDirty, markDirty } = await import("../js/12-dirty-toast.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { saveDoc } = await import("../js/14-export.js");
const homeModule = await import("../legacy/location-bridge.ts");
const app = await import("../bootstrap/app.ts");
const { confirmedSave } = await import("../legacy/save-bridge.ts");
const { saveInProgress } = await import("../legacy/screen-state.ts");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

const DOC_ID = "d" + "b".repeat(32);

function script() {
  return migrateRows({
    schema: 5, title: "T", docId: DOC_ID,
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  });
}

function textOf(row) {
  return String((row && row.audioText) || "").replace(/<[^>]*>/g, "");
}

function createServer() {
  const docs = new Map();
  const answered = [];
  return {
    docs: docs,
    answered: answered,
    answer: async function (r) {
      const path = r.url.replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "");
      const doc = /^api\/docs\/([^/]+)$/.exec(path);
      if (doc && r.method === "PUT") {
        const found = docs.get(doc[1]);
        if (!found) return { status: 404, body: { error: "not-found" } };
        if (r.body.baseRev !== found.rev) {
          answered.push(r.body.baseRev + ":409");
          return { status: 409, body: { error: "conflict", rev: found.rev, state: found.state } };
        }
        found.rev += 1;
        found.state = JSON.parse(JSON.stringify(r.body.state));
        answered.push(r.body.baseRev + ":200");
        return { status: 200, body: { id: doc[1], rev: found.rev } };
      }
      return { status: 200, body: {} };
    }
  };
}

async function settle() {
  for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function openOnServer(docId) {
  loadTestDocument(script());
  flushEdits();
  clearDirty();
  homeModule.setHome("none");
  window.__hostedTest.setSession({ docId: docId, rev: 1 });
  documentLocation().markWrittenOut(true);
  clearDirty();
}

function type(row, text) {
  S.state.rows[row].audioText = text;
  markDirty();
}

function warnToasts() {
  return Array.from(document.querySelectorAll("#toast-host .toast.warn")).map((el) => el.textContent);
}

test("a hosted save that lands after its wiring was disposed and the app rewired with the same home changes nothing in the replacement, and the next save merges it in", async (t) => {
  mockClock(t);
  const server = createServer();
  server.docs.set("srv-t", { rev: 1, state: script() });
  const held = createHeldFetch({ connection: () => homeModule.currentConn(), answer: server.answer });
  t.after(held.install());

  openOnServer("srv-t");
  const opened = homeModule.currentHome();
  const baseline = mergeBase();
  assert.equal(textOf(baseline.rows[0]), "One.", "the baseline is the server's revision 1");

  type(0, "Typed before the teardown.");
  held.holdWhen((r) => r.method === "PUT");
  const saving = saveDoc({ auto: true });
  await held.gates.arrived("fetch");

  const doc = S.state;
  app.stopApp();
  const wiring = await rewireApp();
  t.after(() => wiring.dispose());
  assert.equal(S.state, null, "the replacement's session holds no document until one is handed to it");
  assert.equal(mergeBase(), null, "nor a merge base");
  liveDocumentPort.assign(doc);
  holdMergeBase(baseline);
  assert.equal(homeModule.currentHome(), opened, "the rewired app keeps the same home record");
  assert.equal(confirmedSave().baseline, null, "the replacement coordinator starts with no baseline");
  const warnedBefore = warnToasts().length;

  held.gates.releaseAll("fetch");
  await saving;
  await settle();

  assert.equal(server.docs.get("srv-t").rev, 2, "the late save reached the server");
  assert.equal(homeModule.currentHome().rev, 1, "the late save did not move the replacement's revision");
  assert.equal(mergeBase(), baseline, "the late save did not replace the baseline");
  assert.equal(confirmedSave().baseline, null, "the late save's baseline did not reach the replacement coordinator");
  assert.deepEqual(warnToasts().slice(warnedBefore), ["An earlier save of this script arrived late. Your next save will merge both versions."], "the late save is reported once");
  assert.equal(saveInProgress(), false, "the late save leaves the idle replacement not busy");
  assert.equal(document.getElementById("btn-save").disabled, false, "the header Save button is enabled after the late save");

  type(1, "Typed after the rewire.");
  await saveDoc();
  await settle();

  const stored = server.docs.get("srv-t");
  assert.deepEqual(server.answered, ["1:200", "1:409", "2:200"], "the next save was refused once and retried after a merge");
  assert.equal(textOf(stored.state.rows[0]), "Typed before the teardown.", "the server keeps the text the late save sent");
  assert.equal(textOf(stored.state.rows[1]), "Typed after the rewire.", "the server holds the edit made after the rewire");
  assert.equal(homeModule.currentHome().rev, 3, "the replacement adopts the revision of its own save");
});

test("a hosted save that lands after its wiring was disposed leaves the replacement's running save busy", async (t) => {
  mockClock(t);
  const server = createServer();
  server.docs.set("srv-b", { rev: 1, state: script() });
  const held = createHeldFetch({ connection: () => homeModule.currentConn(), answer: server.answer });
  t.after(held.install());
  await rewireRunningApp();
  t.after(() => app.stopApp());

  openOnServer("srv-b");
  type(0, "Typed before the teardown.");
  held.holdWhen((r) => r.method === "PUT", 2);
  const late = saveDoc({ auto: true });
  await held.gates.arrived("fetch");

  await rewireRunningApp();

  type(1, "Typed after the rewire.");
  const current = saveDoc();
  await held.gates.arrived("fetch", 2);
  assert.equal(saveInProgress(), true, "the replacement's save shows as busy");

  held.gates.release("fetch");
  await late;
  await settle();

  const button = document.getElementById("btn-save");
  assert.equal(saveInProgress(), true, "the late save did not clear the replacement's busy state");
  assert.equal(button.textContent, "Saving…", "the header Save button still says Saving…");
  assert.equal(button.disabled, true, "the header Save button stays disabled");

  held.gates.releaseAll("fetch");
  await current;
  await settle();

  assert.equal(saveInProgress(), false, "the replacement's save clears the busy state when it finishes");
  assert.equal(button.disabled, false, "the header Save button is enabled again");
});
