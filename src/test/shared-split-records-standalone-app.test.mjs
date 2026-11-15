import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { currentBrollRecords } from "../bootstrap/wiring/broll.ts";
import { cellEditing } from "../bootstrap/wiring/editor-owners.ts";
import { clearProductionSelection } from "../bootstrap/wiring/production-editing-owners.ts";
import { sharedCommentCommands, sharedGalleryCommands, sharedRecordCommands } from "../bootstrap/wiring/ports/shared-commands.ts";
import { findOrAddPerson, registerProductionTag } from "../features/tags/production-tags.ts";
import { armRemoveTag, openProductionPanel, saveTagRename } from "../features/tags/panels.ts";
import { closeCommentComposer, toggleResolve } from "../features/comments/comments.ts";
import { removeGallerySlot } from "../core/document/gallery.ts";
import { tagKey } from "../core/document/tags.ts";
import { encodeSharedState } from "../adapters/collab/document.ts";
import { toastHost, warnings, clearWarnings, SOURCE, enter, shape, brollOpen, twice, post, tidy, $, typeIn, FIRE, B1, NOOPS, noopOnce } from "./_shared-split-records.mjs";

for (const noop of NOOPS) test(`C7 record no-op: ${noop.name}, shared and standalone alike, with nothing written and no warning`, async () => {
  const f = await enter();
  try {
    noopOnce(noop.act, noop.cleaned, () => [encodeSharedState(f.parts.handle), f.parts.undo.sizes(), undoOwner().sizes()]);
  } finally { tidy(f); }
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  try {
    noopOnce(noop.act, noop.cleaned, () => [undoOwner().sizes()]);
  } finally { closeCommentComposer(); clearProductionSelection(); }
});

test("C7 record standalone: the record, picture and comment callers read no shared ports", () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
  assert.equal(sharedSession(), false);
  assert.equal(sharedRecordCommands.ports(), null);
  assert.equal(sharedGalleryCommands.ports(), null);
  assert.equal(sharedCommentCommands.ports(), null);
  clearWarnings();
  assert.equal(registerProductionTag("location", "Park"), true);
  assert.notEqual(findOrAddPerson("Cy"), "");
  assert.deepEqual(currentBrollRecords()?.addBrollProp("b1", "Lamp"), { changed: true, held: false });
  assert.deepEqual(cellEditing().editGallery("r1", "Picture removed", row => removeGallerySlot(row, 1)), { changed: true, held: false });
  const pictureToast = [...toastHost().querySelectorAll(".toast")].find(el => el.firstChild.textContent === "Picture removed");
  assert.ok(pictureToast?.querySelector(".toast-action"), "the standalone picture toast keeps its Undo");
  toggleResolve("C1");
  post("Bob");
  openProductionPanel();
  assert.equal(saveTagRename(tagKey("gear", "Drone"), "Crane"), tagKey("gear", "Crane"));
  twice(armRemoveTag, tagKey("prop", "Mug"));
  brollOpen("b1"); typeIn(`#broll-panel .broll-prop-input${B1}`, "Rope", [4, 4]); FIRE.enter($(`#broll-panel .broll-prop-input${B1}`));
  assert.deepEqual([$(`#broll-panel .broll-prop-input${B1}`).value, document.activeElement === $(`#broll-panel .broll-prop-input${B1}`)], ["", true]);
  document.activeElement.blur();
  const s = shape(currentDocument());
  assert.deepEqual([s.people, s.tags.map(t => t[1]), s.shots[0][4], s.rows[0][3], s.rows[1][2], s.comments.map(c => [c[0], c[1]])],
    [["Ann", "Bob", "Cy"], ["Crane", "Mug", "Park", "Lamp", "Rope"], ["Mug", "Lamp", "Rope"], ["a", "c"], "A Mug", [["C1", true], ["C9", false]]]);
  assert.equal(currentDocument().comments[1].author, "Bob");
  assert.deepEqual(warnings(), []);
});
