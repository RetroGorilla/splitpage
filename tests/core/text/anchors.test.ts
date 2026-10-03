import { test } from "node:test";
import assert from "node:assert/strict";
import { syncCommentAnchors } from "../../../src/core/text/anchors.ts";
import type { AnchorState, AnchoredComment } from "../../../src/core/text/anchors.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migratedThenSet } from "../migrate-ports.ts";
import type { CellDecoder } from "../../../src/core/text/ports.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { B, T } from "./cells.ts";

const PLAIN = [T("no comments here")];
const C1_AND_C2 = [T("one ", { cmt: ["c1"] }), T("two", { cmt: ["c1", "c2"] })];
const C2 = [T("again", { cmt: ["c2"] })];
const C3_ON_KEY = [T("x "), B("bs1", "B-roll:", { cmt: ["c3"] })];
const A9 = [T("anchored", { cmt: ["a9"] })];

function decoderFor(cells: Run[][]): { decode: CellDecoder; seen: string[] } {
  const byHtml = new Map<string, Run[]>();
  for (const cell of cells) byHtml.set(toHtml(cell), normalizeCell(cell));
  const seen: string[] = [];
  return {
    seen: seen,
    decode: (html: string) => {
      seen.push(html);
      const cell = byHtml.get(html);
      if (!cell) throw new Error("not written by toHtml: " + html);
      return cell;
    }
  };
}

const { decode, seen } = decoderFor([PLAIN, C1_AND_C2, C2, C3_ON_KEY, A9]);

function state(comments: (AnchoredComment | null)[]): AnchorState & ValidatedDocument {
  return migratedThenSet({
    comments: comments,
    rows: [
      { id: "r1", visualText: toHtml(PLAIN), audioText: toHtml(C1_AND_C2) },
      null,
      { id: "r2", visualText: toHtml(C2), audioText: toHtml(C3_ON_KEY) },
      { id: "r3", visualText: 7, audioText: toHtml(A9) }
    ]
  });
}

function without(key: string, doc: ValidatedDocument): ValidatedDocument {
  Reflect.deleteProperty(doc, key);
  return doc;
}

test("a comment follows its anchor to the row and field that hold it now", () => {
  const c1 = { id: "c1", rowId: "r9", field: "visualText" };
  const c3 = { id: "c3", rowId: "r1", field: "audioText" };
  assert.equal(syncCommentAnchors(state([c1, c3]), decode), 2);
  assert.deepEqual(c1, { id: "c1", rowId: "r1", field: "audioText" });
  assert.deepEqual(c3, { id: "c3", rowId: "r2", field: "audioText" }, "an anchor on a b-roll key counts");
});

test("the first place an anchor appears wins, rows in order and the visual cell first", () => {
  const c2 = { id: "c2", rowId: "r2", field: "visualText" };
  assert.equal(syncCommentAnchors(state([c2]), decode), 1);
  assert.deepEqual(c2, { id: "c2", rowId: "r1", field: "audioText" });
});

test("a comment already in place, one with no anchor, a conflict card and a title comment are left alone", () => {
  const inPlace = { id: "c1", rowId: "r1", field: "audioText" };
  const lost = { id: "c7", rowId: "r1", field: "visualText" };
  const conflict = { id: "c1", kind: "conflict", rowId: "r9", field: "visualText" };
  const title = { id: "c2", rowId: null, field: "title" };
  const before = JSON.stringify([inPlace, lost, conflict, title]);
  assert.equal(syncCommentAnchors(state([inPlace, null, lost, conflict, title]), decode), 0);
  assert.equal(JSON.stringify([inPlace, lost, conflict, title]), before);
});

test("a reply's anchor id is looked up before its own id", () => {
  const reply = { id: "c1", anchorId: "a9", rowId: "r1", field: "audioText" };
  assert.equal(syncCommentAnchors(state([reply]), decode), 1);
  assert.deepEqual(reply, { id: "c1", anchorId: "a9", rowId: "r3", field: "audioText" });
});

test("only cells with an anchor are decoded, and nothing is decoded without comments", () => {
  seen.length = 0;
  syncCommentAnchors(state([{ id: "c1" }]), decode);
  assert.deepEqual(seen, [toHtml(C1_AND_C2), toHtml(C2), toHtml(C3_ON_KEY), toHtml(A9)]);
  seen.length = 0;
  assert.equal(syncCommentAnchors(state([]), decode), 0);
  assert.equal(syncCommentAnchors(without("comments", state([])), decode), 0);
  assert.equal(syncCommentAnchors(null, decode), 0);
  assert.equal(syncCommentAnchors(undefined, decode), 0);
  assert.equal(syncCommentAnchors(without("rows", migratedThenSet({ comments: [{ id: "c1" }] })), decode), 0);
  assert.deepEqual(seen, []);
});
