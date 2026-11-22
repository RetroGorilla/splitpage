import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { nativeEntrySwitchFixture as entrySwitchFixture } from "../../tests/bootstrap/native-entry-switch-support.ts";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { fromHtml, sanitizeHtml, scriptCellOf } from "../bootstrap/richtext.ts";
import { adoptReplacement, currentDocument, sharedRecoverySession, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { commentRange } from "../core/text/edits.ts";
import { closeBrollPage, openBrollPage, openBrollPanel, runBrollRefresh } from "../features/broll/panel.ts";
import { closeCommentComposer, openCommentsPanel, renderComments } from "../features/comments/comments.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { openGearPanel, openProductionPanel, renderProduction, toggleCardSelection } from "../features/tags/panels.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const actor = "Editor";
const sharedDocId = "d00000000000000000000000000000001";
const originalThreadId = "thread";
const selection = { from: 1, to: 2 };
const refused = "This is not available in a shared session yet.";
const inlineMug = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">Mug</span>';
const source = {
  schema: 2,
  paragraphsDecided: true,
  title: "Typed record boxes",
  rows: [{ id: "r1", audioText: "One" }, { id: "r2", audioText: "Two" }],
  comments: [{ id: originalThreadId, rowId: "r1", field: "audioText", author: "Reader", body: "Original" }],
  people: [{ id: "p1", name: "Crew" }],
  productionTags: [{ cat: "prop", name: "Mug" }, { cat: "gear", name: "Drone", owner: "p1" }],
  brollShots: [{ id: "b1", name: "City", origin: "list", owner: "p1", props: [{ name: "Mug" }] }]
};
const orders = ["local-first", "remote-first"];
const find = selector => document.querySelector(selector);

function need(selector) {
  const element = find(selector);
  assert.ok(element, selector);
  return element;
}

const click = selector => need(selector).click();
const shotBox = field => `#broll-panel .broll-${field}-input[data-id="b1"]`;
const shotAction = action => `#broll-panel [data-action="broll-${action}"][data-id="b1"]`;
const tagBox = (field, key = "prop mug", panel = "#production-panel") => `${panel} .tag-${field}-input[data-key="${key}"]`;
const tagAction = (action, key = "prop mug", panel = "#production-panel") => `${panel} [data-action="tag-${action}"][data-key="${key}"]`;
const shot = doc => doc.brollShots.find(entry => entry.id === "b1");
const tag = (doc, name = "Mug") => doc.productionTags.find(entry => entry?.name === name);

async function enter(t, fields = {}) {
  const { ports, errors } = entrySwitchFixture();
  ports.commandRefused = sharedCommandRefusalNotice(notices);
  ports.editor = () => actor;
  ports.docId = () => sharedDocId;
  const seed = { ...source, ...fields };
  adoptReplacement(migrateRows(structuredClone(seed)));
  const show = t.mock.method(notices, "show", () => {});
  let native;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  t.after(() => {
    closeBrollPage();
    closeCommentComposer(true);
    if (sharedSession()) assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    document.activeElement?.blur();
    assert.deepEqual(errors, []);
  });
  const shown = () => show.mock.calls.map(call => call.arguments);
  return { native, seed, shown, warnings: () => shown().filter(([, level]) => level === "warn").map(([message]) => message) };
}

function referenceDocument(t, seed) {
  const document = migrateRows(structuredClone({ ...seed, docId: sharedDocId }));
  const reference = openNativeSession({
    kind: "document", document, conversion: { cells: scriptCellOf, creation: sharedDocId, at: new Date(0).toISOString(), by: actor }
  }, { actor, sanitize: sanitizeHtml });
  t.after(reference.close);
  return reference.document();
}

function clone(t, state) {
  const copy = openNativeSession({ kind: "state", state }, { actor: "Peer", sanitize: sanitizeHtml });
  t.after(copy.close);
  return copy;
}

function editPeer(peer) {
  const at = peer.commands.anchorText({ beat: "r2", cell: "narration" }, 3);
  assert.equal(at.kind, "anchored");
  assert.equal(peer.commands.typeText(at.range, "!", {}).kind, "written");
}

function exchange(native, peer, order) {
  const deliveries = [[peer, native.encodeState()], [native, peer.encodeState()]];
  if (order === "remote-first") deliveries.reverse();
  for (const [receiver, bytes] of deliveries) assert.equal(applyNativePeerUpdate(receiver, bytes), true);
}

function assertCopies(t, native, peer, order, read, expected, narration = "Two!") {
  const late = clone(t, native.encodeState());
  const appDoc = currentDocument(), localDoc = native.document(), peerDoc = peer.document(), lateDoc = late.document();
  for (const [label, doc] of [["app", appDoc], ["native", localDoc], ["peer", peerDoc], ["late", lateDoc]]) {
    assert.deepEqual([read(doc), doc.rows.find(row => row.id === "r2").audioText], [expected, narration], label);
  }
  const delivery = order === "local-first" ? "D1" : "D2";
  assertReplicasAgree("typed record boxes", [
    { order: delivery, replica: "A", output: appDoc },
    { order: delivery, replica: "B", output: peerDoc },
    { order: "late-C", replica: "C", output: lateDoc }
  ]);
}

function key(box, key) {
  for (const type of ["keydown", "keyup"]) {
    box.dispatchEvent(new window.KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
  }
}

function type(box, value) {
  box.focus();
  box.value = value;
  box.setSelectionRange(1, 2);
}

function input(box, inputType = "insertText") {
  box.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType }));
}

function blur(box) {
  box.focus();
  box.blur();
}

const enterKey = box => key(box, "Enter");

function openShot() {
  openBrollPanel();
  if (!find(shotBox("notes"))) click(shotAction("expand"));
}

function shotBulk(kind) {
  openShot();
  const expand = need(shotAction("expand"));
  if (!expand.closest(".broll-row").classList.contains("is-selected")) {
    expand.dispatchEvent(new window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
  }
  const select = need(`#broll-bulk-${kind}`);
  select.value = "__new__";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function editShot(action) {
  openShot();
  click(shotAction(action));
}

function openTags() {
  openProductionPanel();
  click('#production-modes [data-group="cat"]');
}

function expandTag(key = "prop mug", panel = "#production-panel") {
  if (!find(`${panel} .tag-entity.is-expanded[data-key="${key}"]`)) click(tagAction("expand", key, panel));
}

function openMug() {
  openTags();
  expandTag();
}

function tagBulk() {
  openTags();
  if (!find('#production-list .tag-entity[data-key="prop mug"][aria-selected="true"]')) toggleCardSelection("prop mug");
  click('[data-action="bulk-person-new"]');
}

const person = record => doc => [doc.people.map(entry => entry.name).sort(),
  doc.people.find(entry => entry.id === record(doc).owner)?.name ?? ""];
function shotPropsAndRegistry(doc) {
  const registeredProps = doc.productionTags.filter(entry => entry?.cat === "prop");
  const props = shot(doc).props;
  return [props.map(entry => entry.name), registeredProps.map(entry => entry.name).sort(),
    props.every(prop => registeredProps.some(entry => entry.id === prop.id && entry.name === prop.name))];
}
const notes = doc => shot(doc).notes;
const location = doc => shot(doc).location;
const newPerson = [["Camera", "Crew"], "Camera"];
const crew = [["Crew"], "Crew"];
const unassigned = [["Crew"], ""];
const shotPerson = { open: () => editShot("person-new"), box: shotBox("person"), text: "Camera", read: person(shot), before: crew, after: newPerson };
const shotProp = { open: openShot, box: shotBox("prop"), text: "Lamp", read: shotPropsAndRegistry,
  before: [["Mug"], ["Mug"], true], after: [["Mug", "Lamp"], ["Lamp", "Mug"], true] };
const shotLocation = { open: () => editShot("loc-edit"), box: shotBox("loc"), text: "Quay", read: location };
const shotNotes = { open: openShot, box: shotBox("notes"), text: "Wide", read: notes, submit: blur };
const mugPerson = { open: () => { openMug(); click(tagAction("person-new")); }, box: tagBox("person"), text: "Camera",
  read: person(tag), before: unassigned, after: newPerson };
const bulkPerson = { ...mugPerson, open: tagBulk, box: "#bulk-person-input" };

const routes = [
  { name: "B-roll bulk new person", ...shotPerson, open: () => shotBulk("owner"), box: "#broll-bulk-input" },
  { name: "B-roll shot person via Enter", ...shotPerson },
  { name: "B-roll shot person via Add", ...shotPerson, submit: () => click(shotAction("person-save")) },
  { name: "B-roll add shot", open: openBrollPanel, box: "#broll-add-input", text: "Park",
    read: doc => doc.brollShots.map(entry => entry.name).sort(), before: ["City"], after: ["City", "Park"] },
  { name: "B-roll prop via Enter", ...shotProp },
  { name: "B-roll prop via suggestion", ...shotProp, submit: box => input(box, "insertReplacementText") },
  { name: "B-roll location via Enter", ...shotLocation },
  { name: "B-roll location via blur", ...shotLocation, submit: blur },
  { name: "B-roll audio via blur", open: () => editShot("ref-edit"), box: shotBox("ref"), text: "0:12",
    read: doc => shot(doc).audioRef, submit: blur },
  { name: "B-roll page note via Enter", open: openBrollPage, box: '#broll-page .broll-page-note[data-id="b1"]',
    text: "Wide", read: notes, submit: enterKey, retry: blur },
  { name: "B-roll bulk new location", open: () => shotBulk("location"), box: "#broll-bulk-input", text: "Quay", read: location },
  { name: "B-roll notes via blur", ...shotNotes },
  { name: "B-roll notes typed before a redraw", ...shotNotes, beforeSubmit: runBrollRefresh },
  { name: "tag person via Enter", ...mugPerson, redraw: renderProduction },
  { name: "tag person via Add", ...mugPerson, submit: () => click(tagAction("person-save")), redraw: renderProduction },
  { name: "Gear tag person via Enter", open: () => { openGearPanel(); expandTag("gear drone", "#gear-panel"); click(tagAction("person-new", "gear drone", "#gear-panel")); },
    box: tagBox("person", "gear drone", "#gear-panel"), text: "Camera", read: person(doc => tag(doc, "Drone")),
    before: crew, after: newPerson, redraw: renderProduction },
  { name: "tag bulk person via Enter", ...bulkPerson, redraw: renderProduction },
  { name: "tag bulk person via Add", ...bulkPerson, submit: () => click('[data-action="bulk-person-save"]'), redraw: renderProduction },
  { name: "tag notes typed then blurred", open: openMug, box: tagBox("notes"), text: "Wide", read: doc => tag(doc).notes,
    submit: input, retry: blur, redraw: renderProduction },
  { name: "Gear quick add", open: openGearPanel, box: "#gear-quickadd-input", text: "Drone\nCrane",
    read: doc => doc.productionTags.filter(entry => entry?.cat === "gear").map(entry => entry.name).sort(),
    before: ["Drone"], after: ["Crane", "Drone"], submit: () => click("#gear-quickadd-save"), redraw: renderProduction }
];

async function retryDraft(t, { native, warnings }, route, order) {
  const peer = clone(t, native.encodeState());
  editPeer(peer);
  const release = sharedRecoverySession().hold("test-hold");
  t.after(release);
  const revision = native.revision();
  const redraw = route.redraw ?? runBrollRefresh;
  const submit = route.submit ?? enterKey;
  const before = route.before ?? "";
  const saved = route.after ?? route.text;
  const kept = stage => {
    assert.equal(route.visible ? route.visible() : need(route.box).value, route.text, stage);
    assert.deepEqual(route.read(currentDocument()), before, stage);
    assert.equal(native.revision(), revision, stage);
    assert.deepEqual(warnings(), [refused], stage);
  };
  if (route.type) route.type();
  else type(need(route.box), route.text);
  if (route.beforeSubmit) {
    route.beforeSubmit();
    assert.equal(need(route.box).value, route.text, "after redraw before first submission");
  }
  submit(need(route.box));
  kept("after refusal");
  redraw();
  kept("after redraw while held");
  release();
  redraw();
  kept("after release and redraw");
  (route.retry ?? submit)(need(route.box));
  await Promise.resolve();
  assert.equal(native.revision(), revision + 1, "one accepted write");
  assert.deepEqual(route.read(currentDocument()), saved);
  assert.deepEqual(route.read(peer.document()), before, "local write still held for the peer");
  assert.equal(currentDocument().rows[1].audioText, "Two", "remote write still held for the app");
  exchange(native, peer, order);
  await Promise.resolve();
  assertCopies(t, native, peer, order, route.read, saved);
  assert.deepEqual(warnings(), [refused]);
  assert.equal(native.commands.undo().kind, "written");
  assert.deepEqual(route.read(native.document()), before);
  assert.equal(native.commands.undo().kind, "unchanged");
}

for (const route of routes) for (const order of orders) {
  test(`${route.name} keeps its held draft until one explicit save, ${order}`, async t => {
    const session = await enter(t);
    route.open();
    await retryDraft(t, session, route, order);
  });
}

test("inline tag rename via Enter keeps the refused draft, focus and selection", async t => {
  const visualText = `A ${inlineMug}`;
  const { native, seed, shown } = await enter(t, { rows: [source.rows[0], { ...source.rows[1], visualText }] });
  const originalDocument = referenceDocument(t, seed);
  const peer = clone(t, native.encodeState());
  openMug();
  click(tagAction("rename"));
  const selector = tagBox("rename");
  const original = need(selector);
  type(original, "Cup");
  enterKey(original);
  assert.equal(need(selector), original);
  for (const redraw of [() => {}, renderProduction]) {
    redraw();
    const box = need(selector);
    assert.equal(document.activeElement, box);
    assert.deepEqual([box.value, box.selectionStart, box.selectionEnd], ["Cup", 1, 2]);
    assert.deepEqual(shown(), [[refused, "warn"]]);
  }
  assert.deepEqual(currentDocument(), originalDocument, "after redraw before Escape");
  key(need(selector), "Escape");
  assert.equal(find(selector), null);
  exchange(native, peer, "local-first");
  await Promise.resolve();
  assertCopies(t, native, peer, "local-first", doc => doc, originalDocument, "Two");
  assert.equal(native.commands.undo().kind, "unchanged");
});

function threadsWithAnchors(doc) {
  return doc.comments.map(entry => {
    if (entry.id === originalThreadId) return entry;
    const row = doc.rows.find(row => row.id === entry.rowId);
    return [entry.rowId, entry.field, entry.quotedText, entry.author, entry.body, entry.replies,
      entry.anchorId === entry.id, commentRange(fromHtml(row?.[entry.field]), entry.id)];
  });
}

for (const reply of [false, true]) for (const order of orders) {
  test(`${reply ? "reply" : "comment"} Post keeps the held body and uses the session author, ${order}`, async t => {
    const session = await enter(t);
    openCommentsPanel();
    if (reply) click('[data-action="toggle-reply"][data-id="thread"]');
    else {
      const cell = need('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
      cell.focus();
      setCellSelection(cell, selection.from, selection.to);
      cell.closest(".field-wrap").querySelector('[data-cmd="comment"]').click();
    }
    const box = reply ? '.reply-composer[data-for="thread"] .cell-editable' : "#comment-body-editable";
    const author = reply ? '.reply-composer[data-for="thread"] .reply-name-input' : "#comment-name";
    const post = reply ? '[data-action="reply-post"][data-id="thread"]' : "#comment-post";
    const text = reply ? "Reply body" : "New comment body";
    const visible = () => {
      if (!reply) assert.equal(need("#comment-modal").hidden, false);
      assert.equal(need(author).readOnly, true);
      assert.equal(need(author).value, actor);
      return need(box).textContent;
    };
    assert.equal(visible(), "");
    const originalThreads = reply ? [] : referenceDocument(t, session.seed).comments;
    const newThread = ["r1", "audioText", "n", actor, text, [], true, selection];
    await retryDraft(t, session, {
      box, text, visible, redraw: openCommentsPanel,
      type: () => { need(box).textContent = text; input(need(box)); },
      submit: () => click(post), before: originalThreads, after: reply ? [[actor, text]] : [...originalThreads, newThread],
      read: reply
        ? doc => doc.comments.find(entry => entry.id === originalThreadId).replies.map(entry => [entry.author, entry.body])
        : threadsWithAnchors
    }, order);
    renderComments();
    if (reply) assert.equal(find(box), null);
    else assert.equal(need("#comment-modal").hidden, true);
  });
}
