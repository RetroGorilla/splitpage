import { test } from "node:test";
import assert from "node:assert/strict";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { mintTagId } from "../../../src/core/document/tags.ts";
import {
  bulkTagCell,
  closeCueNames,
  collectTagsFromRows,
  cueEditPairs,
  deriveProductionIndex,
  holdsMedia,
  missingRegistryTags,
  newRegistryTag,
  planQuickAdd,
  planRegistryHealing,
  refreshedProductionIndex,
  registryEntry,
  registryIndex,
  retagCell,
  snapshotCues,
  tagFieldOccurrences,
  tagOccurrences
} from "../../../src/core/production/tags.ts";
import type { MediaTagWriter, NewRegistryTag, RegistryTag, TagState } from "../../../src/core/production/tags.ts";
import type { ProductionRow } from "../../../src/core/production/ports.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migratedThenSet } from "../migrate-ports.ts";
import { B, T, cue, jsonCopy, mapDecoder, readersOver, tag } from "./cells.ts";

const cells = mapDecoder();
const EMPTY = cells.html([]);
const readers = readersOver(cells);

const NO_MEDIA: MediaTagWriter = function () { throw new Error("no cell here holds media"); };

function doc(state: TagState): TagState & ValidatedDocument {
  return migratedThenSet(state);
}

const R1: ProductionRow = {
  id: "r1",
  visualText: cells.html([T("Wide on the "), tag("location", "Kitchen", "kitchen")]),
  audioText: cells.html([T("Fill the "), tag("prop", "Kettle", "kettle"), T(".")])
};
const R2: ProductionRow = {
  id: "r2",
  visualText: cells.html([cue("SFX: whistle")]),
  audioText: cells.html([tag("prop", "kettle ", "KETTLE"), T(" and "), tag("bogus", "Thing")])
};

function registered(cat: string, name: string, extra?: Partial<RegistryTag>): RegistryTag {
  return Object.assign({ id: mintTagId(cat, name), cat: cat, name: name, owner: "", notes: "", status: "needed" }, extra || {});
}

function minted(registry: RegistryTag[], cat: string, names: string[]): NewRegistryTag[] {
  const work: RegistryTag[] = registry.slice();
  return names.map(function (name) {
    const rec: NewRegistryTag = { id: mintTagId(cat, name, work), cat: cat, name: name, owner: "", notes: "", status: "needed" };
    work.push(rec);
    return rec;
  });
}

test("collectTagsFromRows groups mentions by category and name, visual column first, with category ids", () => {
  assert.deepEqual(collectTagsFromRows([R1, R2], readers), [
    { key: "location kitchen", catId: "location", name: "Kitchen", mentions: [{ rowId: "r1", rowIndex: 0, field: "visualText", text: "kitchen" }] },
    {
      key: "prop kettle", catId: "prop", name: "Kettle", mentions: [
        { rowId: "r1", rowIndex: 0, field: "audioText", text: "kettle" },
        { rowId: "r2", rowIndex: 1, field: "audioText", text: "KETTLE" }
      ]
    },
    { key: "sound whistle", catId: "sound", name: "whistle", mentions: [{ rowId: "r2", rowIndex: 1, field: "visualText", text: "SFX: whistle" }] }
  ]);
  assert.deepEqual(collectTagsFromRows(null, readers), []);
});

test("missingRegistryTags lists each live tag the registry lacks once, its name cleaned and cut at 80", () => {
  const r3: ProductionRow = {
    id: "r3",
    visualText: cells.html([tag("prop", "<b>Boom</b> pole", "boom"), T(" "), tag("gear", "L".repeat(85), "lens"), T(" "), tag("vfx", "<i></i>", "glow")]),
    audioText: EMPTY
  };
  const needed = { owner: "", notes: "", status: "needed" };
  assert.deepEqual(missingRegistryTags([R1, R2, r3], [{ cat: "prop", name: "KETTLE" }, null, { cat: "sound", name: "" }], readers), [
    Object.assign({ cat: "location", name: "Kitchen" }, needed),
    Object.assign({ cat: "sound", name: "whistle" }, needed),
    Object.assign({ cat: "prop", name: "Boom pole" }, needed),
    Object.assign({ cat: "gear", name: "L".repeat(80) }, needed)
  ]);
  assert.deepEqual(missingRegistryTags([R1], null, readers).map((t) => t.name), ["Kitchen", "Kettle"]);
});

test("registry lookups match by category and normalised name, first entry first", () => {
  const registry = [registered("gear", "Tripod", { id: "t_a" }), registered("gear", "tripod ", { id: "t_b" })];
  assert.equal(registryIndex(registry, "gear", "  TRIPOD"), 0);
  assert.equal(registryEntry(registry, "gear", "tripod"), registry[0]);
  assert.equal(registryEntry(registry, "prop", "Tripod"), null);
  assert.equal(newRegistryTag(registry, "gear", "TRIPOD"), null);
  assert.deepEqual(newRegistryTag(registry, "gear", "Slider"), minted(registry, "gear", ["Slider"])[0]);
  const taken = [{ id: mintTagId("gear", "Slider"), cat: "prop", name: "Something else" }];
  assert.equal(newRegistryTag(taken, "gear", "Slider")?.id, mintTagId("gear", "Slider") + "-2");
});

test("a blank or whitespace-only name registers nothing, in any category (#298)", () => {
  const registry = [registered("gear", "Tripod")];
  for (const name of ["", " ", "   ", "\t", "\n", " ", "  \t\r\n ", "​", "‌", "‍", "⁠", "­", "﻿", " ​ ‍⁠­\t "]) {
    for (const cat of ["gear", "prop", "sound"]) {
      assert.equal(newRegistryTag(registry, cat, name), null, JSON.stringify(name) + " in " + cat);
    }
  }
  assert.equal(newRegistryTag(registry, "gear", null as unknown as string), null);
  assert.equal(newRegistryTag(registry, "gear", undefined as unknown as string), null);
  assert.equal(newRegistryTag([], "gear", " a ")?.name, " a ", "a name with words is registered as given");
  assert.equal(newRegistryTag([], "gear", "!!")?.name, "!!", "punctuation alone is a name");
  assert.equal(newRegistryTag([], "gear", "a​b")?.name, "a​b", "an invisible character inside a name is kept as it is");
});

function occ(cell: Run[], phrase: unknown): number[][] {
  return tagOccurrences(normalizeCell(cell), phrase).map((m) => [m.from, m.to]);
}

test("tagOccurrences finds whole words outside tags, links and line breaks, folding case without changing length", () => {
  assert.deepEqual(occ([T("the kettle, the Kettle and KETTLE")], "kettle"), [[4, 10], [16, 22], [27, 33]]);
  assert.deepEqual(occ([tag("prop", "Kettle", "kettle"), T(" and a kettle")], "kettle"), [[13, 19]]);
  assert.deepEqual(occ([T("kettle", { href: "https://x.example/" }), T(" kettle")], "kettle"), [[7, 13]]);
  assert.deepEqual(occ([T("kettles teakettle kettle-black kettle_")], "kettle"), [[18, 24], [31, 37]]);
  assert.deepEqual(occ([T("red\nmug red mug")], "red mug"), [[8, 15]]);
  assert.deepEqual(occ([B("bs1"), T("kettle")], "kettle"), [[1, 7]]);
  assert.deepEqual(occ([T("İstanbul istanbul")], "istanbul"), [[9, 17]]);
  assert.deepEqual(occ([T("kettle")], ""), []);
  assert.deepEqual(occ([T("kettle")], null), []);
});

test("tagOccurrences skips a match whose characters carry different comments", () => {
  assert.deepEqual(occ([T("ket"), T("tle", { cmt: ["c1"] }), T(" "), T("kettle", { cmt: ["c1"] })], "kettle"), [[7, 13]]);
});

const BULK = cells.html([T("A kettle, a Kettle, and "), tag("prop", "Kettle", "kettle"), T(" again; kettles")]);

test("bulkTagCell tags every free occurrence and counts those already tagged", () => {
  const res = bulkTagCell(BULK, " kettle ", "prop", " Kettle ", false, false, readers, NO_MEDIA);
  assert.deepEqual(res, {
    hits: 2, inTags: 1, skipped: 0,
    html: toHtml([
      T("A "), tag("prop", "Kettle", "kettle"), T(", a "), tag("prop", "Kettle", "Kettle"), T(", and "),
      tag("prop", "Kettle", "kettle"), T(" again; kettles")
    ])
  });
  const exact = bulkTagCell(BULK, "kettle", "prop", "Kettle", true, false, readers, NO_MEDIA);
  assert.deepEqual([exact.hits, exact.inTags, exact.skipped], [1, 1, 0]);
  assert.deepEqual(bulkTagCell(BULK, "kettle", "prop", "Kettle", false, true, readers, NO_MEDIA), { hits: 2, inTags: 1, skipped: 0, html: BULK });
  assert.deepEqual(bulkTagCell(BULK, "  ", "prop", "Kettle", false, false, readers, NO_MEDIA), { hits: 0, inTags: 0, skipped: 0, html: BULK });
  const linked = cells.html([T("kettle", { href: "https://x.example/" }), T(" kettle")]);
  const counted = bulkTagCell(linked, "kettle", "prop", "Kettle", false, true, readers, NO_MEDIA);
  assert.deepEqual([counted.hits, counted.inTags, counted.skipped], [1, 0, 1], "a whole word inside a link is skipped");
});

test("a cell holding media is tagged through the media writer, which can refuse", () => {
  const cell = [T("kettle and kettle")];
  const media = cells.put(toHtml(cell) + "<img class=\"comment-img\" data-blob=\"ab\">", cell);
  assert.equal(holdsMedia(media), true);
  assert.equal(holdsMedia(toHtml(cell) + "<a class=\"video-embed-card\" href=\"https://youtu.be/x\">x</a>"), true);
  assert.equal(holdsMedia(BULK), false);
  assert.equal(holdsMedia(undefined), false);
  const calls: unknown[] = [];
  const writer: MediaTagWriter = function (html, decoded, found, cat, name) {
    calls.push({ html: html, cells: decoded.length, found: found.map((m) => [m.from, m.to]), cat: cat, name: name });
    return "wrapped";
  };
  assert.deepEqual(bulkTagCell(media, "kettle", "prop", " Kettle ", false, false, readers, writer),
    { hits: 2, inTags: 0, skipped: 0, html: "wrapped" });
  assert.deepEqual(calls, [{ html: media, cells: 1, found: [[0, 6], [11, 17]], cat: "prop", name: "Kettle" }]);
  assert.deepEqual(bulkTagCell(media, "kettle", "prop", "Kettle", false, false, readers, () => null),
    { hits: 0, inTags: 0, skipped: 2, html: media });
});

test("tagFieldOccurrences tags one occurrence, all of them, or counts them", () => {
  const mugs = cells.html([T("mug, mug and mug")]);
  assert.deepEqual(tagFieldOccurrences(mugs, "mug", "prop", "Mug", false, 1, readers, NO_MEDIA),
    { hits: 1, html: toHtml([T("mug, "), tag("prop", "Mug", "mug"), T(" and mug")]) });
  assert.deepEqual(tagFieldOccurrences(mugs, "mug", "prop", "Mug", false, 5, readers, NO_MEDIA), { hits: 0, html: mugs });
  assert.deepEqual(tagFieldOccurrences(mugs, "mug", "prop", "Mug", true, undefined, readers, NO_MEDIA), { hits: 3, html: mugs });
  assert.equal(tagFieldOccurrences(mugs, "mug", "prop", "Mug", false, undefined, readers, NO_MEDIA).hits, 3);
  assert.deepEqual(tagFieldOccurrences(undefined, "mug", "prop", "Mug", false, undefined, readers, NO_MEDIA), { hits: 0, html: undefined });
});

test("retagCell renames or removes one item's tags, and its cue lines for a sound", () => {
  const html = cells.html([
    T("Fill "), tag("prop", "Kettle", "kettle"), T(" and "), tag("prop", "kettle ", "the kettle"), T(", "),
    tag("prop", "Mug", "mug"), T(" "), tag("gear", "Kettle", "rig")
  ]);
  assert.equal(retagCell(html, "prop", "kettle", "t:prop:Copper kettle", readers), toHtml([
    T("Fill "), tag("prop", "Copper kettle", "kettle"), T(" and "), tag("prop", "Copper kettle", "the kettle"), T(", "),
    tag("prop", "Mug", "mug"), T(" "), tag("gear", "Kettle", "rig")
  ]));
  assert.equal(retagCell(html, "prop", "kettle", null, readers),
    toHtml([T("Fill kettle and the kettle, "), tag("prop", "Mug", "mug"), T(" "), tag("gear", "Kettle", "rig")]));
  const cued = cells.html([cue("SFX: door slam"), T("\nThen "), tag("sound", "Door slam", "the slam")]);
  assert.equal(retagCell(cued, "sound", "door slam", "t:sound:Door bang", readers),
    toHtml([cue("SFX: Door bang"), T("\nThen "), tag("sound", "Door bang", "the slam")]));
  assert.equal(retagCell(cued, "sound", "door slam", null, readers), toHtml([T("SFX: door slam\nThen the slam")]));
  assert.equal(retagCell(cued, "prop", "door slam", null, readers), cued, "a cue is only a sound");
});

function tagState(): TagState & ValidatedDocument {
  return doc({
    docId: "d1",
    rows: [R1, R2],
    productionTags: [
      registered("prop", "kettle", { id: "t_kettle", owner: "p1", notes: "copper", status: "have" }),
      registered("prop", "Old prop", { id: "t_old", status: "returned" }),
      registered("bogus", "Kitchen", { id: "t_bogus" }),
      null,
      registered("prop", "KETTLE", { id: "t_dupe" }),
      registered("gear", "Tripod", { id: "t_tripod", status: "weird" })
    ]
  });
}

test("deriveProductionIndex lists registry entries in order, then the live tags it lacks", () => {
  const state = tagState();
  const ix = deriveProductionIndex(state, readers);
  assert.deepEqual(ix.entries.map((e) => [e.key, e.id, e.catId, e.name, e.mentions.length, e.orphaned, e.owner, e.notes, e.status]), [
    ["prop kettle", "t_kettle", "prop", "Kettle", 2, false, "p1", "copper", "have"],
    ["prop old prop", "t_old", "prop", "Old prop", 0, true, "", "", "returned"],
    ["gear tripod", "t_tripod", "gear", "Tripod", 0, true, "", "", "needed"],
    ["location kitchen", null, "location", "Kitchen", 1, false, "", "", "needed"],
    ["sound whistle", null, "sound", "whistle", 1, false, "", "", "needed"]
  ]);
  assert.deepEqual(ix.unregistered.map((t) => t.key), ["location kitchen", "sound whistle"]);
  assert.equal(ix.entries[3]?.mentions, ix.unregistered[0]?.mentions);
  assert.equal(ix.rowCount, 2);
  assert.equal(ix.tagSig.length, 36);
  assert.deepEqual(ix.tagSig.slice(18, 24), [null, null, null, null, null, null]);
});

test("an index is kept through prose edits and goes stale when what it reads changes", () => {
  const state = tagState();
  const ix = deriveProductionIndex(state, readers);
  assert.equal(refreshedProductionIndex(ix, state, readers), ix, "nothing changed, so the same index comes back");
  const reworded = cells.html([T("Now fill the "), tag("prop", "Kettle", "kettle"), T(" slowly.")]);
  const edited = Object.assign({}, state, { rows: [Object.assign({}, R1, { audioText: reworded }), R2] });
  const kept = refreshedProductionIndex(ix, edited, readers);
  assert.ok(kept && kept !== ix);
  assert.equal(kept.rowSig[2], reworded, "the signature follows the prose edit");
  assert.equal(kept.entries, ix.entries);
  assert.equal(kept.unregistered, ix.unregistered);
  assert.equal(kept.tagSig, ix.tagSig);
  assert.equal(refreshedProductionIndex(kept, edited, readers), kept);
  const retexted = cells.html([T("Fill the "), tag("prop", "Kettle", "big kettle")]);
  assert.equal(refreshedProductionIndex(ix, Object.assign({}, state, { rows: [Object.assign({}, R1, { audioText: retexted }), R2] }), readers), null);
  assert.equal(refreshedProductionIndex(deriveProductionIndex(state, readers), Object.assign({}, state, { rows: [R2, R1] }), readers), null);
  const restatused = jsonCopy(state);
  (restatused.productionTags[0] as RegistryTag).status = "sourcing";
  assert.equal(refreshedProductionIndex(deriveProductionIndex(state, readers), restatused, readers), null);
  const grown = Object.assign({}, state, { productionTags: state.productionTags.concat([registered("cast", "Ada")]) });
  assert.equal(refreshedProductionIndex(deriveProductionIndex(state, readers), grown, readers), null);
});

test("keeping an index through a prose edit writes nothing into the index it was given", () => {
  const state = tagState();
  const ix = deepFreeze(deriveProductionIndex(state, readers));
  const before = JSON.stringify(ix);
  const reworded = cells.html([T("Now fill the "), tag("prop", "Kettle", "kettle"), T(" slowly.")]);
  const reshot = cells.html([T("Wide on the "), tag("location", "Kitchen", "kitchen"), T(", then close.")]);
  const edited = Object.assign({}, state, { rows: [Object.assign({}, R1, { audioText: reworded, visualText: reshot }), R2] });
  const kept = refreshedProductionIndex(ix, edited, readers);
  assert.equal(JSON.stringify(ix), before);
  assert.ok(kept);
  assert.deepEqual(kept, deriveProductionIndex(edited, readers));
});

test("the healing plan registers each unregistered tag with an id minted after the ones before it, and writes nothing", () => {
  const registry = [registered("prop", "Kettle", { status: "have" }), { id: mintTagId("location", "Kitchen"), cat: "cast", name: "Taken" }];
  const state = doc({ docId: "d1", rows: [R1, R2], productionTags: registry });
  const before = JSON.stringify(state);
  const plan = planRegistryHealing(state, readers);
  assert.equal(JSON.stringify(state), before);
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.retitle, []);
  assert.deepEqual(plan.register, minted(registry, "location", ["Kitchen"]).concat(minted(
    registry.concat(minted(registry, "location", ["Kitchen"])), "sound", ["whistle"])));
  assert.equal(plan.register[0]?.id, mintTagId("location", "Kitchen") + "-2");
  assert.deepEqual(jsonCopy(plan.cues), { docId: "d1", cells: {} });
  assert.equal(Object.getPrototypeOf(plan.cues.cells), null, "the cells are keyed by scene id, in a map with no prototype");
});

test("the healing plan counts the names it takes in, not a name the registry refuses, which a fresh derivation still lists last as unregistered (#377)", () => {
  const refused = String.fromCharCode(0x2060);
  const row: ProductionRow = {
    id: "r1",
    visualText: EMPTY,
    audioText: cells.html([tag("prop", "kettle", "kettle"), T(" "), tag("prop", refused, refused), T(" "), tag("prop", "mug", "mug")])
  };
  const state = doc({ docId: "d1", rows: [row], productionTags: [] });
  const plan = planRegistryHealing(state, readers);
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.register.map((t) => t.name), ["kettle", "mug"]);
  const healed = doc({ docId: "d1", rows: [row], productionTags: plan.register });
  const ix = deriveProductionIndex(healed, readers);
  assert.deepEqual(ix.entries.map((e) => e.name), ["kettle", "mug", refused]);
  assert.deepEqual(ix.unregistered.map((t) => t.name), [refused]);
  assert.deepEqual(jsonCopy(planRegistryHealing(healed, readers, null, ix)), { cues: { docId: "d1", cells: {} }, count: 0, retitle: [], register: [] });
  const onlyRefused = doc({ docId: "d1", rows: [{ id: "r1", visualText: EMPTY, audioText: cells.html([tag("cast", refused, refused)]) }], productionTags: [] });
  assert.equal(planRegistryHealing(onlyRefused, readers).count, 0);
});

test("with nothing to register the plan is empty but still snapshots the cues", () => {
  const audio = cells.html([cue("Music: theme")]);
  const state = doc({ docId: "d2", rows: [{ id: "r1", visualText: EMPTY, audioText: audio }], productionTags: [registered("sound", "theme")] });
  assert.deepEqual(jsonCopy(planRegistryHealing(state, readers)), { cues: { docId: "d2", cells: { r1: ["theme"] } }, count: 0, retitle: [], register: [] });
  assert.deepEqual(jsonCopy(snapshotCues(state, readers)), { docId: "d2", cells: { r1: ["theme"] } });
});

function cueRow(id: string, lines: string[]): ProductionRow {
  const cell: Run[] = [];
  lines.forEach(function (line, i) {
    if (i) cell.push(T("\n"));
    cell.push(/^(SFX|Music):/.test(line) ? cue(line) : T(line));
  });
  return { id: id, visualText: EMPTY, audioText: cells.html(cell) };
}

test("a cue edited in place keeps its registry entry: the plan retitles it instead of registering the new name", () => {
  const first = doc({ docId: "dA", rows: [cueRow("r1", ["Music: slow"])], productionTags: [] });
  const opened = planRegistryHealing(first, readers, null);
  assert.deepEqual(opened.register.map((t) => t.name), ["slow"]);
  const registry: RegistryTag[] = [Object.assign({}, opened.register[0] as RegistryTag, { status: "have", notes: "the Rhodes take" })];
  const typed = doc({ docId: "dA", rows: [cueRow("r1", ["Music: slow piano"])], productionTags: registry });
  const plan = planRegistryHealing(typed, readers, opened.cues);
  assert.deepEqual(jsonCopy(plan), {
    cues: { docId: "dA", cells: { r1: ["slow piano"] } },
    count: 1,
    retitle: [{ at: 0, from: "slow", name: "slow piano" }],
    register: []
  });
  assert.equal(registry[0]?.name, "slow", "the plan leaves the registry to the caller");
  const elsewhere = planRegistryHealing(typed, readers, { docId: "dB", cells: opened.cues.cells });
  assert.deepEqual(elsewhere.retitle, [], "a snapshot of another document retitles nothing");
  assert.deepEqual(elsewhere.register.map((t) => t.name), ["slow piano"]);
  const stillTagged = doc({
    docId: "dA",
    rows: [cueRow("r1", ["Music: slow piano"]), { id: "r2", visualText: cells.html([tag("sound", "slow")]), audioText: EMPTY }],
    productionTags: registry
  });
  assert.deepEqual(planRegistryHealing(stillTagged, readers, opened.cues).retitle, [], "an old name still in the script is not retitled");
});

test("cue snapshots hold scenes with Object.prototype ids, and a new such scene is read against the old snapshot (#311)", () => {
  const snap = snapshotCues({ docId: "dP", rows: [cueRow("__proto__", ["Music: theme"]), cueRow("constructor", ["SFX: bang"])], productionTags: [] }, readers);
  assert.deepEqual(Object.keys(snap.cells), ["__proto__", "constructor"]);
  assert.deepEqual(snap.cells["__proto__"], ["theme"]);
  const opened = planRegistryHealing(doc({ docId: "dA", rows: [cueRow("r1", ["Music: slow"])], productionTags: [] }), readers, null);
  const registry: RegistryTag[] = [opened.register[0] as RegistryTag];
  for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const typed = doc({ docId: "dA", rows: [cueRow("r1", ["Music: slow piano"]), cueRow(id, ["SFX: bang"])], productionTags: registry });
    const plan = planRegistryHealing(typed, readers, opened.cues);
    assert.deepEqual(plan.retitle, [{ at: 0, from: "slow", name: "slow piano" }], id);
    assert.deepEqual(plan.register.map((t) => t.name), ["bang"], id);
    const fromJson = planRegistryHealing(typed, readers, jsonCopy(opened.cues));
    assert.deepEqual(fromJson.retitle, [{ at: 0, from: "slow", name: "slow piano" }], id + ", a snapshot read back from JSON");
    assert.deepEqual(fromJson.register.map((t) => t.name), ["bang"], id + ", a snapshot read back from JSON");
  }
});

test("cue retitling pairs the names that went and came by closeness, not by position, when as many went as came (#294)", () => {
  const before = doc({
    docId: "dC", rows: [cueRow("r1", ["SFX: door slam", "SFX: kettle whistle"])], productionTags: []
  });
  const opened = planRegistryHealing(before, readers, null);
  const after = doc({
    docId: "dC", rows: [cueRow("r1", ["SFX: kettle whistles", "SFX: door slams"])], productionTags: opened.register
  });
  assert.deepEqual(planRegistryHealing(after, readers, opened.cues).retitle, [
    { at: 0, from: "door slam", name: "door slams" },
    { at: 1, from: "kettle whistle", name: "kettle whistles" }
  ]);
});

function retitlesAfter(was: string[], now: string[]): { from: string; name: string }[] {
  const opened = planRegistryHealing(doc({ docId: "dE", rows: [cueRow("r1", was)], productionTags: [] }), readers, null);
  const edited = doc({ docId: "dE", rows: [cueRow("r1", now)], productionTags: opened.register });
  return planRegistryHealing(edited, readers, opened.cues).retitle.map((t) => ({ from: t.from, name: t.name }));
}

test("one cue deleted and another edited in the same cell: the edited cue keeps its own item (#282)", () => {
  const two = ["SFX: door slam", "SFX: kettle whistle"];
  assert.deepEqual(retitlesAfter(two, ["SFX: kettle whistling"]), [{ from: "kettle whistle", name: "kettle whistling" }], "the first deleted");
  assert.deepEqual(retitlesAfter(two, ["SFX: door slams"]), [{ from: "door slam", name: "door slams" }], "the second deleted");
  assert.deepEqual(retitlesAfter(two, ["SFX: door slams", "SFX: kettle whistles"]), [
    { from: "door slam", name: "door slams" },
    { from: "kettle whistle", name: "kettle whistles" }
  ], "both edited: each by its own line");
});

test("a cue deleted beside an edit that could be either cue's: no rename, the edit becomes a new item (#282)", () => {
  assert.deepEqual(retitlesAfter(["Music: slow", "Music: slow piano"], ["Music: slow piano intro"]), [], "like both");
  assert.deepEqual(retitlesAfter(["SFX: door slam", "SFX: kettle whistle"], ["SFX: thunder"]), [], "like neither");
  assert.deepEqual(retitlesAfter(["SFX: a", "SFX: b"], ["SFX: a", "SFX: b", "SFX: c"]), [], "only one added");
  assert.deepEqual(retitlesAfter(["SFX: door slam"], ["SFX: door bang"]), [{ from: "door slam", name: "door bang" }], "one out, one in");
});

test("a cue lost, one gained and one edited in one go: the edited cue keeps its item whichever way round they sit (#294)", () => {
  const theme = [{ from: "theme", name: "themes" }];
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme"], ["Music: themes", "SFX: thunder"]), theme, "the issue's example");
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme"], ["SFX: thunder", "Music: themes"]), theme, "the new cues swapped");
  assert.deepEqual(retitlesAfter(["Music: theme", "SFX: door slam"], ["Music: themes", "SFX: thunder"]), theme, "the old cues swapped");
  assert.deepEqual(retitlesAfter(["Music: theme", "SFX: door slam"], ["SFX: thunder", "Music: themes"]), theme, "both swapped");
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme", "SFX: kettle whistle"], ["SFX: thunder", "SFX: kettle whistles", "Music: themes"]), [
    { from: "theme", name: "themes" },
    { from: "kettle whistle", name: "kettle whistles" }
  ], "three cues, two edited");
});

test("a find-and-replace over several cues in one cell renames none of their items; each becomes a new item (#294)", () => {
  const opened = planRegistryHealing(doc({ docId: "dF", rows: [cueRow("r1", ["Music: slow", "Music: slowly"])], productionTags: [] }), readers, null);
  const edited = doc({ docId: "dF", rows: [cueRow("r1", ["Music: fast", "Music: fastly"])], productionTags: opened.register });
  const plan = planRegistryHealing(edited, readers, opened.cues);
  assert.deepEqual(plan.retitle, []);
  assert.deepEqual(plan.register.map((t) => t.name), ["fast", "fastly"]);
});

test("one cue edited in a cell of several is still renamed, and several close edits at once are each renamed to their own (#294)", () => {
  assert.deepEqual(retitlesAfter(["SFX: door slam"], ["SFX: door bang"]), [{ from: "door slam", name: "door bang" }]);
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme"], ["SFX: door slams", "Music: theme"]), [{ from: "door slam", name: "door slams" }]);
  assert.deepEqual(retitlesAfter(["SFX: door slam", "SFX: kettle whistle"], ["SFX: kettle whistles", "SFX: door slams"]), [
    { from: "door slam", name: "door slams" },
    { from: "kettle whistle", name: "kettle whistles" }
  ]);
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme", "SFX: kettle whistle"], ["SFX: kettle whistles", "Music: themes", "SFX: door slams"]), [
    { from: "door slam", name: "door slams" },
    { from: "theme", name: "themes" },
    { from: "kettle whistle", name: "kettle whistles" }
  ]);
});

test("as many cues went as came and the pairing is a tie: no rename, the new cues become new items (#294)", () => {
  assert.deepEqual(retitlesAfter(["SFX: door slam", "SFX: door slap"], ["SFX: door slams", "SFX: thunder"]), [], "one new cue is close to both old ones");
  assert.deepEqual(retitlesAfter(["SFX: door slam", "SFX: door slap"], ["SFX: door slams", "SFX: door slaps"]), [], "each old cue is close to both new ones");
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme"], ["SFX: thunder", "Music: lightning"]), [], "nothing is close");
  assert.deepEqual(retitlesAfter(["SFX: x", "SFX: y"], ["SFX: p", "SFX: q"]), [], "no resemblance at all");
});

test("a cue whose name only changed case is the same item: it is neither gone nor come (#294)", () => {
  const door = [{ from: "door slam", name: "thunder" }];
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme"], ["SFX: thunder", "Music: Theme"]), door, "the issue's cues, one re-cased");
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme"], ["Music: Theme", "SFX: thunder"]), door, "the new cues the other way round");
  assert.deepEqual(retitlesAfter(["Music: theme", "SFX: door slam"], ["SFX: thunder", "Music: Theme"]), door, "the old cues the other way round");
  assert.deepEqual(retitlesAfter(["Music: theme", "SFX: door slam"], ["Music: Theme", "SFX: thunder"]), door, "both the other way round");
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme", "SFX: rain"], ["SFX: thunder", "Music: Theme"]), [], "two went and one came, none close: new item");
  assert.deepEqual(retitlesAfter(["SFX: door slam", "Music: theme", "SFX: rain"], ["SFX: door slams", "Music: Theme"]), [{ from: "door slam", name: "door slams" }], "two went and one came, one close");
  assert.deepEqual(cueEditPairs(["door slam", "theme"], ["thunder", "Theme"]), [["door slam", "thunder"]]);
  assert.deepEqual(cueEditPairs(["door slam", "theme", "rain"], ["thunder", "Theme"]), []);
  assert.deepEqual(cueEditPairs(["Door slam", "door slam"], ["door slams"]), [["Door slam", "door slams"]], "one item under two spellings counts once");
});

test("cueEditPairs: which old cue name each new one is taken as an edit of (#282)", () => {
  assert.deepEqual(cueEditPairs(["a"], ["b"]), [["a", "b"]]);
  assert.deepEqual(cueEditPairs(["door slam", "kettle whistle"], ["kettle whistling"]), [["kettle whistle", "kettle whistling"]]);
  assert.deepEqual(cueEditPairs(["door slam", "kettle whistle"], ["thunder"]), []);
  assert.deepEqual(cueEditPairs(["slow", "slow piano"], ["slow piano intro"]), []);
  assert.deepEqual(cueEditPairs(["door slam", "kettle whistle", "theme"], ["door slams", "kettle whistles"]), [
    ["door slam", "door slams"],
    ["kettle whistle", "kettle whistles"]
  ]);
  assert.deepEqual(cueEditPairs(["x", "y"], ["p", "q"]), [], "as many in as out but none close: no rename (#294)");
  assert.deepEqual(cueEditPairs(["door slam", "theme"], ["themes", "thunder"]), [["theme", "themes"]], "#294's example");
  assert.deepEqual(cueEditPairs(["door slam", "kettle whistle"], ["kettle whistles", "door slams"]), [
    ["door slam", "door slams"],
    ["kettle whistle", "kettle whistles"]
  ], "as many in as out and each close to its own: by closeness, not position (#294)");
  assert.deepEqual(cueEditPairs(["door slam", "door slam"], ["door slams"]), [["door slam", "door slams"]]);
  assert.equal(closeCueNames("Pianno intro", "piano intro"), true);
  assert.equal(closeCueNames("door slam", "door bang"), true);
  assert.equal(closeCueNames("door slam", "upbeat intro"), false);
  assert.equal(closeCueNames("", "door"), false);
  assert.deepEqual(cueEditPairs(["door slam", "kettle whistle", "theme"], ["door slams", "door slammed"]), [], "one old cue close to two new ones: no rename");
  assert.equal(closeCueNames("door slam", "dog bark"), false, "a shared start and nothing else is not close");
  assert.equal(closeCueNames("DOOR SLAM", "door slams"), true, "case does not matter");
  assert.equal(closeCueNames("kick", "kiss"), true, "exactly half shared");
  assert.equal(closeCueNames("kick", "kxyz"), false, "a quarter shared");
  assert.equal(closeCueNames("cat", "cow"), false, "just under half shared");
  assert.equal(closeCueNames("cart", "cost"), true, "exactly half shared, from both ends");
});

test("seeded: cueEditPairs pairs a name that left with a name that came only when they are close or are the only one each way (#294)", () => {
  const NAMES = ["door slam", "door slams", "kettle whistle", "kettle whistling", "theme", "thunder", "slow", "slow piano", "Theme", "DOOR SLAM"];
  let s = 7;
  const r = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (): string => NAMES[Math.floor(r() * NAMES.length)] as string;
  const draw = (): string[] => Array.from({ length: 1 + Math.floor(r() * 3) }, pick);
  const key = (n: string): string => n.toLowerCase();
  const unique = (l: string[]): string[] => l.filter((n, i) => l.findIndex((m) => key(m) === key(n)) === i);
  const outside = (l: string[], other: string[]): string[] => unique(l.filter((n) => !other.some((m) => key(m) === key(n))));
  let sameCount = 0, renamedSameCount = 0, refused = 0;
  for (let i = 0; i < 2000; i++) {
    const before = draw();
    const after = r() < 0.5 ? before.map((n) => (r() < 0.5 ? n : pick())) : draw();
    const got = cueEditPairs(before, after);
    const msg = JSON.stringify([before, after]);
    const gone = outside(before, after);
    const came = outside(after, before);
    const oneForOne = gone.length === 1 && came.length === 1;
    assert.equal(new Set(got.map((p) => p[0])).size, got.length, msg + " an old name paired twice");
    assert.equal(new Set(got.map((p) => p[1])).size, got.length, msg + " a new name paired twice");
    for (const [g, c] of got) {
      assert.ok(gone.includes(g) && came.includes(c), msg + " paired a name that did not leave or come");
      assert.ok(oneForOne || closeCueNames(g, c), msg + " paired names that are not close");
    }
    const expected: [string, string][] = [];
    if (oneForOne) expected.push([gone[0] as string, came[0] as string]);
    else {
      for (const g of gone) {
        const near = came.filter((c) => closeCueNames(g, c));
        if (near.length === 1 && gone.filter((x) => closeCueNames(x, near[0] as string)).length === 1) expected.push([g, near[0] as string]);
      }
    }
    assert.deepEqual(got, expected, msg);
    if (gone.length === came.length) {
      sameCount++;
      if (got.length) renamedSameCount++;
      if (gone.length > 1 && !got.length) refused++;
    }
  }
  assert.ok(sameCount > 300 && renamedSameCount > 100 && refused > 20, [sameCount, renamedSameCount, refused].join(" "));
});

const GEAR_ROW: ProductionRow = {
  id: "r1",
  visualText: cells.html([T("Wide on "), tag("gear", "Tripod", "the tripod"), T(" and "), tag("gear", "Slider")]),
  audioText: EMPTY
};

function gearState(extra?: RegistryTag[]): TagState & ValidatedDocument {
  return doc({
    rows: [GEAR_ROW],
    productionTags: [
      registered("gear", "Tripod", { status: "have" }), registered("gear", "Slider"),
      registered("gear", "Old lens", { notes: "sold" }), registered("gear", "Gimbal"), registered("prop", "Kettle")
    ].concat(extra || [])
  });
}

test("INV-26: the quick-add plan deletes an orphaned entry whose line went and keeps one still tagged in the script", () => {
  const state = gearState();
  const before = JSON.stringify(state);
  assert.deepEqual(planQuickAdd(state, readers, ""), { remove: ["Old lens", "Gimbal"], register: [], added: 0, removed: 2 });
  assert.deepEqual(planQuickAdd(state, readers, "Tripod\nSlider\nOld lens\nGimbal"), { remove: [], register: [], added: 0, removed: 0 });
  assert.equal(JSON.stringify(state), before);
});

test("the quick-add plan adds each new line once, cleaned, with ids minted after the removals", () => {
  const state = gearState([{ id: mintTagId("gear", "Lav mic"), cat: "gear", name: "Spare battery" }]);
  const plan = planQuickAdd(state, readers, "gimbal\r\n  Lav mic  \nLAV MIC\n\n<b>Boom</b> pole\r" + "x".repeat(81));
  assert.deepEqual(plan.remove, ["Old lens", "Spare battery"]);
  assert.equal(plan.removed, 2);
  const kept = (state.productionTags as RegistryTag[]).filter((t) => t.name !== "Old lens" && t.name !== "Spare battery");
  assert.deepEqual(plan.register, minted(kept, "gear", ["Lav mic", "Boom pole", "x".repeat(80)]));
  assert.equal(plan.register[0]?.id, mintTagId("gear", "Lav mic"), "the removed entry's id is free again");
  assert.equal(plan.added, 3);
});

const OBJECT_PROPERTY_NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

test("quick-add lines named after Object's own properties are registered like any other name", () => {
  const state = gearState();
  const plan = planQuickAdd(state, readers, OBJECT_PROPERTY_NAMES.concat("Tripod").join("\n"));
  const kept = (state.productionTags as RegistryTag[]).filter((t) => t.name !== "Old lens" && t.name !== "Gimbal");
  assert.deepEqual(plan, {
    remove: ["Old lens", "Gimbal"], register: minted(kept, "gear", OBJECT_PROPERTY_NAMES), added: 5, removed: 2
  });
});

test("a registered gear entry named after an Object property survives while its line stays and goes when it is dropped", () => {
  const state = gearState(OBJECT_PROPERTY_NAMES.map((name) => registered("gear", name)));
  const kept = "Tripod\nSlider\n" + OBJECT_PROPERTY_NAMES.join("\n");
  assert.deepEqual(planQuickAdd(state, readers, kept), { remove: ["Old lens", "Gimbal"], register: [], added: 0, removed: 2 });
  assert.deepEqual(
    planQuickAdd(state, readers, "Tripod\nSlider"),
    { remove: ["Old lens", "Gimbal"].concat(OBJECT_PROPERTY_NAMES), register: [], added: 0, removed: 2 + OBJECT_PROPERTY_NAMES.length }
  );
});

test("removing a line deletes every registry entry under that name", () => {
  const state = gearState([registered("gear", "old LENS", { id: "t_second" })]);
  const plan = planQuickAdd(state, readers, "Gimbal");
  assert.deepEqual(plan.remove, ["Old lens"]);
  assert.equal(plan.removed, 1);
  const index = deriveProductionIndex(state, readers);
  assert.deepEqual(planQuickAdd(state, readers, "Gimbal", index), plan, "the caller's index gives the same plan");
});
