import test from "node:test";
import assert from "node:assert/strict";
import { createProductionIndex } from "../../../src/application/production/production-index.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import type { FakeMigration } from "../../core/migrate-ports.ts";

function mentionOf(m: FakeMigration, cat: string, name: string): string {
  return m.cell([{ text: name.toLowerCase(), marks: { tag: "t:" + cat + ":" + name } }]);
}

function documentWith(m: FakeMigration, rows: { id: string; visualText: string }[], tags: { id?: string; cat: string; name: string }[]): ValidatedDocument {
  const doc = migrateRows({ schema: 2, rows: rows, productionTags: tags }, m.ports);
  return structuredClone(doc);
}

function withoutRegistry(doc: ValidatedDocument, name: string): ValidatedDocument {
  const copy = structuredClone(doc);
  copy.productionTags = copy.productionTags.filter(function (t) { return t?.name !== name; });
  return copy;
}

test("no document gives no entries and no index, and derives nothing", () => {
  const m = fakeMigration();
  const ix = createProductionIndex(m.ports.readers, deepFreeze);
  assert.deepEqual(ix.entries(null), []);
  assert.deepEqual(ix.entries(undefined), []);
  assert.equal(ix.current(null), null);
  assert.equal(ix.current(undefined), null);
  assert.equal(ix.derived(), 0);
});

test("entries list the registry tags in registry order, presented with their category look and no raw category id", () => {
  const m = fakeMigration();
  const doc = documentWith(m, [], [{ id: "t_hat", cat: "prop", name: "Hat" }, { id: "t_sam", cat: "gear", name: "Tripod" }]);
  const entries = createProductionIndex(m.ports.readers, deepFreeze).entries(doc);
  assert.deepEqual(entries.map(function (e) { return e.key; }), ["prop hat", "gear tripod"]);
  const hat = entries[0];
  assert.equal(hat?.id, "t_hat");
  assert.equal(hat?.name, "Hat");
  assert.equal(hat?.cat.id, "prop");
  assert.equal(hat?.cat.label, "Prop");
  assert.equal("catId" in (hat ?? {}), false);
  assert.equal(hat?.orphaned, true);
  assert.deepEqual(hat?.mentions, []);
});

test("a tag mentioned in a row lists the mention and is not orphaned", () => {
  const m = fakeMigration();
  const doc = documentWith(m, [{ id: "r1", visualText: mentionOf(m, "prop", "Mug") }], []);
  const mug = createProductionIndex(m.ports.readers, deepFreeze).entries(doc).find(function (e) { return e.key === "prop mug"; });
  assert.equal(mug?.orphaned, false);
  assert.deepEqual(mug?.mentions.map(function (x) { return x.rowId + ":" + x.field; }), ["r1:visualText"]);
});

test("reading the same document again reuses the held index and derives once", () => {
  const m = fakeMigration();
  const doc = documentWith(m, [], [{ cat: "prop", name: "Hat" }]);
  const ix = createProductionIndex(m.ports.readers, deepFreeze);
  const first = ix.current(doc);
  ix.entries(doc);
  ix.entries(doc);
  assert.equal(ix.current(doc), first);
  assert.equal(ix.derived(), 1);
});

test("each entries call returns a new array of the same entry objects", () => {
  const m = fakeMigration();
  const doc = documentWith(m, [], [{ cat: "prop", name: "Hat" }]);
  const ix = createProductionIndex(m.ports.readers, deepFreeze);
  const a = ix.entries(doc);
  const b = ix.entries(doc);
  assert.notEqual(a, b);
  assert.equal(a[0], b[0]);
  a.length = 0;
  assert.equal(ix.entries(doc).length, 1);
});

test("the held index is sealed with the given seal", () => {
  const m = fakeMigration();
  const doc = documentWith(m, [], [{ cat: "prop", name: "Hat" }]);
  const sealed: unknown[] = [];
  const ix = createProductionIndex(m.ports.readers, function <T>(value: T) { sealed.push(value); return deepFreeze(value); });
  const core = ix.current(doc);
  assert.ok(sealed.length >= 2);
  assert.ok(Object.isFrozen(core));
});

test("a different document object is derived afresh, and resetDerived zeroes the count", () => {
  const m = fakeMigration();
  const doc = documentWith(m, [], [{ cat: "prop", name: "Hat" }]);
  const other = structuredClone(doc);
  const ix = createProductionIndex(m.ports.readers, deepFreeze);
  ix.entries(doc);
  ix.entries(other);
  assert.equal(ix.derived(), 2);
  ix.resetDerived();
  assert.equal(ix.derived(), 0);
  ix.entries(other);
  assert.equal(ix.derived(), 0);
});

test("two indexes hold their own state", () => {
  const m = fakeMigration();
  const doc = documentWith(m, [], [{ cat: "prop", name: "Hat" }]);
  const one = createProductionIndex(m.ports.readers, deepFreeze);
  const two = createProductionIndex(m.ports.readers, deepFreeze);
  one.entries(doc);
  assert.equal(one.derived(), 1);
  assert.equal(two.derived(), 0);
});

test("a records plan needs a document to plan for", () => {
  const m = fakeMigration();
  const doc = documentWith(m, [], []);
  const ix = createProductionIndex(m.ports.readers, deepFreeze);
  assert.equal(ix.recordsPlan(null, doc), null);
  assert.equal(ix.recordsPlan(undefined, doc), null);
});

test("a records plan for a fully registered document has nothing to apply", () => {
  const m = fakeMigration();
  const doc = documentWith(m, [{ id: "r1", visualText: mentionOf(m, "prop", "Mug") }], []);
  const plan = createProductionIndex(m.ports.readers, deepFreeze).recordsPlan(doc, doc);
  assert.equal(plan?.apply, null);
  assert.equal(typeof plan?.commit, "function");
});

test("a records plan registers a mentioned tag that the registry lacks, and applying it adds the entry with an id", () => {
  const m = fakeMigration();
  const full = documentWith(m, [{ id: "r1", visualText: mentionOf(m, "prop", "Mug") }], [{ id: "t_hat", cat: "prop", name: "Hat" }]);
  const live = withoutRegistry(full, "Mug");
  const ix = createProductionIndex(m.ports.readers, deepFreeze);
  assert.equal(ix.entries(live).find(function (e) { return e.key === "prop mug"; })?.id, null);
  const plan = ix.recordsPlan(live, live);
  assert.equal(typeof plan?.apply, "function");
  assert.equal(plan?.apply?.(live), 1);
  const mug = live.productionTags.find(function (t) { return t?.name === "Mug"; });
  assert.equal(mug?.cat, "prop");
  assert.ok(mug?.id);
  assert.deepEqual(live.productionTags.map(function (t) { return t?.name; }), ["Hat", "Mug"]);
});

test("after the plan is applied to the viewed document, the held index shows the new id without deriving again", () => {
  const m = fakeMigration();
  const full = documentWith(m, [{ id: "r1", visualText: mentionOf(m, "prop", "Mug") }], []);
  const live = withoutRegistry(full, "Mug");
  const ix = createProductionIndex(m.ports.readers, deepFreeze);
  ix.entries(live);
  ix.recordsPlan(live, live)?.apply?.(live);
  const registered = live.productionTags.find(function (t) { return t?.name === "Mug"; });
  const mug = ix.entries(live).find(function (e) { return e.key === "prop mug"; });
  assert.equal(mug?.id, registered?.id);
  assert.equal(ix.current(live)?.unregistered.length, 0);
  assert.equal(ix.derived(), 1);
});

test("applying a plan to a document with no held index refuses with a type error", () => {
  const m = fakeMigration();
  const full = documentWith(m, [{ id: "r1", visualText: mentionOf(m, "prop", "Mug") }], []);
  const live = withoutRegistry(full, "Mug");
  const ix = createProductionIndex(m.ports.readers, deepFreeze);
  const plan = ix.recordsPlan(live, null);
  assert.equal(typeof plan?.apply, "function");
  assert.throws(() => plan?.apply?.(live), TypeError);
});
