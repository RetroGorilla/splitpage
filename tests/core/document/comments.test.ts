import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commentLastActivity,
  commentMatchesAssigneeFilter,
  commentMatchesFilterMode,
  commentRecentOrder,
  compareCommentPositions
} from "../../../src/core/document/comments.ts";
import type { PlacedComment } from "../../../src/core/document/comments.ts";

test("the open filter is the default; resolved and all are the others", () => {
  const open = { resolved: false }, done = { resolved: true }, unset = {};
  assert.deepEqual([open, done, unset].map((c) => commentMatchesFilterMode(c, "open")), [true, false, true]);
  assert.deepEqual([open, done, unset].map((c) => commentMatchesFilterMode(c, "resolved")), [false, true, false]);
  assert.deepEqual([open, done, unset].map((c) => commentMatchesFilterMode(c, "all")), [true, true, true]);
  assert.deepEqual([open, done, unset].map((c) => commentMatchesFilterMode(c, "bogus")), [true, false, true]);
});

test("the assignee filter: everyone, unassigned, me, or a name in any case", () => {
  let asked = 0;
  const me = () => { asked++; return "  Sam  Smith "; };
  const sam = { assignee: "sam smith" }, ada = { assignee: "Ada" }, nobody = { assignee: "" }, unset = {};
  const all = [sam, ada, nobody, unset];
  assert.deepEqual(all.map((c) => commentMatchesAssigneeFilter(c, "", me)), [true, true, true, true]);
  assert.deepEqual(all.map((c) => commentMatchesAssigneeFilter(c, null, me)), [true, true, true, true]);
  assert.deepEqual(all.map((c) => commentMatchesAssigneeFilter(c, "__unassigned__", me)), [false, false, true, true]);
  assert.deepEqual(all.map((c) => commentMatchesAssigneeFilter(c, " ADA ", me)), [false, true, false, false]);
  assert.equal(asked, 0, "my name is read only for the me filter");
  assert.deepEqual(all.map((c) => commentMatchesAssigneeFilter(c, "me", me)), [true, false, false, false]);
  assert.equal(asked, 4);
  assert.deepEqual(all.map((c) => commentMatchesAssigneeFilter(c, "me", () => "  ")), [false, false, false, false]);
});

test("comments sort by scene, then visual before audio, then when they were made; lost scenes go last", () => {
  const order = ["r1", "r2"];
  const compare = (a: PlacedComment, b: PlacedComment) => compareCommentPositions(a, b, (id) => order.indexOf(id as string));
  const list: (PlacedComment & { n: number })[] = [
    { n: 1, rowId: "gone", field: "visualText", createdAt: "2026-01-01" },
    { n: 2, rowId: "r2", field: "audioText", createdAt: "2026-01-01" },
    { n: 3, rowId: "r2", field: "visualText", createdAt: "2026-01-03" },
    { n: 4, rowId: "r1", field: "audioText", createdAt: "2026-01-02" },
    { n: 5, rowId: "r1", field: "audioText", createdAt: "2026-01-01" },
    { n: 6, rowId: "r2", field: "visualImage", createdAt: null }
  ];
  assert.deepEqual(list.slice().sort(compare).map((c) => c.n), [5, 4, 6, 3, 2, 1]);
});

test("comparing two comments asks for the first one's scene, then the second's, each once", () => {
  const asked: unknown[] = [];
  const rowIndex = (id: string | null | undefined) => { asked.push(id); return id === "r1" ? 0 : 1; };
  assert.ok(compareCommentPositions({ rowId: "r2" }, { rowId: "r1" }, rowIndex) > 0);
  assert.deepEqual(asked, ["r2", "r1"]);
});

test("a comment on a lost scene sorts after one on a kept scene, whichever is compared first", () => {
  const compare = (a: PlacedComment, b: PlacedComment) => compareCommentPositions(a, b, (id) => (id === "r1" ? 0 : -1));
  const lost = { rowId: "gone", field: "visualText", createdAt: "2026-01-01" };
  const kept = { rowId: "r1", field: "audioText", createdAt: "2026-01-09" };
  const title = { rowId: null, field: "title", createdAt: "2026-01-01" };
  assert.ok(compare(lost, kept) > 0);
  assert.ok(compare(kept, lost) < 0);
  assert.ok(compare(title, kept) > 0);
  assert.ok(compare(kept, title) < 0);
  const laterLost = { rowId: "gone too", field: "visualText", createdAt: "2026-01-02" };
  assert.ok(compare(lost, laterLost) < 0, "two lost scenes fall back to field and time");
  assert.ok(compare(laterLost, lost) > 0);
});

test("a thread's last activity is its latest reply, or when it was made", () => {
  assert.equal(commentLastActivity({ createdAt: "2026-01-02", replies: [{ createdAt: "2026-01-01" }, { createdAt: "2026-01-05" }, {}] }), "2026-01-05");
  assert.equal(commentLastActivity({ createdAt: "2026-01-02", replies: [{ createdAt: null }] }), "2026-01-02");
  assert.equal(commentLastActivity({}), "");
  const a = { n: "a", createdAt: "2026-01-01", replies: [{ createdAt: "2026-01-09" }] };
  const b = { n: "b", createdAt: "2026-01-05" };
  const c = { n: "c", createdAt: "2026-01-07" };
  assert.deepEqual([b, a, c].sort(commentRecentOrder).map((x) => x.n), ["a", "c", "b"]);
});

test("a thread with no timestamps has the empty string as its last activity, never null", () => {
  assert.equal(commentLastActivity({ createdAt: "", replies: [{ createdAt: null }] }), "");
  assert.equal(commentLastActivity({ createdAt: null, replies: [{ createdAt: "" }, {}] }), "");
  assert.equal(commentLastActivity({ createdAt: undefined, replies: null }), "");
  assert.equal(commentLastActivity({ createdAt: "2026-01-01", replies: [{ createdAt: "2026-01-01" }] }), "2026-01-01");
  const bare = { createdAt: "", replies: [{ createdAt: null }] };
  assert.equal(commentRecentOrder(bare, { createdAt: null }), 0);
  assert.equal(commentRecentOrder({ createdAt: null }, bare), 0);
  assert.ok(commentRecentOrder(bare, { createdAt: "2026-01-01" }) > 0);
});
