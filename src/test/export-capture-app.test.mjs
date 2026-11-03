import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";

await bootApp();
after(closeApp);

const { LONG_DEMO } = await import("../starters/index.ts");
const { setHome } = await import("../bootstrap/wiring/location-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { standaloneHtmlFor } = await import("../adapters/page/standalone-html.ts");
const { confirmSavedNow } = await import("../bootstrap/wiring/save-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const flushEdits = () => undoOwner().flush();
const { exportMetaLine, toMarkdownDoc, toMarkdownTableDoc } = await import("../adapters/formats/export-text.ts");
const { captureExportDocument } = await import("../bootstrap/wiring/export-capture.ts");
const { exportFacts } = await import("../adapters/formats/export-kit.ts");
const { buildMarkdownProject, buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { loadTestDocument } = await import("./_document.mjs");

const FILE_NAME = "e15-private-plan.md";

function useDemo() {
  loadTestDocument(migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state))));
  flushEdits();
  confirmSavedNow();
}

test("E15: a capture taken with a file home holds no file name or handle", () => {
  useDemo();
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
      assert.equal(text.includes(FILE_NAME), false, "output " + i + " holds the file name");
    });
    assert.deepEqual(Object.keys(doc).sort(),
      ["beats", "broll", "capturedAt", "clockMode", "commentNumbers", "comments", "document", "people", "production", "shots", "tags", "title"]);
  } finally {
    setHome("none");
  }
});

test("a capture is taken from the live document at once and is frozen; the live document stays writable", () => {
  useDemo();
  const doc = captureExportDocument();
  assert.equal(doc.document.title, currentDocument().title);
  assert.notEqual(doc.document, currentDocument());
  assert.ok(Object.isFrozen(doc.document.rows[0]));
  assert.throws(() => { doc.document.rows[0].audioText = "x"; }, TypeError);
  currentDocument().rows[0].audioText = "Still writable";
  assert.equal(currentDocument().rows[0].audioText, "Still writable");
});
