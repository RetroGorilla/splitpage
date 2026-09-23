/* The one home record (_home.js, #73).
 *
 * Where a document lives used to be three globals — docFileHandle,
 * openedFile, serverDoc — zeroed against each other by hand, and a path
 * that forgot one left two homes half-set at once. What is pinned here is
 * the part that makes that impossible, and the one answer everything else
 * reads off it:
 *
 *   - there is always exactly one home, and it starts out "none" without a
 *     page and without any module's __init() having run (#92);
 *   - setHome() replaces the record whole, so nothing of the previous kind
 *     survives a change of home;
 *   - a record carries its own kind's fields and no others — a field name
 *     left over from the old globals throws where it is written instead of
 *     reading back as undefined somewhere else;
 *   - restoreHome() puts back the same object, for the one caller (saveDoc's
 *     undoRetarget) that is compared against by identity;
 *   - autoSaveTarget() (14-export.js) still answers "server" | "file" | null
 *     off it, the contract autoSaveIdleFor keys on (#70).
 *
 * The first block imports _home.js alone and no DOM, on purpose: the module
 * is a leaf, and what a leaf needs to be importable is nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HOME_KINDS,
  conn,
  fileHome,
  home,
  importHome,
  restoreHome,
  serverHomeId,
  setHome
} from "../js/_home.js";

test("a document starts out with nowhere to live", () => {
  assert.deepEqual(home, { kind: "none" });
  assert.equal(serverHomeId(), null);
  assert.equal(fileHome(), null);
  assert.equal(importHome(), null);
});

test("the four kinds are none, file, import and server", () => {
  assert.deepEqual(HOME_KINDS.slice().sort(), ["file", "import", "none", "server"]);
});

test("setHome builds a record with exactly its kind's fields, defaulted", () => {
  const f = setHome("file", { format: "md", name: "a.md" });
  assert.deepEqual(f, { kind: "file", handle: null, format: "md", name: "a.md",
                        lastModified: null, diskBase: null });
  const i = setHome("import", { name: "notes.docx", format: "docx" });
  assert.deepEqual(i, { kind: "import", handle: null, format: "docx", name: "notes.docx",
                        lastModified: null, size: null, inPlace: false, dirty: false });
  const s = setHome("server", { id: "doc-1" });
  assert.deepEqual(s, { kind: "server", id: "doc-1", rev: 0, conn });
  assert.equal(s.conn, conn, "a server home holds this tab's connection itself, not a copy");
  assert.deepEqual(setHome("none"), { kind: "none" });
});

test("the importer sees the current record through the live binding", () => {
  const rec = setHome("server", { id: "doc-2", rev: 7 });
  assert.equal(home, rec);
  assert.equal(home.rev, 7);
  assert.equal(serverHomeId(), "doc-2");
  setHome("none");
  assert.equal(home.kind, "none");
});

test("changing home replaces the record whole — two homes can never be half-set", () => {
  const handle = { name: "script.md" };
  setHome("file", { handle, format: "md", name: "script.md", lastModified: 5, diskBase: { rows: [] } });
  setHome("server", { id: "doc-3", rev: 2 });
  assert.equal(fileHome(), null);
  assert.equal(importHome(), null);
  assert.equal("handle" in home, false);
  assert.equal("diskBase" in home, false);
  assert.equal("lastModified" in home, false);

  setHome("import", { name: "a.docx", format: "docx", dirty: true });
  assert.equal(serverHomeId(), null);
  assert.equal("id" in home, false);
  assert.equal("rev" in home, false);

  setHome("file", { format: "splitpage", name: "b.splitpage" });
  assert.equal(importHome(), null);
  assert.equal("dirty" in home, false);
  assert.equal(home.diskBase, null, "a new file home starts with no ancestor of its own");
  setHome("none");
});

test("fileHome and importHome never hand one kind's handle to the other", () => {
  const handle = { name: "report.docx" };
  setHome("import", { handle, name: "report.docx", format: "docx" });
  assert.equal(fileHome(), null, "Save must not pick up the import's handle");
  assert.equal(importHome().handle, handle);
  setHome("file", { handle, format: "md", name: "report.md" });
  assert.equal(importHome(), null);
  assert.equal(fileHome().handle, handle);
  setHome("none");
});

test("a field from another kind, or the old globals, throws where it is written", () => {
  /* docFileHandle.kind was the file's format; on the record `kind` is the
     tag, and the format is `format`. */
  assert.throws(() => setHome("file", { format: "md", name: "a.md", kind: "md" }), /format is `format`/);
  assert.throws(() => setHome("file", { handle: null, kind: "md" }), /format is `format`/);
  assert.throws(() => setHome("server", { id: "d", handle: null }), /server home has no field "handle"/);
  assert.throws(() => setHome("none", { id: "d" }), /none home has no field "id"/);
  assert.throws(() => setHome("file", { format: "md", lastModifed: 1 }), /no field "lastModifed"/);
  assert.throws(() => setHome("drive", {}), /unknown kind "drive"/);
  assert.equal(home.kind, "none", "a refused setHome leaves the home where it was");
});

test("a home that would mean nothing is refused rather than stored", () => {
  /* `{id: null}` used to be how serverDoc said "not on the server". That is
     "none" now, and nothing else. */
  assert.throws(() => setHome("server", { id: null }), /needs "id"/);
  assert.throws(() => setHome("server", {}), /needs "id"/);
  assert.throws(() => setHome("file", { name: "a.md" }), /needs "format"/);
  assert.throws(() => setHome("import", { format: "docx" }), /needs "name"/);
});

test("restoreHome puts back the same object, not a copy", () => {
  const before = setHome("import", { name: "a.csv", format: "csv" });
  const picked = setHome("file", { format: "md", name: "a.md" });
  assert.notEqual(home, before);
  restoreHome(before);
  assert.equal(home, before);
  assert.notEqual(home, picked);
  assert.throws(() => restoreHome({ kind: "drive" }), /not a home record/);
  assert.throws(() => restoreHome(null), /not a home record/);
  setHome("none");
});

test("the record's own facts move in place while the home stays the same", () => {
  /* A server rev after a PUT, a file's timestamp after a write: the same
     home, one fact newer. Identity is what an awaiting save checks. */
  const rec = setHome("server", { id: "doc-4", rev: 1 });
  home.rev = 2;
  assert.equal(rec.rev, 2);
  assert.equal(home, rec);
  setHome("none");
});

/* The readers. autoSaveTarget() lives in a module that needs a DOM to
   import (its neighbours sanitise HTML), so these borrow jsdom — but still
   no page, and no __init(). */
test("autoSaveTarget answers server, file or null off the home", async () => {
  await import("./_dom.mjs");
  const { autoSaveTarget } = await import("../js/14-export.js");
  const { onServerDoc } = await import("../js/13-hosted.js");

  setHome("none");
  assert.equal(autoSaveTarget(), null);
  assert.equal(onServerDoc(), false);

  setHome("server", { id: "doc-5", rev: 3 });
  assert.equal(autoSaveTarget(), "server");
  assert.equal(onServerDoc(), true);

  /* a project file with somewhere to write */
  setHome("file", { handle: { name: "a.md" }, format: "md", name: "a.md" });
  assert.equal(autoSaveTarget(), "file");
  assert.equal(onServerDoc(), false);

  /* a plain <input type=file> open: a home, but Save has to ask first */
  setHome("file", { handle: null, format: "md", name: "a.md" });
  assert.equal(autoSaveTarget(), null);

  /* a legacy .html project: its next save opens a picker */
  setHome("file", { handle: { name: "old.html" }, format: "html", name: "old.html" });
  assert.equal(autoSaveTarget(), null);

  /* an imported .docx has a handle, but Save never writes into it */
  setHome("import", { handle: { name: "a.docx", createWritable() {} }, name: "a.docx", format: "docx" });
  assert.equal(autoSaveTarget(), null);

  setHome("none");
});
