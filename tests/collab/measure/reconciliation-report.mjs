import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { retainedCategories } from "./retained-bytes.mjs";
import { sessionRates } from "./session-rates.mjs";

const directory = "docs/collaboration/", read = name => JSON.parse(readFileSync(directory + name, "utf8"));
const reconciliation = read("stage-2-byte-reconciliation.json"), sessions = [];
const prefixes = read("stage-2-capacity-prefix.json"), controls = read("stage-2-key-rates.json");
for (const fixture of ["long", "large"]) for (const people of [1, 2, 4]) {
  const data = read(`stage-2-working-days-${fixture}-${people}.json`);
  sessions.push({ data, rates: sessionRates(data) });
}
writeFileSync(directory + "stage-2-working-days-rates.json", JSON.stringify({ version: 1, sessions: sessions.map(item => item.rates) }, null, 2) + "\n");
const csv = [["kind", "fixture", "people", "newWordsPerPersonPerSampleSession", "sampleSession", "keyboardKeys", "encodedBytes", "encodedBytesLessRemovalMarks", "plainBytes", "addedBytesPerKey", "addedBytesPerKeyLessRemovalMarks", ...retainedCategories, ...retainedCategories.map(category => category + " added B/key")]];
for (const { data: { result }, rates } of sessions) for (const [index, point] of result.points.entries()) {
  const rate = rates.points[index];
  csv.push(["measured", result.fixture, result.people, result.measuredWordsPerPersonPerDay, point.day, rate.keyboardKeys,
    point.encodedBytes, rate.encodedBytesLessRemovalMarks, point.plainBytes, rate.bytesPerKey, rate.bytesPerKeyLessRemovalMarks,
    ...retainedCategories.map(category => point.categories[category]), ...retainedCategories.map(category => rate.categoryBytesPerKey[category])]);
}
writeFileSync(directory + "stage-2-working-days-by-category.csv", csv.map(row => row.map(value => JSON.stringify(value)).join(",")).join("\n") + "\n");

const fmt = value => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const table = (head, rows) => ["| " + head.join(" | ") + " |", "| " + head.map(() => "---").join(" | ") + " |",
  ...rows.map(row => "| " + row.join(" | ") + " |")].join("\n");
const comparison = table(["Form / writers / blocks", "Encoded B", "B / 1,000 final", "B / 1,000 typed", "Active export B", "Encoded / export", "2 MiB / 10x reported export"],
  [...reconciliation.stageOne.map(point => ["Stage 1 text / " + point.writers + " / 1", point]),
    ...reconciliation.stageTwo.map(point => ["Stage 2 text / " + point.writers + " / 1", point])].map(([name, point]) =>
    [name, fmt(point.encodedBytes), fmt(point.bytesPer1000Final), fmt(point.bytesPer1000Typed), fmt(point.exportedFileBytes), fmt(point.encodedOverExport),
      `${point.within2MiB ? "within" : "over"} / ${point.within10x ? "within" : "over"}`]));
const categories = table(["Exclusive encoded category", "Stage 1 / 2 writers B", "Stage 2 / 2 writers B", "Stage 2 / 6 writers B"],
  [...retainedCategories.map(category => [category, ...[reconciliation.stageOne[0], ...reconciliation.stageTwo].map(point => fmt(point.categories[category]))]),
    ["TOTAL", ...[reconciliation.stageOne[0], ...reconciliation.stageTwo].map(point => fmt(point.encodedBytes))]]);
const controlTable = table(["Control", "Fresh peer", "Keys", "Added B", "Added B / key"], controls.map(point =>
  [point.fixture, point.freshPeer === undefined ? "native only" : point.freshPeer ? "yes" : "no", point.typed, fmt(point.addedBytes), fmt(point.addedBytes / point.typed)]));
const observations = table(["Observed-list component", "Stage 2 / 2 writers B", "Stage 2 / 6 writers B"],
  [["insertion-bound addition references", "insertionBound"], ["range addition references", "range"], ["unknown references", "unknown"]]
    .map(([name, key]) => [name, ...reconciliation.stageTwo.map(point => fmt(point.observationReferences[key].bytes))])
    .concat([["keys and array framing", ...reconciliation.stageTwo.map(point => fmt(point.observationReferences.keysAndArrayFraming))]]));
const measured = sessions.map(({ rates }) => {
  return `### ${rates.fixture}, ${rates.people} people: 10 new words each per sample session, plus corrections and rewrites\n\n` + table(
    ["Sample session", "Keys typed", "Encoded B", "B less removal marks", "Plain B", "Added B/key", "Added B/key less removal marks"],
    rates.points.map(point => [point.sampleSession, fmt(point.keyboardKeys), fmt(point.encodedBytes), fmt(point.encodedBytesLessRemovalMarks), fmt(point.plainBytes),
      point.bytesPerKey === null ? "n/a" : fmt(point.bytesPerKey), point.bytesPerKeyLessRemovalMarks === null ? "n/a" : fmt(point.bytesPerKeyLessRemovalMarks)])) +
    `\n\nFirst measured sample session over 2 MiB: ${rates.firstOverCap ? rates.firstOverCap.sampleSession + "; " + fmt(rates.firstOverCap.keyboardKeys) + " keys typed" : "not reached"}.`;
}).join("\n\n");
const endpoints = sessions.map(({ rates }) => rates.points.at(-1));
const rateHead = ["Exclusive growth category, B/key", ...sessions.map(({ rates }, index) => `${rates.fixture} / ${rates.people} people / ${fmt(endpoints[index].keyboardKeys)} keys`)];
const rateTable = table(rateHead, retainedCategories.map(category => [category, ...endpoints.map(point => fmt(point.categoryBytesPerKey[category]))])
  .concat([["TOTAL growth B/key", ...endpoints.map(point => fmt(point.bytesPerKey))], ["Growth B/key less removal marks", ...endpoints.map(point => fmt(point.bytesPerKeyLessRemovalMarks))]]));
const path = directory + "stage-2-byte-reconciliation.md", source = readFileSync(path, "utf8");
const marker = "## Generated comparison and byte ledger";
assert.ok(source.includes(marker));
writeFileSync(path, source.slice(0, source.indexOf(marker)) + marker + "\n\n" + comparison + "\n\n### Unformatted typing difference controls\n\n" + controlTable +
  "\n\n### Exact retained-byte ledger at the common text checkpoint\n\n" + categories +
  "\n\nThe birth observed-list row splits exactly as follows. Insertion-bound references name additions whose native-id interval is fixed; range additions have no such restriction. This identifies candidates for the correctness trial and does not remove any observation in Piece R.\n\n" + observations +
  "\n\n## Measured default-volume capacity crossing\n\n" + table(["Fixture", "People", "First default day over 2 MiB", "Original keys at crossing", "Bytes before / after block"],
    prefixes.map(point => [point.fixture, point.groupSizes.join(", "), point.firstDayOverCap ?? "not reached", point.crossed
      ? `${point.crossed.previous.typed + 1}-${point.crossed.typed}` : "not reached", point.crossed
      ? `${fmt(point.crossed.previous.bytes)} / ${fmt(point.crossed.bytes)}` : "not reached"])) +
  "\n\n## Repeated sessions: measured samples\n\nAdded rates divide growth since session zero by all recorded keyboard keys, including correction and rewrite typing. They include command-generated edits in the numerator. Subtracting removal marks is exact category accounting, not a rerun with removal disabled; other remove/restore effects remain.\n\n" + measured +
  "\n\n## Per-key growth at the measured volumes\n\nEach category is its change from session zero divided by measured keys. Every checkpoint's exact fractions are in the rates JSON and CSV; the final measured checkpoints are below. Displayed rates are rounded.\n\n" + rateTable +
  "\n\nNo full-volume day total is claimed because the samples do not establish growth at that typing volume or distribution.\n");
