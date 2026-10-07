import { test } from "node:test";
import assert from "node:assert/strict";
import { cellTextEdit, needsReconciliation } from "../../src/application/session/change-set.ts";
import { syncCommentAnchors } from "../../src/core/text/anchors.ts";
import { toHtml } from "../../src/core/text/html.ts";
import { normalizeCell } from "../../src/core/text/runs.ts";
import type { Marks, Run } from "../../src/core/text/runs.ts";
import { migratedThenSet } from "../core/migrate-ports.ts";

const IDS = ["c1", "c2", "c3", "c4"];
const WORDS = ["a", "bc", "def", " x", "y "];
const FIELDS = ["visualText", "audioText"] as const;
const SEEDS = 400;

type Field = (typeof FIELDS)[number];
type Random = () => number;

function seeded(seed: number): Random {
  let s = (seed * 2654435761) >>> 0 || 1;
  return function () {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) / 16777216;
  };
}

function pick<T>(r: Random, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)] as T;
}

function randomMarks(r: Random): Marks {
  const marks: Marks = {};
  if (r() < 0.35) marks.cmt = r() < 0.2 ? [pick(r, IDS), pick(r, IDS)] : [pick(r, IDS)];
  if (r() < 0.2) marks.b = true;
  return marks;
}

function randomRuns(r: Random, most: number): Run[] {
  const runs: Run[] = [];
  const n = Math.floor(r() * (most + 1));
  for (let i = 0; i < n; i++) runs.push({ text: pick(r, WORDS), marks: randomMarks(r) });
  return normalizeCell(runs);
}

const decoded = new Map<string, Run[]>();

function htmlOf(runs: readonly Run[]): string {
  const cell = normalizeCell(runs);
  const html = toHtml(cell);
  decoded.set(html, cell);
  return html;
}

function cellOf(html: string): readonly Run[] {
  return decoded.get(html) || [];
}

function editCell(r: Random, before: readonly Run[]): Run[] {
  const runs: Run[] = before.map(function (run) { return { text: run.text, marks: { ...run.marks } }; });
  const at = Math.floor(r() * (runs.length + 1));
  const kind = Math.floor(r() * 5);
  if (kind === 0) runs.splice(at, 0, { text: pick(r, WORDS), marks: r() < 0.7 ? {} : randomMarks(r) });
  else if (kind === 1 && runs.length) runs.splice(Math.min(at, runs.length - 1), 1);
  else if (kind === 2 && runs.length) {
    const run = runs[Math.min(at, runs.length - 1)] as Run;
    run.text = run.text.slice(0, Math.floor(r() * run.text.length)) + (r() < 0.5 ? pick(r, WORDS) : "");
  } else if (kind === 3 && runs.length) {
    const run = runs[Math.min(at, runs.length - 1)] as Run;
    if (run.marks.b) delete run.marks.b; else run.marks.b = true;
  } else {
    return randomRuns(r, 4);
  }
  return normalizeCell(runs);
}

function places(doc: { comments: { id: string; [key: string]: unknown }[] }): string[] {
  return doc.comments.map(function (c) { return c.id + "@" + String(c.rowId) + "/" + String(c.field); });
}

test("a one-cell edit that keeps the cell's comment ids cannot move any anchor's rowId or field, so the session may skip reconciliation (seeded)", () => {
  let skipped = 0, reconciled = 0, movedWhenReconciled = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = seeded(seed);
    const rows = [];
    const rowCount = 1 + Math.floor(r() * 5);
    for (let i = 0; i < rowCount; i++) {
      rows.push({ id: "r" + i, status: "todo", visualText: htmlOf(randomRuns(r, 3)), audioText: htmlOf(randomRuns(r, 3)) });
    }
    const comments = IDS.concat(["c5"]).map(function (id) {
      return { id: id, anchorId: id, kind: "anchor", rowId: "r0", field: pick(r, FIELDS), body: "", replies: [] };
    });
    comments.push({ id: "k1", anchorId: "c1", kind: "conflict", rowId: "r0", field: "audioText", body: "", replies: [] });
    const doc = migratedThenSet({ title: "Fuzz " + seed, rows: rows, comments: comments });
    syncCommentAnchors(doc, cellOf);
    assert.equal(syncCommentAnchors(doc, cellOf), 0, "seed " + seed + ": reconciliation reaches a fixed point in one pass");

    for (let step = 0; step < 6; step++) {
      const row = pick(r, doc.rows);
      const field: Field = pick(r, FIELDS);
      const before = cellOf(String(row[field]));
      const after = editCell(r, before);
      const changes = cellTextEdit(row.id, field, before, after);
      row[field] = htmlOf(after);
      const was = places(doc);
      const moved = syncCommentAnchors(doc, cellOf);
      if (!needsReconciliation(changes)) {
        skipped++;
        assert.equal(moved, 0, "seed " + seed + " step " + step + ": a skipped reconciliation would have moved an anchor");
        assert.deepEqual(places(doc), was);
      } else {
        reconciled++;
        if (moved) movedWhenReconciled++;
      }
    }
  }
  assert.ok(skipped > 1000, "most one-cell edits keep their comment ids: " + skipped);
  assert.ok(reconciled > 100, "some add or drop one: " + reconciled);
  assert.ok(movedWhenReconciled > 10, "and some of those do move an anchor, so the change set must say so: " + movedWhenReconciled);
});

test("a cell edit's change set reconciles exactly when the cell's comment ids change", () => {
  const plain: Run[] = [{ text: "hello", marks: {} }];
  const commented: Run[] = [{ text: "hel", marks: {} }, { text: "lo", marks: { cmt: ["c1"] } }];
  assert.equal(needsReconciliation(cellTextEdit("r1", "audioText", plain, [{ text: "hello there", marks: {} }])), false);
  assert.equal(needsReconciliation(cellTextEdit("r1", "audioText", commented, [{ text: "hel", marks: { b: true } }, { text: "lo!", marks: { cmt: ["c1"] } }])), false);
  assert.equal(needsReconciliation(cellTextEdit("r1", "audioText", plain, commented)), true, "an anchor arrives");
  assert.equal(needsReconciliation(cellTextEdit("r1", "audioText", commented, plain)), true, "an anchor leaves");
  assert.equal(needsReconciliation(cellTextEdit("r1", "audioText", commented, [{ text: "lo", marks: { cmt: ["c2"] } }])), true, "one anchor for another");
});
