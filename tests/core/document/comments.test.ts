import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commentLastActivity,
  commentMatchesAssigneeFilter,
  commentMatchesFilterMode,
  commentPositionOrder,
  commentRecentOrder
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
  const compare = commentPositionOrder((id) => order.indexOf(id as string));
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

test("a comment on a lost scene sorts after one on a kept scene, whichever is compared first", () => {
  const compare = commentPositionOrder((id) => (id === "r1" ? 0 : -1));
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
