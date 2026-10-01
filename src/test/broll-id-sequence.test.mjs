import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { makeId, migrateRows } from "../js/02-state.js";
import { __init as initBroll, anchorBrollInRows, brollEntries, newBrollRecord } from "../js/08c-broll.js";
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

test("repairing b-roll mints the ids the code before 2.6 minted, unmasked, with one discarded draw per created shot", () => {
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "B-roll: Steam<br>B-roll: Hands")]);
  brollEntries();
  anchorBrollInRows(S.state.rows);
  assert.deepEqual(shots(), [["Steam", "bsf3o9g5mo5vwtxke"], ["Hands", "bsuz4mfclo5vwtxke"]]);
  assert.equal(S.state.rows[0].visualText,
    key("bsf3o9g5mo5vwtxke", "B-roll:") + " Steam<br>" + key("bsuz4mfclo5vwtxke", "B-roll:") + " Hands");
  assert.equal(makeId("probe"), "probeqwyplh9o5vwtxke");
});

test("a read-only read draws only for lines with no key id; a repair also draws once for each shot it creates", () => {
  freezeClockAndRandom(SEED);
  load([
    row("r1", "Kettle on.", "B-roll: Steam<br>B-roll: Hands"),
    row("r2", "Pour.", key("bskeyed01", "B-roll:") + " Cup<br>B-roll: Spoon<br>" + key("bskeyed01", "B-roll:") + " Saucer")
  ]);
  assert.deepEqual(brollEntries(true).map((e) => e.id),
    ["bsf3o9g5mo5vwtxke", "bszjm9vjpo5vwtxke", "bskeyed01", "bsuz4mfclo5vwtxke", "bss7dow7oo5vwtxke"]);
  assert.deepEqual(S.state.brollShots, []);
  assert.deepEqual(brollEntries().map((e) => e.id),
    ["bsqwyplh9o5vwtxke", "bsh93g4wto5vwtxke", "bskeyed01", "bse22slyio5vwtxke", "bs7wls5yho5vwtxke"]);
  anchorBrollInRows(S.state.rows);
  assert.deepEqual(shots(), [
    ["Steam", "bsqwyplh9o5vwtxke"], ["Hands", "bsh93g4wto5vwtxke"], ["Cup", "bskeyed01"],
    ["Spoon", "bse22slyio5vwtxke"], ["Saucer", "bs7wls5yho5vwtxke"]
  ]);
  assert.deepEqual(S.state.rows.map((r) => r.visualText), [
    key("bsqwyplh9o5vwtxke", "B-roll:") + " Steam<br>" + key("bsh93g4wto5vwtxke", "B-roll:") + " Hands",
    key("bskeyed01", "B-roll:") + " Cup<br>" + key("bse22slyio5vwtxke", "B-roll:") + " Spoon<br>" +
      key("bs7wls5yho5vwtxke", "B-roll:") + " Saucer"
  ]);
  assert.equal(makeId("probe"), "probeav1enuto5vwtxke");
});

test("anchoring first, as runBrollRefresh does, mints one id per typed line; the repair after it draws only for the shots it creates", () => {
  freezeClockAndRandom(SEED);
  load([
    row("r1", "Kettle on.", "B-roll: Steam<br>B-roll: Hands"),
    row("r2", "Pour.", "B-roll: Cup<br>B-roll: Spoon")
  ]);
  assert.equal(anchorBrollInRows(S.state.rows), 4);
  assert.deepEqual(S.state.brollShots, []);
  assert.deepEqual(S.state.rows.map((r) => r.visualText), [
    key("bsf3o9g5mo5vwtxke", "B-roll:") + " Steam<br>" + key("bszjm9vjpo5vwtxke", "B-roll:") + " Hands",
    key("bsuz4mfclo5vwtxke", "B-roll:") + " Cup<br>" + key("bss7dow7oo5vwtxke", "B-roll:") + " Spoon"
  ]);
  assert.deepEqual(brollEntries().map((e) => e.id),
    ["bsf3o9g5mo5vwtxke", "bszjm9vjpo5vwtxke", "bsuz4mfclo5vwtxke", "bss7dow7oo5vwtxke"]);
  assert.deepEqual(shots(), [
    ["Steam", "bsf3o9g5mo5vwtxke"], ["Hands", "bszjm9vjpo5vwtxke"],
    ["Cup", "bsuz4mfclo5vwtxke"], ["Spoon", "bss7dow7oo5vwtxke"]
  ]);
  assert.equal(makeId("probe"), "probedtum9qjo5vwtxke");
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

test("brollEntries(false) repairs exactly as brollEntries() does, with the same ids and draws", () => {
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "B-roll: Steam<br>B-roll: Hands")]);
  assert.deepEqual(brollEntries(false).map((e) => e.id), ["bsf3o9g5mo5vwtxke", "bsuz4mfclo5vwtxke"]);
  assert.deepEqual(shots(), [["Steam", "bsf3o9g5mo5vwtxke"], ["Hands", "bsuz4mfclo5vwtxke"]]);
  assert.equal(makeId("probe"), "probeqwyplh9o5vwtxke");
});