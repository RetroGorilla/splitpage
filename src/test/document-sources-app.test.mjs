import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { listDocHistory } = await import("../js/03a-history-store.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { parseProjectFileState } = await import("../adapters/formats/project-file.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { documentSources, openDocument } = await import("../legacy/transition-bridge.ts");
const { heldDocument, noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

function script(title, digit) {
  return migrateRows({ title: title, docId: "d" + digit.repeat(32), rows: [{ id: "r1", visualText: "", audioText: title + ".", status: "todo" }] });
}

function splitpageFile(doc, name) {
  return new File([buildSplitpageFile(exportDocumentOf(doc))], name, { lastModified: 1 });
}

test("the built-in document sources are the project file, the import and the server, newest first", () => {
  assert.deepEqual(documentSources().ids(), ["server", "import", "project-file"]);
});

test("opening a project file through the sources keeps the document it replaces in that document's history", async () => {
  loadTestDocument(script("Before", "3"));
  noteSessionEdit();
  assert.equal(await openDocument({ kind: "file", file: splitpageFile(script("After", "4"), "after.splitpage"), handle: null, options: { silent: true } }), true);
  assert.equal(heldDocument().title, "After");
  const listed = await listDocHistory("d" + "3".repeat(32));
  assert.ok(listed.entries.some((entry) => entry.label === "Before opening after.splitpage"), "the replaced document was kept");
});

test("skipSnapshot opens without keeping the document it replaces", async () => {
  loadTestDocument(script("Unkept", "5"));
  noteSessionEdit();
  await openDocument({ kind: "file", file: splitpageFile(script("Next", "6"), "next.splitpage"), handle: null, options: { skipSnapshot: true, silent: true } });
  const listed = await listDocHistory("d" + "5".repeat(32));
  assert.ok(!listed.entries.some((entry) => entry.label === "Before opening next.splitpage"));
});

test("a file opening that is already parsed adopts within the call, before its promise settles", async () => {
  loadTestDocument(script("Live", "7"));
  const file = splitpageFile(script("Parsed", "8"), "parsed.splitpage");
  const parsed = await parseProjectFileState(file);
  const opening = openDocument({ kind: "file", file: file, handle: null, parsed: parsed, options: { skipSnapshot: true, silent: true } });
  assert.equal(heldDocument().title, "Parsed", "the document was replaced before the call returned");
  assert.equal(await opening, true);
});

test("an opening no source takes answers false and leaves the document alone", async () => {
  loadTestDocument(script("Stays", "9"));
  assert.equal(await openDocument({ kind: "nowhere" }), false);
  assert.equal(heldDocument().title, "Stays");
});
