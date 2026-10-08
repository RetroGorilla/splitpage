import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { render } = await import("../js/05-render.js");
const { applyTag, findOrAddPerson, openTagComposer, renameTag } = await import("../js/07-production-tags.js");
const { plainTagPhrase } = await import("../js/07b-plain-tags.js");
const { addBrollProp } = await import("../js/08c-broll.js");
const { closeBrollPanel, openBrollPanel } = await import("../js/08d-broll-panel.js");
const { COMMENT_NAME_KEY, setCommentAssignee } = await import("../js/10-comments.js");
const { PERSON_COLOR_KEY, writePref } = await import("../js/00p-prefs.js");
const { recordMyColor } = await import("../js/13a-presence.js");
const { maybeAskGuestName } = await import("../js/13b-collaborate.js");
const { PERSON_COLORS } = await import("../core/document/person-colors.ts");

after(closeApp);

const GRIN = String.fromCodePoint(0x1F600);
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const x = (n) => "x".repeat(n);
const ACROSS = { typed: (cap) => x(cap - 1) + GRIN + " tail", kept: (cap) => x(cap - 1) + GRIN };
const AFTER_SPACE = { typed: (cap) => x(cap - 1) + " y", kept: (cap) => x(cap - 1) };
const CASES = [["an emoji across the cap", ACROSS], ["a cut that lands after a space", AFTER_SPACE]];

function load(extra) {
  S.state = migrateRows(Object.assign({
    schema: 2, title: "Names",
    rows: [
      { id: "r1", status: "todo", audioText: "the mug and the mug", visualText: '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> Old shot' },
      { id: "r2", status: "todo", audioText: "", visualText: "" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "mug", author: "Ann", body: "x", createdAt: "2026-10-01T10:00:00Z", kind: "anchor", replies: [] }],
    people: [],
    productionTags: [{ cat: "prop", name: "Kettle" }],
    brollShots: [
      { id: "bs1", name: "Old shot", origin: "script" },
      { id: "bs2", name: "Listed shot", origin: "list" }
    ]
  }, extra || {}));
  render();
}

function panel() { return document.getElementById("broll-panel"); }
function click(sel) {
  const el = panel().querySelector(sel);
  assert.ok(el, "no " + sel);
  el.click();
}
function expand(id) {
  if (!panel().querySelector('.broll-card[data-id="' + id + '"]')) click('.broll-row-main[data-id="' + id + '"]');
  assert.ok(panel().querySelector('.broll-card[data-id="' + id + '"]'), id + " is open");
}
function enter(el) { el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); }
function shot(id) { return S.state.brollShots.filter((b) => b.id === id)[0]; }

for (const [what, c] of CASES) {
  test("07 findOrAddPerson: " + what + " (#344, #419)", () => {
    load();
    const id = findOrAddPerson(c.typed(60));
    assert.equal(S.state.people.filter((p) => p.id === id)[0].name, c.kept(60));
  });

  test("07 renameTag: " + what + " (#344, #419)", () => {
    load();
    assert.ok(renameTag("prop", "Kettle", c.typed(80)));
    assert.deepEqual(S.state.productionTags.map((t) => t.name), [c.kept(80)]);
  });

  test("07 applyTag, the tag composer's name: " + what + " (#344, #419)", () => {
    load();
    openTagComposer({ quotedText: "mug", cat: "prop", rowId: "r1", field: "audioText", occurrenceIndex: 0 });
    document.getElementById("tag-name").value = c.typed(80);
    document.getElementById("tag-all").checked = true;
    applyTag();
    assert.ok(S.state.productionTags.some((t) => t.name === c.kept(80)), JSON.stringify(S.state.productionTags.map((t) => t.name)));
    assert.equal(S.state.rows[0].audioText.split('data-tag-name="' + c.kept(80) + '"').length, 3);
  });

  test("07b plainTagPhrase: " + what + " (#344, #419)", () => {
    assert.equal(plainTagPhrase(" " + c.typed(80)).name, c.kept(80));
  });

  test("08c addBrollProp: " + what + " (#344, #419)", () => {
    load();
    assert.ok(addBrollProp("bs2", c.typed(80)));
    assert.deepEqual(shot("bs2").props.map((p) => p.name), [c.kept(80)]);
    assert.ok(S.state.productionTags.some((t) => t.cat === "prop" && t.name === c.kept(80)));
  });

  test("08d the b-roll panel's new shot: " + what + " (#344, #419)", () => {
    load();
    openBrollPanel();
    document.getElementById("broll-add-input").value = c.typed(200);
    document.getElementById("broll-add-save").click();
    assert.ok(S.state.brollShots.some((b) => b.origin === "list" && b.name === c.kept(200)), JSON.stringify(S.state.brollShots.map((b) => b.name)));
    closeBrollPanel();
  });

  test("08d a shot's location: " + what + " (#344, #419)", () => {
    load();
    openBrollPanel();
    expand("bs2");
    click('[data-action="broll-loc-edit"][data-id="bs2"]');
    const box = panel().querySelector('.broll-loc-input[data-id="bs2"]');
    box.value = c.typed(80);
    enter(box);
    assert.equal(shot("bs2").location, c.kept(80));
    closeBrollPanel();
  });

  test("08d the selected shots' location: " + what + " (#344, #419)", () => {
    load();
    openBrollPanel();
    if (!panel().querySelector("#broll-bulk-location")) {
      panel().querySelector('.broll-row-main[data-id="bs2"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    }
    const pick = panel().querySelector("#broll-bulk-location");
    assert.ok(pick, "the bulk bar shows");
    pick.value = "__new__";
    pick.dispatchEvent(new window.Event("change", { bubbles: true }));
    document.getElementById("broll-bulk-input").value = c.typed(80);
    click('[data-action="broll-bulk-input-save"]');
    assert.equal(shot("bs2").location, c.kept(80));
    click('[data-action="broll-bulk-clear"]');
    closeBrollPanel();
  });

  test("08d renaming a script shot: " + what + " (#344, #419)", () => {
    load();
    openBrollPanel();
    expand("bs1");
    click('[data-action="broll-menu"][data-id="bs1"]');
    click('[data-action="broll-rename"][data-id="bs1"]');
    panel().querySelector('.broll-rename-input[data-id="bs1"]').value = c.typed(200);
    click('[data-action="broll-rename-save"][data-id="bs1"]');
    const text = new window.DOMParser().parseFromString(S.state.rows[0].visualText, "text/html").body.textContent;
    assert.equal(text, "B-roll: " + c.kept(200));
    closeBrollPanel();
  });

  test("10 setCommentAssignee: " + what + " (#344, #419)", () => {
    load();
    setCommentAssignee("c1", c.typed(80));
    assert.equal(S.state.comments[0].assignee, c.kept(80));
  });

  test("13b the guest's name: " + what + " (#344, #419)", () => {
    load();
    writePref(COMMENT_NAME_KEY, null);
    sessionStorage.clear();
    assert.ok(maybeAskGuestName());
    document.getElementById("guest-name").value = c.typed(80);
    document.querySelector('#guest-modal [data-guest-action="save"]').click();
    assert.equal(localStorage.getItem(COMMENT_NAME_KEY), c.kept(80));
  });
}

test("13a my colour is recorded under my name cut by code point (#344)", () => {
  load();
  writePref(COMMENT_NAME_KEY, x(79) + GRIN + "y");
  writePref(PERSON_COLOR_KEY, PERSON_COLORS[1]);
  const state = { personColors: null };
  assert.ok(recordMyColor(state));
  assert.deepEqual(state.personColors, { [x(79) + GRIN]: PERSON_COLORS[1] });
});

test("07 the tag composer offers the selected words cut by code point (#344)", () => {
  load();
  openTagComposer({ quotedText: x(79) + GRIN + "y", cat: "prop", rowId: "r1", field: "audioText", occurrenceIndex: 0 });
  const value = document.getElementById("tag-name").value;
  assert.equal(value, x(79) + GRIN);
  assert.ok(!LONE.test(value));
});
