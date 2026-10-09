import { bootApp, closeApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { rightToday, wrongToday } from "./_m4-matrix.mjs";

const opened = [];
const factory = globalThis.indexedDB;
const open = factory.open;
factory.open = function (name, ...rest) {
  opened.push(String(name));
  return open.call(this, name, ...rest);
};

const raw = {
  schema: 5, title: "Opened with a junk editor name", docId: "d" + "b".repeat(32), rev: 0, lastEditedBy: "   ",
  rows: [{ id: "r1", status: "todo", visualText: "", audioText: "Kept." }]
};

await bootApp(JSON.stringify(raw));

after(() => {
  factory.open = open;
  closeApp();
});

const settled = new Promise((resolve) => setImmediate(resolve));

rightToday("T3-boot", "the page boots the document its state data holds", async () => {
  await settled;
  assert.equal(S.state.title, "Opened with a junk editor name");
  assert.equal(S.state.docId, "d" + "b".repeat(32));
});

wrongToday("T3", "the pristine check and the resume check agree on a document with a junk editor name and no revision", async () => {
  await settled;
  assert.equal(Boolean(S.state.lastEditedBy), false, "the loaded document's editor name is cleaned to nothing");
  const pristineSaid = S.docIdWrittenOut === false;
  const resumeTried = opened.includes("splitpage-files");
  assert.equal(resumeTried, pristineSaid, "pristine says " + pristineSaid + " and the resume check says " + resumeTried);
});
