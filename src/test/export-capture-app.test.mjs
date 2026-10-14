import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();
after(closeApp);

const { LONG_DEMO } = await import("../js/_starters.js");
const { setConnection, setHome } = await import("../js/_home.js");
const { migrateRows } = await import("../js/02-state.js");
const { standaloneHtmlFor } = await import("../js/02b-doc-id.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { exportMetaLine, toMarkdownDoc, toMarkdownTableDoc } = await import("../js/14d-export-text.js");
const { captureExportDocument, exportFacts } = await import("../js/14b-export-kit.js");
const { buildMarkdownProject, buildSplitpageFile } = await import("../js/20d-formats.js");

const TOKEN = "tok-e15-0123456789abcdef";
const FILE_NAME = "e15-private-plan.md";

function useDemo() {
  S.state = migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state)));
  flushEdits();
  clearDirty();
}

test("E15: a capture taken with a live connection and a file home holds no token, file name or handle", () => {
  useDemo();
  setConnection({ serverUrl: "http://127.0.0.1:9/", token: TOKEN, role: "edit" });
  setHome("file", { handle: { name: FILE_NAME, kind: "file" }, format: "md", name: FILE_NAME });
  try {
    const doc = captureExportDocument();
    const outputs = [
      JSON.stringify(doc),
      buildSplitpageFile(doc),
      buildMarkdownProject(doc),
      standaloneHtmlFor(doc, { title: doc.title, description: exportMetaLine(exportFacts(doc)) }),
      toMarkdownDoc(doc),
      toMarkdownTableDoc(doc, { export: true }),
      JSON.stringify(exportFacts(doc))
    ];
    outputs.forEach((text, i) => {
      assert.equal(text.includes(TOKEN), false, "output " + i + " holds the token");
      assert.equal(text.includes(FILE_NAME), false, "output " + i + " holds the file name");
    });
    assert.deepEqual(Object.keys(doc).sort(),
      ["broll", "capturedAt", "commentNumbers", "comments", "document", "people", "production", "scenes", "shots", "tags", "title"]);
  } finally {
    setHome("none");
    setConnection({});
  }
});

test("a capture is taken from the live document at once and is frozen; the live document stays writable", () => {
  useDemo();
  const doc = captureExportDocument();
  assert.equal(doc.document.title, S.state.title);
  assert.notEqual(doc.document, S.state);
  assert.ok(Object.isFrozen(doc.document.rows[0]));
  assert.throws(() => { doc.document.rows[0].audioText = "x"; }, TypeError);
  S.state.rows[0].audioText = "Still writable";
  assert.equal(S.state.rows[0].audioText, "Still writable");
});
