import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMarks } from "../../../src/core/document/gallery.ts";
import type { Mark } from "../../../src/core/document/gallery.ts";
import { cappedLongText, unitSafePrefix, withoutLoneSurrogates } from "../../../src/core/document/text-policy.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { brollInCell, brollSeedRef } from "../../../src/core/production/broll.ts";
import type { ProductionRow } from "../../../src/core/production/ports.ts";
import { fakeMigration } from "../migrate-ports.ts";

const GRIN = "\u{1F600}";
const HIGH = "\uD83D";
const LOW = "\uDE00";
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const x = (n: number): string => "x".repeat(n);

type Bag = Record<string, unknown>;

const markText = (m: Mark): string => (m.kind === "text" ? m.text : "");

function seeded(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return function (n: number): number {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 16) % n;
  };
}

function codePoints(s: string): number {
  return Array.from(s).length;
}

test("cappedLongText cuts by code point, drops lone halves and keeps every space (#434)", () => {
  assert.equal(cappedLongText(x(299) + GRIN + "y", 300), x(299) + GRIN);
  assert.equal(cappedLongText(GRIN.repeat(301), 300), GRIN.repeat(300));
  assert.equal(cappedLongText(x(298) + HIGH + "yz", 300), x(298) + "yz", "a lone half is dropped before the cut");
  assert.equal(cappedLongText(" a\n\n b " + LOW, 300), " a\n\n b ", "no trim");
  assert.equal(cappedLongText(x(299) + " y", 300), x(299) + " ", "a cut after a space keeps the space");
  assert.equal(cappedLongText(HIGH, 300), "");
  assert.equal(cappedLongText("", 300), "");
});

test("unitSafePrefix cuts at max UTF-16 units and never inside a pair (#434)", () => {
  assert.equal(unitSafePrefix(x(89) + GRIN + "y", 90), x(89));
  assert.equal(unitSafePrefix(x(88) + GRIN + "y", 90), x(88) + GRIN);
  assert.equal(unitSafePrefix(x(95), 90), x(90));
  assert.equal(unitSafePrefix(x(5), 90), x(5));
  assert.equal(unitSafePrefix(x(89) + HIGH + "y", 90), x(89) + HIGH, "a half already lone is not this cut's to drop");
  assert.equal(unitSafePrefix(GRIN, 1), "");
  assert.equal(unitSafePrefix(GRIN, 0), "");
});

test("a seeded fuzz over emoji and lone halves: cappedLongText and unitSafePrefix never leave half an emoji (#434)", () => {
  const parts = ["a", " ", "\n", GRIN, HIGH, LOW, "é", "‍", "\u{1F469}"];
  const next = seeded(434);
  for (let round = 0; round < 3000; round++) {
    let s = "";
    for (let k = next(14); k > 0; k--) s += parts[next(parts.length)];
    const max = next(10);
    const where = JSON.stringify([s, max]);
    const clean = withoutLoneSurrogates(s);
    const long = cappedLongText(s, max);
    assert.ok(!LONE.test(long), "no lone half: " + where);
    assert.ok(clean.startsWith(long), "a prefix of the clean text: " + where);
    assert.equal(codePoints(long), Math.min(max, codePoints(clean)), "max code points: " + where);
    assert.equal(cappedLongText(long, max), long, "a fixed point: " + where);
    const label = unitSafePrefix(s, max);
    assert.ok(s.startsWith(label), "a prefix: " + where);
    assert.ok(label.length <= max && (s.length <= max ? label === s : label.length >= max - 1), "max units: " + where);
    const end = label.charCodeAt(label.length - 1), after = s.charCodeAt(label.length);
    assert.ok(!(end >= 0xd800 && end <= 0xdbff && after >= 0xdc00 && after <= 0xdfff), "never inside a pair: " + where);
  }
});

function migrated(doc: Bag): Bag {
  return migrateRows(Object.assign({ schema: 2, rows: [], comments: [], people: [] }, doc), fakeMigration().ports) as unknown as Bag;
}

const ACROSS = (n: number): string => x(n - 1) + GRIN + "tail";
const KEPT = (n: number): string => x(n - 1) + GRIN;

test("migrateRows cuts the title at 300 code points and drops its lone halves (#434)", () => {
  assert.equal(migrated({ title: ACROSS(300) }).title, KEPT(300));
  assert.equal(migrated({ title: "My " + HIGH + "script " }).title, "My script ");
  assert.equal(migrated({ title: x(299) + HIGH }).title, x(299));
});

test("migrateRows cuts tag notes and shot description, notes and reference at 2000 code points, without a lone half (#434)", () => {
  const out = migrated({
    productionTags: [{ id: "t_a", cat: "prop", name: "Mug", notes: ACROSS(2000) }, { id: "t_b", cat: "prop", name: "Cup", notes: " two\n" + LOW + "lines " }],
    brollShots: [{ id: "bs1", name: "Shot", desc: ACROSS(2000), notes: ACROSS(2000), audioRef: ACROSS(2000), origin: "list" },
                 { id: "bs2", name: "Other", desc: "a" + HIGH + " b", notes: HIGH, audioRef: " ref ", origin: "list" }]
  });
  const tags = out.productionTags as Bag[], shots = out.brollShots as Bag[];
  assert.deepEqual(tags.map((t) => t.notes), [KEPT(2000), " two\nlines "]);
  assert.deepEqual(shots.map((b) => [b.desc, b.notes, b.audioRef]), [[KEPT(2000), KEPT(2000), KEPT(2000)], ["a b", "", " ref "]]);
});

test("a seeded fuzz: migrateRows leaves no lone half in a title, note, description or reference, and a second load changes nothing (#434)", () => {
  const parts = ["x", " ", "\n", GRIN, HIGH, LOW, "<b>", "\u0007"];
  const next = seeded(1434);
  const text = (len: number): string => {
    let s = "";
    while (s.length < len) s += parts[next(parts.length)];
    return s;
  };
  for (let round = 0; round < 200; round++) {
    const near = (cap: number): number => cap - 3 + next(7);
    const doc = {
      title: text(near(300)),
      productionTags: [{ id: "t_a", cat: "prop", name: "Mug", notes: text(near(2000)) }],
      brollShots: [{ id: "bs1", name: "Shot", desc: text(near(2000)), notes: text(near(2000)), audioRef: text(near(2000)), origin: "list" }]
    };
    const once = migrated(JSON.parse(JSON.stringify(doc)) as Bag);
    const tag = (once.productionTags as Bag[])[0] as Bag, shot = (once.brollShots as Bag[])[0] as Bag;
    [once.title, tag.notes, shot.desc, shot.notes, shot.audioRef].forEach((v, i) => {
      assert.equal(typeof v, "string");
      assert.ok(!LONE.test(v as string), "round " + round + " field " + i);
      assert.ok(codePoints(v as string) <= (i ? 2000 : 300), "round " + round + " field " + i);
    });
    const json = JSON.stringify(once);
    assert.equal(JSON.stringify(migrated(JSON.parse(json) as Bag)), json, "round " + round);
  }
});

test("picture annotation text is cut at 500 code points, without a lone half (#434)", () => {
  const mark = (text: string): Bag => ({ kind: "text", color: "#e5383b", size: 0.05, x: 0.1, y: 0.1, text: text });
  const texts = normalizeMarks([mark(ACROSS(500)), mark("a" + HIGH + "b"), mark(" two\nlines ")]).map(markText);
  assert.deepEqual(texts, [KEPT(500), "ab", " two\nlines "]);
});

test("an annotation text of only lone halves is kept as stored, not lost (#434)", () => {
  const mark = { kind: "text", color: "#e5383b", size: 0.05, x: 0.1, y: 0.1, text: " " + HIGH + " " };
  assert.deepEqual(normalizeMarks([mark]).map(markText), [" " + HIGH + " "]);
  assert.deepEqual(normalizeMarks([Object.assign({}, mark, { text: x(499) + HIGH + HIGH })]).map(markText), [x(499)]);
});

test("a B-roll line's description and seed reference are cut at 2000 code points (#434)", () => {
  const cell = [{ text: "B-roll: Shot\n" + x(1999) + GRIN + "tail", marks: {} }];
  assert.deepEqual(brollInCell(cell).map((b) => b.desc), [KEPT(2000)]);
  const row = { id: "r1", audioText: " " + ACROSS(2000), visualText: "" } as unknown as ProductionRow;
  assert.equal(brollSeedRef(row, (html) => String(html)), KEPT(2000));
});
