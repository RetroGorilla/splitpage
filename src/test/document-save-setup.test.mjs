import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { loadTestDocument } from "./_document.mjs";
import { currentDocument, runCommand } from "../legacy/session-bridge.ts";
import { changeSet } from "../application/session/change-set.ts";
import { autoSavePolicy, savesStarted, unsavedChanges } from "../legacy/save-bridge.ts";

test("a document-only test session wires its real save effects without save-coordinator errors or automatic writes", (t) => {
  const reported = [];
  t.mock.method(console, "error", (...args) => { reported.push(args); });
  const doc = { title: "Before", rows: [], productionTags: [], brollShots: [] };
  loadTestDocument(doc);
  const outcome = runCommand({
    name: "fixture save setup",
    plan: () => ({ changes: changeSet({ docFields: ["title"] }), apply: (draft) => { draft.title = "After"; } })
  });
  assert.equal(savesStarted(), true, "the fixture's production save effects need a started save owner");
  assert.equal(outcome.kind, "applied", "a successful edit must complete without side-effect errors");
  assert.equal(currentDocument(), doc);
  assert.equal(doc.title, "After");
  assert.deepEqual(reported, [], "a successful edit must not report unstarted dependencies");
  assert.equal(unsavedChanges(), true, "the edit reaches the actual in-memory save coordinator");
  assert.equal(autoSavePolicy().enabled(), false);
  assert.equal(autoSavePolicy().pending(), false);
});

test("loading another test document preserves an already-running save owner and its configured policy", (t) => {
  const reported = [];
  t.mock.method(console, "error", (...args) => { reported.push(args); });
  loadTestDocument({ title: "Existing fixture", rows: [], productionTags: [], brollShots: [] });
  const policy = autoSavePolicy();
  policy.setEnabled(true);
  const doc = { title: "Another document", rows: [], productionTags: [], brollShots: [] };
  loadTestDocument(doc);
  assert.equal(autoSavePolicy(), policy);
  assert.equal(policy.enabled(), true);
  assert.equal(policy.pending(), false);
  assert.equal(currentDocument(), doc);
  assert.deepEqual(reported, []);
});
