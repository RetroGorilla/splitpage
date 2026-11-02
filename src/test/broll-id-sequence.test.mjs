import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { makeId } from "../adapters/identity/ids.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { derivedRecordsPlan } from "../bootstrap/wiring/broll.ts";
import { broll } from "./_broll-mounted.mjs";
const { brollEntries } = broll;
import "./_broll-mounted.mjs";
import { anchorBrollInRows } from "../adapters/production/broll-anchors.ts";
import { productionReaders } from "../bootstrap/document-ports.ts";
import { cellOf } from "../bootstrap/richtext.ts";
import { inertBody } from "../bootstrap/richtext.ts";
import { sanitizeHtml } from "../bootstrap/richtext.ts";
import { newBrollRecord } from "../application/commands/production-actions.ts";
import { runDocumentEdit, currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { randomIds } from "../adapters/identity/ids.ts";
import { WHOLE_DOCUMENT } from "../application/session/change-set.ts";
import { startTestHistory as initHistory } from "./_history-started.mjs";
import { freezeClockAndRandom } from "./golden-helpers.mjs";
import { loadTestDocument } from "./_document.mjs";

const SEED = 0x70726f64;

initHistory();

const row = (id, audioText, visualText) => ({
  id, status: "todo", visualText, audioText, imageRef: null, updatedAt: "2026-03-01T09:00:00.000Z", updatedBy: "Sam"
});
const key = (id, text) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">${text}</span>`;

function load(rows) {
  loadTestDocument(migrateRows({ schema: 2, title: "Ids", docId: "d" + "7".repeat(32), rows, brollShots: [], productionTags: [] }));
}

const shots = () => currentDocument().brollShots.map((s) => [s.name, s.id]);

test("entry derives a record id for each b-roll line; entry, reading and anchoring draw nothing", () => {
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "B-roll: Steam<br>B-roll: Hands")]);
  assert.deepEqual(shots(), [["Steam", "bs-load-6ee2584e99173334d669e2ca-1"], ["Hands", "bs-load-6ee2584e99173334d669e2ca-2"]]);
  assert.deepEqual(brollEntries().map((e) => e.id), ["bs-load-6ee2584e99173334d669e2ca-1", "bs-load-6ee2584e99173334d669e2ca-2"]);
  anchorBrollInRows(currentDocument(), undefined, { readers: productionReaders, ids: randomIds, cellOf: cellOf, inertBody: inertBody, sanitize: sanitizeHtml, declined: () => false });
  assert.deepEqual(shots(), [["Steam", "bs-load-6ee2584e99173334d669e2ca-1"], ["Hands", "bs-load-6ee2584e99173334d669e2ca-2"]]);
  assert.equal(currentDocument().rows[0].visualText,
    key("bs-load-6ee2584e99173334d669e2ca-1", "B-roll:") + " Steam<br>" + key("bs-load-6ee2584e99173334d669e2ca-2", "B-roll:") + " Hands");
  assert.equal(makeId("probe"), "probef3o9g5mo5vwtxke");
});

test("entry keeps a key's id for the first line that holds it and gives a second line with the same key an id of its own", () => {
  freezeClockAndRandom(SEED);
  load([
    row("r1", "Kettle on.", "B-roll: Steam<br>B-roll: Hands"),
    row("r2", "Pour.", key("bskeyed01", "B-roll:") + " Cup<br>B-roll: Spoon<br>" + key("bskeyed01", "B-roll:") + " Saucer")
  ]);
  assert.deepEqual(shots(), [
    ["Steam", "bs-load-548406f755a0a00f43474f9e-1"], ["Hands", "bs-load-548406f755a0a00f43474f9e-2"], ["Cup", "bskeyed01"],
    ["Spoon", "bs-load-548406f755a0a00f43474f9e-3"], ["Saucer", "bs-load-548406f755a0a00f43474f9e-4"]
  ]);
  assert.equal(makeId("probe"), "probef3o9g5mo5vwtxke");
});

test("a read of lines typed after entry draws ids it does not keep and writes nothing; the edit's records plan creates the shots", () => {
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "")]);
  currentDocument().rows[0].visualText = "B-roll: Steam<br>B-roll: Hands";
  assert.deepEqual(brollEntries().map((e) => e.id), ["bsf3o9g5mo5vwtxke", "bszjm9vjpo5vwtxke"]);
  assert.deepEqual(currentDocument().brollShots, []);
  const plan = derivedRecordsPlan(currentDocument(), WHOLE_DOCUMENT);
  assert.deepEqual(plan.fields, ["brollShots"]);
  assert.deepEqual(currentDocument().brollShots, [], "planning wrote the document");
  plan.apply(currentDocument());
  assert.deepEqual(shots(), [["Steam", "bsuz4mfclo5vwtxke"], ["Hands", "bss7dow7oo5vwtxke"]]);
  assert.deepEqual(derivedRecordsPlan(currentDocument(), WHOLE_DOCUMENT).fields, [], "a second plan found work");
  assert.equal(makeId("probe"), "probeqwyplh9o5vwtxke");
});

test("newBrollRecord draws its own bs id whether or not the caller supplies one, so the capture and paste paths advance the sequence by one", () => {
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "")]);
  const minted = newBrollRecord({}, { run: runDocumentEdit, ids: randomIds });
  assert.equal(minted.id, "bsf3o9g5mo5vwtxke");
  assert.equal(makeId("probe"), "probezjm9vjpo5vwtxke");
  freezeClockAndRandom(SEED);
  load([row("r1", "Kettle on.", "")]);
  const supplied = newBrollRecord({ id: "bspasted01" }, { run: runDocumentEdit, ids: randomIds });
  assert.equal(supplied.id, "bspasted01");
  assert.deepEqual(shots(), [["", "bspasted01"]]);
  assert.equal(makeId("probe"), "probezjm9vjpo5vwtxke");
});
