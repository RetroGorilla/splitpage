import { bootApp, closeApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { cellEditing } from "../bootstrap/wiring/editor-owners.ts";
import { clearProductionSelection, selectedKeys } from "../bootstrap/wiring/production-editing-owners.ts";
import { openGearPanel, openProductionPanel } from "../features/tags/panels.ts";
import { openBrollPanel } from "../features/broll/panel.ts";
import { closeCommentComposer, openCommentComposer, postComment } from "../features/comments/comments.ts";
import { moveGallerySlot } from "../core/document/gallery.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));

await bootApp();
after(closeApp);

export const noticeCalls = [];
export const actualShow = notices.show;
notices.show = (...args) => { noticeCalls.push(args); return actualShow(...args); };
after(() => { notices.show = actualShow; });

export const toastHost = () => { const host = document.getElementById("toast-host"); assert.ok(host); return host; };
export const warnings = () => [...toastHost().querySelectorAll(".toast.warn")].map(el => el.firstChild.textContent);
export const clearWarnings = () => { toastHost().replaceChildren(); };

export const ref = letter => ({ sha256: letter.repeat(64), width: 10, height: 10, mime: "image/png" });
export const anchor = (id, text) => '<span class="cmt-anchor" data-cmt="' + id + '">' + text + "</span>";
export const D = "t_i9fk0si5uyzl";
export const M = "t_1okou1ndmeusp";

export const SOURCE = { schema: 2, title: "Shared records", paragraphsDecided: true, wordsPerMinute: 150,
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

export function adopt(source) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows(structuredClone(source)));
}

export function shape(doc) {
  const person = id => doc.people.find(p => p.id === id)?.name ?? "";
  return {
    rows: doc.rows.map(r => [r.id, r.audioText, r.visualText, [r.imageRef?.sha256?.[0] ?? null, ...(r.moreImages ?? []).map(m => m.imageRef?.sha256?.[0] ?? null)]]),
    comments: doc.comments.map(c => [c.id, c.resolved, c.assignee ?? "", (c.replies ?? []).map(reply => reply.body)]),
    people: doc.people.map(p => p.name),
    tags: doc.productionTags.filter(Boolean).map(t => [t.cat, t.name, person(t.owner), t.status]),
    shots: doc.brollShots.map(s => [s.name, s.status, person(s.owner), !!s.reshoot, (s.props ?? []).map(p => p.name)])
  };
}

export function press(target, key, modifiers = {}) {
  const handled = !target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
  target.dispatchEvent(new window.KeyboardEvent("keyup", { key, bubbles: true, ...modifiers }));
  return handled;
}

export function brollButton(action, id, extra = "") {
  const button = document.querySelector(`#broll-panel [data-action="${action}"][data-id="${id}"]${extra}`);
  assert.ok(button, action + " " + id); return button;
}

export function brollOpen(id) {
  openBrollPanel();
  if (!document.querySelector(`#broll-panel [data-action="broll-person-new"][data-id="${id}"]`)) brollButton("broll-expand", id).click();
}

export function brollSelect(id) {
  openBrollPanel();
  document.querySelector('#broll-panel [data-action="broll-bulk-clear"]')?.click();
  brollButton("broll-expand", id).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
}

export const twice = (arm, ...args) => { const button = document.createElement("button"); arm(button, ...args); arm(button, ...args); };

export const REFUSED = "This is not available in a shared session yet.";
export const ADMISSION_HELD = "held-for-test";

export const post = name => {
  openCommentComposer({ id: "C9", rowId: "r1", field: "visualText", quotedText: "yz" });
  document.getElementById("comment-name").value = name; document.getElementById("comment-body-editable").innerHTML = "new";
  postComment();
};

export const $ = selector => { const el = document.querySelector(selector); assert.ok(el, selector); return el; };
export const typeIn = (selector, text, range) => { const box = $(selector); box.focus(); box.value = text; box.setSelectionRange(...range); };
export const choose = (selector, value) => { const box = $(selector); box.focus(); box.value = value; };
export const ctrlClick = selector => { $(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })); };

export const FIRE = {
  click: el => { el.click(); },
  enter: el => { press(el, "Enter"); },
  change: el => { el.dispatchEvent(new window.Event("change", { bubbles: true })); },
  blur: el => { el.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); },
  pick: el => { el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertReplacementText" })); }
};

export const commentState = () => ({
  composer: [document.getElementById("comment-modal").hidden, document.getElementById("comment-name").value, document.getElementById("comment-body-editable").innerHTML],
  replies: [...document.querySelectorAll(".reply-composer")].map(card => [card.getAttribute("data-for"), card.querySelector(".reply-name-input").value, card.querySelector(".cell-editable").innerHTML]),
  menu: [...document.querySelectorAll('#comments-panel [data-action="delete-comment"]')].map(el => el.getAttribute("data-id"))
});

export const galleryState = () => ({
  open: [...document.querySelectorAll(".scene-gallery-remove")].filter(el => !el.closest("[hidden]")).length,
  selected: [...document.querySelectorAll(".scene-gallery-grid-tile.is-selected")].map(el => el.getAttribute("data-slot"))
});

export const B1 = '[data-id="b1"]';
export const MUG = '[data-key="prop mug"]';
export const DRONE = '[data-key="gear drone"]';

export function brollBulkNew(kind) { brollSelect("b1"); choose(`#broll-bulk-${kind}`, "__new__"); FIRE.change($(`#broll-bulk-${kind}`)); }
export function productionCards() { openProductionPanel(); $('#production-modes [data-group="cat"]').click(); }
export function expandedCard(panel, key) {
  if (!document.querySelector(`${panel} .tag-entity.is-expanded[data-key="${key}"]`)) $(`${panel} [data-action="tag-expand"][data-key="${key}"]`).click();
}
export function productionPick(key) { productionCards(); clearProductionSelection(); openProductionPanel(); ctrlClick(`#production-panel .tag-entity[data-key="${key}"] .tag-entity-row`); assert.deepEqual(selectedKeys(), [key]); }
export function gearOpen() { openGearPanel(); }
export function composer(id) {
  openCommentComposer({ id, rowId: "r1", field: "visualText", quotedText: "yz" });
  document.getElementById("comment-name").value = "Alice"; document.getElementById("comment-body-editable").innerHTML = "new";
}

export function tidyStandalone() {
  closeCommentComposer();
  clearProductionSelection();
  document.querySelector('#broll-panel [data-action="broll-bulk-clear"]')?.click();
  if (galleryState().open) $("#gallery-close").click();
  document.activeElement?.blur?.();
}

export const NOOPS = [
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

export function noopOnce(act, cleaned, written) {
  const start = shape(currentDocument()), before = written();
  noticeCalls.length = 0;
  act();
  assert.deepEqual(noticeCalls, []);
  assert.deepEqual(written(), before);
  assert.deepEqual(shape(currentDocument()), start);
  cleaned();
}
