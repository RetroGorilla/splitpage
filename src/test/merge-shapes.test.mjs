import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mergeStates } from "../legacy/merge-bridge.ts";
import "./_merge-started.mjs";
import { saveAuthorName } from "../js/10-comments.js";
import { freezeClockAndRandom, jsonCopy } from "./golden-helpers.mjs";
import { mergeCorpus, seededRandom } from "./_merge-corpus.mjs";

saveAuthorName("Merge Editor");

let cryptoDraw = seededRandom(1);
for (const c of new Set([globalThis.crypto, window.crypto])) {
  Object.defineProperty(c, "getRandomValues", {
    configurable: true,
    writable: true,
    value: (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(cryptoDraw() * 256);
      return arr;
    }
  });
}

const isObject = (v) => !!v && typeof v === "object";
const objects = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function cleaned(doc) {
  if (!doc) return doc;
  doc.rows = objects(doc.rows);
  doc.comments = objects(doc.comments);
  for (const k of ["people", "productionTags", "brollShots"]) if (own(doc, k) && doc[k] != null) doc[k] = objects(doc[k]);
  for (const r of doc.rows) {
    if (Array.isArray(r)) continue;
    if (own(r, "imageLinks") && r.imageLinks != null) r.imageLinks = objects(r.imageLinks);
    if (own(r, "moreImages") && r.moreImages != null) r.moreImages = objects(r.moreImages);
    for (const it of Array.isArray(r.moreImages) ? r.moreImages : []) {
      if (!Array.isArray(it) && own(it, "links") && it.links != null) it.links = objects(it.links);
    }
  }
  for (const c of doc.comments) if (!Array.isArray(c) && own(c, "replies") && c.replies != null) c.replies = objects(c.replies);
  return doc;
}

freezeClockAndRandom(0x304);

function merged(inputs, i) {
  Math.random = seededRandom(0x304000 + i);
  cryptoDraw = seededRandom(0x305000 + i);
  const res = mergeStates(inputs.base, inputs.mine, inputs.theirs);
  return { out: jsonCopy({ merged: res.merged, conflicts: res.conflicts, stats: res.stats }), next: Math.random() };
}

test("#304, differential: seeded merges with list faults never throw, and equal the merge of the same sides with their lists cleaned", () => {
  let faulted = 0, cases = 0;
  for (const seed of [1001, 1002]) {
    for (const c of mergeCorpus(seed, 2000)) {
      const raw = jsonCopy(c.inputs);
      const clean = jsonCopy(c.inputs);
      ["base", "mine", "theirs"].forEach((s) => cleaned(clean[s]));
      if (JSON.stringify(raw) !== JSON.stringify(clean)) faulted++;
      let got;
      assert.doesNotThrow(() => { got = merged(raw, cases); }, c.label);
      const want = merged(clean, cases);
      assert.deepEqual(got, want, c.label);
      cases++;
    }
  }
  assert.equal(cases, 4000);
  assert.ok(faulted > 1500, "the corpus holds list faults: " + faulted + " of " + cases + " cases");
});
