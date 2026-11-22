import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { trackGlobalListeners } from "./_global-listener-inventory.mjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { currentWhoList } from "../bootstrap/wiring/who-list.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const inventory = trackGlobalListeners();
await bootApp();
after(closeApp);
const eventErrors = [];
const onError = event => { eventErrors.push(event.error); event.preventDefault(); };
window.addEventListener("error", onError);
after(() => { window.removeEventListener("error", onError); });

const warning = ["This is not available in a shared session yet.", "warn"];
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const visualCell = (id = "r1") => document.querySelector(`#rows .cell-editable[data-id="${id}"][data-field="visualText"]`);
const audioCell = (id = "r1") => document.querySelector(`#rows .cell-editable[data-id="${id}"][data-field="audioText"]`);
const imageButton = (id = "r1") => document.querySelector(`#rows .row[data-id="${id}"] [data-action="image-add"]`);
const listEl = () => document.getElementById("who-list");
const options = () => listEl().hidden ? [] : [...listEl().querySelectorAll(".who-option")]
  .map(el => (el.getAttribute("aria-selected") === "true" ? "*" : "") + el.textContent);
const place = (node, from, to = from) => { node.focus(); setCellSelection(node, from, to); };
const selectBackward = (node, anchor, head) => {
  node.focus();
  const a = posToDom(node, anchor), h = posToDom(node, head);
  document.getSelection().setBaseAndExtent(a.node, a.offset, h.node, h.offset);
};
const selectionState = () => {
  const sel = document.getSelection();
  return [document.activeElement, sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset];
};

function beforeInput(node, inputType, data = null, targetRange = null) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data });
  const range = targetRange ?? document.getSelection().getRangeAt(0);
  Object.defineProperty(event, "getTargetRanges", { value: () => [range.cloneRange()] });
  node.dispatchEvent(event);
  return event;
}

function keydown(node, key, options = {}) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options });
  node.dispatchEvent(event);
  return event;
}

function compose(node, stage, data = "") {
  node.dispatchEvent(new window.CompositionEvent("composition" + stage, { bubbles: true, data }));
}

function startPreedit(node, text) {
  compose(node, "start");
  compose(node, "update", text);
  const range = document.getSelection().getRangeAt(0);
  const before = new window.InputEvent("beforeinput", {
    bubbles: true, cancelable: false, inputType: "insertCompositionText", data: text, isComposing: true
  });
  Object.defineProperty(before, "getTargetRanges", { value: () => [range.cloneRange()] });
  assert.equal(node.dispatchEvent(before), true);
  const inserted = document.createTextNode(text);
  range.insertNode(inserted);
  document.getSelection().collapse(inserted, text.length);
  node.dispatchEvent(new window.InputEvent("input", {
    bubbles: true, inputType: "insertCompositionText", data: text, isComposing: true
  }));
}

function backspaceRange(node) {
  const sel = cellSelection(node);
  const start = posToDom(node, sel.from - 1), end = posToDom(node, sel.from);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

async function openShared(order, visualText = "") {
  const fixture = entrySwitchFixture();
  adoptReplacement(migrateRows({
    schema: 2, title: "Split Visual person picker", paragraphsDecided: true,
    people: [{ id: "p1", name: "Alice" }, { id: "p2", name: "Alex" }],
    rows: [
      { id: "r1", audioText: "Hello", visualText },
      { id: "r2", audioText: "other", visualText: "other" }
    ]
  }));
  undoOwner().flush();
  const writer = writerControls();
  writer.openWriter();
  const ports = { ...fixture.ports, commandRefused: sharedCommandRefusalNotice(notices) };
  let native;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  writer.closeWriter();
  const peer = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Peer" });
  const packets = [];
  const stop = peer.subscribeLocalUpdates(bytes => packets.push(bytes));
  for (const [offset, letter] of [[0, "P"], [1, "Q"]]) {
    const at = peer.commands.anchorText({ beat: "r2", cell: "narration" }, offset);
    assert.equal(at.kind, "anchored");
    assert.equal(peer.commands.typeText(at.range, letter, {}).kind, "written");
  }
  stop();
  for (const bytes of order === "reverse" ? packets.toReversed() : packets) {
    assert.equal(applyNativePeerUpdate(native, bytes), true);
  }
  await tick();
  assert.deepEqual(currentDocument(), peer.document());
  return { native, peer, errors: fixture.errors };
}

async function typeChars(native, peer, node, text) {
  for (const ch of text) {
    const packets = [];
    const stop = native.subscribeLocalUpdates(bytes => packets.push(bytes));
    const event = beforeInput(node, "insertText", ch);
    assert.equal(event.defaultPrevented, true);
    await tick();
    stop();
    assert.equal(packets.length, 1);
    assert.equal(applyNativePeerUpdate(peer, packets[0]), true);
    assert.deepEqual(currentDocument(), native.document());
    assert.deepEqual(currentDocument(), peer.document());
  }
}

function landAndVerify(native, peer, baseline, errors) {
  const snapshot = structuredClone(currentDocument());
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.notEqual(currentDocument().docId, snapshot.docId);
  assert.deepEqual({ ...currentDocument(), docId: snapshot.docId }, migrateRows(snapshot));
  assert.equal(native.isClosingOrClosed(), true);
  assert.equal(sharedSession(), false);
  peer.close();
  assert.deepEqual([errors, eventErrors], [[], []]);
  assert.deepEqual(inventory(), baseline);
}

for (const order of ["forward", "reverse"]) {
  test(`Split Visual typing opens, refreshes, navigates, deletes and refuses collapsed Tab once (${order})`, async t => {
    const show = t.mock.method(notices, "show", () => {});
    const baseline = inventory();
    const { native, peer, errors } = await openShared(order);
    const node = visualCell(), who = currentWhoList();
    try {
      place(node, 0);
      await typeChars(native, peer, node, "@");
      assert.equal(who.isOpen(node), true);
      assert.deepEqual(options(), ["*Alice", "Alex"]);
      assert.equal(document.activeElement, node);
      assert.deepEqual(cellSelection(node), { from: 1, to: 1 });
      assert.equal(show.mock.calls.length, 0);

      await typeChars(native, peer, node, "A");
      assert.deepEqual(options(), ["*Alice", "Alex", "A"]);
      assert.deepEqual(cellSelection(node), { from: 2, to: 2 });

      await typeChars(native, peer, node, "l");
      assert.deepEqual(options(), ["*Alice", "Alex", "Al"]);
      assert.deepEqual(cellSelection(node), { from: 3, to: 3 });

      assert.equal(keydown(node, "ArrowDown").defaultPrevented, true);
      assert.deepEqual(options(), ["Alice", "*Alex", "Al"]);
      assert.equal(keydown(node, "ArrowUp").defaultPrevented, true);
      assert.deepEqual(options(), ["*Alice", "Alex", "Al"]);
      assert.equal(show.mock.calls.length, 0);

      const bytesBeforeTab = native.encodeState(), peerBeforeTab = peer.encodeState();
      const docBeforeTab = structuredClone(currentDocument()), selBeforeTab = selectionState();
      const tabPackets = [];
      const stopTab = native.subscribeLocalUpdates(bytes => tabPackets.push(bytes));
      const tab = keydown(node, "Tab");
      await tick();
      stopTab();
      assert.equal(tab.defaultPrevented, true);
      assert.deepEqual(show.mock.calls.map(call => call.arguments), [warning]);
      assert.equal(who.isOpen(node), false);
      assert.equal(listEl().hidden, true);
      assert.deepEqual(tabPackets, []);
      assert.deepEqual(native.encodeState(), bytesBeforeTab);
      assert.deepEqual(peer.encodeState(), peerBeforeTab);
      assert.deepEqual(currentDocument(), docBeforeTab);
      assert.equal(node.innerHTML, "@Al");
      selectionState().forEach((value, index) => assert.equal(value, selBeforeTab[index]));

      show.mock.resetCalls();
      await typeChars(native, peer, node, " @");
      assert.equal(who.isOpen(node), true);
      assert.deepEqual(options(), ["*Alice", "Alex"]);
      assert.equal(keydown(node, "Escape").defaultPrevented, true);
      assert.equal(who.isOpen(node), false);
      assert.equal(show.mock.calls.length, 0);

      await typeChars(native, peer, node, " adam@");
      assert.equal(who.isOpen(node), false);
      assert.equal(listEl().hidden, true);

      await typeChars(native, peer, node, " @A");
      assert.equal(who.isOpen(node), true);
      assert.deepEqual(options(), ["*Alice", "Alex", "A"]);
      const delPackets = [];
      const stopDel = native.subscribeLocalUpdates(bytes => delPackets.push(bytes));
      assert.equal(beforeInput(node, "deleteContentBackward", null, backspaceRange(node)).defaultPrevented, true);
      await tick();
      assert.equal(who.isOpen(node), true);
      assert.deepEqual(options(), ["*Alice", "Alex"]);
      assert.equal(beforeInput(node, "deleteContentBackward", null, backspaceRange(node)).defaultPrevented, true);
      await tick();
      stopDel();
      assert.equal(delPackets.length, 2);
      for (const packet of delPackets) assert.equal(applyNativePeerUpdate(peer, packet), true);
      assert.equal(who.isOpen(node), false);
      assert.equal(listEl().hidden, true);
      assert.deepEqual(currentDocument(), peer.document());
      assert.equal(show.mock.calls.length, 0);

      landAndVerify(native, peer, baseline, errors);
    } finally {
      who.cancel();
      if (sharedSession() && !leaveRunningSharedSession().ok) forceLeaveSharedSession();
      if (!peer.isClosingOrClosed()) peer.close();
    }
  });

  test(`Split Visual selected Tab covers both pre-selectionchange and natural selectionchange routes (${order})`, async t => {
    const show = t.mock.method(notices, "show", () => {});
    for (const fireSelectionChange of [false, true]) {
      show.mock.resetCalls();
      const baseline = inventory();
      const { native, peer, errors } = await openShared(order);
      const node = visualCell(), who = currentWhoList();
      try {
        place(node, 0);
        await typeChars(native, peer, node, "@Al");
        assert.equal(who.isOpen(node), true);
        assert.deepEqual(options(), ["*Alice", "Alex", "Al"]);

        selectBackward(node, 3, 2);
        if (fireSelectionChange) {
          document.dispatchEvent(new window.Event("selectionchange"));
          assert.equal(who.isOpen(node), false);
          assert.equal(listEl().hidden, true);
        } else {
          assert.equal(who.isOpen(node), true);
        }
        const before = structuredClone(currentDocument()), bytes = native.encodeState(), peerBytes = peer.encodeState();
        const sel = selectionState(), packets = [];
        const stop = native.subscribeLocalUpdates(update => packets.push(update));
        const tab = keydown(node, "Tab");
        await tick();
        stop();
        assert.equal(tab.defaultPrevented, !fireSelectionChange);
        assert.deepEqual(show.mock.calls.map(call => call.arguments), []);
        assert.equal(who.isOpen(node), false);
        assert.equal(listEl().hidden, true);
        assert.deepEqual(packets, []);
        assert.deepEqual(native.encodeState(), bytes);
        assert.deepEqual(peer.encodeState(), peerBytes);
        assert.deepEqual(currentDocument(), before);
        assert.equal(node.innerHTML, "@Al");
        selectionState().forEach((value, index) => assert.equal(value, sel[index]));

        landAndVerify(native, peer, baseline, errors);
      } finally {
        who.cancel();
        if (sharedSession() && !leaveRunningSharedSession().ok) forceLeaveSharedSession();
        if (!peer.isClosingOrClosed()) peer.close();
      }
    }
  });

  test(`Split Visual composing Tab preserves preview, refreshes picker and commits once without double writes (${order})`, async t => {
    const show = t.mock.method(notices, "show", () => {});
    for (const scenario of ["synthetic-cancel", "trusted-commit-before-blur", "trusted-blur-before-commit"]) {
      show.mock.resetCalls();
      const baseline = inventory();
      const { native, peer, errors } = await openShared(order);
      const node = visualCell(), who = currentWhoList(), targetButton = imageButton();
      try {
        place(node, 0);
        await typeChars(native, peer, node, "@Al");
        assert.equal(who.isOpen(node), true);
        assert.deepEqual(options(), ["*Alice", "Alex", "Al"]);

        const beforeCompose = structuredClone(currentDocument()), bytes = native.encodeState(), peerBytes = peer.encodeState();
        const preeditPackets = [];
        const stopPreedit = native.subscribeLocalUpdates(update => preeditPackets.push(update));
        startPreedit(node, "i");
        await tick();
        assert.equal(node.innerHTML, "@Ali");
        assert.equal(document.activeElement, node);
        assert.deepEqual(cellSelection(node), { from: 4, to: 4 });
        assert.equal(who.isOpen(node), true);
        assert.deepEqual(options(), ["*Alice", "Ali"]);
        assert.deepEqual(preeditPackets, []);
        assert.deepEqual(currentDocument(), beforeCompose);
        assert.deepEqual(peer.document(), beforeCompose);

        const tab = keydown(node, "Tab", scenario === "synthetic-cancel" ? {} : { isComposing: true });
        await tick();
        assert.equal(tab.defaultPrevented, false);
        assert.deepEqual(show.mock.calls.map(call => call.arguments), []);
        assert.deepEqual(preeditPackets, []);
        assert.deepEqual(native.encodeState(), bytes);
        assert.deepEqual(peer.encodeState(), peerBytes);
        assert.equal(who.isOpen(node), true);
        assert.deepEqual(options(), ["*Alice", "Ali"]);
        stopPreedit();

        if (scenario === "synthetic-cancel") {
          compose(node, "end", "");
          await tick();
          assert.equal(node.innerHTML, "@Al");
          assert.equal(document.activeElement, node);
          assert.deepEqual(cellSelection(node), { from: 3, to: 3 });
          assert.equal(who.isOpen(node), true);
          assert.deepEqual(options(), ["*Alice", "Alex", "Al"]);
          assert.deepEqual(currentDocument(), beforeCompose);
          assert.deepEqual(peer.document(), beforeCompose);
        } else {
          const commitPackets = [];
          const stopCommit = native.subscribeLocalUpdates(update => commitPackets.push(update));
          const focusOut = () => {
            targetButton.focus();
            node.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: targetButton }));
          };
          if (scenario === "trusted-commit-before-blur") {
            compose(node, "end", "i");
            focusOut();
          } else {
            focusOut();
            await tick();
            compose(node, "end", "i");
          }
          await tick();
          stopCommit();
          assert.equal(commitPackets.length, 1);
          assert.equal(applyNativePeerUpdate(peer, commitPackets[0]), true);
          assert.equal(who.isOpen(node), false);
          assert.equal(listEl().hidden, true);
          assert.equal(document.activeElement, targetButton);
          assert.equal(node.innerHTML, "@Ali");
          assert.equal(currentDocument().rows[0].visualText, "@Ali");
          assert.deepEqual(currentDocument(), peer.document());
          assert.deepEqual(show.mock.calls.map(call => call.arguments), []);
        }

        landAndVerify(native, peer, baseline, errors);
      } finally {
        who.cancel();
        if (sharedSession()) {
          compose(node, "end", "");
          if (!leaveRunningSharedSession().ok) forceLeaveSharedSession();
        }
        if (!peer.isClosingOrClosed()) peer.close();
      }
    }
  });
}

test("outside shared Split Visual keeps existing behavior and standalone restores chip pick after Leave", async t => {
  const show = t.mock.method(notices, "show", () => {});
  const baseline = inventory();
  const { native, peer, errors } = await openShared("forward");
  const who = currentWhoList();
  try {
    const audio = audioCell();
    place(audio, 5);
    assert.equal(beforeInput(audio, "insertText", " ").defaultPrevented, true);
    assert.equal(beforeInput(audio, "insertText", "@").defaultPrevented, true);
    await tick();
    assert.equal(who.isOpen(), false);
    assert.equal(listEl().hidden, true);

    const writer = writerControls();
    writer.openWriter();
    writer.writerFlowControl().openVisual("r1");
    const writerVisual = document.querySelector('.wr-flow-visual-text[data-id="r1"][data-field="visualText"]');
    place(writerVisual, 0);
    assert.equal(beforeInput(writerVisual, "insertText", "@").defaultPrevented, true);
    await tick();
    assert.equal(who.isOpen(), false);
    assert.equal(listEl().hidden, true);
    writer.closeWriter();

    landAndVerify(native, peer, baseline, errors);

    const standaloneVisual = visualCell();
    place(standaloneVisual, 1);
    standaloneVisual.innerHTML = "@Al";
    setCellSelection(standaloneVisual, 3, 3);
    standaloneVisual.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "@" }));
    standaloneVisual.innerHTML = "@";
    setCellSelection(standaloneVisual, 1, 1);
    standaloneVisual.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "@" }));
    assert.equal(who.isOpen(standaloneVisual), true);
    assert.deepEqual(options(), ["*Alice", "Alex"]);
    assert.equal(keydown(standaloneVisual, "Tab").defaultPrevented, true);
    assert.equal(who.isOpen(standaloneVisual), false);
    assert.equal(standaloneVisual.querySelectorAll(".who-anchor").length, 1);
    assert.equal(standaloneVisual.querySelector(".who-anchor").getAttribute("data-who"), "Alice");
    assert.equal(show.mock.calls.length, 0);
  } finally {
    who.cancel();
    if (sharedSession() && !leaveRunningSharedSession().ok) forceLeaveSharedSession();
    if (!peer.isClosingOrClosed()) peer.close();
  }
});
