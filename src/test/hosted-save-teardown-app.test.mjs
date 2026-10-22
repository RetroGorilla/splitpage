import { bootApp, closeApp, rewireApp } from "./_app-boot.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { createHeldFetch, mockClock } from "./_m4-matrix.mjs";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { clearDirty, markDirty } = await import("../js/12-dirty-toast.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { saveDoc } = await import("../js/14-export.js");
const homeModule = await import("../js/_home.js");
const app = await import("../bootstrap/app.ts");
const { confirmedSave } = await import("../legacy/save-bridge.ts");
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

function warnToasts() {
  return Array.from(document.querySelectorAll("#toast-host .toast.warn")).map((el) => el.textContent);
}

test("a hosted save that lands after its wiring was disposed and the app rewired with the same home changes nothing in the replacement, and the next save merges it in", async (t) => {
  mockClock(t);
  const server = createServer();
  server.docs.set("srv-t", { rev: 1, state: script() });
  const held = createHeldFetch({ connection: () => homeModule.conn, answer: server.answer });
  t.after(held.install());

  loadTestDocument(script());
  flushEdits();
  clearDirty();
  homeModule.setHome("none");
  window.__hostedTest.setSession({ docId: "srv-t", rev: 1 });
  S.docIdWrittenOut = true;
  clearDirty();
  const opened = homeModule.home;
  const baseline = S.baseState;
  assert.equal(textOf(baseline.rows[0]), "One.", "the baseline is the server's revision 1");

  S.state.rows[0].audioText = "Typed before the teardown.";
  markDirty();
  held.holdWhen((r) => r.method === "PUT");
  const saving = saveDoc({ auto: true });
  await held.gates.arrived("fetch");

  app.stopApp();
  const wiring = await rewireApp();
  t.after(() => wiring.dispose());
  assert.equal(homeModule.home, opened, "the rewired app keeps the same home record");
  assert.equal(confirmedSave().baseline, null, "the replacement coordinator starts with no baseline");
  const warnedBefore = warnToasts().length;

  held.gates.releaseAll("fetch");
  await saving;
  await settle();

  assert.equal(server.docs.get("srv-t").rev, 2, "the late save reached the server");
  assert.equal(homeModule.home.rev, 1, "the late save did not move the replacement's revision");
  assert.equal(S.baseState, baseline, "the late save did not replace the baseline");
  assert.equal(confirmedSave().baseline, null, "the late save's baseline did not reach the replacement coordinator");
  assert.deepEqual(warnToasts().slice(warnedBefore), ["An earlier save of this script arrived late. Your next save will merge both versions."], "the late save is reported once");

  S.state.rows[1].audioText = "Typed after the rewire.";
  markDirty();
  await saveDoc();
  await settle();

  const stored = server.docs.get("srv-t");
  assert.deepEqual(server.answered, ["1:200", "1:409", "2:200"], "the next save was refused once and retried after a merge");
  assert.equal(textOf(stored.state.rows[0]), "Typed before the teardown.", "the server keeps the text the late save sent");
  assert.equal(textOf(stored.state.rows[1]), "Typed after the rewire.", "the server holds the edit made after the rewire");
  assert.equal(homeModule.home.rev, 3, "the replacement adopts the revision of its own save");
});
