import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { applyStepsLive, diffStates, flushEdits, noteEdit, redo, trackDocument, undo } from "../js/12a-undo.js";
import { invertSteps } from "../js/04c-doc-model.js";
import { loadTestDocument } from "./_document.mjs";

const clone = (v) => JSON.parse(JSON.stringify(v));
const person = (id, name) => ({ id, name });
const tag = (id, name, owner, extra) => Object.assign({ id, cat: "prop", name, owner: owner || "", notes: "", status: "needed" }, extra);
const shot = (id, name, owner) => ({ id, name, owner: owner || "" });
const doc = (extra) => Object.assign({ title: "T", rows: [], comments: [], people: [], productionTags: [], brollShots: [] }, extra);
const ownerOf = (list, name) => (list.find((e) => e.name === name) || {}).owner;

test("replaying an edit that adds a person moves a collaborator's same-named person's items to the person kept (#353)", () => {
  const steps = diffStates(doc(), doc({ people: [person("pM", "Ada")], productionTags: [tag("t_kettle", "Kettle", "pM")] }));
  const live = doc({ people: [person("pT", "ada")], productionTags: [tag("t_lamp", "Lamp", "pT")],
    brollShots: [shot("bs_pier", "Pier", "pT")] });
  assert.deepEqual(applyStepsLive(live, steps), { ok: true });
  assert.deepEqual(live.people, [person("pM", "Ada")]);
  assert.equal(ownerOf(live.productionTags, "Kettle"), "pM");
  assert.equal(ownerOf(live.productionTags, "Lamp"), "pM", "an item of theirs in the merged list too");
  assert.equal(ownerOf(live.brollShots, "Pier"), "pM");
  const saved = migrateRows(clone(live));
  assert.equal(ownerOf(saved.brollShots, "Pier"), "pM", "still assigned once migrateRows has run");
  assert.equal(ownerOf(saved.productionTags, "Kettle"), "pM");
});

test("undoing a person's removal moves a same-named person's items, added since, to the person restored (#353)", () => {
  const before = doc({ people: [person("pM", "Ada")], productionTags: [tag("t_kettle", "Kettle", "pM")] });
  const after = doc({ productionTags: [tag("t_kettle", "Kettle", "")] });
  const steps = invertSteps(diffStates(before, after));
  assert.deepEqual(steps.map((s) => s.key), ["productionTags", "people"]);
  const live = doc({ people: [person("pT", "ADA")], productionTags: [tag("t_kettle", "Kettle", "")],
    brollShots: [shot("bs_pier", "Pier", "pT"), shot("bs_dock", "Dock", "pT")] });
  const pier = live.brollShots[0];
  assert.deepEqual(applyStepsLive(live, steps), { ok: true });
  assert.deepEqual(live.people, [person("pM", "Ada")]);
  assert.equal(ownerOf(live.productionTags, "Kettle"), "pM");
  assert.deepEqual(live.brollShots.map((b) => b.owner), ["pM", "pM"]);
  assert.equal(pier.owner, "pT", "the shots are re-pointed in a copy, not written into in place");
});

test("an owner from the replayed list's own same-named duplicate goes to the person kept", () => {
  const steps = diffStates(doc(), doc({ people: [person("pM", "Ada"), person("pQ", "ada")],
    productionTags: [tag("t_kettle", "Kettle", "pQ")] }));
  const live = doc({ people: [person("pB", "Bo")] });
  assert.deepEqual(applyStepsLive(live, steps), { ok: true });
  assert.deepEqual(live.people, [person("pM", "Ada"), person("pB", "Bo")]);
  assert.equal(ownerOf(live.productionTags, "Kettle"), "pM");
});

test("a replayed people merge re-points only the ids it folded into another person", () => {
  const steps = diffStates(doc(), doc({ people: [person("pM", "Ada")] }));
  const live = doc({ people: [person("pB", "Bo"), person("pT", "ada")],
    productionTags: [tag("t_kettle", "Kettle", "pB"), tag("t_lamp", "Lamp", "pT"), tag("t_cup", "Cup", "pGone")],
    brollShots: [shot("bs_pier", "Pier", "pB"), shot("bs_dock", "Dock", "")] });
  const shots = live.brollShots;
  assert.deepEqual(applyStepsLive(live, steps), { ok: true, cleared: 1 });
  assert.deepEqual(live.people, [person("pM", "Ada"), person("pB", "Bo")]);
  assert.deepEqual(live.productionTags.map((t) => t.owner), ["pB", "pM", ""]);
  assert.deepEqual(live.brollShots.map((b) => b.owner), ["pB", ""]);
  assert.equal(live.brollShots, shots, "a list with nothing to re-point is left as it was");
});

test("a replay that sets the people list as recorded hands an owner it dropped to the same-named person it kept", () => {
  const steps = diffStates(doc({ people: [person("pX", "Bo"), person("pC", "Cy")] }),
    doc({ people: [person("pY", "bo"), person("pC", "Cy")] }));
  const live = doc({ people: [person("pX", "Bo"), person("pC", "Cy")],
    brollShots: [shot("bs_pier", "Pier", "pX"), shot("bs_dock", "Dock", "pC")] });
  assert.deepEqual(applyStepsLive(live, steps), { ok: true });
  assert.deepEqual(live.people, [person("pY", "bo"), person("pC", "Cy")]);
  assert.equal(ownerOf(live.brollShots, "Pier"), "pY");
  assert.equal(ownerOf(live.brollShots, "Dock"), "pC");
});

test("a replayed list merge hands an item to its live owner when the replayed owner is gone (#353)", () => {
  const people = [person("pS", "Sam"), person("pA", "Ada")];
  const steps = diffStates(
    doc({ people: people, productionTags: [tag("t_kettle", "Kettle", "")], brollShots: [shot("bs_pier", "Pier", "")] }),
    doc({ people: people, productionTags: [tag("t_kettle", "Kettle", "pS")], brollShots: [shot("bs_pier", "Pier", "pS")] }));
  const live = doc({ people: [person("pA", "Ada")], productionTags: [tag("t_kettle", "Kettle", "pA")],
    brollShots: [shot("bs_pier", "Pier", "pA")] });
  assert.deepEqual(applyStepsLive(live, steps), { ok: true });
  assert.equal(ownerOf(live.productionTags, "Kettle"), "pA");
  assert.equal(ownerOf(live.brollShots, "Pier"), "pA");
});

test("a replayed list merge judges owners against the people the replay leaves, not the people before it", () => {
  const before = doc({ people: [person("pS", "Sam"), person("pA", "Ada")], productionTags: [tag("t_kettle", "Kettle", "pS")] });
  const after = doc({ people: [person("pA", "Ada")], productionTags: [tag("t_kettle", "Kettle", "pA")] });
  const steps = invertSteps(diffStates(before, after));
  const live = clone(after);
  live.productionTags[0].notes = "dented";
  assert.deepEqual(applyStepsLive(live, steps), { ok: true });
  assert.deepEqual(live.people, [person("pS", "Sam"), person("pA", "Ada")]);
  assert.deepEqual(live.productionTags, [tag("t_kettle", "Kettle", "pS", { notes: "dented" })]);
});

test("redo after a same-named person reached the document without an undo entry keeps that person's items assigned (#353)", () => {
  loadTestDocument(migrateRows({ schema: 2, title: "Replay", comments: [], rows: [
    { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
  ] }));
  trackDocument();
  S.state.people.push(person("pM", "Ada"));
  S.state.productionTags.push(tag("t_kettle", "Kettle", "pM"));
  noteEdit();
  flushEdits();
  assert.equal(undo().ok, true);
  assert.deepEqual(S.state.people, []);
  S.state.people.push(person("pT", "ada"));
  S.state.brollShots.push(shot("bs_pier", "Pier", "pT"));
  assert.equal(redo().ok, true);
  assert.deepEqual(S.state.people, [person("pM", "Ada")]);
  assert.equal(ownerOf(S.state.brollShots, "Pier"), "pM");
  assert.equal(ownerOf(S.state.productionTags, "Kettle"), "pM");
  assert.equal(ownerOf(migrateRows(clone(S.state)).brollShots, "Pier"), "pM");
});
