import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mergeStates } from "../js/03-sync.js";
import { saveAuthorName } from "../js/10-comments.js";
import { freezeClockAndRandom, jsonCopy } from "./golden-helpers.mjs";
import { mergeCorpus, mergeGoldenInputs } from "./_merge-corpus.mjs";

freezeClockAndRandom(0x303);
saveAuthorName("Merge Editor");

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
  return value;
}

function reachable(value, into) {
  if (!value || typeof value !== "object" || into.has(value)) return into;
  into.add(value);
  for (const v of Object.values(value)) reachable(v, into);
  return into;
}

function shared(merged, inputs) {
  const found = [];
  const seen = new Set();
  (function walk(v, path) {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (inputs.has(v)) { found.push(path); return; }
    for (const [k, x] of Object.entries(v)) walk(x, path + "." + k);
  })(merged, "merged");
  return found;
}

function run(inputs) {
  try {
    return { res: mergeStates(inputs.base, inputs.mine, inputs.theirs) };
  } catch (e) {
    return { error: String(e) };
  }
}

function checkCase(label, inputs) {
  const plain = jsonCopy(inputs);
  const before = JSON.stringify(plain);
  const open = run(plain);
  assert.equal(JSON.stringify(plain), before, label + ": the inputs read the same after the merge");

  const frozen = deepFreeze(jsonCopy(inputs));
  const inputObjects = reachable(frozen, new Set());
  const closed = run(frozen);
  if (open.error) {
    assert.equal(closed.error, open.error, label + ": frozen inputs fail the same way");
    return false;
  }
  assert.equal(closed.error, undefined, label + ": a merge of frozen inputs writes into none of them");
  assert.deepEqual(shared(closed.res.merged, inputObjects), [], label + ": the merged document shares no object with an input");
  return true;
}

test("every merge golden case merges frozen inputs, and its result shares no object with them (#303)", () => {
  const cases = mergeGoldenInputs();
  assert.ok(cases.length > 60);
  const withReplies = cases.filter((c) => JSON.stringify(c.inputs).includes('"replies":[{'));
  assert.ok(withReplies.length > 0, "some cases hold replies on a comment");
  for (const c of cases) assert.equal(checkCase(c.name, c.inputs), true);
});

test("seeded generated merges never write into their inputs, migrated or not (#303)", () => {
  let merged = 0, failed = 0;
  const kinds = new Set();
  for (const seed of [303, 0x5eed]) {
    for (const c of mergeCorpus(seed, 700)) {
      if (checkCase(c.label, c.inputs)) merged++; else failed++;
      c.kinds.forEach((k) => kinds.add(k));
    }
  }
  assert.ok(merged > 1000, "most generated cases merge: " + merged + " merged, " + failed + " threw");
  assert.deepEqual([...kinds].sort(), ["add-item", "cross", "delete", "list-shape", "odd-item", "proto-id", "reply", "set", "unmigrate"]);
});
