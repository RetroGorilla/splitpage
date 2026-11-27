import assert from "node:assert/strict";
import { test } from "node:test";
import { currentBrollRecords } from "../bootstrap/wiring/broll.ts";
import { openBrollPanel } from "../features/broll/panel.ts";
import { findOrAddPerson, registerProductionTag } from "../features/tags/production-tags.ts";
import { tagKey } from "../core/document/tags.ts";
import { buildPublishHtml } from "../adapters/page/page-shell.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { SHARED_ADMISSION_ANNOUNCED } from "../application/session/shared-session.ts";
import { cellEditing } from "../bootstrap/wiring/editor-owners.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedRecoverySession } from "../bootstrap/wiring/session-owner.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { removeGallerySlot } from "../core/document/gallery.ts";
import { openCommentsPanel, setCommentFilterMode } from "../features/comments/comments.ts";
import { selectedKeys } from "../bootstrap/wiring/production-editing-owners.ts";
import {
  addPersonForTag, applyGearQuickAdd, armDeleteTag, armPersonDelete, armRemoveTag, bulkDeleteSelected, openGearPanel,
  openProductionPanel, setTagOwner, setTagStatus
} from "../features/tags/panels.ts";
import {
  $, ADMISSION_HELD, B1, FIRE, M, MUG, REFUSED, SOURCE, adopt, brollButton, brollOpen, brollSelect, clearWarnings,
  commentState, expandedCard, galleryState, noticeCalls, press, productionCards, productionPick, shape, tidyStandalone,
  toastHost, twice, typeIn, warnings
} from "./_standalone-records.mjs";

const hook = window.__sharedTest;
const peer = hook.nativePeer;
const settle = () => new Promise(resolve => setImmediate(resolve));
const menu = '[data-action="comment-menu"][data-id="C1"]';
const remove = '[data-action="delete-comment"][data-id="C1"]';
const resolve = '[data-action="toggle-resolve"][data-id="C1"]';

async function enter(t, source = SOURCE) {
  adopt(source);
  assert.deepEqual(await hook.enter(), { ok: true });
  t.after(() => {
    tidyStandalone();
    assert.deepEqual(hook.leave(), { ok: true });
  });
  clearWarnings();
  noticeCalls.length = 0;
  const start = shape(hook.read().app);
  const standalone = undoOwner().sizes();
  const session = sharedRecoverySession();
  peer.seedReader();
  peer.hold("updates");
  assert.equal(peer.type("r2", 0, "Z").kind, "written");
  assert.equal(peer.type("r2", 6, "!").kind, "written");
  return { start, standalone, session };
}

function snapshot(session) {
  return [session.generation(), hook.read(), peer.queuedUpdates(), peer.readLateReader(), peer.queuedReaderUpdates(), undoOwner().sizes()];
}

function withPeer(start) {
  const next = structuredClone(start);
  next.rows[1][1] = "ZOther!";
  return next;
}

async function agree(expected, standalone) {
  await settle();
  const { app, peer: other } = hook.read();
  assert.deepEqual(shape(app), expected);
  assert.deepEqual(other, app);
  peer.deliverToReader("app");
  assert.deepEqual(peer.readLateReader(), app);
  assert.deepEqual(peer.freshSnapshot("peer"), app);
  assert.deepEqual(peer.queuedUpdates(), []);
  assert.deepEqual(peer.queuedReaderUpdates(), []);
  assert.deepEqual(undoOwner().sizes(), standalone);
}

function undo() {
  const target = $('#rows .cell-editable[data-id="r2"][data-field="audioText"]');
  target.focus();
  return press(target, "z", { ctrlKey: true });
}

async function exhausted(session) {
  const before = snapshot(session);
  undo();
  await settle();
  assert.deepEqual(snapshot(session), before);
}

function openGallery() {
  $('[data-action="gallery-open"][data-id="r1"][data-slot="1"]').click();
  assert.deepEqual(galleryState(), { open: 1, selected: ["1"] });
}

function armDelete() {
  $(menu).click();
  $(remove).click();
  assert.equal($(remove).classList.contains("armed"), true);
}

for (const order of ["forward", "reverse"]) {
  test("Native gallery owner and Remove preserve the selected picture on refusal, " + order, async t => {
    const { start, standalone, session } = await enter(t);
    openGallery();
    const button = $(".scene-gallery-remove");
    button.focus();
    const before = snapshot(session);
    const edit = t.mock.fn(row => removeGallerySlot(row, 1));
    const release = session.hold(ADMISSION_HELD);
    try {
      assert.deepEqual(cellEditing().editGallery("r1", "Picture removed", edit), { changed: false, held: true });
      button.click();
      assert.deepEqual(noticeCalls, [[REFUSED, "warn"], [REFUSED, "warn"]]);
    } finally { release(); }
    const stop = session.beforeCommand(() => {
      notices.show("Gallery edit blocked", "warn");
      return SHARED_ADMISSION_ANNOUNCED;
    });
    try { button.click(); } finally { stop(); }
    assert.equal(edit.mock.callCount(), 0);
    assert.deepEqual(noticeCalls, [[REFUSED, "warn"], [REFUSED, "warn"], ["Gallery edit blocked", "warn"]]);
    assert.deepEqual(galleryState(), { open: 1, selected: ["1"] });
    assert.equal(document.activeElement, button);
    assert.deepEqual(snapshot(session), before);
    assert.deepEqual(peer.release(order).map(packet => packet.to), ["app", "app"]);
    await agree(withPeer(start), standalone);
    $("#gallery-close").click();
    await exhausted(session);
  });

  test("Native gallery Remove and keyboard Undo converge with concurrent text, " + order, async t => {
    const { start, standalone, session } = await enter(t);
    openGallery();
    $(".scene-gallery-remove").click();
    assert.deepEqual(noticeCalls, [["Picture removed", "ok"]]);
    const toast = toastHost().querySelector(".toast.ok");
    assert.equal(toast?.firstChild.textContent, "Picture removed");
    assert.equal(toast.querySelector(".toast-action"), null);
    assert.deepEqual(galleryState(), { open: 1, selected: ["0"] });
    assert.deepEqual(peer.release(order).map(packet => packet.to), order === "forward" ? ["app", "app", "peer"] : ["peer", "app", "app"]);
    const after = withPeer(start);
    after.rows[0][3] = ["a", "c"];
    await agree(after, standalone);
    $("#gallery-close").click();
    peer.hold("updates");
    assert.equal(undo(), true);
    assert.deepEqual(peer.release(order).map(packet => packet.to), ["peer"]);
    await agree(withPeer(start), standalone);
    await exhausted(session);
  });

  for (const action of ["resolve", "reopen", "delete", "assign"]) {
    test("Native comment " + action + " isolates admission and history, " + order, async t => {
      const source = structuredClone(SOURCE);
      if (action === "reopen") {
        Object.assign(source.comments[0], { resolved: true, resolvedBy: "Ann", resolvedAt: source.comments[0].createdAt });
      }
      const { start, standalone, session } = await enter(t, source);
      openCommentsPanel();
      setCommentFilterMode(action === "reopen" ? "resolved" : "open");
      if (action === "delete") armDelete();
      const act = () => $(action === "delete" ? remove : resolve).click();
      const before = snapshot(session);
      const view = commentState();
      if (action === "assign") {
        const select = $('.comment-assignee-select[data-id="C1"]');
        assert.equal(select.disabled, true);
        select.focus();
        assert.notEqual(document.activeElement, select);
        select.value = "Bob";
        FIRE.change(select);
      } else {
        const release = session.hold(ADMISSION_HELD);
        try { act(); } finally { release(); }
      }
      assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
      assert.deepEqual(commentState(), view);
      assert.deepEqual(snapshot(session), before);
      assert.deepEqual(peer.release(order).map(packet => packet.to), ["app", "app"]);
      const expected = withPeer(start);
      await agree(expected, standalone);
      await exhausted(session);
      if (action === "assign") {
        assert.equal($('.comment-assignee-select[data-id="C1"]').disabled, true);
        return;
      }

      peer.hold("updates");
      assert.equal(peer.type("r2", 7, "?").kind, "written");
      if (action === "delete") {
        if (!document.querySelector(remove)) $(menu).click();
        $(remove).click();
      }
      act();
      assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
      assert.deepEqual(peer.release(order).map(packet => packet.to), order === "forward" ? ["app", "peer"] : ["peer", "app"]);
      expected.rows[1][1] += "?";
      const restored = structuredClone(expected);
      if (action === "resolve" || action === "reopen") {
        assert.equal(start.comments[0][1], action === "reopen");
        expected.comments[0][1] = action === "resolve";
      }
      if (action === "delete") {
        expected.comments = [];
        assert.match(start.rows[0][1], /data-cmt="C1"/);
      }
      await agree(expected, standalone);
      if (action === "delete") {
        const cell = $('#rows .cell-editable[data-id="r1"][data-field="audioText"]');
        assert.equal(cell.querySelector('.cmt-anchor[data-cmt="C1"]')?.textContent, "bc");
        const html = buildPublishHtml(JSON.stringify(hook.read().app));
        const saved = new window.DOMParser().parseFromString(html, "text/html").getElementById("state-data");
        const reopened = migrateRows(JSON.parse(saved.textContent));
        assert.deepEqual(reopened.comments, []);
        assert.equal(reopened.rows[0].audioText, start.rows[0][1]);
      }
      peer.hold("updates");
      assert.equal(undo(), true);
      assert.deepEqual(peer.release(order).map(packet => packet.to), ["peer"]);
      await agree(restored, standalone);
      await exhausted(session);
    });
  }

  for (const control of ["Ready", "status"]) {
    test("Native Scene Prep " + control + " stays refused after release without retry, " + order, async t => {
      const { start, standalone, session } = await enter(t);
      openProductionPanel();
      $('#production-modes [data-group="prep"]').click();
      const before = snapshot(session);
      const release = session.hold(ADMISSION_HELD);
      try {
        if (control === "Ready") $('.prep-ready[data-id="prop mug"]').click();
        else {
          const select = $('.prep-status-select[data-key="prop mug"]');
          select.value = "have";
          FIRE.change(select);
        }
      } finally { release(); }
      assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
      assert.deepEqual(snapshot(session), before);
      assert.deepEqual(peer.release(order).map(packet => packet.to), ["app", "app"]);
      await agree(withPeer(start), standalone);
      await exhausted(session);
    });
  }

  for (const [name, key, act] of [
    ["bulk deletion of a labelled tag", "prop mug", bulkDeleteSelected],
    ["removal of existing labels", "prop mug", () => twice(armRemoveTag, "prop mug")],
    ["removal of absent labels", "gear drone", () => twice(armRemoveTag, "gear drone")]
  ]) {
    test("Native tag refusal of " + name + " preserves records and history, " + order, async t => {
      const { start, standalone, session } = await enter(t);
      productionPick(key);
      const before = snapshot(session);
      act();
      assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
      assert.deepEqual(selectedKeys(), [key]);
      assert.deepEqual(snapshot(session), before);
      assert.deepEqual(peer.release(order).map(packet => packet.to), ["app", "app"]);
      await agree(withPeer(start), standalone);
      await exhausted(session);
      assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
    });
  }
  for (const action of ["B-roll status", "tag delete"]) {
    test("Native " + action + " refusal leaves no history before keyboard Undo round trip, " + order, async t => {
      const { start, standalone, session } = await enter(t);
      if (action === "B-roll status") brollOpen("b1");
      else {
        productionPick("gear drone");
        $('#production-panel [data-action="bulk-delete"]').click();
      }
      const currentButton = () => action === "B-roll status" ? brollButton("broll-status-toggle", "b1") : $('#production-panel [data-action="bulk-delete"]');
      const before = snapshot(session);
      const release = session.hold(ADMISSION_HELD);
      try { currentButton().click(); } finally { release(); }
      assert.deepEqual(noticeCalls, [[REFUSED, "warn"]]);
      assert.deepEqual(snapshot(session), before);
      assert.deepEqual(peer.release(order).map(packet => packet.to), ["app", "app"]);
      await agree(withPeer(start), standalone);
      await exhausted(session);
      peer.hold("updates");
      assert.equal(peer.type("r2", 7, "?").kind, "written");
      if (action === "tag delete") currentButton().click();
      currentButton().click();
      assert.equal(peer.release(order).length, 2);
      const expected = withPeer(start);
      expected.rows[1][1] += "?";
      const changed = structuredClone(expected);
      if (action === "tag delete") changed.tags.shift();
      else changed.shots[0][1] = "shot";
      await agree(changed, standalone);
      peer.hold("updates");
      assert.equal(undo(), true);
      assert.deepEqual(peer.release(order).map(packet => packet.to), ["peer"]);
      await agree(expected, standalone);
      await exhausted(session);
    });
  }
}

function tagPersonBox(panel, key) {
  expandedCard(panel, key);
  $(panel + ' [data-action="tag-person-new"][data-key="' + key + '"]').click();
  typeIn(panel + ' .tag-person-input[data-key="' + key + '"]', "Cy", [1, 2]);
}

const edit = (s, change) => { const next = structuredClone(s); change(next); return next; };

const keyboardLiterals = [
  { name: "registering a production tag", tagOnly: true, retainedTag: ["location", "Park", "", "needed"],
    act: () => { assert.equal(registerProductionTag("location", "Park"), true); },
    after: s => edit(s, n => { n.tags.push(["location", "Park", "", "needed"]); }) },
  { name: "finding or adding a person", act: () => { assert.notEqual(findOrAddPerson("Cy"), ""); },
    after: s => edit(s, n => { n.people.push("Cy"); }) },
  { name: "adding a prop to a shot", retainedTag: ["prop", "Lamp", "", "needed"],
    act: () => { assert.deepEqual(currentBrollRecords()?.addBrollProp("b1", "Lamp"), { changed: true, held: false }); },
    after: s => edit(s, n => { n.tags.push(["prop", "Lamp", "", "needed"]); n.shots[0][4].push("Lamp"); }) },
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
  { name: "the b-roll prop box", retainedTag: ["prop", "Lamp", "", "needed"], act: () => {
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
  { name: "the gear quick add", tagOnly: true, retainedTag: ["gear", "Crane", "", "needed"], act: () => {
    openGearPanel();
    const box = $("#gear-quickadd-input");
    box.value = "Drone\nCrane";
    applyGearQuickAdd();
  }, after: s => edit(s, n => { n.tags.push(["gear", "Crane", "", "needed"]); }) },
  { name: "advancing a tag's status", act: () => { openProductionPanel(); setTagStatus(tagKey("gear", "Drone"), null); },
    after: s => edit(s, n => { n.tags[0][3] = "sourcing"; }) },
  { name: "deleting a tag from its card", act: () => { openProductionPanel(); twice(armDeleteTag, tagKey("gear", "Drone")); },
    after: s => edit(s, n => { n.tags.shift(); }) },
  { name: "assigning a tag's owner", act: () => { openProductionPanel(); setTagOwner(tagKey("prop", "Mug"), "p2"); },
    after: s => edit(s, n => { n.tags[1][2] = "Bob"; }) },
  { name: "creating a person while assigning a tag (one undo step removes both)", act: () => { openProductionPanel(); addPersonForTag(tagKey("prop", "Mug"), "Cy"); },
    after: s => edit(s, n => { n.people.push("Cy"); n.tags[1][2] = "Cy"; }) },
  { name: "adding a person from the production panel", act: () => { openProductionPanel(); addPersonForTag(null, "Cy"); },
    after: s => edit(s, n => { n.people.push("Cy"); }) },
  { name: "deleting a person", act: () => { openProductionPanel(); twice(armPersonDelete, "p2"); },
    after: s => edit(s, n => { n.people = ["Ann"]; }) },
  { name: "posting a reply", act: () => {
    openCommentsPanel();
    $('[data-action="toggle-reply"][data-id="C1"]').click();
    $('.reply-composer[data-for="C1"] .cell-editable').textContent = "ok";
    $('[data-action="reply-post"][data-id="C1"]').click();
    assert.equal(document.querySelector('.reply-composer[data-for="C1"]'), null);
  }, after: s => edit(s, n => { n.comments[0][3] = ["ok"]; }) }
];

for (const literal of keyboardLiterals) for (const order of ["forward", "reverse"]) {
  test("Native keyboard Undo after " + literal.name + ", " + order, async t => {
    const { start, standalone, session } = await enter(t);
    literal.act();
    const queued = peer.queuedUpdates().map(packet => packet.to);
    const createsProp = literal.retainedTag && !literal.tagOnly;
    assert.deepEqual(queued, createsProp ? ["app", "app", "peer", "peer"] : ["app", "app", "peer"]);
    assert.deepEqual(peer.release(order).map(packet => packet.to), order === "forward" ? queued : queued.toReversed());
    await agree(withPeer(literal.after(start)), standalone);
    assert.deepEqual(warnings(), []);

    peer.hold("updates");
    assert.equal(undo(), true);
    assert.deepEqual(peer.release(order).map(packet => packet.to), literal.tagOnly ? [] : ["peer"]);
    const undone = withPeer(start);
    if (literal.retainedTag) undone.tags.push(literal.retainedTag);
    await agree(undone, standalone);
    await exhausted(session);
    assert.deepEqual(warnings(), []);
  });
}
