import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { makeId, migrateRows } from "../js/02-state.js";
import { __init as initBroll, anchorBrollInRows, brollEntries, derivedRecordsPlan, newBrollRecord } from "../js/08c-broll.js";
import { WHOLE_DOCUMENT } from "../application/session/change-set.ts";
import { __init as initHistory } from "../js/03a-history-store.js";
import { freezeClockAndRandom } from "./golden-helpers.mjs";

const SEED = 0x70726f64;

initBroll();
initHistory();

const row = (id, audioText, visualText) => ({
  id, status: "todo", visualText, audioText, imageRef: null, updatedAt: "2026-03-01T09:00:00.000Z", updatedBy: "Sam"
});
const key = (id, text) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">${text}</span>`;

function load(rows) {
  S.state = migrateRows({ schema: 2, title: "Ids", docId: "d" + "7".repeat(32), rows, brollShots: [], productionTags: [] });
}

const shots = () => S.state.brollShots.map((s) => [s.name, s.id]);

test("entry creates a record for each b-roll line, one draw per line in line order; reading and anchoring then draw nothing", () => {
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "B-roll: Steam<br>B-roll: Hands")]);
  assert.deepEqual(shots(), [["Steam", "bsf3o9g5mo5vwtxke"], ["Hands", "bszjm9vjpo5vwtxke"]]);
  assert.deepEqual(brollEntries().map((e) => e.id), ["bsf3o9g5mo5vwtxke", "bszjm9vjpo5vwtxke"]);
  anchorBrollInRows(S.state.rows);
  assert.deepEqual(shots(), [["Steam", "bsf3o9g5mo5vwtxke"], ["Hands", "bszjm9vjpo5vwtxke"]]);
  assert.equal(S.state.rows[0].visualText,
    key("bsf3o9g5mo5vwtxke", "B-roll:") + " Steam<br>" + key("bszjm9vjpo5vwtxke", "B-roll:") + " Hands");
  assert.equal(makeId("probe"), "probeuz4mfclo5vwtxke");
});

test("entry keeps a key's id for the first line that holds it and gives a second line with the same key an id of its own", () => {
  freezeClockAndRandom(SEED);
  load([
    row("r1", "Kettle on.", "B-roll: Steam<br>B-roll: Hands"),
    row("r2", "Pour.", key("bskeyed01", "B-roll:") + " Cup<br>B-roll: Spoon<br>" + key("bskeyed01", "B-roll:") + " Saucer")
  ]);
  assert.deepEqual(shots(), [
    ["Steam", "bsf3o9g5mo5vwtxke"], ["Hands", "bszjm9vjpo5vwtxke"], ["Cup", "bskeyed01"],
    ["Spoon", "bsuz4mfclo5vwtxke"], ["Saucer", "bss7dow7oo5vwtxke"]
  ]);
  assert.equal(makeId("probe"), "probeqwyplh9o5vwtxke");
});

test("a read of lines typed after entry draws ids it does not keep and writes nothing; the edit's records plan creates the shots", () => {
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "")]);
  S.state.rows[0].visualText = "B-roll: Steam<br>B-roll: Hands";
  assert.deepEqual(brollEntries().map((e) => e.id), ["bsf3o9g5mo5vwtxke", "bszjm9vjpo5vwtxke"]);
  assert.deepEqual(S.state.brollShots, []);
  const plan = derivedRecordsPlan(S.state, WHOLE_DOCUMENT);
  assert.deepEqual(plan.fields, ["brollShots"]);
  assert.deepEqual(S.state.brollShots, [], "planning wrote the document");
  plan.apply(S.state);
  assert.deepEqual(shots(), [["Steam", "bsuz4mfclo5vwtxke"], ["Hands", "bss7dow7oo5vwtxke"]]);
  assert.equal(derivedRecordsPlan(S.state, WHOLE_DOCUMENT), null, "a second plan found work");
  assert.equal(makeId("probe"), "probeqwyplh9o5vwtxke");
});

test("newBrollRecord draws its own bs id whether or not the caller supplies one, so the capture and paste paths advance the sequence by one", () => {
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "")]);
  const minted = newBrollRecord({});
  assert.equal(minted.id, "bsf3o9g5mo5vwtxke");
  assert.equal(makeId("probe"), "probezjm9vjpo5vwtxke");
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "")]);
  const supplied = newBrollRecord({ id: "bspasted01" });
  assert.equal(supplied.id, "bspasted01");
  assert.deepEqual(shots(), [["", "bspasted01"]]);
  assert.equal(makeId("probe"), "probezjm9vjpo5vwtxke");
});
