import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import type { IdSource } from "../../../src/core/document/ports.ts";
import { ensureTagIds, registryKey } from "../../../src/core/document/tags.ts";
import { plainText } from "../../../src/core/document/text-policy.ts";
import { anchorBrollCell, applyBrollRecords, brollAnchorTodo, brollEntries, planBrollAnchors, planBrollRecords } from "../../../src/core/production/broll.ts";
import type { BrollEntry, BrollShot } from "../../../src/core/production/broll.ts";
import { createProductionReaders } from "../../../src/core/production/readers.ts";
import {
  bulkTagCell,
  collectTagsFromRows,
  deriveProductionIndex,
  holdsMedia,
  missingRegistryTags,
  planQuickAdd,
  planRegistryHealing,
  tagOccurrences
} from "../../../src/core/production/tags.ts";
import type { CueSnapshot, HealingPlan, MediaTagWriter, ProductionIndex, RegistryTag } from "../../../src/core/production/tags.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { maskTokens, newTokens } from "../../../src/test/golden-helpers.mjs";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migratedThenSet } from "../migrate-ports.ts";
import { countingIds, jsonCopy, plainTextOf } from "./cells.ts";
import { storedDecoder } from "./stored.ts";

type Row = { id: string; visualText: string; audioText: string };
type Doc = { docId: string; rows: Row[]; productionTags: RegistryTag[]; brollShots: BrollShot[] };
type Live = Doc & ValidatedDocument;
type Out = Record<string, unknown>;

const stored = storedDecoder();
const readers = createProductionReaders(stored.decode, deepFreeze);
const NO_MEDIA: MediaTagWriter = function () { throw new Error("no golden document cell holds media"); };
const MINTED_SHOT = /\bbs[0-9a-z]{6,}\b/g;
const PRESENTATION_ONLY = ["demoSha256", "byCategory", "shotsByProp"];

function fixture(name: string): Out {
  return JSON.parse(readFileSync(new URL("../../../src/test/fixtures/golden/production-" + name + ".json", import.meta.url), "utf8")) as Out;
}

const LONG_DEMO = JSON.parse(readFileSync(new URL("../../../src/starters/long-demo.json", import.meta.url), "utf8")) as Doc;

function demo(): Live {
  const doc = jsonCopy(LONG_DEMO);
  doc.docId = "d" + "7".repeat(32);
  return migratedThenSet(doc);
}

function entriesView(entries: ProductionIndex["entries"]): unknown[] {
  return entries.map((e) => ({
    key: e.key, id: e.id, cat: e.catId, name: e.name, mentions: e.mentions, orphaned: e.orphaned, owner: e.owner, notes: e.notes, status: e.status
  }));
}

function brollView(doc: Doc, list: readonly BrollEntry[]): unknown[] {
  return list.map((e) => {
    const at = doc.brollShots.indexOf(e.rec);
    return Object.assign({}, e, { rec: at === -1 ? { fresh: jsonCopy(e.rec) } : { stored: at } });
  });
}

const unchangedOr = (before: unknown, now: unknown): unknown => (JSON.stringify(before) === JSON.stringify(now) ? "unchanged" : jsonCopy(now));
const sameAsOr = (label: string, earlier: unknown, now: unknown): unknown => (JSON.stringify(earlier) === JSON.stringify(now) ? "same as " + label : now);

function planned<T>(doc: Doc, plan: () => T): T {
  const before = JSON.stringify(doc);
  const out = plan();
  assert.equal(JSON.stringify(doc), before, "a plan wrote the document it read");
  return out;
}

function applyHealing(doc: Doc, plan: HealingPlan): void {
  plan.retitle.forEach((r) => { (doc.productionTags[r.at] as RegistryTag).name = r.name; });
  plan.register.forEach((t) => { doc.productionTags.push(t); });
}

function anchorAll(doc: Live, ids: IdSource): number {
  const plan = planned(doc, () => planBrollAnchors(doc, readers, ids));
  let total = 0;
  doc.rows.forEach((row) => {
    const cell = readers.cellOf(row.visualText);
    const todo = brollAnchorTodo(cell, row.id, plan);
    if (!todo.length) return;
    assert.equal(holdsMedia(row.visualText), false);
    const res = anchorBrollCell(cell, todo);
    if (res.anchored) row.visualText = toHtml(res.cell);
    total += res.anchored;
  });
  return total;
}

function readAll(doc: Live, ids: IdSource): Out {
  const before = JSON.stringify(doc);
  const out: Out = {
    entries: entriesView(deriveProductionIndex(doc, readers).entries),
    brollRead: brollView(doc, brollEntries(doc, readers, ids, plainTextOf))
  };
  out.readsWroteNothing = JSON.stringify(doc) === before;
  return out;
}

function occurrencesOf(doc: Doc, names: { cat: string; name: string }[]): unknown[] {
  return names.map(({ cat, name }) => {
    const hits: unknown[] = [];
    doc.rows.forEach((r) => {
      (["visualText", "audioText"] as const).forEach((field) => {
        const found = tagOccurrences(readers.cellOf(r[field]), name);
        if (found.length) hits.push({ rowId: r.id, field, ranges: found.map((m) => [m.from, m.to]) });
      });
    });
    const visualColumnCount = { hits: 0, inTags: 0, skipped: 0 };
    doc.rows.forEach((r) => {
      const res = bulkTagCell(r.visualText, name, cat, name, false, true, readers, NO_MEDIA);
      visualColumnCount.hits += res.hits;
      visualColumnCount.inTags += res.inTags;
      visualColumnCount.skipped += res.skipped;
    });
    return { cat, name, hits, visualColumnCount };
  });
}

function repairAll(doc: Live, out: Out, ids: IdSource): Out {
  const registryBefore = jsonCopy(doc.productionTags);
  const heal = planned(doc, () => planRegistryHealing(doc, readers, null));
  applyHealing(doc, heal);
  out.healed = heal.count;
  out.registryAfterHeal = unchangedOr(registryBefore, doc.productionTags);
  out.entriesAfterHeal = sameAsOr("entries", out.entries, entriesView(deriveProductionIndex(doc, readers).entries));
  const again = planned(doc, () => planRegistryHealing(doc, readers, heal.cues));
  applyHealing(doc, again);
  out.healedAgain = again.count;
  const shotsBefore = jsonCopy(doc.brollShots);
  const records = planned(doc, () => planBrollRecords(doc, readers, ids, plainTextOf, null));
  applyBrollRecords(doc.brollShots, records);
  const repair = brollView(doc, brollEntries(doc, readers, ids, plainTextOf));
  out.brollRepair = sameAsOr("brollRead", out.brollRead, repair);
  out.shotsAfterRepair = unchangedOr(shotsBefore, doc.brollShots);
  const rowsBefore = jsonCopy(doc.rows.map((r) => r.visualText));
  out.anchored = anchorAll(doc, ids);
  out.visualAfterAnchoring = unchangedOr(rowsBefore, doc.rows.map((r) => r.visualText));
  out.brollAfterAnchoring = sameAsOr("brollRepair", repair, brollView(doc, brollEntries(doc, readers, ids, plainTextOf)));
  return out;
}

function masked(out: Out, input: unknown): Out {
  const tokens: string[] = newTokens(out, input, MINTED_SHOT);
  tokens.forEach((t) => assert.match(t, /^bs[0-9a-z]+$/));
  return maskTokens(out, tokens, "minted-broll-id") as Out;
}

function matchesGolden(name: string, mine: Out): void {
  const golden = fixture(name);
  assert.deepEqual(Object.keys(mine), Object.keys(golden).filter((k) => PRESENTATION_ONLY.indexOf(k) === -1));
  Object.keys(mine).forEach((k) => sameText(mine[k], golden[k], name + ": " + k));
}

function sameText(mine: unknown, golden: unknown, label: string): void {
  assert.equal(JSON.stringify(mine, null, 2), JSON.stringify(golden, null, 2), label);
}

test("every long demo cell is in stored form, so the stored reader decodes it as the app does", () => {
  LONG_DEMO.rows.forEach((r) => {
    assert.equal(toHtml(stored.decode(r.visualText)), r.visualText);
    assert.equal(toHtml(stored.decode(r.audioText)), r.audioText);
  });
});

test("the long demo as shipped: the reads, the plans and their application give what the legacy path wrote", () => {
  const doc = demo();
  const input = jsonCopy(doc);
  const ids = countingIds();
  const out = readAll(doc, ids);
  out.occurrences = occurrencesOf(doc, doc.productionTags.map((t) => ({ cat: t.cat, name: t.name })));
  matchesGolden("long-demo", masked(repairAll(doc, out, ids), input));
});

test("the long demo with its registry emptied: the healing plan registers what the legacy heal wrote", () => {
  const doc = demo();
  const input = jsonCopy(doc);
  doc.productionTags = [];
  const ids = countingIds();
  matchesGolden("long-demo-registry-emptied", masked(repairAll(doc, readAll(doc, ids), ids), input));
});

test("the long demo with its shots dropped: the b-roll plan creates the shots the legacy repair wrote", () => {
  const doc = demo();
  const input = jsonCopy(doc);
  doc.brollShots = [];
  const ids = countingIds();
  matchesGolden("long-demo-shots-dropped", masked(repairAll(doc, readAll(doc, ids), ids), input));
});

test("the crafted b-roll document: creations, renames and anchoring match the legacy writes", () => {
  const fx = fixture("broll-crafted");
  const doc = migratedThenSet(jsonCopy(fx.input) as Doc);
  const ids = countingIds();
  const out: Out = Object.assign({ input: jsonCopy(fx.input) }, readAll(doc, ids));
  matchesGolden("broll-crafted", masked(repairAll(doc, out, ids), fx.input));
});

test("the crafted healing document: the plan registers what the legacy heal wrote, the raw cells read as the sanitiser leaves them", () => {
  const fx = fixture("heal-crafted");
  const doc = migratedThenSet(jsonCopy(fx.input) as Doc);
  doc.rows = jsonCopy(fx.edited) as Row[];
  const inputCells = new Set((fx.input as Doc).rows.flatMap((r) => [r.visualText, r.audioText]));
  doc.rows.forEach((r) => [r.visualText, r.audioText].forEach((html) => { if (!inputCells.has(html)) stored.raw.add(html); }));
  const ids = countingIds();
  const out: Out = Object.assign({ input: jsonCopy(fx.input), edited: jsonCopy(fx.edited) }, readAll(doc, ids));
  out.occurrences = occurrencesOf(doc, [{ cat: "prop", name: "kettle" }, { cat: "prop", name: "Mug" }, { cat: "sound", name: "whistle" }]);
  matchesGolden("heal-crafted", masked(repairAll(doc, out, ids), fx.input));
});

const cue = (inner: string): string => "<span class=\"audio-cue\">" + inner + "</span>";
const tagSpan = (cat: string, name: string): string =>
  "<span class=\"tag-anchor\" data-tag-cat=\"" + cat + "\" data-tag-name=\"" + name + "\" contenteditable=\"false\">" + name + "</span>";

function row(id: string, audioText?: string, visualText?: string): Row {
  return { id, visualText: visualText || "", audioText: audioText || "" };
}

function loadWithoutRegistry(docId: string, rows: Row[]): Live {
  const productionTags: RegistryTag[] = collectTagsFromRows(rows, readers)
    .map((t) => ({ cat: t.catId, name: plainText(t.name).trim().slice(0, 80), status: "needed", owner: "", notes: "" }))
    .filter((t) => t.name);
  missingRegistryTags(rows, productionTags, readers).forEach((t) => { productionTags.push(t); });
  ensureTagIds(productionTags);
  return migratedThenSet<Doc>({ docId, rows, productionTags, brollShots: [] });
}

function cueDoc(docId: string, rows?: Row[]): Live {
  return loadWithoutRegistry(docId, rows || [
    row("r1", "Welcome back.<br>" + cue("SFX: door slam") + "<br>Today, the kettle.", "Kitchen"),
    row("r2", cue("Music: upbeat intro")),
    row("r3", "")
  ]);
}

test("cue retitling: the healing plans, applied step by step, match every legacy heal", () => {
  let doc = cueDoc("d" + "a".repeat(32));
  let cues: CueSnapshot | null = null;
  const heal = (): number => {
    const plan = planned(doc, () => planRegistryHealing(doc, readers, cues));
    cues = plan.cues;
    applyHealing(doc, plan);
    return plan.count;
  };
  const rowOf = (id: string): Row => doc.rows.find((r) => r.id === id) as Row;
  const setAudio = (id: string, html: string) => (): number => { rowOf(id).audioText = html; return heal(); };
  const setVisual = (id: string, html: string) => (): number => { rowOf(id).visualText = html; return heal(); };
  const entryNamed = (name: string): RegistryTag => doc.productionTags.find((t) => t.name === name) as RegistryTag;
  const steps = (list: [string, () => number | undefined][]): unknown[] => list.map(([label, fn]) => {
    const healed = fn();
    return {
      step: label, healed: healed === undefined ? null : healed,
      sound: doc.productionTags.filter((t) => t.cat === "sound").map((t) => [t.id, t.name, t.status, t.notes]),
      orphaned: deriveProductionIndex(doc, readers).entries.filter((e) => e.orphaned).map((e) => e.key)
    };
  });
  const out: Out = {};

  out.typedWithPauses = steps([
    ["open and heal", heal],
    ["Music: slow", setAudio("r3", cue("Music: slow"))],
    ["Music: slow piano", setAudio("r3", cue("Music: slow piano"))],
    ["Music: slow piano intro", setAudio("r3", cue("Music: slow piano intro"))],
    ["marked Have it with a note", () => { Object.assign(entryNamed("slow piano intro"), { status: "have", notes: "the Rhodes take" }); return undefined; }],
    ["a one-letter fix", setAudio("r3", cue("Music: slow piano intros"))],
    ["undone", setAudio("r3", cue("Music: slow piano intro"))]
  ]);

  doc = cueDoc("d" + "b".repeat(32));
  out.oldNameStillInScript = steps([
    ["open with the cue twice", () => { (doc.rows[1] as Row).audioText = cue("SFX: door slam"); return heal(); }],
    ["marked Have it", () => { entryNamed("door slam").status = "have"; return undefined; }],
    ["one copy edited", setAudio("r2", cue("SFX: door slams"))]
  ]);

  doc = cueDoc("d" + "c".repeat(32));
  out.oldNameStillTagged = steps([
    ["a tag of the same name", setVisual("r1", "Kitchen " + tagSpan("sound", "door slam"))],
    ["the cue edited", setAudio("r1", "Welcome back.<br>" + cue("SFX: door bang"))]
  ]);

  doc = cueDoc("d" + "d".repeat(32));
  out.newNameAlreadyTracked = steps([
    ["open and heal", heal],
    ["the cue moved to another row", () => {
      (doc.rows[1] as Row).audioText = cue("Music: door slam");
      (doc.rows[0] as Row).audioText = "Welcome back.";
      return heal();
    }],
    ["the first cue renamed to a tracked name", setAudio("r1", "Welcome back.<br>" + cue("SFX: upbeat intro"))]
  ]);

  doc = cueDoc("d" + "e".repeat(32), [
    row("r1", cue("SFX: door slam") + "<br>Then.<br>" + cue("SFX: kettle whistle")),
    row("r2", cue("Music: theme"))
  ]);
  out.twoCuesInOneCell = steps([
    ["open and heal", heal],
    ["both edited at once", setAudio("r1", cue("SFX: door slams") + "<br>Then.<br>" + cue("SFX: kettle whistles"))],
    ["one removed, one edited", setAudio("r1", "Then.<br>" + cue("SFX: kettle whistling"))]
  ]);

  doc = cueDoc("d" + "f".repeat(32));
  out.cueMovedToAnotherRow = steps([
    ["open and heal", heal],
    ["removed from one row, a new one in another", () => {
      (doc.rows[1] as Row).audioText = "";
      (doc.rows[2] as Row).audioText = cue("Music: upbeat outro");
      return heal();
    }]
  ]);

  const docA = cueDoc("d" + "0".repeat(31) + "a");
  const docB = cueDoc("d" + "0".repeat(31) + "b");
  out.anotherDocumentBetweenHeals = steps([
    ["document A healed", () => { doc = docA; return heal(); }],
    ["document B healed", () => { doc = docB; return heal(); }],
    ["back to A with its cue edited", () => {
      doc = docA;
      (doc.rows[1] as Row).audioText = cue("Music: upbeat intros");
      return heal();
    }]
  ]);

  sameText(out, fixture("cue-retitle"), "cue-retitle");
});

test("the Gear quick add: each plan, applied as the panel applies it, leaves the registry the legacy apply left", () => {
  const fx = fixture("gear-quick-add");
  const golden = fx.steps as Out[];
  let doc = migratedThenSet(jsonCopy(fx.input) as Doc);
  const quickAdd = (label: string, lines: string[], eol?: string): Out => {
    const text = lines.join(eol || "\n");
    const others = jsonCopy(doc.productionTags.filter((t) => t.cat !== "gear"));
    const plan = planned(doc, () => planQuickAdd(doc, readers, text));
    plan.remove.forEach((name) => {
      const key = registryKey("gear", name);
      doc.productionTags = doc.productionTags.filter((t) => registryKey(t.cat, t.name) !== key);
    });
    plan.register.forEach((t) => { doc.productionTags.push(t); });
    const parts: string[] = [];
    if (plan.added) parts.push("added " + plan.added);
    if (plan.removed) parts.push("removed " + plan.removed);
    return {
      step: label, typed: text,
      gear: doc.productionTags.filter((t) => t.cat === "gear").map((t) => [t.id, t.name, t.status, t.notes]),
      otherTagsUntouched: JSON.stringify(others) === JSON.stringify(doc.productionTags.filter((t) => t.cat !== "gear")),
      toasts: parts.length ? ["Gear list updated — " + parts.join(", ") + "."] : [],
      boxAfter: deriveProductionIndex(doc, readers).entries.filter((e) => e.catId === "gear").map((e) => e.name)
        .sort((a, b) => a.localeCompare(b)).join("\n"),
      dirty: parts.length > 0
    };
  };
  const lines = ["tripod", "  Lav mic  ", "Gimbal", "constructor", "__proto__", "toString", "hasOwnProperty", "x".repeat(81),
    "<b>Boom</b> pole", "", "   ", "Lav Mic"];
  const mine = [
    quickAdd("a list with every kind of line, CRLF", lines, "\r\n"),
    quickAdd("the same list again, LF", lines, "\n"),
    quickAdd("the same list, CR", lines, "\r"),
    quickAdd("a list leaving out everything not in the script", ["Tripod", "Slider"])
  ];
  doc = migratedThenSet<Doc>({
    docId: "d" + "5".repeat(31) + "c",
    rows: jsonCopy((fx.input as Doc).rows),
    productionTags: [
      { id: "t_tripod", cat: "gear", name: "Tripod", owner: "", notes: "", status: "needed" },
      { id: "t_spare", cat: "gear", name: "Spare battery", owner: "", notes: "", status: "needed" }
    ],
    brollShots: []
  });
  missingRegistryTags(doc.rows, doc.productionTags, readers).forEach((t) => { doc.productionTags.push(t); });
  ensureTagIds(doc.productionTags);
  mine.push(quickAdd("lines named after Object's own properties, none tracked yet", ["constructor", "__proto__", "Tripod", "toString"]));
  mine.push(quickAdd("an empty list", [""]));
  assert.equal(mine.length, golden.length);
  mine.forEach((step, i) => {
    const want = Object.assign({}, golden[i]);
    Reflect.deleteProperty(want, "personColors");
    sameText(step, want, String(step.step));
  });
});
