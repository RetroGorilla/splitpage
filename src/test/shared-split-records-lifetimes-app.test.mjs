import { test } from "node:test";
import assert from "node:assert/strict";
import { openProductionPanel, renderProduction } from "../features/tags/panels.ts";
import { runBrollRefresh } from "../features/broll/panel.ts";
import { SOURCE, adopt, enter, brollOpen, tidy, $, typeIn, FIRE, MUG, productionCards, expandedCard, tagPersonBox, shotB1, tagById, blurOut, NOTES, LAMP, SCENED, OTHER, PROP, shownValue, refusedNotes } from "./_shared-split-records.mjs";

test("C7 record typed text: drafts in two occurrences of one tag in By scene each stay in their own box across a redraw", async () => {
  const f = await enter(SCENED);
  try {
    openProductionPanel(); $('#production-modes [data-group="by-scene"]').click();
    const scope = index => `#production-panel [data-scene-group=":scene:${index}"]`;
    for (const [index, name] of [[0, "Alice"], [1, "Bob"]]) {
      expandedCard(scope(index), "prop mug"); $(`${scope(index)} [data-action="tag-person-new"]${MUG}`).click();
      typeIn(`${scope(index)} .tag-person-input${MUG}`, name, [name.length, name.length]);
    }
    $('#production-panel [data-action="tag-status-cycle"][data-key="prop lamp"]').click();
    assert.notEqual(tagById(LAMP).status, "needed", "the other tag's status was served");
    assert.deepEqual([0, 1].map(index => $(`${scope(index)} .tag-person-input${MUG}`).value), ["Alice", "Bob"]);
  } finally { $('#production-modes [data-group="cat"]').click(); tidy(f); }
});

test("C7 record typed text: drafts typed before the session starts do not cross into it", async () => {
  adopt(SOURCE);
  productionCards(); tagPersonBox("#production-panel", "prop mug");
  brollOpen("b1"); typeIn(PROP, "Old prop", [8, 8]); document.activeElement.blur();
  const f = await enter(SOURCE, false);
  try {
    renderProduction(); runBrollRefresh();
    assert.deepEqual([shownValue(`#production-panel .tag-person-input${MUG}`), shownValue(PROP)], ["", ""]);
  } finally { tidy(f); }
});

test("C7 record typed text: a b-roll prop draft kept in the session does not reach another script's shot with the same id after leaving", async () => {
  const f = await enter();
  try {
    brollOpen("b1"); typeIn(PROP, "Old script prop", [15, 15]); document.activeElement.blur();
    runBrollRefresh();
    assert.equal(shownValue(PROP), "Old script prop", "kept across a redraw in the session");
  } finally { tidy(f); }
  adopt(OTHER);
  brollOpen("b1");
  assert.equal(shownValue(PROP), "");
  $(PROP).focus(); FIRE.enter($(PROP));
  assert.deepEqual(shotB1().props, []);
  document.activeElement?.blur?.();
});

test("C7 record typed text: after a refused notes write and leaving, a standalone redraw saves the same notes, as on main", async () => {
  await refusedNotes();
  adopt(SOURCE);
  brollOpen("b1"); typeIn(NOTES, "Wide", [4, 4]); runBrollRefresh();
  assert.equal(shotB1().notes, "Wide");
  document.activeElement?.blur?.();
});

test("C7 record typed text: a refused notes write does not outlive its session, and the next session saves the same notes only on blur", async () => {
  await refusedNotes();
  const f = await enter();
  try {
    brollOpen("b1");
    assert.deepEqual([$(NOTES).value, window.__brollTest.drafts()], ["", []]);
    const before = f.parts.undo.sizes().undo;
    typeIn(NOTES, "Wide", [4, 4]); runBrollRefresh(); runBrollRefresh();
    assert.equal(shotB1().notes, "");
    blurOut($(NOTES));
    assert.equal(shotB1().notes, "Wide");
    assert.equal(f.parts.undo.sizes().undo - before, 1);
  } finally { tidy(f); }
});
