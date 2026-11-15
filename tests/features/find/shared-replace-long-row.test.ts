import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNotices } from "../fakes.ts";
import { agreedRows, deliverAll, findCopy, findReplicas, findSource, finder, shownMessages } from "./shared-replace-support.ts";

const SIZES = [12, 125_000];
const LONG_ROWS = [
  { name: "Replace", cell: (n: number) => "cup " + "a".repeat(n), all: false, after: (n: number) => "mug " + "a".repeat(n), notices: [] },
  { name: "Replace all", cell: (n: number) => "cup " + "a".repeat(n) + " cup", all: true, after: (n: number) => "mug " + "a".repeat(n) + " mug",
    notices: [["Replaced 3 matches", "ok"]] }
];

for (const row of LONG_ROWS) for (const size of SIZES) test(`a shared ${row.name} in a row of ${size} characters gives the small row's result, scaled`, () => {
  const notices = fakeNotices(), set = findReplicas(findSource(row.cell(size))), a = findCopy(set.a, "Alice", notices);
  try {
    const route = finder(a.session, notices, a.shared);
    try { route.search("cup", "mug"); if (row.all) route.replaceAll(); else route.replace(); } finally { route.dispose(); }
    deliverAll(set.queue, "D1");
    const text = String(agreedRows(row.name, set)[0]?.audioText);
    assert.ok(text === row.after(size), `length ${text.length}, starts ${JSON.stringify(text.slice(0, 8))}, ends ${JSON.stringify(text.slice(-8))}`);
    assert.deepEqual(shownMessages(notices), row.notices);
    assert.deepEqual(a.owner.sizes(), { undo: 1, redo: 0, dropped: 0 });
  } finally { a.session.dispose(); set.close(); }
});
