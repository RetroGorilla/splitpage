import { test } from "node:test";
import assert from "node:assert/strict";
import { fileTitleChange } from "../../../src/core/document/file-title.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../migrate-ports.ts";
import { diffStates } from "../../../src/application/editing/undo/history.ts";

test("filename versions are terminal, case insensitive, and never incremented", () => {
  for (const suffix of [" v3", " V3", "_v3", "-v3"]) {
    const got = fileTitleChange({ title: "Untitled Script" }, "Headset ad" + suffix + ".md", true);
    assert.equal(got?.title, "Headset ad");
    assert.equal(got?.titleVersion, "v3");
  }
  assert.equal(fileTitleChange({ title: "" }, "Headset.v2 ad V000123.splitpage", true)?.titleVersion, "v000123");
  assert.equal(fileTitleChange({ title: "" }, "Headset v3 draft.md", true)?.title, "Headset v3 draft");
  assert.equal(fileTitleChange({ title: "" }, "Headset ad.md", true)?.titleVersion, undefined);
  assert.equal(fileTitleChange({ title: "" }, "v3.md", true), null);
  assert.equal(fileTitleChange({ title: "Headset", titleOrigin: "file", titleVersion: "v2" }, "V3.md", false), null);
});

for (const title of ["Rev2", "Dev3", "TV3", "Cv3", "Café Rv2", "Headsetv3"]) {
  test("a glued ending stays in the title without a version: " + title, () => {
    const naming = fileTitleChange({ title: "Untitled Script" }, title + ".md", true);
    assert.equal(naming?.title, title);
    assert.equal(naming?.titleVersion, undefined);
  });
}

test("only untouched default titles are eligible on first save", () => {
  for (const title of ["", "Untitled Script", "Untitled"]) {
    assert.equal(fileTitleChange({ title }, "Headset.md", true)?.title, "Headset");
  }
  assert.equal(fileTitleChange({ title: "My title" }, "Headset v3.md", true), null);
  assert.equal(fileTitleChange({ title: "Untitled Script", titleOrigin: "user" }, "Headset.md", true), null);
  assert.equal(fileTitleChange({ title: "Untitled Script" }, "Headset.md", false), null);
});

test("seeded filename variants preserve the chosen title and version digits", () => {
  let seed = 32;
  const choose = (count: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % count; };
  const names = ["Headset ad", "Scene 12", "Café", "Headset.ad"];
  const separators = [" ", "_", "-"];
  for (let i = 0; i < 500; i++) {
    const title = names[choose(names.length)] as string;
    const number = String(choose(100000)).padStart(choose(25) + 1, "0");
    const filename = title + separators[choose(separators.length)] + (choose(2) ? "V" : "v") + number + (choose(2) ? ".md" : ".splitpage");
    const naming = fileTitleChange({ title: "Untitled Script" }, filename, true);
    assert.equal(naming?.title, title, filename);
    assert.equal(naming?.titleVersion, "v" + number, filename);
  }
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
