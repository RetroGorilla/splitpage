import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { retainedCategories } from "./retained-bytes.mjs";

const directory = "docs/collaboration/", read = name => JSON.parse(readFileSync(directory + name, "utf8"));
const reconciliation = read("stage-2-byte-reconciliation.json"), days = [];
const prefixes = read("stage-2-capacity-prefix.json");
const controls = read("stage-2-key-rates.json");
const horizons = [1, 2, 5, 10, 20, 60];

function retainedFit(points, field) {
  const initial = field(points[0]), samples = points.filter(point => point.day > 0).slice(-3);
  assert.equal(samples.length, 3);
  let s2 = 0, s3 = 0, s4 = 0, sy1 = 0, sy2 = 0;
  for (const point of samples) {
    const t = point.day, y = field(point) - initial;
    s2 += t ** 2; s3 += t ** 3; s4 += t ** 4; sy1 += y * t; sy2 += y * t ** 2;
  }
  const determinant = s2 * s4 - s3 ** 2;
  let linear = (sy1 * s4 - sy2 * s3) / determinant, quadratic = (sy2 * s2 - sy1 * s3) / determinant;
  if (quadratic < 0) { quadratic = 0; linear = Math.max(0, sy1 / s2); }
  if (linear < 0) { linear = 0; quadratic = Math.max(0, sy2 / s4); }
  const predict = t => initial + linear * t + quadratic * t ** 2;
  return { initial, linear, quadratic, sampleDays: samples.map(point => point.day),
    maxFitResidualBytes: Math.max(...samples.map(point => Math.abs(predict(point.day) - field(point)))) };
}

for (const fixture of ["long", "large"]) for (const people of [1, 2, 4]) {
  const { plan, result } = read(`stage-2-working-days-${fixture}-${people}.json`);
  const typedPerOriginal = 1 + plan.rewriteFraction[0] / plan.rewriteFraction[1] + 1 / plan.correctionEvery;
  const factor = plan.wordsPerPerson / (result.measuredWordsPerPersonPerDay * typedPerOriginal);
  const fits = Object.fromEntries(retainedCategories.map(category => [category, retainedFit(result.points, point => point.categories[category])]));
  const plainFit = retainedFit(result.points, point => point.plainBytes);
  const predict = (fit, day) => Math.round(fit.initial + fit.linear * day * factor + fit.quadratic * (day * factor) ** 2);
  const projected = horizons.map(day => {
    const categories = Object.fromEntries(retainedCategories.map(category => [category, predict(fits[category], day)]));
    return { day, extrapolated: true, equivalentSampleDays: day * factor, targetKeyboardKeys: day * plan.wordsPerPerson * plan.keysPerWord * people, categories,
      encodedBytes: Object.values(categories).reduce((sum, value) => sum + value, 0), plainBytes: predict(plainFit, day) };
  });
  days.push({ fixture, people, measuredNewWordsPerPersonPerDay: result.measuredWordsPerPersonPerDay, defaultWordsPerPersonPerDay: plan.wordsPerPerson,
    defaultWordMeaning: "all keyboard typing, including correction retyping and rewrite typing; command-inserted seed strings excluded",
    typedPerOriginal, sampleDayScale: factor,
    measuredThroughDay: result.points.at(-1).day,
    method: "nonnegative quadratic by category, fixed measured day-0 intercept, last three checkpoints; sample-day axis scaled by total typing volume including corrections and rewrites",
    limitation: "word volume and elapsed days are confounded; the fit does not validate full-volume capacity or late mark/removal behavior",
    fits, plainFit, projected, firstDefaultDayOver2MiB: projected.find(point => point.encodedBytes > 2 * 1024 ** 2)?.day ?? null,
    measuredFirstSampleDayOver2MiB: result.firstCap,
    measuredFirstCrossingInterval: result.points.filter(point => point.encodedBytes <= 2 * 1024 ** 2).at(-1)?.day < result.points.at(-1).day
      ? [result.points.filter(point => point.encodedBytes <= 2 * 1024 ** 2).at(-1)?.day + 1, result.points.find(point => point.encodedBytes > 2 * 1024 ** 2).day] : null });
}
writeFileSync(directory + "stage-2-working-days-projections.json", JSON.stringify({ version: 1, days }, null, 2) + "\n");
const csv = [["kind", "fixture", "people", "wordsPerPersonPerDay", "wordMeaning", "day", "keyboardKeys", "encodedBytes", "plainBytes", ...retainedCategories]];
for (const item of days) {
  const { result } = read(`stage-2-working-days-${item.fixture}-${item.people}.json`);
  for (const [kind, words, points] of [["measured", 10, result.points], ["extrapolated", 5000, item.projected]]) {
    const meaning = kind === "measured" ? "new drafting, before corrections and rewrites" : "all keyboard typing, including corrections and rewrites";
    for (const point of points) csv.push([kind, item.fixture, item.people, words, meaning, point.day,
      point.targetKeyboardKeys ?? point.counters.typed + point.counters.correctionRetypes + point.counters.rewritten, point.encodedBytes, point.plainBytes,
      ...retainedCategories.map(category => point.categories[category])]);
  }
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
const measured = days.map(({ fixture, people }) => {
  const { result } = read(`stage-2-working-days-${fixture}-${people}.json`);
  return `### ${fixture}, ${people} people: measured at 10 new words each per sample day, plus corrections and rewrites\n\n` + table(["Sample day", "Encoded B", "Plain B", "Birth B", "Removal marks B"],
    result.points.map(point => [point.day, fmt(point.encodedBytes), fmt(point.plainBytes),
      fmt(Object.entries(point.categories).filter(([category]) => category.startsWith("birth ")).reduce((sum, [, value]) => sum + value, 0)), fmt(point.categories["removal marks"])])) +
    `\n\nFirst measured sample day over 2 MiB: ${result.firstCap?.day ?? "not reached"}.`;
}).join("\n\n");
const forecasts = days.map(point => `### ${point.fixture}, ${point.people} people: extrapolated at 5,000 words each per day\n\n` +
  table(["Working day", "Encoded B (fit)", "Plain B (fit)", "Beyond last measured sample"], point.projected.map(row =>
    [row.day, fmt(row.encodedBytes), fmt(row.plainBytes), fmt(row.equivalentSampleDays / point.measuredThroughDay) + "x"]))).join("\n\n");
const path = directory + "stage-2-byte-reconciliation.md";
const source = readFileSync(path, "utf8");
const marker = "## Generated comparison and byte ledger";
assert.ok(source.includes(marker));
writeFileSync(path, source.slice(0, source.indexOf(marker)) + marker + "\n\n" + comparison + "\n\n### Unformatted typing difference controls\n\n" + controlTable +
  "\n\n### Exact retained-byte ledger at the common text checkpoint\n\n" + categories +
  "\n\nThe birth observed-list row splits exactly as follows. Insertion-bound references name additions whose native-id interval is fixed; range additions have no such restriction. This identifies candidates for the correctness trial and does not remove any observation in Piece R.\n\n" + observations +
  "\n\n## Measured default-volume capacity crossing\n\n" + table(["Fixture", "People", "First default day over 2 MiB", "Original keys at crossing", "Bytes before / after block"],
    prefixes.map(point => [point.fixture, point.groupSizes.join(", "), point.firstDayOverCap ?? "not reached", point.crossed
      ? `${point.crossed.previous.typed + 1}–${point.crossed.typed}` : "not reached", point.crossed
      ? `${fmt(point.crossed.previous.bytes)} / ${fmt(point.crossed.bytes)}` : "not reached"])) +
  "\n\n## Repeated sessions: measured samples\n\n" + measured + "\n\n## Full-volume horizons: extrapolations, not observed days\n\n" + forecasts + "\n");
