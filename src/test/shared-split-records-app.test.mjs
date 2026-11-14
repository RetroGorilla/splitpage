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
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { currentBrollRecords } from "../bootstrap/wiring/broll.ts";
import { cellEditing } from "../bootstrap/wiring/editor-owners.ts";
import { sharedCommentCommands, sharedGalleryCommands, sharedRecordCommands } from "../bootstrap/wiring/ports/shared-commands.ts";
import { findOrAddPerson, registerProductionTag } from "../features/tags/production-tags.ts";
import { addPersonForTag, applyGearQuickAdd, armDeleteTag, armPersonDelete, bulkDeleteSelected, openProductionPanel, setTagStatus, toggleCardSelection } from "../features/tags/panels.ts";
import { openBrollPanel } from "../features/broll/panel.ts";
import { armDeleteComment, closeCommentComposer, openCommentComposer, openCommentsPanel, postComment, postReply, setCommentAssignee, toggleReplyComposer, toggleResolve } from "../features/comments/comments.ts";
import { removeGallerySlot } from "../core/document/gallery.ts";
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
  refusal: () => null, settle: () => { undoOwner().flush(); }, detach: () => {},
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
      imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("b"), name: "Two" }] },
    { id: "r2", audioText: "Other", visualText: 'A <span class="tag-anchor" data-tag-cat="prop" data-tag-name="Mug" contenteditable="false">Mug</span>', status: "todo" }
  ],
  comments: [{ id: "C1", author: "Ann", createdAt: "2026-11-13T10:00:00.000Z", rowId: "r1", field: "audioText", anchorId: "C1", body: "note",
    quotedText: "bc", resolved: false, resolvedAt: null, resolvedBy: null, replies: [] }],
  people: [{ id: "p1", name: "Ann" }, { id: "p2", name: "Bob" }],
  productionTags: [{ id: D, cat: "gear", name: "Drone", owner: "p1", notes: "", status: "needed" }, { id: M, cat: "prop", name: "Mug", owner: "", notes: "", status: "needed" }],
  brollShots: [{ id: "b1", name: "City", desc: "", status: "unshot", reshoot: false, notes: "", owner: "p1", audioRef: "", location: "", props: [{ id: M, name: "Mug" }], origin: "list" }]
};

async function enter() {
  reports.length = 0; errors.length = 0; clearWarnings(); noticeCalls.length = 0;
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(SOURCE)));
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

const served = [
  { name: "registering a production tag", act: () => { assert.equal(registerProductionTag("location", "Park"), true); },
    after: s => edit(s, n => { n.tags.push(["location", "Park", "", "needed"]); }) },
  { name: "finding or adding a person", act: () => { assert.notEqual(findOrAddPerson("Cy"), ""); },
    after: s => edit(s, n => { n.people.push("Cy"); }) },
  { name: "adding a prop to a shot", act: () => { assert.equal(currentBrollRecords()?.addBrollProp("b1", "Lamp"), true); },
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
  }, after: s => edit(s, n => { n.people.push("Cy"); n.shots[0][2] = "Cy"; }) },
  { name: "the b-roll delete", act: () => {
    brollOpen("b1"); brollButton("broll-menu", "b1").click(); brollButton("broll-delete", "b1").click();
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
    openProductionPanel(); toggleCardSelection(tagKey("gear", "Drone")); bulkDeleteSelected();
  }, after: s => edit(s, n => { n.tags.shift(); }) },
  { name: "adding a person from the production panel", act: () => { openProductionPanel(); addPersonForTag(null, "Cy"); },
    after: s => edit(s, n => { n.people.push("Cy"); }) },
  { name: "deleting a person", act: () => { openProductionPanel(); twice(armPersonDelete, "p2"); },
    after: s => edit(s, n => { n.people = ["Ann"]; }) },
  { name: "removing a picture from the gallery (rule 152: its toast has no Undo)", act: () => {
    clearWarnings(); noticeCalls.length = 0;
    assert.doesNotThrow(() => { assert.equal(cellEditing().editGallery("r1", "Picture removed", row => removeGallerySlot(row, 1)), true); });
    assert.deepEqual(noticeCalls, [["Picture removed", "ok"]]);
    assert.deepEqual([...toastHost().querySelectorAll(".toast")].map(el => [el.firstChild.textContent, el.querySelector(".toast-action")]), [["Picture removed", null]]);
  }, after: s => edit(s, n => { n.rows[0][3] = ["a"]; }) },
  { name: "resolving a comment (rule 35 on #1414: a resolve records no undo step)", act: () => { toggleResolve("C1"); }, undoable: false,
    after: s => edit(s, n => { n.comments[0][1] = true; }) },
  { name: "assigning a comment", act: () => { setCommentAssignee("C1", "Bob"); }, after: s => edit(s, n => { n.comments[0][2] = "Bob"; }) },
  { name: "replying to a comment", act: () => { reply("Alice"); }, after: s => edit(s, n => { n.comments[0][3] = ["ok"]; }) },
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
  } finally { f.close(); }
});

const REFUSED = "This is not available in a shared session yet.";
const reply = name => {
  openCommentsPanel(); toggleReplyComposer("C1");
  const card = document.querySelector('.reply-composer[data-for="C1"]'); assert.ok(card);
  card.querySelector(".reply-name-input").value = name; card.querySelector(".cell-editable").innerHTML = "ok";
  postReply("C1");
};
const post = name => {
  openCommentComposer({ id: "C9", rowId: "r1", field: "visualText", quotedText: "yz" });
  document.getElementById("comment-name").value = name; document.getElementById("comment-body-editable").innerHTML = "new";
  postComment();
};
const refusals = [
  { name: "rule 153: posting a comment under another name than the session's", act: () => { post("Bob"); } },
  { name: "rule 153: replying under another name than the session's", act: () => { reply("Bob"); } },
  { name: "rule 73: bulk deleting a tag the script labels needs a text rewrite", act: () => {
    openProductionPanel(); toggleCardSelection(tagKey("prop", "Mug")); bulkDeleteSelected();
  } }
];

for (const literal of refusals) for (const order of ORDERS) test(`C7 record refusal: ${literal.name} is refused once and writes nothing, ${order}`, async () => {
  const f = await enter();
  try {
    remoteInsert(f.peer, "r2", "audioText", 0, "Z");
    const start = shape(currentDocument()), before = encodeSharedState(f.parts.handle), sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
    noticeCalls.length = 0;
    literal.act();
    assert.deepEqual(noticeCalls.filter(call => call[1] === "warn"), [[REFUSED, "warn"]]);
    assert.deepEqual(noticeCalls.filter(call => call[1] === "ok"), []);
    assert.deepEqual(encodeSharedState(f.parts.handle), before);
    assert.deepEqual(f.parts.undo.sizes(), sizes);
    assert.deepEqual(undoOwner().sizes(), standalone);
    clearWarnings();
    exchange(f, order);
    agree(f, withZ(start));
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
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
  assert.equal(currentBrollRecords()?.addBrollProp("b1", "Lamp"), true);
  assert.equal(cellEditing().editGallery("r1", "Picture removed", row => removeGallerySlot(row, 1)), true);
  const pictureToast = [...toastHost().querySelectorAll(".toast")].find(el => el.firstChild.textContent === "Picture removed");
  assert.ok(pictureToast?.querySelector(".toast-action"), "the standalone picture toast keeps its Undo");
  toggleResolve("C1");
  post("Bob");
  const s = shape(currentDocument());
  assert.deepEqual([s.people, s.tags.map(t => t[1]), s.shots[0][4], s.rows[0][3], s.comments.map(c => [c[0], c[1]])],
    [["Ann", "Bob", "Cy"], ["Drone", "Mug", "Park", "Lamp"], ["Mug", "Lamp"], ["a"], [["C1", true], ["C9", false]]]);
  assert.equal(currentDocument().comments[1].author, "Bob");
  assert.deepEqual(warnings(), []);
});
