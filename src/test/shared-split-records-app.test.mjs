import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sharedSplitBindings } from "../bootstrap/wiring/shared-split.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveSharedSession, sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { openingStatus } from "../bootstrap/wiring/ports/transitions.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { currentBrollRecords } from "../bootstrap/wiring/broll.ts";
import { cellEditing } from "../bootstrap/wiring/editor-owners.ts";
import { clearProductionSelection, selectedKeys } from "../bootstrap/wiring/production-editing-owners.ts";
import { sharedCommentCommands, sharedGalleryCommands, sharedRecordCommands } from "../bootstrap/wiring/ports/shared-commands.ts";
import { findOrAddPerson, registerProductionTag } from "../features/tags/production-tags.ts";
import { addPersonForTag, applyGearQuickAdd, changeProductionOutline, clickProductionOutline, armDeleteTag, armPersonDelete, armRemoveTag, bulkDeleteSelected, openGearPanel, openProductionPanel, renderProduction, saveTagRename, setTagOwner, setTagStatus, toggleCardSelection } from "../features/tags/panels.ts";
import { closeBrollPage, openBrollPage, openBrollPanel, runBrollRefresh } from "../features/broll/panel.ts";
import { armDeleteComment, closeCommentComposer, openCommentComposer, openCommentsPanel, postComment, postReply, setCommentAssignee, toggleReplyComposer, toggleResolve } from "../features/comments/comments.ts";
import { moveGallerySlot, removeGallerySlot } from "../core/document/gallery.ts";
import { tagKey } from "../core/document/tags.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { screenIsStale } from "../features/rows/render.ts";
import { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { projectSharedDocument } from "../adapters/collab/project.ts";
import { registerSharedOperationFamilies } from "../adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../adapters/collab/execute.ts";
import { readSharedPaintedText } from "../adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../adapters/collab/buffer.ts";
import { bufferedFieldKey } from "../core/collab/buffer.ts";
import { readOperation } from "../core/collab/read-operation.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const reports = [], errors = [], noticeCalls = [], actualShow = notices.show;
notices.show = (...args) => { noticeCalls.push(args); return actualShow(...args); };
after(() => { notices.show = actualShow; });
const toastHost = () => { const host = document.getElementById("toast-host"); assert.ok(host); return host; };
const warnings = () => [...toastHost().querySelectorAll(".toast.warn")].map(el => el.firstChild.textContent);
const clearWarnings = () => { toastHost().replaceChildren(); };
const allowed = { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) };
let serial = 0, remoteSerial = 0;
const ports = {
  opening: openingStatus,
  refusal: () => null, commandRefused: sharedCommandRefusalNotice(notices), settle: () => { undoOwner().flush(); }, detach: () => {},
  bindings: sharedSplitBindings({ report: value => { reports.push(value); }, missingBase: () => {}, recovered: () => {} }),
  common: allowed, standalone: createSessionCapabilities("standalone", allowed), migrate: migrateRows,
  docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice", structure: { cells: html => fromHtml(html) },
  report: error => { errors.push(error); }, timers: { now: Date.now, start: (run, ms) => setTimeout(run, ms), stop: clearTimeout }, now: Date.now
};
const ORDERS = ["local-first", "remote-first"];
const ref = letter => ({ sha256: letter.repeat(64), width: 10, height: 10, mime: "image/png" });
const anchor = (id, text) => '<span class="cmt-anchor" data-cmt="' + id + '">' + text + "</span>";
const D = "t_i9fk0si5uyzl", M = "t_1okou1ndmeusp";
const SOURCE = { schema: 2, title: "Shared records", paragraphsDecided: true, wordsPerMinute: 150,
  rows: [
    { id: "r1", audioText: "a" + anchor("C1", "bc") + "def", visualText: "x" + anchor("C9", "yz"), status: "todo",
      imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("b"), name: "Two" }, { imageRef: ref("c"), name: "Three" }] },
    { id: "r2", audioText: "Other", visualText: 'A <span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">Mug</span>', status: "todo" }
  ],
  comments: [{ id: "C1", author: "Ann", createdAt: "2026-11-13T10:00:00.000Z", rowId: "r1", field: "audioText", anchorId: "C1", body: "note",
    quotedText: "bc", resolved: false, resolvedAt: null, resolvedBy: null, replies: [] }],
  people: [{ id: "p1", name: "Ann" }, { id: "p2", name: "Bob" }],
  productionTags: [{ id: D, cat: "gear", name: "Drone", owner: "p1", notes: "", status: "needed" }, { id: M, cat: "prop", name: "Mug", owner: "", notes: "", status: "needed" }],
  brollShots: [{ id: "b1", name: "City", desc: "", status: "unshot", reshoot: false, notes: "", owner: "p1", audioRef: "", location: "", props: [{ id: M, name: "Mug" }], origin: "list" }]
};

function adopt(source) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(source)));
}
async function enter(source = SOURCE, adopting = true) {
  reports.length = 0; errors.length = 0; clearWarnings(); noticeCalls.length = 0;
  if (adopting) adopt(source);
  assert.deepEqual(await enterSharedSession(ports), { ok: true }, errors.map(error => error.stack).join("\n"));
  const parts = sharedSessionParts(); assert.ok(parts); assert.equal(screenIsStale(), false);
  const peer = createSharedDocument(); registerSharedOperationFamilies(peer, { cells: html => fromHtml(html) });
  assert.equal(applySharedUpdate(peer, encodeSharedState(parts.handle)).ok, true);
  return { parts, peer, close: () => { destroySharedDocument(peer); assert.deepEqual(leaveSharedSession(ports), { ok: true }); } };
}
function remoteInsert(handle, rowId, field, offset, text) {
  const target = sharedBufferedTarget(handle, bufferedFieldKey(rowId, field)), painted = readSharedPaintedText(handle, target);
  assert.ok(painted);
  const op = readOperation({ kind: "text-insert", id: "bob_" + ++remoteSerial, by: "Bob", target,
    at: { left: offset === painted.text.length ? painted.endGap : null, right: painted.identity(offset), affinity: offset === painted.text.length ? "after" : "before" },
    content: [{ value: text, marks: [] }] });
  assert.ok(op); assert.deepEqual(executeSharedOperations(handle, [op]), { ok: true });
}
function exchange(f, order) {
  const toPeer = () => { assert.equal(applySharedUpdate(f.peer, encodeSharedState(f.parts.handle)).ok, true); };
  const toLocal = () => { assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true); };
  if (order === "local-first") { toPeer(); toLocal(); } else { toLocal(); toPeer(); }
}
function shape(doc) {
  const person = id => doc.people.find(p => p.id === id)?.name ?? "";
  return {
    rows: doc.rows.map(r => [r.id, r.audioText, r.visualText, [r.imageRef?.sha256?.[0] ?? null, ...(r.moreImages ?? []).map(m => m.imageRef?.sha256?.[0] ?? null)]]),
    comments: doc.comments.map(c => [c.id, c.resolved, c.assignee ?? "", (c.replies ?? []).map(reply => reply.body)]),
    people: doc.people.map(p => p.name),
    tags: doc.productionTags.filter(Boolean).map(t => [t.cat, t.name, person(t.owner), t.status]),
    shots: doc.brollShots.map(s => [s.name, s.status, person(s.owner), !!s.reshoot, (s.props ?? []).map(p => p.name)])
  };
}
function agree(f, expected) {
  const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: html => fromHtml(html) });
  try {
    assert.equal(applySharedUpdate(late, encodeSharedState(f.parts.handle)).ok, true);
    assertReplicasAgree("composed Split record callers", [
      { order: "D1", replica: "A", output: currentDocument() }, { order: "D1", replica: "B", output: projectSharedDocument(f.peer) },
      { order: "late-C", replica: "C", output: projectSharedDocument(late) }
    ]);
    assert.deepEqual(shape(currentDocument()), expected);
    assert.deepEqual([reports, errors], [[], []]);
  } finally { destroySharedDocument(late); }
}
function press(target, key, modifiers = {}) {
  const handled = !target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
  target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true, ...modifiers }));
  return handled;
}
const cellOf = (field, rowId) => {
  const cell = document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);
  assert.ok(cell, rowId + " " + field); return cell;
};
function undoOnce(f, order) {
  assert.equal(press(cellOf("audioText", "r2"), "z", { ctrlKey: true }), true);
  exchange(f, order);
}
const withZ = s => ({ ...s, rows: s.rows.map(r => r[0] === "r2" ? [r[0], "Z" + r[1], ...r.slice(2)] : r) });
const edit = (s, change) => { const next = structuredClone(s); change(next); return next; };
function brollButton(action, id, extra = "") {
  const button = document.querySelector(`#broll-panel [data-action="${action}"][data-id="${id}"]${extra}`);
  assert.ok(button, action + " " + id); return button;
}
function brollOpen(id) {
  openBrollPanel();
  if (!document.querySelector(`#broll-panel [data-action="broll-person-new"][data-id="${id}"]`)) brollButton("broll-expand", id).click();
}
function brollSelect(id) {
  openBrollPanel();
  document.querySelector('#broll-panel [data-action="broll-bulk-clear"]')?.click();
  brollButton("broll-expand", id).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
}
const twice = (arm, ...args) => { const button = document.createElement("button"); arm(button, ...args); arm(button, ...args); };
const selectOnly = key => { openProductionPanel(); clearProductionSelection(); toggleCardSelection(key); assert.deepEqual(selectedKeys(), [key]); };

const served = [
  { name: "registering a production tag", act: () => { assert.equal(registerProductionTag("location", "Park"), true); },
    after: s => edit(s, n => { n.tags.push(["location", "Park", "", "needed"]); }) },
  { name: "finding or adding a person", act: () => { assert.notEqual(findOrAddPerson("Cy"), ""); },
    after: s => edit(s, n => { n.people.push("Cy"); }) },
  { name: "adding a prop to a shot", act: () => { assert.deepEqual(currentBrollRecords()?.addBrollProp("b1", "Lamp"), { changed: true, held: false }); },
    after: s => edit(s, n => { n.tags.push(["prop", "Lamp", "", "needed"]); n.shots[0][4].push("Lamp"); }) },
  { name: "the b-roll status toggle", act: () => { openBrollPanel(); brollButton("broll-status-toggle", "b1").click(); },
    after: s => edit(s, n => { n.shots[0][1] = "shot"; }) },
  { name: "the b-roll bulk Mark filmed", act: () => {
    brollSelect("b1");
    const bulk = document.querySelector('#broll-panel [data-action="broll-bulk-shot"]'); assert.ok(bulk); bulk.click();
  }, after: s => edit(s, n => { n.shots[0][1] = "shot"; }) },
  { name: "the b-roll bulk assign to a new person", act: () => {
    brollSelect("b1");
    const owner = document.getElementById("broll-bulk-owner"); assert.ok(owner);
    owner.value = "__new__"; owner.dispatchEvent(new window.Event("change", { bubbles: true }));
    const box = document.getElementById("broll-bulk-input"); assert.ok(box); box.value = "Cy";
    const save = document.querySelector('#broll-panel [data-action="broll-bulk-input-save"]'); assert.ok(save); save.click();
    assert.equal(document.getElementById("broll-bulk-input"), null, "the bulk box closes");
  }, after: s => edit(s, n => { n.people.push("Cy"); n.shots[0][2] = "Cy"; }) },
  { name: "the b-roll prop box", act: () => {
    brollOpen("b1"); typeIn(`#broll-panel .broll-prop-input${B1}`, "Lamp", [4, 4]); FIRE.enter($(`#broll-panel .broll-prop-input${B1}`));
    const box = $(`#broll-panel .broll-prop-input${B1}`); assert.equal(box.value, "", "the prop box empties"); assert.equal(document.activeElement, box);
    box.blur();
  }, after: s => edit(s, n => { n.tags.push(["prop", "Lamp", "", "needed"]); n.shots[0][4].push("Lamp"); }) },
  { name: "the tag person box", act: () => {
    productionCards(); tagPersonBox("#production-panel", "prop mug"); FIRE.enter($(`#production-panel .tag-person-input${MUG}`));
    assert.equal(document.querySelector(`#production-panel .tag-person-input${MUG}`), null, "the person box closes");
    assert.equal(document.activeElement, $(`#production-panel [data-action="tag-person-new"]${MUG}`));
  }, after: s => edit(s, n => { n.people.push("Cy"); n.tags[1][2] = "Cy"; }) },
  { name: "the b-roll delete", act: () => {
    brollOpen("b1");
    if (!document.querySelector('#broll-panel [data-action="broll-delete"][data-id="b1"]')) brollButton("broll-menu", "b1").click();
    brollButton("broll-delete", "b1").click();
  }, after: s => edit(s, n => { n.shots = []; }) },
  { name: "the b-roll new person for a shot", act: () => {
    brollOpen("b1"); brollButton("broll-person-new", "b1").click();
    const box = document.querySelector('#broll-panel .broll-person-input[data-id="b1"]'); assert.ok(box); box.value = "Cy";
    brollButton("broll-person-save", "b1").click();
  }, after: s => edit(s, n => { n.people.push("Cy"); n.shots[0][2] = "Cy"; }) },
  { name: "adding a shot from the b-roll panel", act: () => {
    openBrollPanel();
    const box = document.getElementById("broll-add-input"); assert.ok(box); box.value = "Park";
    press(box, "Enter");
  }, after: s => edit(s, n => { n.shots.push(["Park", "unshot", "", false, []]); }) },
  { name: "removing a prop from a shot", act: () => { brollOpen("b1"); brollButton("broll-prop-remove", "b1", `[data-ref="${M}"]`).click(); },
    after: s => edit(s, n => { n.shots[0][4] = []; }) },
  { name: "the gear quick add", act: () => {
    openProductionPanel();
    let box = document.getElementById("gear-quickadd-input");
    if (!box) { box = document.createElement("textarea"); box.id = "gear-quickadd-input"; document.body.append(box); }
    box.value = "Drone\nCrane";
    applyGearQuickAdd();
  }, after: s => edit(s, n => { n.tags.push(["gear", "Crane", "", "needed"]); }) },
  { name: "advancing a tag's status", act: () => { openProductionPanel(); setTagStatus(tagKey("gear", "Drone"), null); },
    after: s => edit(s, n => { n.tags[0][3] = "sourcing"; }) },
  { name: "deleting a tag from its card", act: () => { openProductionPanel(); twice(armDeleteTag, tagKey("gear", "Drone")); },
    after: s => edit(s, n => { n.tags.shift(); }) },
  { name: "bulk deleting selected tags", act: () => {
    selectOnly(tagKey("gear", "Drone")); bulkDeleteSelected();
  }, after: s => edit(s, n => { n.tags.shift(); }) },
  { name: "assigning a tag's owner", act: () => { openProductionPanel(); setTagOwner(tagKey("prop", "Mug"), "p2"); },
    after: s => edit(s, n => { n.tags[1][2] = "Bob"; }) },
  { name: "creating a person while assigning a tag (one undo step removes both)", act: () => { openProductionPanel(); addPersonForTag(tagKey("prop", "Mug"), "Cy"); },
    after: s => edit(s, n => { n.people.push("Cy"); n.tags[1][2] = "Cy"; }) },
  { name: "adding a person from the production panel", act: () => { openProductionPanel(); addPersonForTag(null, "Cy"); },
    after: s => edit(s, n => { n.people.push("Cy"); }) },
  { name: "deleting a person", act: () => { openProductionPanel(); twice(armPersonDelete, "p2"); },
    after: s => edit(s, n => { n.people = ["Ann"]; }) },
  { name: "removing a picture from the gallery (rule 152: its toast has no Undo)", act: () => {
    clearWarnings(); noticeCalls.length = 0;
    assert.doesNotThrow(() => { assert.deepEqual(cellEditing().editGallery("r1", "Picture removed", row => removeGallerySlot(row, 1)), { changed: true, held: false }); });
    assert.deepEqual(noticeCalls, [["Picture removed", "ok"]]);
    assert.deepEqual([...toastHost().querySelectorAll(".toast")].map(el => [el.firstChild.textContent, el.querySelector(".toast-action")]), [["Picture removed", null]]);
  }, after: s => edit(s, n => { n.rows[0][3] = ["a", "c"]; }) },
  { name: "resolving a comment (rule 35 on #1414: a resolve records no undo step)", act: () => { toggleResolve("C1"); }, undoable: false,
    after: s => edit(s, n => { n.comments[0][1] = true; }) },
  { name: "assigning a comment", act: () => { setCommentAssignee("C1", "Bob"); }, after: s => edit(s, n => { n.comments[0][2] = "Bob"; }) },
  { name: "replying to a comment", act: () => {
    reply("Alice"); assert.equal(document.querySelector('.reply-composer[data-for="C1"]'), null, "the reply composer closes");
  }, after: s => edit(s, n => { n.comments[0][3] = ["ok"]; }) },
  { name: "deleting a comment", act: () => { openCommentsPanel(); twice(armDeleteComment, "C1"); },
    after: s => edit(s, n => { n.comments = []; n.rows[0][1] = "abcdef"; }) },
  { name: "posting a comment on an anchored selection", act: () => { post("Alice"); }, after: s => edit(s, n => { n.comments.push(["C9", false, "", []]); }) },
  { name: "cancelling a comment unwraps its anchor", act: () => {
    openCommentComposer({ id: "C9", rowId: "r1", field: "visualText", quotedText: "yz" });
    closeCommentComposer(true);
  }, after: s => edit(s, n => { n.rows[0][2] = "xyz"; }) }
];

for (const literal of served) for (const order of ORDERS) test(`C7 record caller literal: ${literal.name}, ${order}`, async () => {
  const f = await enter();
  try {
    const start = shape(currentDocument()), sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
    remoteInsert(f.peer, "r2", "audioText", 0, "Z");
    literal.act(f);
    exchange(f, order);
    agree(f, withZ(literal.after(start)));
    assert.deepEqual(warnings(), []);
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + (literal.undoable === false ? 0 : 1) });
    assert.deepEqual(undoOwner().sizes(), standalone);
    if (literal.undoable === false) return;
    undoOnce(f, order);
    assert.deepEqual(warnings(), []);
    agree(f, withZ(start));
  } finally { tidy(f); }
});

const REFUSED = "This is not available in a shared session yet.";
const ADMISSION_HELD = "held-for-test";
const reply = name => {
  openCommentsPanel();
  if (!document.querySelector('.reply-composer[data-for="C1"]')) toggleReplyComposer("C1");
  const card = document.querySelector('.reply-composer[data-for="C1"]'); assert.ok(card);
  card.querySelector(".reply-name-input").value = name; card.querySelector(".cell-editable").innerHTML = "ok";
  postReply("C1");
};
const post = name => {
  openCommentComposer({ id: "C9", rowId: "r1", field: "visualText", quotedText: "yz" });
  document.getElementById("comment-name").value = name; document.getElementById("comment-body-editable").innerHTML = "new";
  postComment();
};
const composerKept = (name, body) => () => {
  assert.equal(document.getElementById("comment-modal").hidden, false, "the composer stays open");
  assert.deepEqual([document.getElementById("comment-name").value, document.getElementById("comment-body-editable").innerHTML], [name, body]);
};
const replyKept = name => () => {
  openCommentsPanel();
  const card = document.querySelector('.reply-composer[data-for="C1"]'); assert.ok(card, "the reply composer stays open after a render");
  assert.deepEqual([card.querySelector(".reply-name-input").value, card.querySelector(".cell-editable").innerHTML], [name, "ok"]);
};
const tagsKept = key => () => { openProductionPanel(); assert.deepEqual(selectedKeys(), [key]); };
const refusals = [
  { name: "rule 153: posting a comment under another name than the session's", act: () => { post("Bob"); }, kept: composerKept("Bob", "new") },
  { name: "rule 153: replying under another name than the session's", act: () => { reply("Bob"); }, kept: replyKept("Bob") },
  { name: "rule 73: bulk deleting a tag the script labels needs a text rewrite", act: () => {
    selectOnly(tagKey("prop", "Mug")); bulkDeleteSelected();
  }, kept: tagsKept(tagKey("prop", "Mug")) },
  { name: "rule 73: renaming a tag has no shared port", act: () => { openProductionPanel(); assert.equal(saveTagRename(tagKey("prop", "Mug"), "Cup"), tagKey("prop", "Mug")); } },
  { name: "rule 73: removing a tag's labels has no shared port", act: () => { openProductionPanel(); twice(armRemoveTag, tagKey("prop", "Mug")); } },
  { name: "rule 73: removing the labels of a tag the script never mentions has no shared port", act: () => { openProductionPanel(); twice(armRemoveTag, tagKey("gear", "Drone")); } },
  { name: "gallery-order-unavailable: making the last of three pictures loaded together the cover", act: () => {
    const reasons = [], refused = sharedGalleryCommands.refused;
    sharedGalleryCommands.refused = outcome => { reasons.push(outcome.reason); refused(outcome); };
    try { assert.deepEqual(cellEditing().editGallery("r1", "Made the cover", row => moveGallerySlot(row, 2, 0)), { changed: false, held: true }); } finally { sharedGalleryCommands.refused = refused; }
    assert.deepEqual(reasons, ["gallery-order-unavailable"]);
  } }
];

function refusedOnce(f, order, act, kept) {
  remoteInsert(f.peer, "r2", "audioText", 0, "Z");
  const start = shape(currentDocument()), before = encodeSharedState(f.parts.handle), sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
  noticeCalls.length = 0;
  act();
  assert.deepEqual(noticeCalls.filter(call => call[1] === "warn"), [[REFUSED, "warn"]]);
  assert.deepEqual(noticeCalls.filter(call => call[1] === "ok"), []);
  assert.deepEqual(encodeSharedState(f.parts.handle), before);
  assert.deepEqual(f.parts.undo.sizes(), sizes);
  assert.deepEqual(undoOwner().sizes(), standalone);
  kept?.();
  return start;
}
function tidy(f) {
  closeCommentComposer();
  clearProductionSelection();
  document.querySelector('#broll-panel [data-action="broll-bulk-clear"]')?.click();
  if (galleryState().open) $("#gallery-close").click();
  f.close();
  document.activeElement?.blur?.();
}

for (const literal of refusals) for (const order of ORDERS) test(`C7 record refusal: ${literal.name} is refused once and writes nothing, ${order}`, async () => {
  const f = await enter();
  try {
    const start = refusedOnce(f, order, literal.act, literal.kept);
    clearWarnings();
    exchange(f, order);
    agree(f, withZ(start));
    assert.deepEqual(warnings(), []);
  } finally { tidy(f); }
});

const $ = selector => { const el = document.querySelector(selector); assert.ok(el, selector); return el; };
const typeIn = (selector, text, range) => { const box = $(selector); box.focus(); box.value = text; box.setSelectionRange(...range); };
const choose = (selector, value) => { const box = $(selector); box.focus(); box.value = value; };
const optionNamed = (selector, name) => [...$(selector).options].find(o => o.textContent === name).value;
const ctrlClick = selector => { $(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })); };
const FIRE = {
  click: el => { el.click(); },
  enter: el => { press(el, "Enter"); },
  change: el => { el.dispatchEvent(new window.Event("change", { bubbles: true })); },
  blur: el => { el.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); },
  pick: el => { el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertReplacementText" })); }
};
function focused() {
  const active = document.activeElement;
  return { active, value: active && "value" in active ? active.value : null,
    range: active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null };
}
const textBoxes = root => [...document.querySelectorAll(`${root} input[type="text"], ${root} input:not([type]), ${root} textarea`)]
  .map(el => [el.id || el.classList[0], el.getAttribute("data-id") ?? el.getAttribute("data-key") ?? "", el.value]);
const brollState = () => ({
  open: [...document.querySelectorAll('#broll-panel [data-action="broll-person-new"]')].map(el => el.getAttribute("data-id")),
  selected: [...document.querySelectorAll("#broll-panel .broll-row.is-selected")].map(el => el.getAttribute("data-id")),
  menu: [...document.querySelectorAll('#broll-panel [data-action="broll-delete"]')].map(el => el.getAttribute("data-id")),
  boxes: textBoxes("#broll-panel")
});
const tagState = () => ({
  expanded: [...document.querySelectorAll(".tag-entity.is-expanded")].map(el => el.getAttribute("data-key")),
  selected: [...selectedKeys()], boxes: [...textBoxes("#production-panel"), ...textBoxes("#gear-panel")]
});
const commentState = () => ({
  composer: [document.getElementById("comment-modal").hidden, document.getElementById("comment-name").value, document.getElementById("comment-body-editable").innerHTML],
  replies: [...document.querySelectorAll(".reply-composer")].map(card => [card.getAttribute("data-for"), card.querySelector(".reply-name-input").value, card.querySelector(".cell-editable").innerHTML]),
  menu: [...document.querySelectorAll('#comments-panel [data-action="delete-comment"]')].map(el => el.getAttribute("data-id"))
});
const galleryState = () => ({
  open: [...document.querySelectorAll(".scene-gallery-remove")].filter(el => !el.closest("[hidden]")).length,
  selected: [...document.querySelectorAll(".scene-gallery-grid-tile.is-selected")].map(el => el.getAttribute("data-slot"))
});
const B1 = '[data-id="b1"]', MUG = '[data-key="prop mug"]', DRONE = '[data-key="gear drone"]';
function brollMenu() { brollOpen("b1"); if (!document.querySelector(`#broll-panel [data-action="broll-delete"]${B1}`)) brollButton("broll-menu", "b1").click(); }
function brollBulkNew(kind) { brollSelect("b1"); choose(`#broll-bulk-${kind}`, "__new__"); FIRE.change($(`#broll-bulk-${kind}`)); }
function productionCards() { openProductionPanel(); $('#production-modes [data-group="cat"]').click(); }
function expandedCard(panel, key) {
  if (!document.querySelector(`${panel} .tag-entity.is-expanded[data-key="${key}"]`)) $(`${panel} [data-action="tag-expand"][data-key="${key}"]`).click();
}
function tagPersonBox(panel, key) { expandedCard(panel, key); $(`${panel} [data-action="tag-person-new"][data-key="${key}"]`).click(); typeIn(`${panel} .tag-person-input[data-key="${key}"]`, "Cy", [1, 2]); }
function productionPick(key) { productionCards(); clearProductionSelection(); openProductionPanel(); ctrlClick(`#production-panel .tag-entity[data-key="${key}"] .tag-entity-row`); assert.deepEqual(selectedKeys(), [key]); }
function gearOpen() { openGearPanel(); }
function composer(id) {
  openCommentComposer({ id, rowId: "r1", field: "visualText", quotedText: "yz" });
  document.getElementById("comment-name").value = "Alice"; document.getElementById("comment-body-editable").innerHTML = "new";
}
function replyOpen() {
  openCommentsPanel();
  if (!document.querySelector('.reply-composer[data-for="C1"]')) $('[data-action="toggle-reply"][data-id="C1"]').click();
  const card = $('.reply-composer[data-for="C1"]');
  card.querySelector(".reply-name-input").value = "Alice"; card.querySelector(".cell-editable").innerHTML = "ok";
}
function brollEditing(action, box, text, range) {
  brollOpen("b1");
  if (!document.querySelector(box)) brollButton(action, "b1").click();
  typeIn(box, text, range);
}
const broll = (name, how, target, setup, kept = how !== "click") => ({ name, how, target, setup, state: brollState, render: openBrollPanel, kept });
const tags = (name, how, target, setup, kept = false) => ({ name, how, target, setup, state: tagState, render: renderProduction, kept });
const comments = (name, how, target, setup) => ({ name, how, target, setup, state: commentState, render: openCommentsPanel, kept: true });
const LOC = `#broll-panel .broll-loc-input${B1}`, REF = `#broll-panel .broll-ref-input${B1}`;
const HELD_PATHS = [
  broll("the b-roll status button", "click", `#broll-panel .broll-status-btn${B1}`, () => { brollOpen("b1"); }),
  broll("the b-roll reshoot flag", "click", `#broll-panel [data-action="broll-reshoot-toggle"]${B1}`, () => { brollOpen("b1"); }),
  broll("the b-roll bulk Mark filmed", "click", '#broll-panel [data-action="broll-bulk-shot"]', () => { brollSelect("b1"); }),
  broll("the b-roll bulk owner control", "change", "#broll-bulk-owner", () => { brollSelect("b1"); choose("#broll-bulk-owner", "p2"); }),
  broll("the b-roll bulk new person box", "enter", "#broll-bulk-input", () => { brollBulkNew("owner"); typeIn("#broll-bulk-input", "Cy", [1, 2]); }),
  broll("the b-roll bulk new location box", "enter", "#broll-bulk-input", () => { brollBulkNew("location"); typeIn("#broll-bulk-input", "Quay", [1, 3]); }),
  broll("the b-roll delete", "click", `#broll-panel [data-action="broll-delete"]${B1}`, brollMenu),
  broll("the b-roll shot owner control", "change", `#broll-panel .broll-owner-select${B1}`, () => { brollOpen("b1"); choose(`#broll-panel .broll-owner-select${B1}`, "p2"); }),
  broll("the b-roll shot person box, Enter", "enter", `#broll-panel .broll-person-input${B1}`, () => {
    brollOpen("b1"); brollButton("broll-person-new", "b1").click(); typeIn(`#broll-panel .broll-person-input${B1}`, "Cy", [1, 2]);
  }),
  broll("the b-roll shot person box, Add", "click", `#broll-panel [data-action="broll-person-save"]${B1}`, () => {
    brollOpen("b1"); brollButton("broll-person-new", "b1").click(); typeIn(`#broll-panel .broll-person-input${B1}`, "Cy", [1, 2]);
  }),
  broll("the b-roll add box", "enter", "#broll-add-input", () => { openBrollPanel(); typeIn("#broll-add-input", "Park", [1, 3]); }),
  broll("the b-roll prop remove", "click", `#broll-panel [data-action="broll-prop-remove"]${B1}[data-ref="${M}"]`, () => { brollOpen("b1"); }),
  broll("the b-roll prop box, Enter", "enter", `#broll-panel .broll-prop-input${B1}`, () => { brollOpen("b1"); typeIn(`#broll-panel .broll-prop-input${B1}`, "Lamp", [1, 3]); }),
  broll("the b-roll prop box, a suggestion pick", "pick", `#broll-panel .broll-prop-input${B1}`, () => { brollOpen("b1"); typeIn(`#broll-panel .broll-prop-input${B1}`, "Lamp", [1, 3]); }),
  broll("the b-roll location box, Enter", "enter", LOC, () => { brollEditing("broll-loc-edit", LOC, "Quay", [1, 3]); }),
  broll("the b-roll location box, blur", "blur", LOC, () => { brollEditing("broll-loc-edit", LOC, "Quay", [1, 3]); }),
  broll("the b-roll audio box, blur", "blur", REF, () => { brollEditing("broll-ref-edit", REF, "0:12", [1, 2]); }),
  broll("the b-roll notes box, blur", "blur", `#broll-panel .broll-notes-input${B1}`, () => { brollOpen("b1"); typeIn(`#broll-panel .broll-notes-input${B1}`, "Wide", [1, 2]); }),
  tags("the gear status pill", "click", `#gear-panel [data-action="tag-status-cycle"]${DRONE}`, gearOpen),
  tags("the gear status menu", "click", `#gear-panel [data-action="tag-status-set"]${DRONE}:not(.is-active)`, () => { gearOpen(); expandedCard("#gear-panel", "gear drone"); }),
  tags("the tag owner control", "change", `#production-panel .tag-owner-select${MUG}`, () => {
    productionCards(); expandedCard("#production-panel", "prop mug"); choose(`#production-panel .tag-owner-select${MUG}`, "p2");
  }),
  tags("the tag person box, Enter", "enter", `#production-panel .tag-person-input${MUG}`, () => { productionCards(); tagPersonBox("#production-panel", "prop mug"); }),
  tags("the tag person box, Add", "click", `#production-panel [data-action="tag-person-save"]${MUG}`, () => { productionCards(); tagPersonBox("#production-panel", "prop mug"); }),
  tags("the gear tag person box, Enter", "enter", `#gear-panel .tag-person-input${DRONE}`, () => { gearOpen(); tagPersonBox("#gear-panel", "gear drone"); }),
  tags("the tag bulk owner control", "change", "#bulk-owner", () => { productionPick("prop mug"); choose("#bulk-owner", "p2"); }),
  tags("the tag bulk status control", "change", "#bulk-status", () => { productionPick("prop mug"); choose("#bulk-status", $("#bulk-status").options[2].value); }),
  tags("the tag bulk person box, Enter", "enter", "#bulk-person-input", () => {
    productionPick("prop mug"); $('[data-action="bulk-person-new"]').click(); typeIn("#bulk-person-input", "Cy", [1, 2]);
  }),
  tags("the tag bulk person box, Add", "click", '[data-action="bulk-person-save"]', () => {
    productionPick("prop mug"); $('[data-action="bulk-person-new"]').click(); typeIn("#bulk-person-input", "Cy", [1, 2]);
  }),
  tags("the tag bulk delete", "click", '#production-panel [data-action="bulk-delete"]', () => { productionPick("gear drone"); $('#production-panel [data-action="bulk-delete"]').click(); }),
  tags("the gear delete from list", "click", `#gear-panel [data-action="tag-delete"]${DRONE}`, () => {
    gearOpen(); expandedCard("#gear-panel", "gear drone"); $(`#gear-panel [data-action="tag-delete"]${DRONE}`).click();
  }),
  tags("the person remove", "click", '#production-panel [data-action="person-delete"][data-person="p2"]', () => {
    openProductionPanel(); $('#production-modes [data-group="person"]').click(); $('#production-panel [data-action="person-delete"][data-person="p2"]').click();
  }),
  tags("the gear quick add", "click", "#gear-quickadd-save", () => { gearOpen(); typeIn("#gear-quickadd-input", "Drone\nCrane", [0, 5]); }, true),
  comments("the comment Post button", "click", "#comment-post", () => { composer("C9"); }),
  comments("the comment Cancel button", "click", "#comment-cancel", () => { composer("C9"); }),
  comments("the reply Post button", "click", '[data-action="reply-post"][data-id="C1"]', replyOpen),
  comments("the comment delete", "click", '#comments-panel [data-action="delete-comment"][data-id="C1"]', () => {
    openCommentsPanel();
    if (!document.querySelector('#comments-panel [data-action="delete-comment"][data-id="C1"]')) $('[data-action="comment-menu"][data-id="C1"]').click();
    $('#comments-panel [data-action="delete-comment"][data-id="C1"]').click();
  }),
  comments("the comment resolve button", "click", '[data-action="toggle-resolve"][data-id="C1"]', () => { openCommentsPanel(); }),
  comments("the comment assignee control", "change", '.comment-assignee-select[data-id="C1"]', () => {
    openCommentsPanel(); choose('.comment-assignee-select[data-id="C1"]', optionNamed('.comment-assignee-select[data-id="C1"]', "Bob"));
  }),
  { name: "the gallery remove button", how: "click", target: ".scene-gallery-remove", state: galleryState, render: () => {}, kept: true,
    setup: () => { $('[data-action="gallery-open"][data-id="r1"][data-slot="1"]').click(); } }
];

for (const path of HELD_PATHS) for (const order of ORDERS) test(`C7 record held: ${path.name} refused at admission by a session hold writes nothing, keeps text, focus, selection and open state, and warns once, ${order}`, async () => {
  const f = await enter();
  let stop = () => {};
  try {
    path.setup();
    const target = $(path.target);
    if (path.how === "click") target.focus();
    const view = focused(), state = path.state();
    stop = f.parts.session.hold(ADMISSION_HELD);
    const start = refusedOnce(f, order, () => { FIRE[path.how](target); }, () => {
      const now = focused();
      assert.equal(now.active, view.active, "focus stays where it was");
      assert.deepEqual([now.value, now.range], [view.value, view.range], "the text and its selection stay");
      assert.deepEqual(path.state(), state, "the open state and its text stay");
      path.render();
      const shown = s => path.kept || !s.boxes ? s : { ...s, boxes: s.boxes.map(box => box.slice(0, 2)) };
      assert.deepEqual(shown(path.state()), shown(state), path.kept ? "the open state and its text survive a render" : "the open state survives a render");
    });
    stop();
    clearWarnings();
    exchange(f, order);
    agree(f, withZ(start));
    assert.deepEqual(warnings(), []);
  } finally { stop(); tidy(f); }
});

const HELD_OWNER_CALLS = [
  { name: "registering a production tag", act: () => { assert.equal(registerProductionTag("location", "Park"), false); } },
  { name: "finding or adding a person", act: () => { assert.equal(findOrAddPerson("Cy"), ""); } },
  { name: "adding a prop to a shot", act: () => { assert.deepEqual(currentBrollRecords()?.addBrollProp("b1", "Lamp"), { changed: false, held: true }); } },
  { name: "a picture edit", act: () => { assert.deepEqual(cellEditing().editGallery("r1", "Picture removed", row => removeGallerySlot(row, 1)), { changed: false, held: true }); } }
];

for (const call of HELD_OWNER_CALLS) for (const order of ORDERS) test(`C7 record held: the owner call for ${call.name} reports held, writes nothing and warns once, ${order}`, async () => {
  const f = await enter();
  const stop = f.parts.session.hold(ADMISSION_HELD);
  try {
    const start = refusedOnce(f, order, call.act);
    stop();
    clearWarnings();
    exchange(f, order);
    agree(f, withZ(start));
    assert.deepEqual(warnings(), []);
  } finally { stop(); tidy(f); }
});

for (const call of HELD_OWNER_CALLS) test(`C7 record held: the owner call for ${call.name} refused by a listener that announces it is not announced again`, async () => {
  const f = await enter();
  const stop = f.parts.session.beforeCommand(() => { notices.show(REFUSED, "warn"); return "announced"; });
  try { refusedOnce(f, "local-first", call.act); } finally { stop(); tidy(f); }
});

const doc = () => currentDocument();
const nameOf = id => doc().people.find(p => p.id === id)?.name ?? "";
const shotB1 = () => doc().brollShots.find(s => s.id === "b1");
const tagById = id => doc().productionTags.find(t => t?.id === id);
const cyOwns = owner => () => [doc().people.filter(p => p.name === "Cy").length, nameOf(owner())];
const blurOut = el => { el.focus(); el.blur(); };
const NOTES = `#broll-panel .broll-notes-input${B1}`, PAGE_NOTE = `#broll-page .broll-page-note${B1}`, TAG_NOTES = `#production-panel .tag-notes-input${MUG}`;
const RENAME = `#production-panel .tag-rename-input${MUG}`;
const heldPath = name => { const path = HELD_PATHS.find(p => p.name === name); assert.ok(path, name); return path; };
const typedRow = (name, box, saved, want, how = {}) => {
  const path = heldPath(name), real = path.how === "blur" ? blurOut : FIRE[path.how];
  return { ...path, box, saved, want, refuse: how.refuse ?? real, save: how.save ?? real, redraw: how.redraw ?? (path.state === brollState ? runBrollRefresh : path.render) };
};
const TYPED_PATHS = [
  typedRow("the b-roll bulk new person box", "#broll-bulk-input", cyOwns(() => shotB1().owner), [1, "Cy"]),
  typedRow("the b-roll bulk new location box", "#broll-bulk-input", () => shotB1().location, "Quay"),
  typedRow("the b-roll shot person box, Enter", `#broll-panel .broll-person-input${B1}`, cyOwns(() => shotB1().owner), [1, "Cy"]),
  typedRow("the b-roll shot person box, Add", `#broll-panel .broll-person-input${B1}`, cyOwns(() => shotB1().owner), [1, "Cy"]),
  typedRow("the b-roll add box", "#broll-add-input", () => doc().brollShots.filter(s => s.name === "Park").length, 1),
  typedRow("the b-roll prop box, Enter", `#broll-panel .broll-prop-input${B1}`, () => shotB1().props.map(p => p.name), ["Mug", "Lamp"]),
  typedRow("the b-roll prop box, a suggestion pick", `#broll-panel .broll-prop-input${B1}`, () => shotB1().props.map(p => p.name), ["Mug", "Lamp"]),
  typedRow("the b-roll location box, Enter", LOC, () => shotB1().location, "Quay"),
  typedRow("the b-roll location box, blur", LOC, () => shotB1().location, "Quay"),
  typedRow("the b-roll audio box, blur", REF, () => shotB1().audioRef, "0:12"),
  typedRow("the b-roll notes box, blur", NOTES, () => shotB1().notes, "Wide"),
  { name: "the b-roll notes box, typing then a redraw", box: NOTES, target: NOTES, saved: () => shotB1().notes, want: "Wide", redraw: runBrollRefresh,
    setup: () => { brollOpen("b1"); typeIn(NOTES, "Wide", [1, 2]); }, refuse: () => { runBrollRefresh(); }, save: blurOut },
  { name: "the b-roll page note, Enter", box: PAGE_NOTE, target: PAGE_NOTE, saved: () => shotB1().notes, want: "Wide", redraw: runBrollRefresh,
    setup: () => { openBrollPage(); typeIn(PAGE_NOTE, "Wide", [1, 2]); }, refuse: el => { press(el, "Enter"); }, save: blurOut },
  typedRow("the tag person box, Enter", `#production-panel .tag-person-input${MUG}`, cyOwns(() => tagById(M).owner), [1, "Cy"]),
  typedRow("the tag person box, Add", `#production-panel .tag-person-input${MUG}`, cyOwns(() => tagById(M).owner), [1, "Cy"]),
  typedRow("the gear tag person box, Enter", `#gear-panel .tag-person-input${DRONE}`, cyOwns(() => tagById(D).owner), [1, "Cy"]),
  typedRow("the tag bulk person box, Enter", "#bulk-person-input", cyOwns(() => tagById(M).owner), [1, "Cy"]),
  typedRow("the tag bulk person box, Add", "#bulk-person-input", cyOwns(() => tagById(M).owner), [1, "Cy"]),
  { name: "the tag notes box, typing then blur", box: TAG_NOTES, target: TAG_NOTES, saved: () => tagById(M).notes, want: "Wide", redraw: renderProduction,
    setup: () => { productionCards(); expandedCard("#production-panel", "prop mug"); typeIn(TAG_NOTES, "Wide", [1, 2]); },
    refuse: el => { el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "e" })); }, save: blurOut },
  typedRow("the gear quick add", "#gear-quickadd-input", () => doc().productionTags.filter(t => t?.cat === "gear").map(t => t.name).sort(), ["Crane", "Drone"]),
  typedRow("the comment Post button", "#comment-name", () => doc().comments.map(c => c.id), ["C1", "C9"]),
  typedRow("the reply Post button", '.reply-composer[data-for="C1"] .reply-name-input', () => doc().comments[0].replies.map(r => r.body), ["ok"])
];
const boxValue = selector => $(selector).value;

for (const path of TYPED_PATHS) for (const order of ORDERS) test(`C7 record held, typed text: ${path.name} keeps the typed text after the refusal and after a redraw, then saves it once after release and blur or Enter, ${order}`, async () => {
  const f = await enter();
  let stop = () => {};
  try {
    path.setup();
    const typed = boxValue(path.box), before = path.saved(), warned = () => noticeCalls.filter(call => call[1] === "warn");
    stop = f.parts.session.hold(ADMISSION_HELD);
    noticeCalls.length = 0;
    path.refuse($(path.target));
    assert.deepEqual([warned(), boxValue(path.box), path.saved()], [[[REFUSED, "warn"]], typed, before], "after the refusal");
    noticeCalls.length = 0;
    path.redraw();
    assert.deepEqual([warned(), boxValue(path.box), path.saved()], [[], typed, before], "after a redraw");
    stop();
    path.save($(path.target));
    assert.deepEqual([warned(), path.saved()], [[], path.want], "saved once after release");
    exchange(f, order);
    agree(f, shape(currentDocument()));
  } finally { stop(); closeBrollPage(() => {}); tidy(f); }
});

test("C7 record held, typed text: renaming a tag keeps its box, text, focus and selection after the rule 73 refusal and after a redraw", async () => {
  const f = await enter();
  try {
    productionCards();
    $(`#production-panel [data-action="tag-rename"]${MUG}`).click();
    typeIn(RENAME, "Cup", [1, 2]);
    const view = focused(), before = shape(currentDocument());
    noticeCalls.length = 0;
    press($(RENAME), "Enter");
    assert.deepEqual(noticeCalls.filter(call => call[1] === "warn"), [[REFUSED, "warn"]]);
    const kept = () => { const now = focused(); assert.equal(now.active, $(RENAME)); assert.deepEqual([now.value, now.range], [view.value, view.range]); };
    assert.equal(document.activeElement, view.active, "the box itself stays");
    kept();
    noticeCalls.length = 0;
    renderProduction();
    kept();
    assert.deepEqual(noticeCalls, []);
    assert.deepEqual(shape(currentDocument()), before);
    press($(RENAME), "Escape");
    exchange(f, "local-first");
    agree(f, before);
  } finally { tidy(f); }
});

const PREP_CHOICES = [
  { name: "the scene-prep Ready button", notice: "Marked as Have it", act: () => {
    const button = $("#production-list").appendChild(document.createElement("button"));
    button.dataset.prep = "ready"; button.dataset.id = "prop mug";
    try { assert.equal(clickProductionOutline({ target: button }), true); } finally { button.remove(); }
  } },
  { name: "the scene-prep status choice", notice: "Requirement status updated", act: () => {
    const select = $("#production-list").appendChild(document.createElement("select"));
    select.className = "prep-status-select"; select.dataset.key = "prop mug"; select.add(new window.Option("Have it", "have", true, true));
    try { changeProductionOutline(select); } finally { select.remove(); }
  } }
];

for (const choice of PREP_CHOICES) for (const order of ORDERS) test(`C7 record held: ${choice.name} refused at admission by a session hold shows the refusal once and no success notice, ${order}`, async () => {
  const f = await enter();
  const stop = f.parts.session.hold(ADMISSION_HELD);
  try {
    openProductionPanel();
    const start = refusedOnce(f, order, choice.act);
    stop();
    clearWarnings();
    exchange(f, order);
    agree(f, withZ(start));
  } finally { stop(); tidy(f); }
});

for (const choice of PREP_CHOICES) for (const order of ORDERS) test(`C7 record caller literal: ${choice.name} saves in a shared session with its notice and no Undo button (rule 157), ${order}`, async () => {
  const f = await enter();
  try {
    openProductionPanel();
    remoteInsert(f.peer, "r2", "audioText", 0, "Z");
    const start = shape(currentDocument());
    noticeCalls.length = 0; clearWarnings();
    assert.doesNotThrow(choice.act);
    assert.deepEqual(noticeCalls, [[choice.notice, "ok"]]);
    const toast = [...toastHost().querySelectorAll(".toast")].find(el => el.firstChild.textContent === choice.notice);
    assert.ok(toast, "the notice shows");
    assert.equal(toast.querySelector(".toast-action"), null, "the notice has no Undo button");
    exchange(f, order);
    agree(f, edit(withZ(start), n => { n.tags.find(t => t[1] === "Mug")[3] = "have"; }));
  } finally { tidy(f); }
});

const NOOPS = [
  { name: "the b-roll shot person box naming the owner it already has closes the box",
    act: () => { brollOpen("b1"); brollButton("broll-person-new", "b1").click(); typeIn(`#broll-panel .broll-person-input${B1}`, "Ann", [3, 3]); FIRE.enter($(`#broll-panel .broll-person-input${B1}`)); },
    cleaned: () => { assert.equal(document.querySelector(`#broll-panel .broll-person-input${B1}`), null); } },
  { name: "the b-roll prop box naming a prop the shot already has empties the box and keeps it focused",
    act: () => { brollOpen("b1"); typeIn(`#broll-panel .broll-prop-input${B1}`, "mug", [3, 3]); FIRE.enter($(`#broll-panel .broll-prop-input${B1}`)); },
    cleaned: () => { const box = $(`#broll-panel .broll-prop-input${B1}`); assert.equal(box.value, ""); assert.equal(document.activeElement, box); } },
  { name: "the gear tag person box naming the owner it already has closes the box and focuses Add person",
    act: () => { gearOpen(); expandedCard("#gear-panel", "gear drone"); $(`#gear-panel [data-action="tag-person-new"]${DRONE}`).click();
      typeIn(`#gear-panel .tag-person-input${DRONE}`, "Ann", [3, 3]); FIRE.enter($(`#gear-panel .tag-person-input${DRONE}`)); },
    cleaned: () => {
      assert.equal(document.querySelector(`#gear-panel .tag-person-input${DRONE}`), null);
      assert.equal(document.activeElement, $(`#gear-panel [data-action="tag-person-new"]${DRONE}`));
    } },
  { name: "the comment Cancel button after a peer removed the anchor closes the composer",
    act: () => { composer("C8"); $("#comment-cancel").click(); },
    cleaned: () => { const [hidden, , body] = commentState().composer; assert.deepEqual([hidden, body], [true, ""]); } },
  { name: "a picture edit that changes nothing",
    act: () => { assert.deepEqual(cellEditing().editGallery("r1", "Made the cover", row => moveGallerySlot(row, 0, 0)), { changed: false, held: false }); },
    cleaned: () => {} }
];

function noopOnce(act, cleaned, written) {
  const start = shape(currentDocument()), before = written();
  noticeCalls.length = 0;
  act();
  assert.deepEqual(noticeCalls, []);
  assert.deepEqual(written(), before);
  assert.deepEqual(shape(currentDocument()), start);
  cleaned();
}

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

const tagAnchor = name => '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="' + name + '" contenteditable="false">' + name + "</span>";
const LAMP = "t_3lampxyzq0abc";
const SCENED = { ...SOURCE, sections: [{ id: "H1", name: "Open", firstSceneId: "r1" }, { id: "H2", name: "Close", firstSceneId: "r2" }],
  rows: [{ ...SOURCE.rows[0], visualText: SOURCE.rows[0].visualText + " " + tagAnchor("Mug") }, { ...SOURCE.rows[1], visualText: SOURCE.rows[1].visualText + " " + tagAnchor("Lamp") }],
  productionTags: [...SOURCE.productionTags, { id: LAMP, cat: "prop", name: "Lamp", owner: "", notes: "", status: "needed" }] };
const OTHER = { ...SOURCE, title: "Other script", brollShots: [{ ...SOURCE.brollShots[0], name: "Harbour", props: [] }] };
const PROP = `#broll-panel .broll-prop-input${B1}`;
const shownValue = selector => document.querySelector(selector)?.value ?? "";

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

async function refusedNotes() {
  const f = await enter();
  try {
    brollOpen("b1"); typeIn(NOTES, "Wide", [4, 4]);
    const stop = f.parts.session.hold(ADMISSION_HELD);
    try { blurOut($(NOTES)); } finally { stop(); }
    assert.equal(shotB1().notes, "");
  } finally { tidy(f); }
}

test("C7 record typed text: after a refused notes write and leaving, a standalone redraw saves the same notes, as on main", async () => {
  await refusedNotes();
  adopt(SOURCE);
  brollOpen("b1"); typeIn(NOTES, "Wide", [4, 4]); runBrollRefresh();
  assert.equal(shotB1().notes, "Wide");
  document.activeElement?.blur?.();
});

test("C7 record typed text: a refused notes write does not outlive its session, so the next session's redraw saves the same notes", async () => {
  await refusedNotes();
  const f = await enter();
  try {
    brollOpen("b1"); typeIn(NOTES, "Wide", [4, 4]); runBrollRefresh(); runBrollRefresh();
    assert.equal(shotB1().notes, "Wide");
  } finally { tidy(f); }
});
