/* The state field registry (02-state.js, issue #60).
 *
 * Ported from the second half of tests/51-merge-fields.txt, which reached
 * STATE_FIELDS and missingStateFields through
 * window.__splitpageFormats.stateFields / .missingStateFields for no reason
 * other than that a browser was the only place the code existed (#67).
 *
 * HANDOFF invariant #4 used to be a comment above mergeStates' result
 * literal. A top-level field left out of that literal was destroyed on
 * every merge — which is what happened to `people` and `productionTags`
 * once already — and the merge is the one path every hosted save, every
 * stash and every file merge goes through. The table is the fix; these
 * are the assertions that keep the table honest.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STATE_FIELDS, migrateRows, missingStateFields } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { buildSplitpageFile, parseSplitpageFile } from "../js/20d-formats.js";

const SEED = JSON.parse(readFileSync(new URL("../seed-state.json", import.meta.url), "utf8"));

test("every registry field has a strategy mergeStates knows", () => {
  /* An unknown strategy throws in mergeStates rather than dropping the
     field silently — but a field that never reaches the merge at all is
     the failure this catches. */
  const known = {
    "title": 1, "doc-id": 1, "rows": 1, "comments": 1, "list-union-with-base": 1,
    "changed-side-wins": 1, "max-plus-one": 1, "theirs-wins": 1, "constant": 1,
    "person-colors": 1
  };
  const bad = STATE_FIELDS.filter((f) =>
    !known[f.merge] || (f.merge === "list-union-with-base" && typeof f.mergeList !== "function")
  ).map((f) => f.key);
  assert.deepEqual(bad, []);
});

test("a merge keeps every field a migrated document has", () => {
  const empty = migrateRows({});
  const merged = mergeStates(null, migrateRows({}), migrateRows({})).merged;
  const lost = Object.keys(empty).filter((k) => !(k in merged));
  assert.deepEqual(lost, []);
});

test("nothing migrateRows produces is outside the table", () => {
  const empty = migrateRows({});
  const known = Object.create(null);
  STATE_FIELDS.forEach((f) => { known[f.key] = true; });
  const unlisted = Object.keys(empty).filter((k) => !known[k]);
  assert.deepEqual(unlisted, []);
});

test("a migrated document is never missing a defaulted field", () => {
  assert.deepEqual(missingStateFields(migrateRows({})), []);
});

test("the shipped seed document is complete once migrated", () => {
  /* 51-merge-fields.txt asserted this on the live boot state; the seed file
     itself is the thing that state is made of, so assert on the source. */
  assert.deepEqual(missingStateFields(migrateRows(JSON.parse(JSON.stringify(SEED)))), []);
});

test("a merged document is still a complete document", () => {
  const doc = () => migrateRows(JSON.parse(JSON.stringify(SEED)));
  assert.deepEqual(missingStateFields(mergeStates(doc(), doc(), doc()).merged), []);
});

test("a .splitpage save carries every registry field", () => {
  /* The third place a field could go missing: the merge, migrateRows, and
     the file on disk. */
  const round = migrateRows(parseSplitpageFile(buildSplitpageFile(migrateRows(JSON.parse(JSON.stringify(SEED))))));
  assert.deepEqual(missingStateFields(round), []);
});

test("missingStateFields names what is actually absent", () => {
  /* The check is only worth anything if it can fail. */
  const holed = migrateRows({});
  delete holed.people;
  delete holed.brollShots;
  assert.deepEqual(missingStateFields(holed).sort(), ["brollShots", "people"]);
  assert.deepEqual(missingStateFields(null).sort(),
    STATE_FIELDS.filter((f) => f.def).map((f) => f.key).sort());
});

test("a b-roll shot keeps every field it has — props too — through a merge and a save", () => {
  /* The same failure one level down (#149): a field on a shot record that
     the list merge or the file does not carry is lost the same way a
     top-level one was. mergeBrollShots clones a shot whole, and folds the
     other side's copy into it field by field — props through its own set
     merge — so every key migrateRows gives a shot has to come out of it. */
  const doc = () => migrateRows({
    productionTags: [{ cat: "prop", name: "Kettle" }],
    brollShots: [{ id: "b1", name: "Rooftop", props: [{ name: "Kettle" }, { name: "Tarp" }] }]
  });
  const shotKeys = Object.keys(doc().brollShots[0]).sort();
  assert.ok(shotKeys.includes("props"));
  const merged = mergeStates(doc(), doc(), doc()).merged.brollShots[0];
  assert.deepEqual(Object.keys(merged).sort(), shotKeys);
  assert.deepEqual(merged.props, doc().brollShots[0].props);
  const round = migrateRows(parseSplitpageFile(buildSplitpageFile(doc()))).brollShots[0];
  assert.deepEqual(Object.keys(round).sort(), shotKeys);
  assert.deepEqual(round.props, doc().brollShots[0].props);
});
