import test from "node:test";
import assert from "node:assert/strict";
import { fileKindFromName, mimeForFilename } from "../../shared/file-names.js";

test("fileKindFromName reads the kind from the extension in any case, and null for the rest", () => {
  assert.equal(fileKindFromName("a.docx"), "docx");
  assert.equal(fileKindFromName("A.CSV"), "csv");
  assert.equal(fileKindFromName("notes.md"), "md");
  assert.equal(fileKindFromName("notes.markdown"), "md");
  assert.equal(fileKindFromName("a.txt"), "txt");
  assert.equal(fileKindFromName("show.splitpage"), "splitpage");
  assert.equal(fileKindFromName("page.html"), "html");
  assert.equal(fileKindFromName("page.htm"), "html");
  assert.equal(fileKindFromName("a.pdf"), null);
  assert.equal(fileKindFromName("noext"), null);
  assert.equal(fileKindFromName(""), null);
  assert.equal(fileKindFromName(null), null);
});

test("mimeForFilename names the type for each export extension and text/plain for the rest", () => {
  assert.equal(mimeForFilename("a.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(mimeForFilename("a.csv"), "text/csv");
  assert.equal(mimeForFilename("a.XLSX"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(mimeForFilename("a.md"), "text/markdown");
  assert.equal(mimeForFilename("a.markdown"), "text/markdown");
  assert.equal(mimeForFilename("a.pdf"), "application/pdf");
  assert.equal(mimeForFilename("a.html"), "text/html");
  assert.equal(mimeForFilename("a.splitpage"), "application/json");
  assert.equal(mimeForFilename("a.zip"), "application/zip");
  assert.equal(mimeForFilename("a.txt"), "text/plain");
  assert.equal(mimeForFilename("noext"), "text/plain");
  assert.equal(mimeForFilename(undefined), "text/plain");
});
