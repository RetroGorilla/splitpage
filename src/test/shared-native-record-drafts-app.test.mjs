import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument, sharedRecoverySession, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sidePanels } from "../bootstrap/wiring/ports/panels.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { closeBrollPage, openBrollPage, openBrollPanel, runBrollRefresh } from "../features/broll/panel.ts";
import { armDeleteComment, closeCommentComposer, openCommentsPanel, renderComments, setCommentFilterMode, toggleResolve } from "../features/comments/comments.ts";
import { openGearPanel, openProductionPanel, renderProduction, toggleCardSelection } from "../features/tags/panels.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const source = {
  schema: 2,
  paragraphsDecided: true,
  title: "Record drafts",
  rows: [{ id: "r1", audioText: "One" }, { id: "r2", audioText: "Two" }],
  comments: [{ id: "thread", rowId: "r2", field: "audioText", author: "Editor", body: "Original" }],
  productionTags: [{ cat: "prop", name: "Mug" }, { cat: "prop", name: "Lamp" }, { cat: "gear", name: "Drone" }],
  brollShots: [{ id: "b1", name: "City", origin: "list" }, { id: "b2", name: "Harbour", origin: "list" }]
};
const refused = "This is not available in a shared session yet.";
const find = selector => document.querySelector(selector);
function need(selector) {
  const target = find(selector);
  assert.ok(target, selector);
  return target;
}
const click = selector => need(selector).click();
const shotBox = field => `#broll-panel .broll-${field}-input[data-id="b1"]`;
const shotAction = (action, id = "b1") => `#broll-panel [data-action="broll-${action}"][data-id="${id}"]`;
const tagBox = (field, key = "prop mug", panel = "#production-panel") => `${panel} .tag-${field}-input[data-key="${key}"]`;
const tagAction = (action, key = "prop mug", panel = "#production-panel") => `${panel} [data-action="tag-${action}"][data-key="${key}"]`;
const shot = (doc, id = "b1") => doc.brollShots.find(entry => entry.id === id);
const tag = (doc, name = "Mug") => doc.productionTags.find(entry => entry?.name === name);
const owner = (doc, record) => doc.people.find(person => person.id === record.owner)?.name ?? "";
const warnings = show => show.mock.calls.filter(call => call.arguments[1] === "warn").map(call => call.arguments[0]);
const strip = root => [...document.querySelectorAll(root + " .typed-unsaved-text")].map(box => box.value);
const update = () => Promise.resolve();

function adopt(fields = {}) {
  adoptReplacement(migrateRows(structuredClone({ ...source, ...fields })));
}

async function start() {
  assert.deepEqual(await hook.enter(), { ok: true });
}

async function enter(t, fields = {}) {
  adopt(fields);
  const show = t.mock.method(notices, "show", () => {});
  await start();
  t.after(() => {
    closeBrollPage();
    closeCommentComposer(true);
    setCommentFilterMode("all");
    if (sharedSession()) assert.deepEqual(hook.leave(), { ok: true });
    document.activeElement?.blur();
  });
  return show;
}

function hold(t) {
  const release = sharedRecoverySession().hold("test-hold");
  t.after(release);
  return release;
}

function copies(read, expected) {
  const { app, peer } = hook.read();
  assert.deepEqual(read(app), expected, "local copy");
  assert.deepEqual(read(peer), expected, "peer copy");
}

async function peerRegistry(change) {
  const result = hook.nativePeer.registry(change);
  assert.equal(result.kind, "written", JSON.stringify(result));
  await update();
  return result;
}

const shotStatus = (status, id = "b1") => peerRegistry({ kind: "set", collection: "shots", ids: [id], fields: { status } });
const removeShot = () => peerRegistry({ kind: "remove", collection: "shots", ids: ["b1"] });

function key(target, key) {
  const options = { key, bubbles: true, cancelable: true };
  target.dispatchEvent(new window.KeyboardEvent("keydown", options));
  target.dispatchEvent(new window.KeyboardEvent("keyup", options));
}

function type(selector, value) {
  const input = need(selector);
  input.focus();
  input.value = value;
  input.setSelectionRange(1, Math.min(3, value.length));
  input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  return input;
}

function blur(input) {
  input.focus();
  input.blur();
}

function selectShot(id) {
  need(shotAction("expand", id)).dispatchEvent(new window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
}

function openShot() {
  openBrollPanel();
  if (!find(shotBox("notes"))) click(shotAction("expand"));
}

function filter(value) {
  click(`#broll-panel [data-action="broll-filter"][data-filter="${value}"]`);
}

function toggleShotBulk(kind) {
  const control = need("#broll-bulk-" + kind);
  control.value = "__new__";
  control.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function openTags() {
  openProductionPanel();
  click('#production-modes [data-group="cat"]');
}

function expandTag(key = "prop mug", panel = "#production-panel") {
  if (!find(`${panel} .tag-entity.is-expanded[data-key="${key}"]`)) click(tagAction("expand", key, panel));
}

function openTagPerson(which = "production") {
  if (which === "bulk") {
    openTags();
    for (const card of document.querySelectorAll('#production-list .tag-entity[aria-selected="true"]:not([data-key="prop mug"])')) {
      toggleCardSelection(card.getAttribute("data-key"));
    }
    if (!find('#production-list .tag-entity[data-key="prop mug"][aria-selected="true"]')) toggleCardSelection("prop mug");
    if (!find("#bulk-person-input")) click('[data-action="bulk-person-new"]');
  } else if (which === "gear") {
    openGearPanel();
    expandTag("gear drone", "#gear-panel");
    click(tagAction("person-new", "gear drone", "#gear-panel"));
  } else {
    openTags();
    expandTag();
    click(tagAction("person-new"));
  }
}

const notes = shotBox("notes");

for (const redraw of ["local filter", "peer filter", "different shot"]) {
  test(`a refused B-roll note waits for blur after a ${redraw} redraw`, async t => {
    const show = await enter(t);
    openShot();
    if (redraw === "peer filter") filter("unshot");
    const release = redraw === "different shot" ? sharedRecoverySession().beforeCommand(() => {
      notices.show(refused, "warn");
      return "announced";
    }) : hold(t);
    t.after(release);
    blur(type(notes, "Wide take"));
    assert.deepEqual(warnings(show), [refused]);
    copies(doc => shot(doc).notes, "");

    if (redraw === "local filter") {
      filter("shot");
      assert.equal(find(notes), null);
      filter("all");
    } else if (redraw === "peer filter") {
      await shotStatus("shot");
      assert.equal(find(notes), null);
      await shotStatus("unshot");
    } else {
      await shotStatus("shot", "b2");
    }
    assert.equal(need(notes).value, "Wide take");
    release();
    need(notes).focus();
    runBrollRefresh();
    assert.equal(document.activeElement, need(notes));
    copies(doc => shot(doc).notes, "");
    blur(need(notes));
    await update();
    copies(doc => shot(doc).notes, "Wide take");
    assert.deepEqual(warnings(show), [refused]);
    assert.equal(hook.nativePeer.step("undo").kind, "written");
    assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
  });
}

for (const revised of ["", "Wide shot"]) {
  test(`a refused B-roll note revised to ${JSON.stringify(revised)} waits for blur`, async t => {
    await enter(t);
    openShot();
    const release = hold(t);
    blur(type(notes, "Wide"));
    type(notes, revised);
    release();
    runBrollRefresh();
    assert.equal(need(notes).value, revised);
    assert.equal(need(notes).hasAttribute("data-unsaved"), Boolean(revised));
    copies(doc => shot(doc).notes, "");
    blur(need(notes));
    await update();
    copies(doc => shot(doc).notes, revised);
    assert.deepEqual(window.__brollTest.drafts(), []);
  });
}

for (const announced of [false, true]) {
  test(`a ${announced ? "listener-refused" : "held"} B-roll note survives removal until dismissed`, async t => {
    const show = await enter(t);
    openShot();
    const release = announced ? sharedRecoverySession().beforeCommand(() => { notices.show(refused, "warn"); return "announced"; }) : hold(t);
    const removed = "The shot was removed, so its note was not saved. The text is kept at the top of the b-roll list.";
    try {
      blur(type(notes, "Wide take"));
      assert.deepEqual(warnings(show), [refused]);
      await removeShot();
      assert.equal(find(notes), null);
      assert.deepEqual(strip("#broll-panel"), ["Wide take"]);
      if (announced) {
        runBrollRefresh();
        runBrollRefresh();
        assert.deepEqual([warnings(show), strip("#broll-panel")], [[refused, removed], ["Wide take"]]);
      }
      release();
      runBrollRefresh();
      assert.deepEqual(warnings(show), [refused, removed]);
      copies(doc => shot(doc), undefined);
      click('#broll-panel [data-action="typed-unsaved-dismiss"]');
      runBrollRefresh();
      assert.deepEqual(strip("#broll-panel"), []);
      assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
    } finally { release(); }
  });
}

test("a hidden B-roll note can be dismissed from the page without returning to the panel", async t => {
  await enter(t);
  openShot();
  const release = hold(t);
  blur(type(notes, "Wide take"));
  openBrollPage();
  filter("shot");
  runBrollRefresh();
  assert.deepEqual(strip("#broll-page"), ["Wide take"]);
  click('#broll-page [data-action="typed-unsaved-dismiss"]');
  assert.deepEqual(strip("#broll-page"), []);
  release();
  closeBrollPage();
  filter("all");
  openShot();
  assert.equal(need(notes).value, "");
  assert.deepEqual(strip("#broll-panel"), []);
  copies(doc => shot(doc).notes, "");
});

test("a refused note is cleared on leave and a new native session only saves on blur", async t => {
  await enter(t);
  openShot();
  const release = hold(t);
  blur(type(notes, "Wide take"));
  copies(doc => shot(doc).notes, "");
  release();
  assert.deepEqual(hook.leave(), { ok: true });
  adopt();
  openShot();
  type(notes, "Wide take");
  runBrollRefresh();
  assert.equal(shot(currentDocument()).notes, "Wide take");

  adopt();
  await start();
  openShot();
  const releaseSecond = hold(t);
  blur(type(notes, "Wide take"));
  copies(doc => shot(doc).notes, "");
  releaseSecond();
  assert.deepEqual(hook.leave(), { ok: true });
  adopt();
  await start();
  openShot();
  assert.equal(need(notes).value, "");
  assert.deepEqual(window.__brollTest.drafts(), []);
  type(notes, "Wide take");
  runBrollRefresh();
  runBrollRefresh();
  copies(doc => shot(doc).notes, "");
  blur(need(notes));
  await update();
  copies(doc => shot(doc).notes, "Wide take");
  assert.equal(hook.nativePeer.step("undo").kind, "written");
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});

test("a native prop draft stays in its script when a later script reuses the shot ID", async t => {
  await enter(t);
  openShot();
  blur(type(shotBox("prop"), "Old shared prop"));
  runBrollRefresh();
  assert.equal(need(shotBox("prop")).value, "Old shared prop");
  assert.deepEqual(hook.leave(), { ok: true });
  adopt({ title: "Second script", brollShots: [{ id: "b1", name: "Second shot", origin: "list" }] });
  openShot();
  assert.equal(need(shotBox("prop")).value, "");
  key(need(shotBox("prop")), "Enter");
  assert.deepEqual(shot(currentDocument()).props, []);
});

test("drafts typed before entry are cleared on the native record panels", async t => {
  adopt();
  openTagPerson();
  type(tagBox("person"), "Camera");
  openShot();
  blur(type(shotBox("prop"), "Old standalone prop"));
  await start();
  t.after(() => { if (sharedSession()) assert.deepEqual(hook.leave(), { ok: true }); });
  renderProduction();
  runBrollRefresh();
  assert.equal(find(tagBox("person"))?.value ?? "", "");
  assert.equal(need(shotBox("prop")).value, "");
  openTags();
  expandTag();
  if (!find(tagBox("person"))) click(tagAction("person-new"));
  assert.equal(need(tagBox("person")).value, "");
  copies(doc => [shot(doc).props, doc.people], [[], []]);
});

test("a standalone prop draft stays visible if B-roll is hidden before its first native redraw", async t => {
  adopt();
  openShot();
  blur(type(shotBox("prop"), "Old standalone prop"));
  await start();
  t.after(() => { if (sharedSession()) assert.deepEqual(hook.leave(), { ok: true }); });
  openTags();
  runBrollRefresh();
  openShot();
  assert.equal(need(shotBox("prop")).value, "Old standalone prop");
  copies(doc => shot(doc).props, []);
  key(need(shotBox("prop")), "Escape");
  openShot();
  assert.equal(need(shotBox("prop")).value, "");
  copies(doc => shot(doc).props, []);
});

test("By scene keeps separate person drafts for two occurrences of the same tag", async t => {
  const markup = name => `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="${name}" contenteditable="false">${name}</span>`;
  await enter(t, { rows: [
    { id: "r1", audioText: "One", visualText: markup("Mug") },
    { id: "r2", audioText: "Two", visualText: markup("Mug") + " " + markup("Lamp") }
  ], sections: [{ id: "h1", name: "First", firstSceneId: "r1" }, { id: "h2", name: "Second", firstSceneId: "r2" }] });
  openProductionPanel();
  click('#production-modes [data-group="by-scene"]');
  const scenes = [0, 1].map(index => `#production-panel [data-scene-group=":scene:${index}"]`);
  for (const [index, name] of ["First person", "Second person"].entries()) {
    const scene = scenes[index];
    expandTag("prop mug", scene);
    const box = tagBox("person", "prop mug", scene);
    if (!find(box)) click(tagAction("person-new", "prop mug", scene));
    type(box, name);
  }
  await peerRegistry({ kind: "set", collection: "tags", ids: [tag(currentDocument(), "Lamp").id], fields: { status: "have" } });
  assert.deepEqual(scenes.map(scene => need(tagBox("person", "prop mug", scene)).value), ["First person", "Second person"]);
  copies(doc => doc.people, []);
});

const gear = doc => doc.productionTags.filter(entry => entry?.cat === "gear").map(entry => entry.name).sort();
const gearBox = "#gear-quickadd-input";
const gearSave = "#gear-quickadd-save";

for (const dismiss of [false, true]) {
  test(`hidden Gear text ${dismiss ? "stays dismissed" : "returns"} when the panel reopens`, async t => {
    const show = await enter(t);
    openGearPanel();
    const release = hold(t);
    type(gearBox, "Drone\nWireless lav");
    click(gearSave);
    assert.deepEqual(warnings(show), [refused]);
    sidePanels().close("gear-panel");
    openTags();
    assert.deepEqual(strip("#production-panel"), ["Drone\nWireless lav"]);
    if (dismiss) {
      click('#production-panel [data-action="typed-unsaved-dismiss"][data-box="gear-quickadd-input"]');
      assert.deepEqual(strip("#production-panel"), []);
    }
    release();
    renderProduction();
    copies(gear, ["Drone"]);
    openGearPanel();
    assert.deepEqual(need(gearBox).value, dismiss ? "Drone" : "Drone\nWireless lav");
    if (!dismiss) {
      click(gearSave);
      await update();
      copies(gear, ["Drone", "Wireless lav"]);
    }
  });
}

for (const remove of [false, true]) {
  test(`a refused tag person draft ${remove ? "becomes copyable on tag removal" : "stays visible when another card expands"}`, async t => {
    const show = await enter(t);
    openTagPerson();
    const release = hold(t);
    key(type(tagBox("person"), "Camera"), "Enter");
    assert.deepEqual(warnings(show), [refused]);
    if (remove) {
      await peerRegistry({ kind: "remove", collection: "tags", ids: [tag(currentDocument()).id] });
    } else expandTag("prop lamp");
    assert.deepEqual(strip("#production-panel"), remove ? ["Camera"] : []);
    release();
    renderProduction();
    copies(doc => doc.people, []);
    if (remove) {
      copies(doc => tag(doc), undefined);
      assert.deepEqual(strip("#production-panel"), ["Camera"]);
      assert.equal(need("#production-panel .typed-unsaved-text").readOnly, true);
    } else {
      assert.equal(need(tagBox("person")).value, "Camera");
      assert.deepEqual(strip("#production-panel"), []);
      click(tagAction("person-save"));
      await update();
      copies(doc => owner(doc, tag(doc)), "Camera");
    }
  });
}

const enterKey = input => key(input, "Enter");
const shotPerson = () => { openShot(); click(shotAction("person-new")); };
function openShotBulk(kind) {
  openShot();
  for (const id of window.__brollTest.selected()) if (id !== "b1") selectShot(id);
  if (!window.__brollTest.selected().includes("b1")) selectShot("b1");
  toggleShotBulk(kind);
}
const tagAssignee = doc => owner(doc, tag(doc));
const shotAssignee = doc => owner(doc, shot(doc));
const propNames = doc => shot(doc).props.map(prop => prop.name);
const gearPerson = tagBox("person", "gear drone", "#gear-panel");
const pickProp = input => input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
const pageNote = '#broll-page .broll-page-note[data-id="b1"]';

for (const route of [
  { name: "B-roll bulk new person", open: () => openShotBulk("owner"), box: "#broll-bulk-input", read: shotAssignee, text: "Camera" },
  { name: "B-roll shot person", open: shotPerson, box: shotBox("person"), read: shotAssignee, text: "Camera",
    alternate: shotAction("person-save") },
  { name: "B-roll add shot", open: openBrollPanel, box: "#broll-add-input", text: "Square",
    read: doc => doc.brollShots.filter(entry => entry.name === "Square").map(entry => entry.name), before: [], after: ["Square"] },
  { name: "B-roll prop", open: openShot, box: shotBox("prop"), read: propNames, text: "Lamp", before: [], after: ["Lamp"] },
  { name: "B-roll location", open: () => { openShot(); click(shotAction("loc-edit")); }, box: shotBox("loc"),
    read: doc => shot(doc).location, text: "Dock", alternate: blur },
  { name: "B-roll audio reference", open: () => { openShot(); click(shotAction("ref-edit")); }, box: shotBox("ref"),
    read: doc => shot(doc).audioRef, text: "0:12", submit: blur },
  { name: "B-roll page note", open: openBrollPage, box: pageNote, read: doc => shot(doc).notes, text: "Wide",
    submit: input => { input.focus(); enterKey(input); }, resubmit: blur },
  { name: "production tag person", open: openTagPerson, box: tagBox("person"), read: tagAssignee, text: "Camera",
    alternate: tagAction("person-save") },
  { name: "Gear tag person", open: () => openTagPerson("gear"), box: gearPerson,
    read: doc => owner(doc, tag(doc, "Drone")), text: "Camera" },
  { name: "bulk tag person", open: () => openTagPerson("bulk"), box: "#bulk-person-input", read: tagAssignee, text: "Camera",
    alternate: '[data-action="bulk-person-save"]' },
  { name: "tag notes", open: () => { openTags(); expandTag(); }, box: tagBox("notes"),
    read: doc => tag(doc).notes, text: "Wide", submit: blur, inputSubmits: true },
  { name: "Gear quick add", open: openGearPanel, box: gearBox, text: "Drone\nCrane", submit: gearSave,
    read: gear, before: ["Drone"], after: ["Crane", "Drone"], createsTagOnly: true }
]) {
  const submissions = new Map([["", route.submit ?? enterKey]]);
  if (route.alternate) submissions.set(typeof route.alternate === "string" ? " via Add" : " via blur", route.alternate);
  if (route.name === "B-roll prop") submissions.set(" via a suggestion", pickProp);

  for (const [method, action] of submissions) {
    test(`a refused ${route.name} draft${method} waits for explicit resubmission`, async t => {
      const show = await enter(t);
      route.open();
      const release = hold(t);
      const submit = (via = action) => typeof via === "string" ? click(via) : via(need(route.box));
      type(route.box, route.text);
      if (!route.inputSubmits) submit();
      const expectedBefore = route.before ?? "";
      assert.deepEqual(warnings(show), [refused]);
      assert.equal(need(route.box).value, route.text);
      copies(route.read, expectedBefore);
      await shotStatus("shot", "b2");
      release();
      runBrollRefresh();
      renderProduction();
      assert.equal(need(route.box).value, route.text);
      copies(route.read, expectedBefore);
      assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
      submit(route.resubmit);
      await update();
      copies(route.read, route.after ?? route.text);
      assert.deepEqual(warnings(show), [refused]);
      assert.equal(hook.nativePeer.step("undo").kind, route.createsTagOnly ? "unchanged" : "written");
      if (route.createsTagOnly) copies(route.read, route.after);
      assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
    });
  }
}

test("tag notes follow the record ID through a peer rename and reuse of the original name", async t => {
  await enter(t);
  openTags();
  expandTag();
  const release = hold(t);
  blur(type(tagBox("notes"), "For the original mug"));
  const id = tag(currentDocument()).id;
  await peerRegistry({ kind: "set", collection: "tags", ids: [id], fields: { name: "Cup" } });
  const replacement = await peerRegistry({ kind: "create", collection: "tags", fields: { cat: "prop", name: "Mug" } });
  expandTag();
  assert.equal(need(tagBox("notes")).value, "");
  expandTag("prop cup");
  const cup = need(tagBox("notes", "prop cup"));
  assert.equal(cup.value, "For the original mug");
  assert.equal(cup.getAttribute("data-registry-id"), id);
  release();
  renderProduction();
  copies(doc => [tag(doc, "Cup").notes, tag(doc).notes], ["", ""]);
  blur(need(tagBox("notes", "prop cup")));
  await update();
  copies(doc => [tag(doc, "Cup").id, tag(doc, "Cup").notes, tag(doc).id, tag(doc).notes],
    [id, "For the original mug", replacement.created, ""]);
});

test("an inline-tag rename refusal preserves the draft and selection through redraw", async t => {
  const visualText = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">Mug</span>';
  const show = await enter(t, { rows: [{ id: "r1", audioText: "One", visualText }] });
  openTags();
  expandTag();
  click(tagAction("rename"));
  type(tagBox("rename"), "Cup");
  click(tagAction("rename-save"));
  assert.deepEqual(warnings(show), [refused]);
  for (const redraw of [() => {}, renderProduction]) {
    redraw();
    const current = need(tagBox("rename"));
    assert.equal(document.activeElement, current);
    assert.deepEqual([current.value, current.selectionStart, current.selectionEnd], ["Cup", 1, 3]);
  }
  copies(doc => [tag(doc).name, doc.rows[0].visualText], ["Mug", visualText]);
  key(need(tagBox("rename")), "Escape");
  assert.equal(find(tagBox("rename")), null);
});

test("a refused tag rename stays with its card and can be submitted after release", async t => {
  await enter(t);
  openTags();
  expandTag();
  click(tagAction("rename"));
  const release = hold(t);
  type(tagBox("rename"), "Cup");
  click(tagAction("rename-save"));
  expandTag("prop lamp");
  assert.deepEqual(strip("#production-panel"), []);
  release();
  renderProduction();
  copies(doc => tag(doc).name, "Mug");
  expandTag();
  assert.equal(need(tagBox("rename")).value, "Cup");
  key(need(tagBox("rename")), "Enter");
  await update();
  copies(doc => [tag(doc, "Cup").name, tag(doc)], ["Cup", undefined]);
});

for (const held of [false, true]) {
  test(`${held ? "a held" : "an unsupported"} script-linked shot rename stays open until Escape`, async t => {
    const visualText = '<span class="broll-key" data-broll-id="b1" contenteditable="false">B-roll:</span> City';
    const show = await enter(t, { rows: [{ id: "r1", audioText: "One", visualText }],
      brollShots: [{ id: "b1", name: "City", origin: "script" }] });
    openShot();
    click(shotAction("menu"));
    click(shotAction("rename"));
    const release = held ? hold(t) : () => {};
    key(type(shotBox("rename"), "New angle"), "Enter");
    assert.deepEqual(warnings(show), [refused]);
    runBrollRefresh();
    assert.equal(need(shotBox("rename")).value, "New angle");
    release();
    runBrollRefresh();
    assert.equal(need(shotBox("rename")).value, "New angle");
    assert.deepEqual(warnings(show), [refused]);
    copies(doc => [shot(doc).name, doc.rows[0].visualText], ["City", visualText]);
    key(need(shotBox("rename")), "Escape");
    runBrollRefresh();
    assert.equal(find(shotBox("rename")), null);
    assert.deepEqual(window.__brollTest.drafts(), []);
  });
}

for (const panel of ["tag", "B-roll"]) {
  test(`a ${panel} bulk draft writes to the current selection only on resubmit`, async t => {
    await enter(t);
    const isTag = panel === "tag", selector = isTag ? "#bulk-person-input" : "#broll-bulk-input";
    if (isTag) openTagPerson("bulk");
    else openShotBulk("location");
    const release = hold(t);
    const text = isTag ? "Camera" : "Dock";
    key(type(selector, text), "Enter");
    if (isTag) {
      toggleCardSelection("prop mug");
      toggleCardSelection("prop lamp");
    } else {
      selectShot("b1");
      selectShot("b2");
    }
    release();
    const read = doc => isTag ? [owner(doc, tag(doc)), owner(doc, tag(doc, "Lamp"))] : [shot(doc).location, shot(doc, "b2").location];
    if (isTag) renderProduction(); else runBrollRefresh();
    copies(read, ["", ""]);
    copies(doc => [doc.people, shot(doc).location, shot(doc, "b2").location], [[], "", ""]);
    assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
    if (!find(selector)) {
      assert.deepEqual(strip(isTag ? "#production-panel" : "#broll-panel"), [text]);
      if (isTag) click('[data-action="bulk-person-new"]'); else toggleShotBulk("location");
    }
    assert.equal(need(selector).value, text);
    key(need(selector), "Enter");
    await update();
    copies(read, ["", text]);
    if (isTag) copies(doc => tag(doc).owner, "");
    assert.equal(hook.nativePeer.step("undo").kind, "written");
    assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
  });
}

const replyBody = '.reply-composer[data-for="thread"] .cell-editable';
const replyPost = '[data-action="reply-post"][data-id="thread"]';
const commentBody = "#comment-body-editable";

function openReply() {
  if (!find(replyBody)) click('[data-action="toggle-reply"][data-id="thread"]');
}

function typeBody(selector, text) {
  const box = need(selector);
  box.textContent = text;
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

for (const reply of [false, true]) {
  test(`a refused ${reply ? "reply" : "new comment"} stays open during a delete-confirm redraw`, async t => {
    const show = await enter(t);
    openCommentsPanel();
    const selector = reply ? replyBody : commentBody;
    const post = reply ? replyPost : "#comment-post";
    if (reply) openReply();
    else {
      const narration = need('#rows .cell-editable[data-id="r2"][data-field="audioText"]');
      narration.focus();
      setCellSelection(narration, 0, 3);
      narration.closest(".field-wrap").querySelector('[data-cmd="comment"]').click();
    }
    typeBody(selector, "First version");
    const release = hold(t);
    click(post);
    assert.deepEqual(warnings(show), [refused]);
    typeBody(selector, "Revised version");
    release();
    armDeleteComment(document.createElement("button"), "thread");
    renderComments();
    assert.equal(need(selector).textContent, "Revised version");
    const threads = doc => doc.comments.map(entry => [entry.id === "thread", entry.body, entry.replies.map(response => response.body)]);
    copies(threads, [[true, "Original", []]]);
    const posted = reply ? [[true, "Original", ["Revised version"]]] : [[true, "Original", []], [false, "Revised version", []]];
    click(post);
    await update();
    copies(threads, posted);
    renderComments();
    copies(threads, posted);
    assert.equal(hook.nativePeer.step("undo").kind, "written");
    assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
  });
}

for (const remove of [false, true]) {
  test(`a ${remove ? "peer-removed" : "filtered"} thread keeps its refused reply copyable until dismissal`, async t => {
    const show = await enter(t);
    openCommentsPanel();
    openReply();
    typeBody(replyBody, "Unposted reply");
    const release = hold(t);
    click(replyPost);
    assert.deepEqual(warnings(show), [refused]);
    if (remove) {
      assert.equal(hook.nativePeer.removeComment("thread").kind, "written");
      await update();
    } else setCommentFilterMode("resolved");
    assert.deepEqual(strip("#comments-list"), ["Unposted reply"]);
    release();
    renderComments();
    assert.equal(warnings(show).length, remove ? 2 : 1);
    if (remove) assert.match(warnings(show)[1], /comment was removed.*reply was not saved/);
    click('#comments-list [data-action="typed-unsaved-dismiss"]');
    assert.deepEqual(strip("#comments-list"), []);
    setCommentFilterMode("all");
    if (!remove) {
      openReply();
      assert.equal(need(replyBody).textContent, "");
    }
    assert.deepEqual(strip("#comments-list"), []);
    copies(doc => doc.comments.map(entry => entry.replies), remove ? [] : [[]]);
  });
}

test("a held comment delete keeps its open menu so it can be tried again", async t => {
  const show = await enter(t);
  openCommentsPanel();
  const menu = '[data-action="comment-menu"][data-id="thread"]';
  const remove = '[data-action="delete-comment"][data-id="thread"]';
  click(menu);
  click(remove);
  const release = hold(t);
  const before = hook.read();
  click(remove);
  renderComments();
  assert.equal(need(menu).getAttribute("aria-expanded"), "true");
  assert.deepEqual(hook.read(), before);
  assert.deepEqual(warnings(show), [refused]);
  release();
  click(remove);
  click(remove);
  await update();
  copies(doc => doc.comments.map(comment => comment.id), []);
});

test("a held comment resolve warns once without writing", async t => {
  const show = await enter(t);
  openCommentsPanel();
  const before = hook.read();
  const release = hold(t);
  toggleResolve("thread");
  renderComments();
  assert.deepEqual(hook.read(), before);
  assert.deepEqual(warnings(show), [refused]);
  release();
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});

test("B-roll bulk Mark filmed keeps the selected shot on refusal and saves on retry", async t => {
  const show = await enter(t);
  openShot();
  const selected = window.__brollTest.selected();
  for (const id of selected) if (id !== "b1") selectShot(id);
  if (!selected.includes("b1")) selectShot("b1");
  const button = '#broll-panel [data-action="broll-bulk-shot"]';
  assert.deepEqual(window.__brollTest.selected(), ["b1"]);
  const release = hold(t);
  const before = hook.read();
  click(button);
  runBrollRefresh();
  assert.deepEqual(window.__brollTest.selected(), ["b1"]);
  assert.deepEqual(hook.read(), before);
  assert.deepEqual(warnings(show), [refused]);
  release();
  click(button);
  await update();
  copies(doc => doc.brollShots.map(shot => shot.status), ["shot", "unshot"]);
  assert.equal(hook.nativePeer.step("undo").kind, "written");
  assert.equal(hook.nativePeer.step("undo").kind, "unchanged");
});
