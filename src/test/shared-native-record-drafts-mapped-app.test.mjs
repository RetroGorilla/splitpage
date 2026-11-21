import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { fromHtml, sanitizeHtml } from "../bootstrap/richtext.ts";
import { adoptReplacement, currentCapabilities, currentDocument, sharedRecoverySession, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { openingStatus } from "../bootstrap/wiring/ports/transitions.ts";
import { closeBrollPage, openBrollPage, openBrollPanel, runBrollRefresh } from "../features/broll/panel.ts";
import { openCommentsPanel, renderComments } from "../features/comments/comments.ts";
import { openProductionPanel, renderProduction } from "../features/tags/panels.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const visualText = '<span class="broll-key" data-broll-id="script-shot" contenteditable="false">B-roll:</span> Pier';
const source = {
  schema: 2, title: "Record drafts", paragraphsDecided: true,
  rows: [{ id: "r1", audioText: "First", visualText }, { id: "r2", audioText: "Second" }],
  comments: [{ id: "thread", rowId: "r2", field: "audioText", author: "Editor", body: "Original" }],
  productionTags: [{ id: "t_original", cat: "prop", name: "Mug" }, { id: "t_lamp", cat: "prop", name: "Lamp" }],
  brollShots: [
    { id: "b1", name: "City", origin: "list", status: "unshot" },
    { id: "b2", name: "Harbour", origin: "list", status: "unshot" },
    { id: "script-shot", name: "Pier", origin: "script", status: "unshot" }
  ]
};
const orders = ["local-first", "peer-first"];
const refused = "This is not available in a shared session yet.";
const shotRemoved = "The shot was removed, so its note was not saved. The text is kept at the top of the b-roll list.";
const threadRemoved = "The comment was removed, so your reply was not saved. The text is kept at the top of the comments list.";
const find = selector => document.querySelector(selector);
function need(selector) {
  const target = find(selector);
  assert.ok(target, selector);
  return target;
}
const click = selector => need(selector).click();
const strip = root => [...document.querySelectorAll(root + " .typed-unsaved-text")].map(box => box.value);
const dismiss = root => click(root + ' [data-action="typed-unsaved-dismiss"]');
const shotAction = (action, id) => `#broll-panel [data-action="broll-${action}"][data-id="${id}"]`;
const notes = '#broll-panel .broll-notes-input[data-id="b1"]';
const shot = (doc, id = "b1") => doc.brollShots.find(record => record.id === id);
const tag = (doc, id = "t_original") => doc.productionTags.find(record => record.id === id);
const tagAction = (action, key) => `#production-panel [data-action="tag-${action}"][data-key="${key}"]`;
const tagInput = (field, key) => `#production-panel .tag-${field}-input[data-key="${key}"]`;
const warnings = show => show.mock.calls.filter(call => call.arguments[1] === "warn").map(call => call.arguments[0]);
const commands = () => sharedRecoverySession();

async function enter(t) {
  adoptReplacement(migrateRows(structuredClone(source)));
  const show = t.mock.method(notices, "show", () => {});
  const standalone = currentCapabilities(), errors = [];
  const ports = {
    opening: openingStatus, commandRefused: sharedCommandRefusalNotice(notices),
    refusal: () => null, settle: () => {}, detach: () => {},
    bindings: { enter: () => {}, settle: () => null, leave: () => {} },
    common: { edit: standalone.edit, comment: standalone.edit }, standalone, migrate: migrateRows,
    docId: () => "d" + "1".repeat(32), editor: () => "Editor", structure: { cells: fromHtml },
    report: error => errors.push(error), timers: { now: Date.now, start: setTimeout, stop: clearTimeout }, now: Date.now
  };
  let local;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    local = opened.native;
    return opened.backend;
  }), { ok: true });
  const peer = openNativeSession({ kind: "state", state: local.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml });
  t.after(() => {
    peer.close();
    closeBrollPage();
    if (sharedSession()) assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    document.activeElement?.blur();
    assert.deepEqual(errors, []);
  });
  return { local, peer, show };
}

async function exchange({ local, peer }, order) {
  const localBytes = local.encodeState(), peerBytes = peer.encodeState();
  const toLocal = () => assert.equal(applyNativePeerUpdate(local, peerBytes), true);
  const toPeer = () => assert.equal(applyNativePeerUpdate(peer, localBytes), true);
  if (order === "local-first") { toPeer(); toLocal(); }
  else { toLocal(); toPeer(); }
  await Promise.resolve();
}

function copies({ local, peer }, read, expected) {
  assert.deepEqual(read(currentDocument()), expected, "app projection");
  assert.deepEqual(read(local.document()), expected, "local replica");
  assert.deepEqual(read(peer.document()), expected, "peer replica");
}

function hold(t) {
  const release = commands().hold("test-hold");
  t.after(release);
  return release;
}

function announceRefusal(t, redraw) {
  const release = commands().beforeCommand(() => {
    redraw?.();
    notices.show(refused, "warn");
    return "announced";
  });
  t.after(release);
  return release;
}

function type(selector, value) {
  const box = need(selector);
  box.focus();
  box.value = value;
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  return box;
}

function key(target, key) {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true }));
}

function blur(input) {
  input.focus();
  input.blur();
}

function openShot(id = "b1") {
  openBrollPanel();
  if (!find(`#broll-panel .broll-notes-input[data-id="${id}"]`)) click(shotAction("expand", id));
}

function filter(value) {
  click(`#broll-panel [data-action="broll-filter"][data-filter="${value}"]`);
}

function changeShot(f, id, status) {
  assert.equal(f.peer.commands.changeRegistry({ kind: "set", collection: "shots", ids: [id], fields: { status } }).kind, "written");
}

const readNote = doc => shot(doc).notes;

for (const redraw of ["local filter", "peer filter", "another shot"]) for (const order of orders) {
  const change = redraw === "another shot" ? "changes to another shot" : `${redraw} changes`;
  test(`a held B-roll note survives ${change} and saves once on blur, ${order}`, async t => {
    const f = await enter(t);
    openShot();
    filter(redraw === "peer filter" ? "unshot" : "all");
    const release = hold(t);
    blur(type(notes, "Wide"));
    assert.deepEqual(warnings(f.show), [refused]);
    copies(f, readNote, "");

    async function showShot(visible) {
      if (redraw === "local filter") filter(visible ? "all" : "shot");
      else {
        const id = redraw === "peer filter" ? "b1" : "b2", status = visible ? "unshot" : "shot";
        changeShot(f, id, status);
        await exchange(f, order);
        copies(f, doc => shot(doc, id).status, status);
      }
      runBrollRefresh();
      if (!visible && redraw !== "another shot") assert.equal(find(notes), null);
      else assert.equal(need(notes).value, "Wide");
      copies(f, readNote, "");
      assert.deepEqual(warnings(f.show), [refused]);
    }

    await showShot(false);
    if (redraw !== "another shot") {
      await showShot(true);
      await showShot(false);
    }
    release();
    runBrollRefresh();
    copies(f, readNote, "");
    assert.equal(f.local.commands.undo().kind, "unchanged");
    if (redraw !== "another shot") {
      assert.equal(find(notes), null);
      await showShot(true);
    }
    assert.equal(need(notes).value, "Wide");
    const revision = f.local.revision();
    blur(need(notes));
    await exchange(f, order);
    copies(f, readNote, "Wide");
    assert.equal(f.local.revision() - revision, 1);
    assert.deepEqual(warnings(f.show), [refused]);
    assert.deepEqual(window.__brollTest.drafts(), []);
    assert.equal(f.local.commands.undo().kind, "written");
    assert.equal(f.local.commands.undo().kind, "unchanged");
  });
}

for (const revised of ["", "Wide shot"]) {
  test(`revising a held shot note to ${JSON.stringify(revised)} writes only on blur if changed`, async t => {
    const f = await enter(t);
    openShot();
    filter("all");
    const release = hold(t);
    blur(type(notes, "Wide"));
    type(notes, revised);
    release();
    runBrollRefresh();
    assert.equal(need(notes).value, revised);
    assert.equal(need(notes).hasAttribute("data-unsaved"), Boolean(revised));
    assert.equal(window.__brollTest.drafts().length, revised ? 1 : 0);
    copies(f, readNote, "");
    assert.equal(f.local.commands.undo().kind, "unchanged");
    const revision = f.local.revision();
    blur(need(notes));
    await exchange(f, "local-first");
    copies(f, readNote, revised);
    assert.equal(f.local.revision() - revision, revised ? 1 : 0);
    assert.deepEqual(window.__brollTest.drafts(), []);
    if (revised) assert.equal(f.local.commands.undo().kind, "written");
    assert.equal(f.local.commands.undo().kind, "unchanged");
  });
}

function openTags() {
  openProductionPanel();
  click('#production-modes [data-group="cat"]');
}

function expandTag(key) {
  if (!find(`#production-panel .tag-entity.is-expanded[data-key="${key}"]`)) click(tagAction("expand", key));
}

for (const field of ["person", "rename"]) {
  test(`a waiting tag ${field} editor stays on its card when another card expands`, async t => {
    const f = await enter(t);
    openTags();
    expandTag("prop mug");
    click(tagAction(field === "person" ? "person-new" : "rename", "prop mug"));
    const selector = tagInput(field, "prop mug"), text = field === "person" ? "Camera" : "Cup";
    const release = field === "person" ? hold(t) : announceRefusal(t, renderProduction);
    key(type(selector, text), "Enter");
    assert.deepEqual(warnings(f.show), [refused]);
    assert.equal(need(selector).value, text);
    expandTag("prop lamp");
    assert.ok(find('#production-panel .tag-entity.is-expanded[data-key="prop lamp"]'));
    assert.equal(need(selector).value, text);
    assert.deepEqual(strip("#production-panel"), []);
    release();
    renderProduction();
    assert.equal(need(selector).value, text);
    assert.equal(need(selector).hasAttribute("data-unsaved"), true);
    assert.deepEqual(strip("#production-panel"), []);
    copies(f, doc => [tag(doc).name, tag(doc).owner, doc.people], ["Mug", "", []]);
    assert.deepEqual(warnings(f.show), [refused]);
    assert.equal(f.local.commands.undo().kind, "unchanged");
  });
}

test("held tag notes stay on the renamed card when a different tag reuses the name", async t => {
  const f = await enter(t);
  openTags();
  expandTag("prop mug");
  const release = hold(t);
  type(tagInput("notes", "prop mug"), "For the original");
  assert.equal(f.peer.commands.changeRegistry({ kind: "set", collection: "tags", ids: ["t_original"], fields: { name: "Cup" } }).kind, "written");
  await exchange(f, "peer-first");
  const replacement = f.peer.commands.changeRegistry({ kind: "create", collection: "tags", fields: { cat: "prop", name: "Mug" } });
  assert.equal(replacement.kind, "written");
  assert.ok(replacement.created);
  await exchange(f, "peer-first");
  renderProduction();
  const cup = tagInput("notes", "prop cup");
  assert.equal(need(cup).value, "For the original");
  assert.equal(need(cup).getAttribute("data-registry-id"), "t_original");
  assert.deepEqual(strip("#production-panel"), []);
  expandTag("prop mug");
  assert.equal(need(tagInput("notes", "prop mug")).value, "");
  assert.equal(need(cup).value, "For the original");
  release();
  renderProduction();
  const read = doc => ["t_original", replacement.created, "t_lamp"].map(id => {
    const record = tag(doc, id);
    return [record.name, record.notes];
  });
  copies(f, read, [["Cup", ""], ["Mug", ""], ["Lamp", ""]]);
  assert.equal(need(cup).defaultValue, "");
  assert.equal(f.local.commands.undo().kind, "unchanged");
  const revision = f.local.revision();
  blur(need(cup));
  await exchange(f, "peer-first");
  copies(f, read, [["Cup", "For the original"], ["Mug", ""], ["Lamp", ""]]);
  assert.equal(f.local.revision() - revision, 1);
  assert.equal(f.local.commands.undo().kind, "written");
  assert.equal(f.local.commands.undo().kind, "unchanged");
});

for (const order of orders) {
  test(`a listener-refused shot note keeps focus on redraw and saves on the next blur, ${order}`, async t => {
    const f = await enter(t);
    openShot();
    filter("all");
    const release = announceRefusal(t);
    blur(type(notes, "Wide"));
    assert.deepEqual(warnings(f.show), [refused]);
    copies(f, readNote, "");
    release();
    runBrollRefresh();
    assert.equal(need(notes).value, "Wide");
    copies(f, readNote, "");
    assert.deepEqual(warnings(f.show), [refused]);
    need(notes).focus();
    runBrollRefresh();
    assert.equal(document.activeElement, need(notes));
    assert.equal(need(notes).value, "Wide");
    copies(f, readNote, "");
    assert.equal(f.local.commands.undo().kind, "unchanged");
    const revision = f.local.revision();
    blur(need(notes));
    await exchange(f, order);
    copies(f, readNote, "Wide");
    assert.equal(f.local.revision() - revision, 1);
    assert.deepEqual(warnings(f.show), [refused]);
    assert.deepEqual(window.__brollTest.drafts(), []);
    assert.equal(f.local.commands.undo().kind, "written");
    assert.equal(f.local.commands.undo().kind, "unchanged");
  });
}

test("dismissing a hidden shot note clears it from both B-roll views", async t => {
  const f = await enter(t);
  openShot();
  filter("all");
  const release = hold(t);
  blur(type(notes, "Wide"));
  openBrollPage();
  filter("shot");
  runBrollRefresh();
  assert.deepEqual(strip("#broll-page"), ["Wide"]);
  dismiss("#broll-page");
  assert.deepEqual(strip("#broll-page"), []);
  release();
  closeBrollPage();
  filter("all");
  openShot();
  runBrollRefresh();
  assert.equal(need(notes).value, "");
  assert.deepEqual(window.__brollTest.drafts(), []);
  assert.deepEqual(strip("#broll-panel"), []);
  copies(f, readNote, "");
  assert.equal(f.local.commands.undo().kind, "unchanged");
});

for (const order of orders) {
  test(`a peer-removed shot leaves a held note copyable with one removal warning, ${order}`, async t => {
    const f = await enter(t);
    openShot();
    filter("all");
    const release = hold(t);
    blur(type(notes, "Wide"));
    assert.deepEqual(warnings(f.show), [refused]);
    assert.equal(f.peer.commands.changeRegistry({ kind: "remove", collection: "shots", ids: ["b1"] }).kind, "written");
    await exchange(f, order);
    runBrollRefresh();
    assert.equal(find(notes), null);
    assert.deepEqual(strip("#broll-panel"), ["Wide"]);
    assert.deepEqual(warnings(f.show), [refused, shotRemoved]);
    release();
    runBrollRefresh();
    await exchange(f, order);
    assert.deepEqual(strip("#broll-panel"), ["Wide"]);
    assert.deepEqual(warnings(f.show), [refused, shotRemoved]);
    assert.deepEqual(window.__brollTest.drafts(), []);
    copies(f, doc => doc.brollShots.map(record => record.id), ["b2", "script-shot"]);
    assert.equal(f.local.commands.undo().kind, "unchanged");
    dismiss("#broll-panel");
    assert.deepEqual(strip("#broll-panel"), []);
  });
}

for (const held of [false, true]) {
  const admission = held ? " with admission held" : "";
  test(`clicking Save on an unsupported script-shot rename${admission} keeps the draft until Escape`, async t => {
    const f = await enter(t);
    openShot("script-shot");
    filter("all");
    click(shotAction("menu", "script-shot"));
    click(shotAction("rename", "script-shot"));
    const selector = '#broll-panel .broll-rename-input[data-id="script-shot"]';
    const release = held ? hold(t) : () => {};
    type(selector, "Jetty");
    click(shotAction("rename-save", "script-shot"));
    for (const redraw of [() => {}, runBrollRefresh, () => { release(); runBrollRefresh(); }]) {
      redraw();
      assert.deepEqual(warnings(f.show), [refused]);
      assert.equal(need(selector).value, "Jetty");
      copies(f, doc => [shot(doc, "script-shot").name, doc.rows[0].visualText], ["Pier", visualText]);
      assert.equal(f.local.commands.undo().kind, "unchanged");
    }
    key(need(selector), "Escape");
    runBrollRefresh();
    assert.equal(find(selector), null);
    assert.deepEqual(window.__brollTest.drafts(), []);
  });
}

for (const order of orders) {
  test(`a peer-removed comment leaves a held reply copyable with one removal warning, ${order}`, async t => {
    const f = await enter(t);
    openCommentsPanel();
    click('[data-action="toggle-reply"][data-id="thread"]');
    const body = need('.reply-composer[data-for="thread"] .cell-editable');
    body.textContent = "Unposted reply";
    body.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    const release = hold(t);
    click('[data-action="reply-post"][data-id="thread"]');
    assert.deepEqual(warnings(f.show), [refused]);
    copies(f, doc => doc.comments[0].replies, []);
    assert.equal(f.peer.commands.removeComment({ comment: "thread" }).kind, "written");
    await exchange(f, order);
    renderComments();
    assert.deepEqual(strip("#comments-list"), ["Unposted reply"]);
    assert.deepEqual(warnings(f.show), [refused, threadRemoved]);
    release();
    renderComments();
    await exchange(f, order);
    assert.deepEqual(strip("#comments-list"), ["Unposted reply"]);
    assert.deepEqual(warnings(f.show), [refused, threadRemoved]);
    copies(f, doc => doc.comments, []);
    assert.equal(f.local.commands.undo().kind, "unchanged");
    dismiss("#comments-list");
    assert.deepEqual(strip("#comments-list"), []);
  });
}
