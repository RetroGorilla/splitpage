import assert from "node:assert/strict";
import { retainedCategories } from "./retained-bytes.mjs";

export function keyboardKeys(counters) {
  return counters.typed + counters.correctionRetypes + counters.rewritten;
}

export function sessionRates({ plan, result }) {
  const initial = result.points[0];
  assert.equal(initial.day, 0);
  const points = result.points.map(point => {
    const keys = keyboardKeys(point.counters);
    const addedCategories = Object.fromEntries(retainedCategories.map(category => [category, point.categories[category] - initial.categories[category]]));
    const addedBytes = point.encodedBytes - initial.encodedBytes;
    assert.equal(Object.values(addedCategories).reduce((sum, value) => sum + value, 0), addedBytes);
    return { sampleSession: point.day, keyboardKeys: keys, encodedBytes: point.encodedBytes,
      encodedBytesLessRemovalMarks: point.encodedBytes - point.categories["removal marks"], plainBytes: point.plainBytes,
      addedBytes, addedBytesLessRemovalMarks: addedBytes - addedCategories["removal marks"], addedCategories,
      bytesPerKey: keys ? addedBytes / keys : null,
      bytesPerKeyLessRemovalMarks: keys ? (addedBytes - addedCategories["removal marks"]) / keys : null,
      categoryBytesPerKey: Object.fromEntries(retainedCategories.map(category => [category, keys ? addedCategories[category] / keys : null])) };
  });
  const cap = result.firstCap;
  const originalAtCap = cap ? cap.day * result.people * result.measuredWordsPerPersonPerDay * plan.keysPerWord : 0;
  const rewriteAtCap = cap ? cap.day * result.people * Math.floor(result.measuredWordsPerPersonPerDay * plan.keysPerWord / 12) : 0;
  for (const point of result.points) {
    assert.equal(point.counters.typed, point.day * result.people * result.measuredWordsPerPersonPerDay * plan.keysPerWord);
    assert.equal(point.counters.correctionRetypes, Math.floor(point.counters.typed / plan.correctionEvery));
    assert.equal(point.counters.rewritten, point.day * result.people * Math.floor(result.measuredWordsPerPersonPerDay * plan.keysPerWord / 12));
  }
  return { fixture: result.fixture, people: result.people, newWordsPerPersonPerSampleSession: result.measuredWordsPerPersonPerDay,
    method: "measured cumulative encoded growth from session zero divided by recorded keyboard keys; command-generated edits included in growth",
    removalSubtraction: "accounting subtraction of removal marks only; other effects of remove/restore remain; not a rerun with removal disabled",
    firstOverCap: cap ? { sampleSession: cap.day, keyboardKeys: originalAtCap + Math.floor(originalAtCap / plan.correctionEvery) + rewriteAtCap,
      encodedBytes: cap.encodedBytes, keysMethod: "deterministic schedule, checked against all recorded checkpoint counters" } : null, points };
}
