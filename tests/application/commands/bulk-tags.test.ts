import test from "node:test";
import assert from "node:assert/strict";
import { createBulkTagRows } from "../../../src/application/commands/bulk-tags.ts";
import type { BulkTagPorts } from "../../../src/application/commands/bulk-tags.ts";
import type { DocumentRow } from "../../../src/core/document/validated.ts";
import type { BulkTagResult } from "../../../src/core/production/tags.ts";

type Html = BulkTagResult["html"];

interface Call {
  html: Html;
  phrase: string;
  cat: string;
  name: string;
  matchCase: boolean | undefined;
  countOnly: boolean | undefined;
}

interface Rig {
  ports: BulkTagPorts;
  calls: Call[];
  stamped: string[];
}

function rig(answer: (html: Html) => BulkTagResult): Rig {
  const calls: Call[] = [];
  const stamped: string[] = [];
  return {
    calls: calls,
    stamped: stamped,
    ports: {
      cell: function (html, phrase, cat, name, matchCase, countOnly) {
        calls.push({ html: html, phrase: phrase, cat: cat, name: name, matchCase: matchCase, countOnly: countOnly });
        return answer(html);
      },
      stamp: function (row) { stamped.push(row.id); }
    }
  };
}

function row(id: string, visualText: string, audioText = "spoken"): DocumentRow {
  return { id: id, visualText: visualText, audioText: audioText } as DocumentRow;
}

function replacing(from: string, to: string): (html: Html) => BulkTagResult {
  return function (html) {
    return html && html.includes(from)
      ? { hits: 1, inTags: 0, skipped: 0, html: html.replace(from, to) }
      : { hits: 0, inTags: 0, skipped: 0, html: html };
  };
}

test("rows that change are rewritten and stamped, the others are left alone, and the totals add up across rows", () => {
  const r = rig(function (html) {
    if (html === "a mug") return { hits: 2, inTags: 1, skipped: 3, html: "a [mug]" };
    return { hits: 0, inTags: 4, skipped: 5, html: html };
  });
  const rows = [row("r1", "a mug"), row("r2", "nothing"), row("r3", "a mug")];
  const total = createBulkTagRows(r.ports)(rows, "mug", "prop", "Mug");
  assert.deepEqual(total, { hits: 4, inTags: 6, skipped: 11 });
  assert.deepEqual(rows.map(function (x) { return x.visualText; }), ["a [mug]", "nothing", "a [mug]"]);
  assert.deepEqual(r.stamped, ["r1", "r3"]);
});

test("a count-only pass reports the totals but never writes or stamps a row", () => {
  const r = rig(replacing("mug", "[mug]"));
  const rows = [row("r1", "a mug")];
  const total = createBulkTagRows(r.ports)(rows, "mug", "prop", "Mug", false, true);
  assert.deepEqual(total, { hits: 1, inTags: 0, skipped: 0 });
  assert.equal(rows[0]?.visualText, "a mug");
  assert.deepEqual(r.stamped, []);
  assert.equal(r.calls[0]?.countOnly, true);
});

test("a row is not stamped when the tagger reports hits but returns the same html", () => {
  const r = rig(function (html) { return { hits: 1, inTags: 0, skipped: 0, html: html }; });
  const rows = [row("r1", "a mug")];
  assert.deepEqual(createBulkTagRows(r.ports)(rows, "mug", "prop", "Mug"), { hits: 1, inTags: 0, skipped: 0 });
  assert.deepEqual(r.stamped, []);
});

test("a row is not written when the tagger returns new html with no hits", () => {
  const r = rig(function () { return { hits: 0, inTags: 0, skipped: 0, html: "other" }; });
  const rows = [row("r1", "a mug")];
  createBulkTagRows(r.ports)(rows, "mug", "prop", "Mug");
  assert.equal(rows[0]?.visualText, "a mug");
  assert.deepEqual(r.stamped, []);
});

test("only the visual text is tagged, and the phrase, category, name and flags reach the tagger unchanged", () => {
  const r = rig(replacing("mug", "[mug]"));
  const rows = [row("r1", "a mug", "the mug")];
  createBulkTagRows(r.ports)(rows, "Mug", "prop", "Cup", true);
  assert.deepEqual(r.calls, [{ html: "a mug", phrase: "Mug", cat: "prop", name: "Cup", matchCase: true, countOnly: undefined }]);
  assert.equal(rows[0]?.audioText, "the mug");
});

test("null, undefined and empty row lists give zero totals without calling the tagger", () => {
  const r = rig(replacing("mug", "[mug]"));
  const tag = createBulkTagRows(r.ports);
  assert.deepEqual(tag(null, "mug", "prop", "Mug"), { hits: 0, inTags: 0, skipped: 0 });
  assert.deepEqual(tag(undefined, "mug", "prop", "Mug"), { hits: 0, inTags: 0, skipped: 0 });
  assert.deepEqual(tag([], "mug", "prop", "Mug"), { hits: 0, inTags: 0, skipped: 0 });
  assert.deepEqual(r.calls, []);
});

test("each call starts from fresh totals", () => {
  const r = rig(replacing("mug", "[mug]"));
  const tag = createBulkTagRows(r.ports);
  assert.deepEqual(tag([row("r1", "a mug")], "mug", "prop", "Mug"), { hits: 1, inTags: 0, skipped: 0 });
  assert.deepEqual(tag([row("r2", "a mug")], "mug", "prop", "Mug"), { hits: 1, inTags: 0, skipped: 0 });
});
