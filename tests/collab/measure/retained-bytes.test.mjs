import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";
import * as Y from "yjs";
import { retainedBytes } from "./retained-bytes.mjs";
import { sessionRates } from "./session-rates.mjs";
import { executeMeasured, insertionMarks } from "./reconciliation.mjs";
import { fixtures, open, writer } from "./run.mjs";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";

function checked(doc) {
  const result = retainedBytes(doc);
  assert.equal(Object.values(result.categories).reduce((sum, value) => sum + value, 0), Y.encodeStateAsUpdate(doc).length);
  return result;
}

test("exact encoding ledger reproduces the 320-byte key, its 310-byte birth and deletion retention", () => {
  const handle = open(), fixture = fixtures()[0], edit = writer(handle);
  try {
    hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(fixture.document)));
    const target = { owner: fixture.document.rows[0].id, segment: "b:" + fixture.document.rows[0].id, field: "audioText" };
    const before = checked(collabState(handle).doc);
    edit.type(target, "x");
    const typed = checked(collabState(handle).doc), birth = result => Object.entries(result.categories)
      .filter(([key]) => key.startsWith("birth ")).reduce((sum, [, value]) => sum + value, 0);
    assert.equal(typed.encodedBytes - before.encodedBytes, 320);
    assert.equal(birth(typed) - birth(before), 310);
    assert.equal(typed.categories["text content"] - before.categories["text content"], 1);
    edit.command({ kind: "text-delete", target, observed: edit.history(target).units.slice(-1).map(unit => unit.identity) });
    const deleted = checked(collabState(handle).doc);
    assert.equal(birth(deleted), birth(typed));
    const reopened = open(encodeSharedState(handle));
    try { assert.deepEqual(checked(collabState(reopened).doc).categories, deleted.categories); }
    finally { destroySharedDocument(reopened); }
  } finally { destroySharedDocument(handle); }
});

test("framing and deleted native structs are exclusive, including multibyte text", () => {
  const doc = new Y.Doc(); doc.clientID = 7;
  try {
    checked(doc); doc.getText("text").insert(0, "é🙂");
    assert.equal(checked(doc).categories["text content"], 6);
    doc.getText("text").delete(0, 1);
    assert.equal(checked(doc).categories["text content"], 4);
    assert.ok(checked(doc).categories.deletions > 1);
  } finally { doc.destroy(); }
});

test("restoring marked text exposes real mark-copy records in the additive ledger", () => {
  const handle = open(), fixture = fixtures()[0], edit = writer(handle);
  try {
    hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(fixture.document)));
    const target = { owner: fixture.document.rows[0].id, segment: "b:" + fixture.document.rows[0].id, field: "audioText" };
    const before = edit.history(target).units.map(unit => unit.value);
    edit.command({ kind: "mark", target, observed: edit.history(target).units.slice(0, 2).map(unit => unit.identity), mark: { kind: "b", value: true } });
    const removed = edit.command({ kind: "text-delete", target, observed: edit.history(target).units.slice(0, 2).map(unit => unit.identity) });
    edit.reverse(removed);
    assert.deepEqual(edit.history(target).units.map(unit => unit.value), before);
    const hasCopy = Y.decodeUpdate(encodeSharedState(handle)).structs.some(item => item instanceof Y.Item
      && item.content.getContent()[0]?.operation?.startsWith('["mark-copy"'));
    assert.ok(hasCopy); assert.ok(checked(collabState(handle).doc).categories["mark copies"] > 0);
  } finally { destroySharedDocument(handle); }
});

test("prototype occurrence keys become semantic tag, URL and comment-anchor names in the adapter", () => {
  const fixture = fixtures()[0], handle = open(), edit = writer(handle);
  try {
    hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(fixture.document)));
    const target = { owner: fixture.document.rows[0].id, segment: "b:" + fixture.document.rows[0].id, field: "audioText" };
    const marks = insertionMarks({ "t:occurrence": "tag-one", "l:occurrence": "https://example.test/article", "c:comment-one": true, "t:cleared": null, b: null, i: false },
      [{ id: "comment-one", anchorId: "anchor-one" }]);
    executeMeasured(handle, { kind: "text-insert", target, at: edit.gap(target, 0), content: [{ value: "x", marks }] }, 1);
    const values = edit.history(target).units[0].marks.flatMap(mark => mark.values.map(value => [mark.kind, value])).sort();
    assert.deepEqual(values, [["comment", "anchor-one"], ["link", "https://example.test/article"], ["tag", "tag-one"]]);
  } finally { destroySharedDocument(handle); }
});

test("committed comparison reproduces the original full block and reconciles every category", () => {
  const directory = new URL("../../../docs/collaboration/", import.meta.url);
  const recorded = JSON.parse(readFileSync(new URL("stage-2-byte-reconciliation.json", directory), "utf8"));
  assert.deepEqual(recorded.stageOne.map(row => row.fullWorkload.encodedBytes), [67095, 67096]);
  assert.deepEqual(recorded.stageOne.map(row => row.encodedBytes), [50914, 50914]);
  assert.deepEqual(recorded.stageTwo.map(row => row.encodedBytes), [6415088, 6404190]);
  for (const row of [...recorded.stageOne, ...recorded.stageTwo]) {
    assert.equal(row.typedCharacters, 11287); assert.equal(row.finalCharacters, 10478);
    assert.equal(Object.values(row.categories).reduce((sum, value) => sum + value, 0), row.encodedBytes);
    assert.equal(row.bytesPer1000Typed, row.encodedBytes * 1000 / row.typedCharacters);
    assert.equal(row.bytesPer1000Final, row.encodedBytes * 1000 / row.finalCharacters);
  }
  const files = readdirSync(directory).filter(name => /^stage-2-working-days-(long|large)-[124]\.json$/.test(name));
  assert.equal(files.length, 6);
  for (const file of files) {
    const { result } = JSON.parse(readFileSync(new URL(file, directory), "utf8"));
    const expected = result.fixture === "long" && result.people < 4 ? [0, 1, 2, 5, 10, 20, 60] : [0, 1, 2, 5, 10, 20];
    assert.deepEqual(result.points.map(row => row.day), expected);
    for (const row of result.points) assert.equal(Object.values(row.categories).reduce((sum, value) => sum + value, 0), row.encodedBytes);
  }
  const prefixes = JSON.parse(readFileSync(new URL("stage-2-capacity-prefix.json", directory), "utf8"));
  assert.equal(prefixes.length, 2);
  for (const point of prefixes) {
    assert.equal(point.firstDayOverCap, 1);
    assert.ok(point.crossed.previous.bytes <= point.cap && point.crossed.bytes > point.cap);
    assert.ok(point.crossed.typed < 30000);
    assert.equal(Object.values(point.crossed.ledger.categories).reduce((sum, value) => sum + value, 0), point.crossed.bytes);
  }
});

test("sample-session rates use measured key counters and exact category subtraction at every checkpoint", () => {
  const directory = new URL("../../../docs/collaboration/", import.meta.url);
  const rates = JSON.parse(readFileSync(new URL("stage-2-working-days-rates.json", directory), "utf8"));
  assert.equal(rates.sessions.length, 6);
  const crossings = [];
  for (const rate of rates.sessions) {
    const measured = JSON.parse(readFileSync(new URL(`stage-2-working-days-${rate.fixture}-${rate.people}.json`, directory), "utf8"));
    assert.deepEqual(rate, sessionRates(measured));
    for (const point of rate.points) {
      assert.equal(Object.values(point.addedCategories).reduce((sum, value) => sum + value, 0), point.addedBytes);
      assert.equal(point.addedBytesLessRemovalMarks, point.addedBytes - point.addedCategories["removal marks"]);
      if (point.keyboardKeys) for (const [category, bytes] of Object.entries(point.addedCategories)) {
        assert.equal(point.categoryBytesPerKey[category], bytes / point.keyboardKeys);
      }
    }
    crossings.push(rate.firstOverCap ? [rate.firstOverCap.sampleSession, rate.firstOverCap.keyboardKeys] : null);
    assert.equal(Object.hasOwn(rate, "firstDefaultDayOver2MiB"), false);
  }
  assert.deepEqual(crossings, [[56, 3701], [26, 3436], [13, 3436], null, [19, 2511], [9, 2379]]);
});

test("measurement report, measured-rate JSON and CSV reproduce without full-volume fitted totals", () => {
  const directory = new URL("../../../docs/collaboration/", import.meta.url);
  const paths = ["stage-2-byte-reconciliation.md", "stage-2-working-days-rates.json", "stage-2-working-days-by-category.csv"];
  const before = paths.map(path => readFileSync(new URL(path, directory), "utf8"));
  execFileSync(process.execPath, ["tests/collab/measure/reconciliation-report.mjs"]);
  assert.deepEqual(paths.map(path => readFileSync(new URL(path, directory), "utf8")), before);
  assert.equal(existsSync(new URL("stage-2-working-days-projections.json", directory)), false);
  assert.doesNotMatch(before[0], /Full-volume horizons|Encoded B \(fit\)|First measured sample day/);
  assert.doesNotMatch(before[1], /firstDefaultDayOver2MiB|extrapolated|quadratic/);
  assert.doesNotMatch(before[2], /extrapolated/);
  assert.match(before[0], /126 times larger/);
  assert.match(before[0], /No full-volume day total is claimed/);
});
