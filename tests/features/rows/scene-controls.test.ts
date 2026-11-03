import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSceneControls } from "../../../src/features/rows/scene-controls.ts";
import { createSceneView } from "../../../src/application/editing/scene-view.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";
import { toggleRowMenu } from "../../../src/features/rows/row-menu.ts";
import { fakeNotices } from "../fakes.ts";
import { scenesInOrder } from "../../../src/core/document/scenes.ts";

function fixture(existing = false) {
  const h = harness();
  h.session.adopt({ rows: [{ id: "r1" }, { id: "r2" }], sections: existing ? [{ id: "s1", name: "Opening", firstSceneId: "r2" }] : [] });
  document.body.innerHTML = '<div id="rows">' +
    (existing ? '<div class="section-header" data-section-id="s1"><button class="section-name">Opening</button></div>' : '') +
    '<div class="row" data-id="r2"><button class="row-more"></button><div class="row-menu" hidden>' +
    '<button class="row-menu-item" data-action="add-section" data-id="r2"><span>Add Section Header</span></button></div></div></div>';
  let allowed = true;
  const controls = mountSceneControls(window, {
    document: { current: () => h.session.read(doc => doc) },
    edits: { allowed: () => allowed, run: command => runConfined(h.session, command) },
    scenes: createSceneView(),
    focus: { focusedRow: () => {} },
    drag: { dragging: () => null, end: () => {} },
    ids: { id: () => "created" },
    notices: fakeNotices().notices,
    scroll: () => {}, stopScroll: () => {}
  });
  const more = document.querySelector<HTMLButtonElement>(".row-more");
  const add = document.querySelector<HTMLButtonElement>('[data-action="add-section"]');
  assert.ok(more && add);
  return { h, controls, more, add, allow: (value: boolean) => { allowed = value; } };
}

function nameForm(): { input: HTMLInputElement; form: HTMLFormElement } {
  const form = document.querySelector<HTMLFormElement>(".section-rename");
  const input = form?.querySelector("input");
  assert.ok(form && input);
  return { form, input };
}

test("section controls add before the menu's scene without consulting scene selection", () => {
  const f = fixture();
  try {
    toggleRowMenu(f.more, true);
    f.add.querySelector("span")?.click();
    const { form, input } = nameForm();
    assert.equal(document.querySelector<HTMLDivElement>(".row-menu")?.hidden, true);
    assert.equal(f.more.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, input);
    assert.equal(form.closest(".row")?.getAttribute("data-id"), "r2");
    input.value = " Middle ";
    form.requestSubmit();
    assert.deepEqual(f.h.session.read(doc => doc?.sections), [{ id: "created", name: "Middle", firstSceneId: "r2" }]);
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 1);
  } finally { f.controls.dispose(); }
});

test("section controls rename an existing header directly above the menu's scene", () => {
  const f = fixture(true);
  try {
    f.add.click();
    const { form, input } = nameForm();
    assert.equal(input.value, "Opening");
    assert.equal(form.closest(".section-header")?.getAttribute("data-section-id"), "s1");
    input.value = "Renamed";
    form.requestSubmit();
    assert.deepEqual(f.h.session.read(doc => doc?.sections), [{ id: "s1", name: "Renamed", firstSceneId: "r2" }]);
  } finally { f.controls.dispose(); }
});

test("section controls respect edit permission both before naming and before submission", () => {
  const f = fixture();
  try {
    f.allow(false);
    f.add.click();
    assert.equal(document.querySelector(".section-rename"), null);
    f.allow(true);
    f.add.click();
    const { form, input } = nameForm();
    input.value = "Blocked";
    f.allow(false);
    form.requestSubmit();
    assert.equal(f.h.session.read(doc => doc ? scenesInOrder(doc)?.length ?? 0 : 0), 0);
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
    assert.equal(form.isConnected, true);
  } finally { f.controls.dispose(); }
});

test("cancelling section naming returns focus to the scene menu button without an edit", () => {
  const f = fixture();
  try {
    toggleRowMenu(f.more, true);
    f.add.click();
    nameForm().input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(document.querySelector(".section-rename"), null);
    assert.equal(document.activeElement, f.more);
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
  } finally { f.controls.dispose(); }
});
