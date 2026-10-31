import { test } from "node:test";
import assert from "node:assert/strict";
import { fileTitleChange } from "../../../src/core/document/file-title.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../migrate-ports.ts";
import { diffStates } from "../../../src/application/editing/undo/history.ts";

test("filename versions are terminal, case insensitive, and never incremented", () => {
  for (const suffix of ["v3", "V3", "_v3", "-v3", " v3"]) {
    const got = fileTitleChange({ title: "Untitled Script" }, "Headset ad" + suffix + ".md", true);
    assert.equal(got?.title, "Headset ad");
    assert.equal(got?.titleVersion, "v3");
  }
  assert.equal(fileTitleChange({ title: "" }, "Headset.v2 ad V000123.splitpage", true)?.titleVersion, "v000123");
  assert.equal(fileTitleChange({ title: "" }, "Headset v3 draft.md", true)?.title, "Headset v3 draft");
  assert.equal(fileTitleChange({ title: "" }, "Headset ad.md", true)?.titleVersion, undefined);
  assert.equal(fileTitleChange({ title: "" }, "v3.md", true), null);
});

test("only untouched default titles are eligible on first save", () => {
  for (const title of ["", "Untitled Script", "Untitled"]) {
    assert.equal(fileTitleChange({ title }, "Headset.md", true)?.title, "Headset");
  }
  assert.equal(fileTitleChange({ title: "My title" }, "Headset v3.md", true), null);
  assert.equal(fileTitleChange({ title: "Untitled Script", titleOrigin: "user" }, "Headset.md", true), null);
  assert.equal(fileTitleChange({ title: "Untitled Script" }, "Headset.md", false), null);
});

test("file naming fields normalize without adding fields to old scripts, and participate in undo", () => {
  const migrate = (raw: unknown) => migrateRows(raw, fakeMigration().ports);
  const old = migrate({ title: "Old script", rows: [] });
  assert.equal(Object.hasOwn(old, "titleOrigin"), false);
  assert.equal(Object.hasOwn(old, "titleVersion"), false);
  const invalid = migrate({ title: "Old script", rows: [], titleOrigin: "unknown", titleVersion: "<v3>" });
  assert.equal(Object.hasOwn(invalid, "titleOrigin"), false);
  assert.equal(Object.hasOwn(invalid, "titleVersion"), false);
  const named = migrate({ ...old, titleOrigin: "file", titleVersion: "v3" });
  assert.deepEqual(diffStates(old, named).map((s) => s.op === "docField" ? s.key : s.op).sort(), ["titleOrigin", "titleVersion"]);
});
