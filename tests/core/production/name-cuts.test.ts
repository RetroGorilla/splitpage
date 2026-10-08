import { test } from "node:test";
import assert from "node:assert/strict";
import { brollInCell, brollPropsInCell, brollSeedLocation } from "../../../src/core/production/broll.ts";
import { bulkTagCell, missingRegistryTags, newRegistryTag, planQuickAdd, retagCell, tagFieldOccurrences } from "../../../src/core/production/tags.ts";
import type { MediaTagWriter, TagState } from "../../../src/core/production/tags.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import { migratedThenSet } from "../migrate-ports.ts";
import { B, T, cue, mapDecoder, readersOver, tag } from "./cells.ts";

const GRIN = "\u{1F600}";
const x = (n: number): string => "x".repeat(n);
const cells = mapDecoder();
const EMPTY = cells.html([]);
const readers = readersOver(cells);
const NO_MEDIA: MediaTagWriter = function () { throw new Error("no cell here holds media"); };

function emptyDoc(): TagState & ValidatedDocument {
  return migratedThenSet({ rows: [{ id: "r1", visualText: EMPTY, audioText: EMPTY }], productionTags: [] } as TagState);
}

test("a new registry tag is named by cappedName, and a name that cleans to nothing is refused like an empty one (#344, #437)", () => {
  const mug = [{ id: "t_mug", cat: "prop", name: "mug", owner: "", notes: "", status: "needed" }];
  assert.equal(newRegistryTag([], "prop", "\uD83D"), null);
  assert.equal(newRegistryTag([], "prop", " \uDE00 \uD83D "), null);
  assert.equal(newRegistryTag(mug, "prop", "mug\uD83D"), null, "already in the registry once cleaned");
  assert.equal(newRegistryTag([], "prop", " " + x(79) + GRIN + " tail")?.name, x(79) + GRIN);
  assert.equal(newRegistryTag([], "prop", x(79) + "\uD83D")?.name, x(79));
  assert.equal(newRegistryTag([], "prop", x(79) + " y")?.name, x(79));
});

test("a quick-add line is cut by code point, and a cut after a space keeps no space (#344, #419)", () => {
  const plan = planQuickAdd(emptyDoc(), readers, x(79) + GRIN + " tail\n" + x(78) + "z y\n" + x(77) + "\uD83D");
  assert.deepEqual(plan.register.map((t) => t.name), [x(79) + GRIN, x(78) + "z", x(77)]);
});

test("tagging every mention writes the tag name cut by code point, with no space at the cut (#344, #419)", () => {
  const html = cells.html([T("the mug and the mug")]);
  assert.equal(tagFieldOccurrences(html, "mug", "prop", x(79) + GRIN + "z", false, 0, readers, NO_MEDIA).html,
    toHtml([T("the "), tag("prop", x(79) + GRIN, "mug"), T(" and the mug")]));
  assert.equal(bulkTagCell(html, "mug", "prop", "  " + x(79) + " y", false, false, readers, NO_MEDIA).html,
    toHtml([T("the "), tag("prop", x(79), "mug"), T(" and the "), tag("prop", x(79), "mug")]));
});

test("a cue line whose name has an emoji across 80 is renamed with its tag (#344)", () => {
  const name = x(79) + GRIN;
  const html = cells.html([cue("SFX: " + name + " more")]);
  assert.equal(retagCell(html, "sound", name, "t:sound:Thunder", readers), toHtml([cue("SFX: Thunder")]));
});

test("cue names read from a cell are cut by code point (#344)", () => {
  const html = cells.html([cue("Music: " + x(79) + GRIN + " yy")]);
  assert.deepEqual(readers.tagsInField(html), [{ catId: "sound", name: x(79) + GRIN, text: "Music: " + x(79) + GRIN + " yy" }]);
  assert.deepEqual(readers.cueNamesInField(html), [x(79) + GRIN]);
  const doc = { rows: [{ id: "r1", visualText: EMPTY, audioText: html }] };
  assert.deepEqual(missingRegistryTags(doc.rows, [], readers).map((t) => t.name), [x(79) + GRIN]);
});

test("a b-roll shot name read from its marker line is cut by code point at 200, with no space at the cut (#344, #419)", () => {
  assert.equal(brollInCell(normalizeCell([B("k1"), T(" " + x(199) + GRIN + " tail")]))[0]?.name, x(199) + GRIN);
  assert.equal(brollInCell(normalizeCell([B("k1"), T(" " + x(199) + " y")]))[0]?.name, x(199));
});

test("a b-roll prop read from a tag is cut by code point at 80, with no space at the cut (#344, #419)", () => {
  assert.deepEqual(brollPropsInCell(normalizeCell([B("k1"), T(" "), tag("prop", x(79) + GRIN + "z", "mug")])), [[x(79) + GRIN]]);
  assert.deepEqual(brollPropsInCell(normalizeCell([B("k1"), T(" "), tag("prop", x(79) + " y", "mug")])), [[x(79)]]);
});

test("a b-roll shot's seed location is cut by code point at 80, with no space at the cut (#344, #419)", () => {
  const row = (name: string) => ({ id: "r1", visualText: cells.html([tag("location", name, "here")]), audioText: EMPTY });
  assert.equal(brollSeedLocation(row(x(79) + GRIN + "z"), readers), x(79) + GRIN);
  assert.equal(brollSeedLocation(row(x(79) + " y"), readers), x(79));
});
