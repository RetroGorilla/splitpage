/* shared/history-policy.js — the clamps and the stamp the browser store and
 * the desktop store both apply (issue #76).
 *
 * The eviction planner, the third thing this module exports, has its own
 * suite next door (history-eviction.test.mjs, 11 cases) because it was
 * already unit-tested before the move. What is here is everything else:
 * sanitizeHistoryMeta, historyStampAfter, historyClip and the four
 * constants — which lived twice, once in src/js/03a-history-store.js and
 * once in desktop/main.js, until #76.
 *
 * NO _dom.mjs IMPORT, and that is an assertion, not an omission. This module
 * is loaded by the browser bundle, by Electron's main process and by node,
 * so it may not touch a document, a window, an electron or a filesystem, and
 * it may not depend on any __init() having run first (#92, where a "pure
 * core" turned out to need one). A suite that pulled jsdom in first could not
 * tell. The last case here loads the file the way desktop/main.js does — a
 * CommonJS require — and checks it answers identically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  HISTORY_PER_DOC,
  HISTORY_SNAP_ID_RE,
  historyClip,
  historyStampAfter,
  historyUtf8Length,
  planHistoryEviction,
  sanitizeHistoryMeta
} from "../../shared/history-policy.js";

const meta = (over) => Object.assign({ id: "s01", atMs: 1000, label: "x" }, over);

test("the policy constants are the ones both stores were carrying", () => {
  assert.equal(HISTORY_PER_DOC, 50);
  assert.equal(HISTORY_OLDER_KEY, "_older");
  assert.equal(HISTORY_OLDER_TTL_MS, 90 * 24 * 60 * 60 * 1000, "90 days, counted from the migration");
});

test("HISTORY_SNAP_ID_RE: what may become a file name on disk", () => {
  for (const ok of ["s1a", "abc", "0-_" + "z".repeat(60), "snapshot-1"]) {
    assert.ok(HISTORY_SNAP_ID_RE.test(ok), `${ok} should be a usable snapshot id`);
  }
  /* Two characters is too short, 65 too long, and nothing outside
     [a-z0-9_-] gets in — a path separator or a dot least of all. */
  for (const bad of ["ab", "z".repeat(65), "-abc", "_abc", "A1b", "a/b", "a.b", "a b", "aéb", ""]) {
    assert.ok(!HISTORY_SNAP_ID_RE.test(bad), `${bad} should be refused`);
  }
});

test("historyClip: clamps, and turns absent into empty rather than 'null'", () => {
  assert.equal(historyClip("abcdef", 3), "abc");
  assert.equal(historyClip("ab", 10), "ab");
  assert.equal(historyClip(null, 10), "");
  assert.equal(historyClip(undefined, 10), "");
  assert.equal(historyClip(12, 10), "12");
});

test("sanitizeHistoryMeta refuses anything without a usable id", () => {
  assert.equal(sanitizeHistoryMeta(null), null);
  assert.equal(sanitizeHistoryMeta("s01"), null);
  assert.equal(sanitizeHistoryMeta([]) , null, "an array has no id either");
  assert.equal(sanitizeHistoryMeta({}), null);
  assert.equal(sanitizeHistoryMeta({ id: 7 }), null, "a non-string id is not an id");
  assert.equal(sanitizeHistoryMeta({ id: "s1" }), null, "two characters is below the floor");
  assert.equal(sanitizeHistoryMeta({ id: "a/b" }), null, "an id that could name a folder elsewhere");
});

test("sanitizeHistoryMeta rebuilds from plain values and clamps every length", () => {
  const out = sanitizeHistoryMeta({
    id: "s01",
    label: "L".repeat(400),
    at: "2026-01-01T00:00:00.000Z",
    atMs: 1000,
    by: "B".repeat(200),
    rows: "12.7",
    title: "T".repeat(400),
    sizeBytes: 5.9,
    kind: "snapshot",
    extra: "dropped",
    __proto__: { sneaky: 1 }
  });
  assert.deepEqual(Object.keys(out).sort(),
    ["at", "atMs", "by", "formatVersion", "id", "kind", "label", "rows", "sizeBytes", "title"],
    "only the known fields survive");
  assert.equal(out.label.length, 300);
  assert.equal(out.by.length, 100);
  assert.equal(out.title.length, 300);
  assert.equal(out.rows, 12, "rows is a whole number");
  assert.equal(out.sizeBytes, 5, "sizeBytes is a whole number of bytes");
  assert.equal(out.formatVersion, 1);
  assert.equal(out.kind, "snapshot");
});

test("sanitizeHistoryMeta: kind is 'snapshot' unless it is exactly 'legacy'", () => {
  assert.equal(sanitizeHistoryMeta(meta({ kind: "legacy" })).kind, "legacy");
  assert.equal(sanitizeHistoryMeta(meta({ kind: "Legacy" })).kind, "snapshot");
  assert.equal(sanitizeHistoryMeta(meta({ kind: "anything" })).kind, "snapshot");
  assert.equal(sanitizeHistoryMeta(meta({})).kind, "snapshot");
});

test("sanitizeHistoryMeta: negative counts are floored at zero, not carried", () => {
  const out = sanitizeHistoryMeta(meta({ rows: -5, sizeBytes: -1 }));
  assert.equal(out.rows, 0);
  assert.equal(out.sizeBytes, 0);
  /* A size that is not a number at all is 0 too — the backend overwrites it
     from the body it actually stored. */
  assert.equal(sanitizeHistoryMeta(meta({ sizeBytes: "big" })).sizeBytes, 0);
});

test("sanitizeHistoryMeta: atMs and at each fill in for the other", () => {
  /* No atMs: parse the text. */
  const fromText = sanitizeHistoryMeta({ id: "s01", at: "2026-01-02T03:04:05.000Z" });
  assert.equal(fromText.atMs, Date.parse("2026-01-02T03:04:05.000Z"));
  assert.equal(fromText.at, "2026-01-02T03:04:05.000Z", "the wall-clock text the user saw is kept");
  /* No at: write one from atMs. */
  const fromMs = sanitizeHistoryMeta({ id: "s01", atMs: 1735786800000 });
  assert.equal(fromMs.at, new Date(1735786800000).toISOString());
  /* Neither: a finite 0, never NaN — an Invalid Date would throw out of
     toISOString and take the whole put with it. */
  for (const m of [{ id: "s01" }, { id: "s01", atMs: NaN }, { id: "s01", atMs: "x" }]) {
    const out = sanitizeHistoryMeta(m);
    assert.equal(out.atMs, 0);
    assert.equal(out.at, new Date(0).toISOString());
  }
  /* Text that is not a date at all: `at` is what the user was shown, so it
     is kept (clipped) rather than rewritten, and atMs falls to 0 — which is
     what every sort and every trim then reads. */
  const junk = sanitizeHistoryMeta({ id: "s01", atMs: "x", at: "n".repeat(80) });
  assert.equal(junk.atMs, 0);
  assert.equal(junk.at, "n".repeat(40));
});

test("sanitizeHistoryMeta: legacyId appears only when there is one", () => {
  assert.ok(!("legacyId" in sanitizeHistoryMeta(meta({}))));
  assert.equal(sanitizeHistoryMeta(meta({ legacyId: "L".repeat(200) })).legacyId.length, 100);
  assert.equal(sanitizeHistoryMeta(meta({ legacyId: 7 })).legacyId, "7");
});

test("historyStampAfter: a put sorts strictly above the bucket's newest", () => {
  /* The clock went backwards: the new capture would otherwise sort under
     snapshots stamped in the "future" and every trim would eat the real
     work instead of the stale entries. */
  assert.equal(historyStampAfter({ atMs: 500 }, 900).atMs, 901);
  assert.equal(historyStampAfter({ atMs: 900 }, 900).atMs, 901, "equal is not above");
  assert.equal(historyStampAfter({ atMs: 1200 }, 900).atMs, 1200, "already above: left alone");
});

test("historyStampAfter: no newest, or an unusable one, changes nothing", () => {
  assert.equal(historyStampAfter({ atMs: 500 }, null).atMs, 500, "an empty bucket");
  assert.equal(historyStampAfter({ atMs: 500 }, undefined).atMs, 500);
  assert.equal(historyStampAfter({ atMs: 500 }, "later").atMs, 500);
  assert.equal(historyStampAfter({ atMs: 500 }, NaN).atMs, 500);
  /* It stamps in place and hands the same object back — both callers rely
     on that, having just built the meta. */
  const m = { atMs: 1 };
  assert.equal(historyStampAfter(m, 5), m);
});

test("a require() sees exactly what an import does — this file is CommonJS on purpose", () => {
  /* desktop/main.js loads this module with require(), the browser bundle
     through esbuild's import, and this suite through node's ESM interop. If
     the file ever stopped being CommonJS, or shared/package.json stopped
     saying so, the two halves of this case would disagree (or the require
     would throw outright). */
  const require = createRequire(import.meta.url);
  const cjs = require("../../shared/history-policy.js");
  assert.equal(cjs.planHistoryEviction, planHistoryEviction);
  assert.equal(cjs.sanitizeHistoryMeta, sanitizeHistoryMeta);
  assert.equal(cjs.historyStampAfter, historyStampAfter);
  assert.equal(cjs.HISTORY_PER_DOC, HISTORY_PER_DOC);
  assert.deepEqual(Object.keys(cjs).sort(), [
    "HISTORY_OLDER_KEY", "HISTORY_OLDER_TTL_MS", "HISTORY_PER_DOC", "HISTORY_SNAP_ID_RE",
    "historyClip", "historyOlderExpired", "historyStampAfter", "historyUtf8Length",
    "planHistoryEviction", "sanitizeHistoryMeta"
  ]);
});

test("historyUtf8Length: UTF-8 bytes without encoding a copy (moved here from 03a, #83)", () => {
  const enc = new TextEncoder();
  for (const s of ["", "abc", "é", "€", "😀", "a😀b", "\u{10FFFF}", "日本語テキスト", "x".repeat(1000)]) {
    assert.equal(historyUtf8Length(s), enc.encode(s).length, JSON.stringify(s));
  }
  /* A lone surrogate is what TextEncoder writes as U+FFFD: three bytes. */
  assert.equal(historyUtf8Length("\ud800"), 3);
  assert.equal(historyUtf8Length("\udc00x"), 4);
});

test("the module needs no DOM, no Electron and no init", () => {
  /* Nothing has set up jsdom in this process, so if anything in the module
     reached for a document or a window it would have thrown on import. The
     explicit part: the functions work here, first call, with globalThis
     carrying neither. */
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(sanitizeHistoryMeta(meta({})).id, "s01");
  assert.deepEqual(
    planHistoryEviction([{ docId: "d1", lastOpenedAt: 1, snapshots: [{ id: "s1", atMs: 1, sizeBytes: 1 }] }],
      Infinity, 0, {}).deletes, []);
});
