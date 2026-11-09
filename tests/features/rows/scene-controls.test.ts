import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSceneControls } from "../../../src/features/rows/scene-controls.ts";
import { createSceneView } from "../../../src/application/editing/scene-view.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";
import { toggleRowMenu } from "../../../src/features/rows/row-menu.ts";
import { fakeNotices } from "../fakes.ts";
import { scenesInOrder } from "../../../src/core/document/scenes.ts";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";

function fixture(existing = false, moving: string | null = null) {
  const h = harness();
  h.session.adopt({ rows: [{ id: "r1" }, { id: "r2" }], sections: existing ? [{ id: "s1", name: "Opening", firstSceneId: "r2" }] : [] });
  document.body.innerHTML = '<div id="rows">' +
    (existing ? '<div class="section-header" data-section-id="s1"><span role="heading"><button class="section-name">Opening</button></span></div>' : '') +
    '<div class="row" data-id="r2"><button class="row-more"></button><div class="row-menu" hidden>' +
    '<button class="row-menu-item" data-action="add-section" data-id="r2"><span>Add Section Header</span></button></div></div></div>';
  let allowed = true;
  const controls = mountSceneControls(window, {
    document: { current: () => h.session.read(doc => doc), numbering: () => h.session.read(doc => deriveDocumentNumbering(doc ?? { rows: [] })) },
    edits: { allowed: () => allowed, run: command => runConfined(h.session, command) },
    scenes: createSceneView(),
    focus: { focusedRow: () => {} },
    drag: { dragging: () => moving, end: () => { moving = null; } },
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
    assert.equal(form.querySelectorAll("button").length, 0);
    assert.equal(form.closest(".row"), null);
    assert.equal(form.nextElementSibling?.getAttribute("data-id"), "r2");
    input.value = " Middle ";
    form.requestSubmit();
    assert.deepEqual(f.h.session.read(doc => doc?.sections), [{ id: "created", name: "Middle", firstSceneId: "r2" }]);
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 1);
  } finally { f.controls.dispose(); }
});

test("a beat dropped on automatic A joins it without saving a default header", () => {
  for (const existing of [false, true]) {
    const f = fixture(existing, "r2");
    try {
      const automatic = document.createElement("header");
      automatic.className = "section-header";
      automatic.setAttribute("data-section-id", "");
      document.getElementById("rows")?.prepend(automatic);
      const drop = new window.Event("drop", { bubbles: true, cancelable: true });
      automatic.dispatchEvent(drop);
      assert.equal(drop.defaultPrevented, true);
      f.h.session.read(doc => {
        assert.ok(doc);
        assert.deepEqual(doc.rows.map(row => row.id), ["r2", "r1"]);
        assert.equal(doc.sections, undefined);
        assert.equal(deriveDocumentNumbering(doc).beats["r2"]?.full, "A.1");
      });
      assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 1);
    } finally { f.controls.dispose(); }
  }
});

test("section controls rename an existing header directly above the menu's scene", () => {
  const f = fixture(true);
  try {
    f.add.click();
    const { form, input } = nameForm();
    assert.equal(input.value, "Opening");
    assert.equal(form.closest(".section-header")?.getAttribute("data-section-id"), "s1");
    assert.equal(form.parentElement?.getAttribute("role"), "heading");
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, "Opening".length);
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

for (const existing of [false, true]) {
  for (const value of ["", "  ", "New name"]) {
    test(`blurring ${existing ? "an existing" : "a new"} heading with ${JSON.stringify(value)} settles once and keeps outside focus`, () => {
      const f = fixture(existing);
      try {
        f.add.click();
        const { input } = nameForm();
        input.value = value;
        f.more.focus();
        assert.equal(document.querySelector(".section-rename"), null);
        assert.equal(document.activeElement, f.more);
        assert.equal(f.h.log.filter(entry => entry === "undo.record").length, value.trim() ? 1 : 0);
        assert.deepEqual(f.h.session.read(doc => doc?.sections), value.trim()
          ? [{ id: existing ? "s1" : "created", name: "New name", firstSceneId: "r2" }]
          : existing ? [{ id: "s1", name: "Opening", firstSceneId: "r2" }] : undefined);
      } finally { f.controls.dispose(); }
    });
  }

  test(`a connected ${existing ? "rename" : "creation"} line cannot save under another owner`, () => {
    const f = fixture(existing);
    try {
      f.add.click();
      const { input, form } = nameForm();
      input.value = "Wrong owner";
      document.getElementById("rows")?.append(form);
      assert.equal(form.isConnected, true);
      document.body.click();
      assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
    } finally { f.controls.dispose(); }
  });

  test(`removing a ${existing ? "rename" : "creation"} line invalidates it even if later reattached`, async () => {
    const f = fixture(existing);
    try {
      f.add.click();
      const { input, form } = nameForm();
      const parent = form.parentElement, next = form.nextSibling;
      assert.ok(parent);
      input.value = "Expired editor";
      form.remove();
      await Promise.resolve();
      parent.insertBefore(form, next);
      form.requestSubmit();
      assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
      form.remove();
    } finally { f.controls.dispose(); }
  });
}

test("empty Enter leaves the name open without an edit until clicking away", () => {
  const f = fixture();
  try {
    f.add.click();
    nameForm().form.requestSubmit();
    assert.equal(document.activeElement, nameForm().input);
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
    document.body.click();
    assert.equal(document.querySelector(".section-rename"), null);
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
  } finally { f.controls.dispose(); }
});

test("reset and disposal discard a pending name without committing it on blur", () => {
  const f = fixture();
  try {
    f.add.click();
    const { input } = nameForm();
    input.value = "Discard on replacement";
    f.controls.reset();
    input.dispatchEvent(new window.Event("blur"));
    assert.equal(document.querySelector(".section-rename"), null);
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
    f.add.click();
    const pending = nameForm().input;
    pending.value = "Discard on disposal";
    f.controls.dispose();
    pending.dispatchEvent(new window.Event("blur"));
    assert.equal(document.querySelector(".section-rename"), null);
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
  } finally { f.controls.dispose(); }
});

test("clicking a nonfocusable surface settles a pending name once", () => {
  const f = fixture();
  try {
    f.add.click();
    const { input, form } = nameForm();
    input.value = "Click away";
    document.body.click();
    form.requestSubmit();
    assert.equal(document.querySelector(".section-rename"), null);
    assert.equal(f.h.session.read(doc => doc ? scenesInOrder(doc)?.[0]?.name : undefined), "Click away");
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 1);
  } finally { f.controls.dispose(); }
});

test("a pointer click saves after the focus transfer so header controls can receive their click", () => {
  const f = fixture(true);
  try {
    f.add.click();
    const { input } = nameForm();
    input.value = "Before the click";
    f.more.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    f.more.focus();
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
    f.more.click();
    assert.equal(document.activeElement, f.more);
    assert.equal(f.h.session.read(doc => doc ? scenesInOrder(doc)?.[0]?.name : undefined), "Before the click");
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 1);
  } finally { f.controls.dispose(); }
});

test("an expired input cannot cancel a newer editor", async () => {
  const f = fixture();
  try {
    f.add.click();
    const expired = nameForm().input;
    expired.closest("form")?.remove();
    await Promise.resolve();
    f.add.click();
    const current = nameForm().input;
    expired.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(current.isConnected, true);
    assert.equal(document.activeElement, current);
    assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
  } finally { f.controls.dispose(); }
});

for (const existing of [false, true]) {
  for (const commit of ["submit", "click", "blur", "window-blur", "pointercancel"]) {
    test(`a detached ${existing ? "rename" : "creation"} editor cannot commit through ${commit}`, () => {
      const f = fixture(existing);
      try {
        f.add.click();
        const { input, form } = nameForm();
        input.value = "Invisible draft";
        form.remove();
        if (commit === "submit") form.requestSubmit();
        else if (commit === "click") document.body.click();
        else if (commit === "blur") input.dispatchEvent(new window.FocusEvent("blur", { relatedTarget: f.more }));
        else if (commit === "window-blur") window.dispatchEvent(new window.Event("blur"));
        else document.dispatchEvent(new window.Event("pointercancel"));
        assert.equal(f.h.log.filter(entry => entry === "undo.record").length, 0);
        assert.deepEqual(f.h.session.read(doc => doc?.sections), existing
          ? [{ id: "s1", name: "Opening", firstSceneId: "r2" }] : undefined);
      } finally { f.controls.dispose(); }
    });
  }
}
