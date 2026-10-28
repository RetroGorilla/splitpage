import { test } from "node:test";
import assert from "node:assert/strict";
import { HOME_KINDS, createDocumentLocation } from "../../../src/application/location/document-location.ts";
import type { Home, LocationChange } from "../../../src/application/location/document-location.ts";

test("a document starts out with nowhere to live", () => {
  const loc = createDocumentLocation();
  assert.deepEqual(loc.home(), { kind: "none" });
  assert.equal(loc.fileHome(), null);
  assert.equal(loc.importHome(), null);
  assert.equal(loc.writtenOut(), false);
});

test("the three kinds are none, file and import", () => {
  assert.deepEqual(HOME_KINDS.slice().sort(), ["file", "import", "none"]);
});

test("setHome builds a record with exactly its kind's fields, defaulted", () => {
  const loc = createDocumentLocation();
  const f = loc.setHome("file", { format: "md", name: "a.md" });
  assert.deepEqual(f, { kind: "file", handle: null, format: "md", name: "a.md",
                        lastModified: null, diskBase: null });
  const i = loc.setHome("import", { name: "notes.docx", format: "docx" });
  assert.deepEqual(i, { kind: "import", handle: null, format: "docx", name: "notes.docx",
                        lastModified: null, size: null, inPlace: false, dirty: false, diskBase: null });
  assert.deepEqual(loc.setHome("none"), { kind: "none" });
});

test("readers see the current record", () => {
  const loc = createDocumentLocation();
  const rec = loc.setHome("file", { format: "md", name: "a.md", lastModified: 7 });
  assert.equal(loc.home(), rec);
  assert.equal(loc.home()["lastModified"], 7);
  assert.equal(loc.fileHome(), rec);
  loc.setHome("none");
  assert.equal(loc.home().kind, "none");
});

test("changing home replaces the record whole — two homes can never be half-set", () => {
  const loc = createDocumentLocation();
  const handle = { name: "script.md" };
  loc.setHome("file", { handle, format: "md", name: "script.md", lastModified: 5, diskBase: { rows: [] } });
  loc.setHome("none");
  assert.equal(loc.fileHome(), null);
  assert.equal(loc.importHome(), null);
  assert.equal("handle" in loc.home(), false);
  assert.equal("diskBase" in loc.home(), false);
  assert.equal("lastModified" in loc.home(), false);

  loc.setHome("import", { name: "a.docx", format: "docx", dirty: true });
  assert.equal(loc.fileHome(), null);

  loc.setHome("file", { format: "splitpage", name: "b.splitpage" });
  assert.equal(loc.importHome(), null);
  assert.equal("dirty" in loc.home(), false);
  assert.equal(loc.home()["diskBase"], null, "a new file home starts with no ancestor of its own");
});

test("fileHome and importHome never hand one kind's handle to the other", () => {
  const loc = createDocumentLocation();
  const handle = { name: "report.docx" };
  loc.setHome("import", { handle, name: "report.docx", format: "docx" });
  assert.equal(loc.fileHome(), null, "Save must not pick up the import's handle");
  assert.equal(loc.importHome()?.["handle"], handle);
  loc.setHome("file", { handle, format: "md", name: "report.md" });
  assert.equal(loc.importHome(), null);
  assert.equal(loc.fileHome()?.["handle"], handle);
});

test("a field from another kind, or the old globals, throws where it is written", () => {
  const loc = createDocumentLocation();
  assert.throws(() => loc.setHome("file", { format: "md", name: "a.md", kind: "md" }), /format is `format`/);
  assert.throws(() => loc.setHome("file", { handle: null, kind: "md" }), /format is `format`/);
  assert.throws(() => loc.setHome("file", { format: "md", inPlace: true }), /file home has no field "inPlace"/);
  assert.throws(() => loc.setHome("none", { id: "d" }), /none home has no field "id"/);
  assert.throws(() => loc.setHome("file", { format: "md", lastModifed: 1 }), /no field "lastModifed"/);
  assert.throws(() => loc.setHome("drive", {}), /unknown kind "drive"/);
  assert.throws(() => loc.setHome("server", { id: "d" }), /unknown kind "server"/);
  assert.equal(loc.home().kind, "none", "a refused setHome leaves the home where it was");
});

test("a home that would mean nothing is refused rather than stored", () => {
  const loc = createDocumentLocation();
  assert.throws(() => loc.setHome("file", { name: "a.md" }), /needs "format"/);
  assert.throws(() => loc.setHome("file", { format: "" }), /needs "format"/);
  assert.throws(() => loc.setHome("import", { format: "docx" }), /needs "name"/);
});

test("restoreHome puts back the same object, not a copy", () => {
  const loc = createDocumentLocation();
  const before = loc.setHome("import", { name: "a.csv", format: "csv" });
  const picked = loc.setHome("file", { format: "md", name: "a.md" });
  assert.notEqual(loc.home(), before);
  loc.restoreHome(before);
  assert.equal(loc.home(), before);
  assert.notEqual(loc.home(), picked);
  assert.throws(() => loc.restoreHome({ kind: "drive" } as unknown as Home), /not a home record/);
  assert.throws(() => loc.restoreHome(null as unknown as Home), /not a home record/);
  assert.throws(() => loc.restoreHome({ kind: "none" }), /not a home record/, "a record this owner did not make is refused");
});

test("the record's own facts move in place through amendHome while the home stays the same", () => {
  const loc = createDocumentLocation();
  const rec = loc.setHome("file", { format: "md", name: "a.md", lastModified: 1 });
  loc.amendHome(rec, { lastModified: 2 });
  assert.equal(rec["lastModified"], 2);
  assert.equal(loc.home(), rec);
  assert.equal(loc.fileHome()?.["lastModified"], 2);
});

test("a home record refuses every write that does not go through the owner", () => {
  const loc = createDocumentLocation();
  const rec = loc.setHome("file", { format: "md", name: "a.md", lastModified: 1 }) as unknown as Record<string, unknown>;
  assert.throws(() => { rec["lastModified"] = 2; }, /through the document location owner/);
  assert.throws(() => { delete rec["lastModified"]; }, /through the document location owner/);
  assert.throws(() => Object.defineProperty(rec, "lastModified", { value: 3 }), /through the document location owner/);
  assert.equal(rec["lastModified"], 1, "a refused write leaves the record as it was");
});

test("amendHome changes only a kind's own changing facts", () => {
  const loc = createDocumentLocation();
  const file = loc.setHome("file", { format: "md", name: "a.md" });
  loc.amendHome(file, { diskBase: { rows: [] }, lastModified: 9 });
  assert.deepEqual(file["diskBase"], { rows: [] });
  assert.equal(file["lastModified"], 9);
  assert.throws(() => loc.amendHome(file, { name: "b.md" }), /"name" is set when the home is made/);
  assert.throws(() => loc.amendHome(file, { rev: 3 }), /"rev" is set when the home is made/);

  const imported = loc.setHome("import", { name: "a.docx", format: "docx" });
  loc.amendHome(imported, { dirty: true, inPlace: true, size: 12, lastModified: 4, diskBase: { rows: [] } });
  assert.deepEqual([imported["dirty"], imported["inPlace"], imported["size"], imported["lastModified"]], [true, true, 12, 4]);
  assert.throws(() => loc.amendHome(imported, { handle: {} }), /"handle" is set when the home is made/);

  const none = loc.setHome("none");
  assert.throws(() => loc.amendHome(none, { lastModified: 1 }), /"lastModified" is set when the home is made/);
  assert.throws(() => loc.amendHome({ kind: "file", lastModified: 0 }, { lastModified: 1 }), /not a home record/);
});

test("a record held across a change of home is still amended, without moving the current home", () => {
  const loc = createDocumentLocation();
  const held = loc.setHome("file", { format: "md", name: "a.md" });
  const next = loc.setHome("import", { name: "b.csv", format: "csv" });
  loc.amendHome(held, { lastModified: 5 });
  assert.equal(held["lastModified"], 5);
  assert.equal(loc.home(), next);
});

test("each change to the home or the written-out flag is announced", () => {
  const loc = createDocumentLocation();
  const seen: LocationChange[] = [];
  const stop = loc.onChange((change) => seen.push(change));
  const rec = loc.setHome("file", { format: "md", name: "a.md" });
  loc.amendHome(rec, { lastModified: 1 });
  loc.markWrittenOut(true);
  loc.markWrittenOut(true);
  const other = loc.setHome("none");
  loc.amendHome(rec, { lastModified: 2 });
  loc.restoreHome(rec);
  loc.restoreHome(other);
  stop();
  loc.setHome("none");
  assert.deepEqual(seen, ["home", "home", "writtenOut", "home", "home", "home"]);
  assert.equal(loc.writtenOut(), true);
});
