import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { adoptReplacement, liveSession, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { posToDom } from "../features/common/cell-dom.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { scriptCellOf, sanitizeHtml } from "../bootstrap/richtext.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { enterSharedSession, forceLeaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";
import { Doc, encodeStateAsUpdate } from "yjs";
import { breakUndoGroup } from "../bootstrap/wiring/undo.ts";
import { mountNativeSharedInput } from "../bootstrap/wiring/native-shared-input.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const UNAVAILABLE = ["This is not available in a shared session yet.", "warn"];
const cell = (id = "r1") => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="audioText"]');
const beat = (id = "r1") => document.querySelector('#writer-doc .wr-beat[data-id="' + id + '"]');
const root = () => document.getElementById("writer-doc");
const app = (index = 0) => hook.read().app.rows[index].audioText;
const peer = (index = 0) => hook.read().peer.rows[index].audioText;
const flushed = () => delay(55);

function cleanSession() {
  if (!sharedSession() || hook.leave().ok) return;
  forceLeaveSharedSession();
  const allowed = () => ({ allowed: true });
  adoptReplacement(migrateRows({ title: "Standby", rows: [] }), createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
}

function beforeInput(target, inputType, data, extra = {}) {
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data, ...extra });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function deleteIn(target, host, from, to, direction = "Backward") {
  const start = posToDom(host, from), end = posToDom(host, to), range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContent" + direction });
  Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function compose(target, type, data) {
  const event = new window.CompositionEvent("composition" + type, { bubbles: true, cancelable: true, data });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function press(target, key, extra = {}) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ctrlKey: true, ...extra });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function typeKeys(target, keys) {
  for (const key of keys) assert.equal(beforeInput(target, "insertText", key), true, "key " + JSON.stringify(key));
}

function nativeBytes(doc, command) {
  const native = openNativeSession({ kind: "document", document: doc, conversion: {
    cells: scriptCellOf, creation: doc.docId, at: "2026-11-20", by: "Writer"
  } }, { actor: "Writer", sanitize: sanitizeHtml });
  try {
    command?.(native);
    return native.encodeState();
  } finally { native.close(); }
}

async function enter(t, rows = [{ id: "r1", audioText: "Hello", visualText: "Look" }], command, sections) {
  const doc = migrateRows({ schema: 2, title: "Native script", rows, sections });
  adoptReplacement(doc);
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await (command ? hook.enterFrom(nativeBytes(doc, command), { backend: "native" }) : hook.enter({ backend: "native" })), { ok: true });
  t.after(cleanSession);
  return show;
}

const joined = native => assert.equal(native.commands.joinRow("r2", "r1", " ").kind, "written");

function writer(t) {
  const control = writerControls();
  control.openWriter();
  t.after(control.closeWriter);
  root().focus();
  const flow = control.writerFlowControl();
  return {
    flow,
    caret: (id, from, to = from) => {
      flow.place({ anchor: { kind: "beat", rowId: id, offset: from }, head: { kind: "beat", rowId: id, offset: to } });
      document.dispatchEvent(new window.Event("selectionchange"));
    },
    at: () => {
      const range = flow.selection();
      return range && [range.anchor.rowId, range.anchor.offset, range.head.offset];
    }
  };
}

const views = {
  Split: {
    open: () => {},
    surface: () => cell(),
    caret: (_view, id, from, to = from) => { cell(id).focus(); setCellSelection(cell(id), from, to); },
    at: (_view, id = "r1") => {
      const selection = cellSelection(cell(id));
      return document.activeElement === cell(id) && selection ? [id, selection.from, selection.to] : null;
    },
    host: id => cell(id)
  },
  Writer: {
    open: t => writer(t),
    surface: () => root(),
    caret: (view, id, from, to = from) => { view.caret(id, from, to); },
    at: view => document.activeElement === root() ? view.at() : null,
    host: id => beat(id)
  }
};

test("Split: removing a beat with a simultaneous peer insertion preserves the peer letters and undoes the removal", async t => {
  const show = await enter(t, twoBeats);
  const remove = () => document.querySelector('#rows .row[data-id="r1"] [data-action="delete-row"]').click();
  views.Split.caret(null, "r1", 2);
  hook.nativePeer.hold();
  remove();
  assert.equal(app(), "Hello");
  remove();
  assert.deepEqual(hook.read().app.rows.map(row => row.id), ["r2"]);
  assert.equal(hook.nativePeer.type("r1", 2, "Y").kind, "written");
  hook.nativePeer.deliver();
  await Promise.resolve();
  assert.deepEqual(hook.read().app, hook.read().peer);
  assert.equal(app(), "YWorld");
  assert.equal(cell("r2").textContent, "YWorld");
  assert.equal(press(cell("r2"), "z"), true);
  assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["HeYllo", "World"]);
  assert.equal(views.Split.at(null)?.[0], "r1");
  await Promise.resolve();
  assert.deepEqual(hook.read().app, hook.read().peer);
  assert.equal(show.mock.callCount(), 0);
});

test("Split: scene controls add, rename and remove one heading in three undo steps", async t => {
  const show = await enter(t, twoBeats);
  const name = value => {
    const field = document.querySelector(".section-rename input");
    field.value = value;
    field.form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  };
  document.querySelector('#rows [data-action="add-section"][data-id="r2"]').click();
  name("Scene");
  const added = hook.read().app.sections[0];
  assert.equal(added.firstSceneId, "r2");
  const header = () => document.querySelector('.section-header[data-section-id="' + added.id + '"]');
  assert.equal(header().querySelector(".section-name").textContent, "Scene");
  header().querySelector('[data-section-action="rename"]').click();
  name("Changed");
  assert.equal(hook.read().app.sections[0].name, "Changed");
  header().querySelector('[data-section-action="remove"]').click();
  assert.equal(header(), null);
  assert.equal(hook.read().app.sections?.length ?? 0, 0);
  views.Split.caret(null, "r2", 0);
  assert.equal(press(cell("r2"), "z"), true);
  assert.equal(hook.read().app.sections[0].name, "Changed");
  assert.equal(press(cell("r2"), "z"), true);
  assert.deepEqual(hook.read().app.sections, [added]);
  assert.equal(press(cell("r2"), "z"), true);
  assert.equal(hook.read().app.sections?.length ?? 0, 0);
  await Promise.resolve();
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(show.mock.callCount(), 0);
});

test("Writer: renaming and removing a heading replay the heading caret", async t => {
  const show = await enter(t, twoBeats, undefined, [{ id: "section", name: "Scene", firstSceneId: "r2" }]);
  const view = writer(t), heading = () => root().querySelector(".wr-heading");
  const at = offset => ({ kind: "heading", sceneId: "section", offset });
  view.flow.place({ anchor: at(5), head: at(5) });
  typeKeys(root(), " two");
  assert.equal(heading().textContent, "Scene two");
  assert.equal(hook.read().app.sections[0].name, "Scene two");
  assert.deepEqual(view.flow.selection().head, at(9));
  view.flow.place({ anchor: at(0), head: at(0) });
  assert.equal(press(root(), "Backspace", { ctrlKey: false }), true);
  assert.equal(heading(), null);
  assert.equal(press(root(), "z"), true);
  assert.equal(heading().textContent, "Scene two");
  assert.deepEqual(view.flow.selection().head, at(0));
  assert.equal(press(root(), "z"), true);
  assert.equal(heading().textContent, "Scene tw");
  assert.deepEqual(view.flow.selection().head, at(8));
  await Promise.resolve();
  assert.deepEqual(hook.read().peer, hook.read().app);
  assert.equal(show.mock.callCount(), 0);
});

test("Writer: a stale heading cannot supply the range for a rename", async t => {
  const show = await enter(t, twoBeats, undefined, [{ id: "section", name: "Scene", firstSceneId: "r2" }]);
  const view = writer(t);
  const heading = root().querySelector(".wr-heading");
  heading.textContent = "Stale";
  const at = { kind: "heading", sceneId: "section", offset: 2 };
  view.flow.place({ anchor: at, head: at });
  const before = hook.read();
  assert.equal(beforeInput(root(), "insertText", "X"), true);
  assert.deepEqual(hook.read(), before);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
});

const threeBeats = () => [...twoBeats, { id: "r3", audioText: "Again" }];
const rowOrder = () => hook.read().app.rows.map(row => row.id);

test("Split: move-down and a row drag use native history", async t => {
  const show = await enter(t, threeBeats());
  document.querySelector('#rows [data-action="move-down"][data-id="r1"]').click();
  assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
  dragBeat("r2", "r3");
  assert.deepEqual(rowOrder(), ["r1", "r3", "r2"]);
  views.Split.caret(null, "r1", 0);
  assert.equal(press(cell(), "z"), true);
  assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
  assert.equal(press(document.activeElement, "z"), true);
  assert.deepEqual(rowOrder(), ["r1", "r2", "r3"]);
  assert.equal(show.mock.callCount(), 0);
});

function dragBeat(source, destination) {
  const row = document.querySelector('#rows .row[data-id="' + source + '"]');
  const drag = (target, type, clientY = 0) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
  row.setAttribute("draggable", "true");
  drag(row, "dragstart");
  drag(cell(destination), "dragover", 200);
  drag(cell(destination), "drop", 200);
}

for (const [route, move] of [
  ["menu move", () => document.querySelector('#rows [data-action="move-down"][data-id="r1"]').click()],
  ["drag", () => dragBeat("r1", "r2")]
]) test("Split: a " + route + " refuses an unseen change to its destination", async t => {
  const show = await enter(t, threeBeats());
  assert.equal(hook.nativePeer.moveBeat("r2", null).kind, "written");
  move();
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  await Promise.resolve();
  assert.deepEqual(rowOrder(), ["r1", "r3", "r2"]);
  assert.deepEqual(hook.read().peer, hook.read().app);
});

for (const [name, kind] of Object.entries(views)) {
  test(name + ": Alt+Enter splits only in Split", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 2);
    assert.equal(press(kind.surface(), "Enter", { altKey: true, ctrlKey: false }), true);
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), name === "Split" ? ["He", "llo"] : ["Hello"]);
    await Promise.resolve();
    assert.deepEqual(hook.read().app, hook.read().peer);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Alt+Down refuses when an unseen peer move changed the adjacent beat", async t => {
    const show = await enter(t, threeBeats()), view = kind.open(t);
    kind.caret(view, "r1", 2);
    assert.equal(hook.nativePeer.moveBeat("r2", null).kind, "written");
    assert.deepEqual(rowOrder(), ["r1", "r2", "r3"]);
    assert.equal(press(kind.surface(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    await Promise.resolve();
    assert.deepEqual(rowOrder(), ["r1", "r3", "r2"]);
    assert.deepEqual(hook.read().peer, hook.read().app);
  });

  test(name + ": Alt+Down restores both selection ends after a repaint, undo and redo", async t => {
    const show = await enter(t, threeBeats()), view = kind.open(t);
    let repaints = 0;
    const stop = liveSession().subscribe(change => {
      if (change.changes.rowsMoved) {
        repaints++;
        document.getSelection().removeAllRanges();
      }
    });
    t.after(stop);
    kind.caret(view, "r1", 1, 4);
    assert.equal(press(kind.surface(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
    assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
    assert.equal(repaints, 1);
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    kind.caret(view, "r2", 2);
    assert.equal(press(document.activeElement, "z"), true);
    assert.equal(repaints, 2);
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    kind.caret(view, "r2", 3);
    assert.equal(press(document.activeElement, "y"), true);
    assert.equal(repaints, 3);
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Alt+Down rebases a caret placed before buffered typing", async t => {
    const show = await enter(t, threeBeats()), view = kind.open(t);
    kind.caret(view, "r1", 3);
    typeKeys(kind.surface(), "X");
    assert.equal(app(), "Hello");
    kind.caret(view, "r1", 1);
    assert.equal(press(kind.surface(), "ArrowDown", { altKey: true, ctrlKey: false }), true);
    assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
    assert.equal(app(1), "HelXlo");
    assert.deepEqual(kind.at(view), ["r1", 1, 1]);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "HelXlo");
    assert.deepEqual(kind.at(view), ["r1", 1, 1]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Alt+Arrow moves the beat, replays its caret and converges with a competing move", async t => {
    const show = await enter(t, threeBeats()), view = kind.open(t);
    kind.caret(view, "r2", 2);
    const move = key => press(document.activeElement, key, { altKey: true, ctrlKey: false });
    assert.equal(move("ArrowUp"), true);
    assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
    assert.deepEqual(kind.at(view, "r2"), ["r2", 2, 2]);
    assert.equal(press(document.activeElement, "z"), true);
    assert.deepEqual(rowOrder(), ["r1", "r2", "r3"]);
    assert.deepEqual(kind.at(view, "r2"), ["r2", 2, 2]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.deepEqual(rowOrder(), ["r2", "r1", "r3"]);
    assert.deepEqual(kind.at(view, "r2"), ["r2", 2, 2]);
    assert.equal(press(document.activeElement, "z"), true);
    await Promise.resolve();
    hook.nativePeer.hold();
    assert.equal(move("ArrowUp"), true);
    assert.equal(hook.nativePeer.moveBeat("r2", null).kind, "written");
    hook.nativePeer.deliver();
    await Promise.resolve();
    const order = rowOrder().join(",");
    assert.ok(order === "r2,r1,r3" || order === "r1,r3,r2", order);
    assert.deepEqual(hook.read().peer, hook.read().app);
    const selector = name === "Split" ? "#rows .row" : "#writer-doc .wr-beat";
    assert.equal([...document.querySelectorAll(selector)].map(el => el.dataset.id).join(","), order);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Backspace removes a blank beat and undo restores it", async t => {
    const show = await enter(t, [twoBeats[0], { id: "r2", audioText: "" }]), view = kind.open(t);
    kind.caret(view, "r2", 0);
    assert.equal(press(document.activeElement, "Backspace", { ctrlKey: false }), true);
    assert.deepEqual(hook.read().app.rows.map(row => row.id), ["r1"]);
    assert.deepEqual(kind.at(view), ["r1", 5, 5]);
    await Promise.resolve();
    assert.equal(hook.nativePeer.type("r2", 0, "X").kind, "refused");
    assert.equal(press(kind.surface(), "z"), true);
    assert.deepEqual(hook.read().app.rows.map(row => row.id), ["r1", "r2"]);
    assert.deepEqual(kind.at(view, "r2"), ["r2", 0, 0]);
    assert.equal(press(document.activeElement, "y"), true);
    assert.deepEqual(kind.at(view), ["r1", 5, 5]);
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });
  test(name + ": Enter flushes typing, splits once and replays both carets", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 2);
    typeKeys(kind.surface(), "x");
    assert.equal(app(), "Hello");
    assert.equal(press(kind.surface(), "Enter", { ctrlKey: false }), true);
    const { app: local } = hook.read();
    const created = local.rows[1].id;
    assert.deepEqual(local.rows.map(row => row.audioText), ["Hex", "llo"]);
    assert.deepEqual(kind.at(view, created), [created, 0, 0]);
    assert.equal(kind.host(created).textContent.replace(/\u200b/g, ""), "llo");
    assert.equal(press(document.activeElement, "z"), true);
    assert.equal(app(), "Hexllo");
    assert.deepEqual(kind.at(view), ["r1", 3, 3]);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(press(kind.surface(), "y"), true);
    assert.deepEqual(kind.at(view, created), [created, 0, 0]);
    await Promise.resolve();
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Enter refuses a selection or an open composition", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 1, 3);
    assert.equal(press(kind.surface(), "Enter", { ctrlKey: false }), true);
    kind.caret(view, "r1", 2);
    compose(kind.surface(), "start", "");
    assert.equal(press(kind.surface(), "Enter", { ctrlKey: false }), true);
    assert.equal(beforeInput(kind.surface(), "insertParagraph", null), true);
    compose(kind.surface(), "end", "");
    assert.equal(app(), "Hello");
    assert.equal(show.mock.callCount(), 3);
  });

  test(name + ": recognised structure keys cancel the browser default during composition", async t => {
    const show = await enter(t, twoBeats), view = kind.open(t);
    kind.caret(view, "r1", 5);
    assert.equal(compose(kind.surface(), "start", ""), false);
    const before = hook.read();
    for (const signal of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal(press(kind.surface(), "Enter", { ctrlKey: false, ...signal }), true);
      assert.equal(press(kind.surface(), "Delete", { ctrlKey: false, ...signal }), true);
      assert.equal(press(kind.surface(), "ArrowDown", { altKey: true, ctrlKey: false, ...signal }), true);
    }
    assert.deepEqual(hook.read(), before);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), Array.from({ length: 6 }, () => UNAVAILABLE));
    compose(kind.surface(), "end", "X");
    assert.equal(app(), "HelloX");
  });

  test(name + ": Enter refuses stale narration and leaves the peer edit intact", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 2);
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    assert.equal(press(kind.surface(), "Enter", { ctrlKey: false }), true);
    await Promise.resolve();
    assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["YHello"]);
    assert.deepEqual(hook.read().peer, hook.read().app);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  });

  for (const peerSplits of [true, false]) {
    test(name + ": Enter converges with a simultaneous peer " + (peerSplits ? "split" : "insertion"), async t => {
      const show = await enter(t), view = kind.open(t);
      hook.nativePeer.hold();
      kind.caret(view, "r1", 2);
      assert.equal(press(kind.surface(), "Enter", { ctrlKey: false }), true);
      const other = peerSplits ? hook.nativePeer.split("r1", 4) : hook.nativePeer.type("r1", 3, "Y");
      assert.equal(other.kind, "written");
      hook.nativePeer.deliver();
      await Promise.resolve();
      const { app: local, peer: remote } = hook.read();
      const expected = peerSplits ? ["He", "ll", "o"] : ["He", "lYlo"];
      assert.deepEqual(remote, local);
      assert.deepEqual(local.rows.map(row => row.audioText), expected);
      assert.deepEqual(local.rows.map(row => kind.host(row.id).textContent.replace(/\u200b/g, "")), expected);
      assert.equal(show.mock.callCount(), 0);
    });
  }

  for (const backwards of [true, false]) {
    test(name + ": " + (backwards ? "Backspace" : "Delete") + " joins beats and replays the seam", async t => {
      const show = await enter(t, twoBeats), view = kind.open(t);
      const id = backwards ? "r2" : "r1", offset = backwards ? 0 : 5;
      kind.caret(view, id, offset);
      assert.equal(press(document.activeElement, backwards ? "Backspace" : "Delete", { ctrlKey: false }), true);
      assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Hello World"]);
      assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), "Hello World");
      assert.deepEqual(kind.at(view), ["r1", 6, 6]);
      assert.equal(press(kind.surface(), "z"), true);
      assert.deepEqual(hook.read().app.rows.map(row => row.audioText), ["Hello", "World"]);
      assert.deepEqual(kind.at(view, id), [id, offset, offset]);
      assert.equal(press(document.activeElement, "y"), true);
      assert.deepEqual(kind.at(view), ["r1", 6, 6]);
      await Promise.resolve();
      assert.deepEqual(hook.read().peer, hook.read().app);
      assert.equal(show.mock.callCount(), 0);
    });
  }

  test(name + ": Ctrl+Z takes back each typed word with the caret where it began, and Ctrl+Y and Ctrl+Shift+Z put them back", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), " big");
    await flushed();
    assert.equal(app(), "Hello big");
    const steps = [["z", {}, "Hello ", 6], ["z", {}, "Hello", 5], ["y", {}, "Hello ", 6], ["z", { shiftKey: true }, "Hello big", 9]];
    for (const [key, extra, expected, caret] of steps) {
      assert.equal(press(kind.surface(), key, extra), true);
      assert.equal(app(), expected);
      assert.deepEqual(kind.at(view), ["r1", caret, caret], key + " " + JSON.stringify(extra));
      await Promise.resolve();
      assert.equal(peer(), expected);
      assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), expected);
    }
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": undo after a peer edit in the same beat keeps the peer's letters and moves the caret with them", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), " big");
    await flushed();
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    await Promise.resolve();
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "YHello ");
    assert.deepEqual(kind.at(view), ["r1", 7, 7]);
    await Promise.resolve();
    assert.equal(peer(), "YHello ");
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "YHello big");
    assert.deepEqual(kind.at(view), ["r1", 10, 10]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a press with letters still buffered sends them first and takes back only them", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "1 abc");
    assert.equal(app(), "Hello1 ");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello1 ");
    assert.deepEqual(kind.at(view), ["r1", 7, 7]);
    await Promise.resolve();
    assert.equal(peer(), "Hello1 ");
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Hello1 abc");
    assert.deepEqual(kind.at(view), ["r1", 10, 10]);
    await flushed();
    assert.equal(app(), "Hello1 abc");
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": undo in a joined row returns the caret in the row's own offsets", async t => {
    const show = await enter(t, [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }], joined);
    const view = kind.open(t);
    assert.equal(app(), "Hello World");
    kind.caret(view, "r1", 8);
    typeKeys(kind.surface(), "XY");
    await flushed();
    assert.equal(app(), "Hello WoXYrld");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello World");
    assert.deepEqual(kind.at(view), ["r1", 8, 8]);
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Hello WoXYrld");
    assert.deepEqual(kind.at(view), ["r1", 10, 10]);
    await Promise.resolve();
    assert.equal(peer(), "Hello WoXYrld");
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": undo of a replaced selection selects nothing new and puts the caret back at the selection's end on redo", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 1, 4);
    typeKeys(kind.surface(), "ipp");
    await flushed();
    assert.equal(app(), "Hippo");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
    assert.deepEqual(kind.at(view), ["r1", 1, 4]);
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Hippo");
    assert.deepEqual(kind.at(view), ["r1", 4, 4]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": Backspace and Delete inside one beat are undone one press each with the caret where each key was pressed", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 3);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 2, 3), true);
    await flushed();
    kind.caret(view, "r1", 2);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 2, 3, "Forward"), true);
    await flushed();
    assert.equal(app(), "Heo");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Helo");
    assert.deepEqual(kind.at(view), ["r1", 2, 2]);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
    assert.deepEqual(kind.at(view), ["r1", 3, 3]);
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Helo");
    assert.deepEqual(kind.at(view), ["r1", 2, 2]);
    await Promise.resolve();
    assert.equal(peer(), "Helo");
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a press with nothing to undo is silent and leaves the caret where it is", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 3);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(press(kind.surface(), "y"), true);
    assert.equal(app(), "Hello");
    assert.deepEqual(kind.at(view), ["r1", 3, 3]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a press during an open composition is refused with the notice and writes nothing", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "ab");
    await flushed();
    assert.equal(compose(kind.surface(), "start", ""), false);
    assert.equal(press(kind.surface(), "z", { isComposing: true }), true);
    assert.equal(app(), "Helloab");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(compose(kind.surface(), "end", "c"), false);
    await flushed();
    assert.equal(app(), "Helloabc");
  });

  test(name + ": a press from outside the text while a composition is open is refused with the notice and writes nothing", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "ab");
    await flushed();
    assert.equal(compose(kind.surface(), "start", ""), false);
    press(document.body, "z");
    assert.equal(app(), "Helloab");
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(compose(kind.surface(), "end", "c"), false);
    await flushed();
    assert.equal(app(), "Helloabc");
  });

  test(name + ": a press after the buffer stopped on a stale paint writes nothing, adds no notice and keeps the unsent letter on screen", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "ab");
    await flushed();
    assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
    kind.caret(view, "r1", 2);
    assert.equal(beforeInput(kind.surface(), "insertText", "x"), true);
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(show.mock.callCount(), 1);
    assert.equal(app(), "Helloab");
    assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), "Hexlloab");
  });

  test(name + ": a one-second pause between typed letters ends the undo step", async t => {
    const show = await enter(t), view = kind.open(t);
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "a");
    await flushed();
    t.mock.timers.tick(999);
    typeKeys(kind.surface(), "b");
    await flushed();
    t.mock.timers.tick(1000);
    typeKeys(kind.surface(), "c");
    await flushed();
    assert.equal(app(), "Helloabc");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Helloab");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
    assert.equal(show.mock.callCount(), 0);
  });

  for (const buffered of [true, false]) {
    test(name + ": a command boundary " + (buffered ? "with letters still buffered" : "after the letters were sent") + " ends the undo step", async t => {
      const show = await enter(t), view = kind.open(t);
      kind.caret(view, "r1", 5);
      typeKeys(kind.surface(), "ab");
      if (!buffered) await flushed();
      breakUndoGroup();
      await flushed();
      typeKeys(kind.surface(), "cd");
      await flushed();
      assert.equal(app(), "Helloabcd");
      assert.equal(press(kind.surface(), "z"), true);
      assert.equal(app(), "Helloab");
      assert.deepEqual(kind.at(view), ["r1", 7, 7]);
      assert.equal(press(kind.surface(), "z"), true);
      assert.equal(app(), "Hello");
      assert.equal(show.mock.callCount(), 0);
    });
  }

  test(name + ": the keys undo and redo a status change and a posted comment one at a time and leave the caret alone", async t => {
    const show = await enter(t);
    const status = doc => doc.rows[0].status, comments = doc => doc.comments.map(item => item.body);
    const anchored = doc => /cmt-anchor/.test(doc.rows[0].audioText);
    document.querySelector('#rows [data-action="cycle-status"][data-id="r1"]').click();
    await Promise.resolve();
    cell().focus();
    setCellSelection(cell(), 0, 5);
    cell().closest(".field-wrap").querySelector('[data-cmd="comment"]').click();
    document.getElementById("comment-body-editable").textContent = "Check this";
    document.getElementById("comment-post").click();
    await Promise.resolve();
    const both = () => { const { app: mine, peer: theirs } = hook.read(); return [mine, theirs]; };
    for (const copy of both()) assert.deepEqual([status(copy), comments(copy), anchored(copy)], ["ready", ["Check this"], true]);
    const view = kind.open(t);
    kind.caret(view, "r1", 3);
    const steps = [["z", "ready", [], false], ["z", "todo", [], false], ["y", "ready", [], false], ["y", "ready", ["Check this"], true]];
    for (const [key, expectedStatus, expectedComments, expectedAnchor] of steps) {
      assert.equal(press(kind.surface(), key), true);
      await Promise.resolve();
      for (const copy of both()) assert.deepEqual([status(copy), comments(copy), anchored(copy)], [expectedStatus, expectedComments, expectedAnchor], key);
      assert.deepEqual(kind.at(view), ["r1", 3, 3], key);
    }
    assert.equal(show.mock.calls.filter(call => call.arguments[1] === "warn").length, 0);
  });

  test(name + ": the browser's own history input steps the session like the keys", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 5);
    typeKeys(kind.surface(), "!");
    await flushed();
    assert.equal(beforeInput(kind.surface(), "historyUndo", null), true);
    assert.equal(app(), "Hello");
    assert.deepEqual(kind.at(view), ["r1", 5, 5]);
    assert.equal(beforeInput(kind.surface(), "historyRedo", null), true);
    assert.equal(app(), "Hello!");
    assert.deepEqual(kind.at(view), ["r1", 6, 6]);
    assert.equal(show.mock.callCount(), 0);
  });

  test(name + ": a deletion with nothing in its range is refused with the notice and changes nothing", async t => {
    const show = await enter(t), view = kind.open(t);
    kind.caret(view, "r1", 3);
    assert.equal(deleteIn(kind.surface(), kind.host("r1"), 3, 3), true);
    await flushed();
    assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
    assert.equal(app(), "Hello");
    assert.equal(kind.host("r1").textContent.replace(/\u200b/g, ""), "Hello");
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(app(), "Hello");
  });
}

test("Writer: a burst of 200 keys reaches both copies whole with the caret after the last key", async t => {
  const show = await enter(t), view = writer(t);
  view.caret("r1", 5);
  const keys = Array.from({ length: 200 }, (_, index) => index % 7 === 6 ? " " : String.fromCharCode(97 + index % 26));
  typeKeys(root(), keys);
  await flushed();
  const expected = "Hello" + keys.join("");
  assert.equal(app(), expected);
  assert.equal(beat().textContent.replace(/\u200b/g, ""), expected);
  assert.deepEqual(view.at(), ["r1", 205, 205]);
  await Promise.resolve();
  assert.equal(peer(), expected);
  assert.equal(show.mock.callCount(), 0);
});

test("Writer: a peer edit in the same beat while letters are buffered keeps both", async t => {
  const show = await enter(t), view = writer(t);
  view.caret("r1", 5);
  typeKeys(root(), "ab");
  assert.equal(hook.nativePeer.type("r1", 0, "Y").kind, "written");
  typeKeys(root(), "c");
  await flushed();
  assert.equal(app(), "YHelloabc");
  assert.equal(beat().textContent.replace(/\u200b/g, ""), "YHelloabc");
  assert.deepEqual(view.at(), ["r1", 9, 9]);
  await Promise.resolve();
  assert.equal(peer(), "YHelloabc");
  assert.equal(show.mock.callCount(), 0);
});

test("Writer: buffered letters are sent when focus leaves the page text or the page hides", async t => {
  await enter(t);
  const view = writer(t);
  view.caret("r1", 5);
  typeKeys(root(), "ab");
  root().dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  await Promise.resolve();
  assert.equal(app(), "Helloab");
  view.caret("r1", 7);
  typeKeys(root(), "c");
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(app(), "Helloabc");
});

test("a buffered write records its after-selection only when the session wrote it", t => {
  const doc = migrateRows({ title: "Native script", rows: [{ id: "r1", audioText: "Hello" }] });
  adoptReplacement(doc);
  const native = openNativeSession({ kind: "state", state: nativeBytes(doc) }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(native.close);
  const recorded = t.mock.fn(), results = [{ kind: "unchanged" }, { kind: "written" }];
  const typeText = Object.assign(() => assert.fail("a write without a recorded selection"),
    { withSelection: () => ({ result: results.shift(), recordAfter: recorded }) });
  const input = mountNativeSharedInput({
    native: { ...native, commands: { ...native.commands, typeText } }, report: assert.fail,
    editAttribution: () => ({ by: "Writer", at: "now" }), session: { admit: () => null, refuse: t.mock.fn(), subscribe: () => () => {} }
  });
  t.after(() => { input.dispose(); cell().textContent = "Hello"; });
  cell().focus();
  setCellSelection(cell(), 2);
  assert.equal(beforeInput(cell(), "insertText", "x"), true);
  assert.equal(input.finish(), null);
  assert.equal(recorded.mock.callCount(), 0);
  setCellSelection(cell(), 2);
  assert.equal(beforeInput(cell(), "insertText", "y"), true);
  assert.equal(input.finish(), null);
  assert.equal(recorded.mock.callCount(), 1);
});

const twoBeats = [{ id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }];

test("Writer: moving between beats shows no notice, and a beat sync that changes the text is still refused", async t => {
  const show = await enter(t, twoBeats), view = writer(t);
  view.caret("r1", 2);
  view.caret("r2", 3);
  view.caret("r1", 1);
  assert.equal(show.mock.callCount(), 0);
  beat("r1").textContent = "Changed";
  view.caret("r2", 1);
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [UNAVAILABLE]);
  assert.deepEqual([app(0), app(1)], ["Hello", "World"]);
  await Promise.resolve();
  assert.deepEqual([peer(0), peer(1)], ["Hello", "World"]);
});

async function openFixture(t) {
  const fixture = entrySwitchFixture(), refused = t.mock.fn();
  const ports = { ...fixture.ports, commandRefused: refused };
  let native;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    native = opened.native;
    return opened.backend;
  }), { ok: true });
  t.after(cleanSession);
  return { native, refused };
}

const fixtureViews = {
  Split: {
    open: () => null,
    surface: () => cell("R1"),
    caret: (_view, offset) => { cell("R1").focus(); setCellSelection(cell("R1"), offset); },
    host: () => cell("R1")
  },
  Writer: {
    open: t => writer(t),
    surface: () => root(),
    caret: (view, offset) => { view.caret("R1", offset); },
    host: () => beat("R1")
  }
};

for (const [name, kind] of Object.entries(fixtureViews)) {
  test(name + ": an undo press at the size ceiling with a letter buffered is silent and keeps the letter on screen", async t => {
    const { native, refused } = await openFixture(t), view = kind.open(t), filler = new Doc();
    t.after(() => filler.destroy());
    kind.caret(view, 8);
    assert.equal(beforeInput(kind.surface(), "insertText", "!"), true);
    filler.getMap("sizeFixture").set("payload", "x".repeat(native.sizeLimits.limit));
    assert.equal(applyNativePeerUpdate(native, encodeStateAsUpdate(filler)), true);
    await Promise.resolve();
    assert.equal(native.size, "full");
    const revision = native.revision();
    assert.equal(press(kind.surface(), "z"), true);
    assert.equal(native.revision(), revision);
    assert.equal(native.narrationHtml("R1"), "Captured words");
    assert.equal(kind.host().textContent.replace(/\u200b/g, ""), "Captured! words");
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), []);
  });

  test(name + ": an undo press after the session stopped during a composition adds nothing to the stop notice", async t => {
    const { native, refused } = await openFixture(t), view = kind.open(t);
    kind.caret(view, 8);
    assert.equal(compose(kind.surface(), "start", ""), false);
    native.close();
    await Promise.resolve();
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"]]);
    assert.equal(press(kind.surface(), "z", { isComposing: true }), true);
    press(document.body, "z");
    assert.deepEqual(refused.mock.calls.map(call => call.arguments), [["native-input-pending"]]);
    assert.equal(kind.host().textContent.replace(/\u200b/g, ""), "Captured words");
  });
}
const outOfScope = [
  ["typing over a selection across two beats", view => {
    view.flow.place({ anchor: { kind: "beat", rowId: "r1", offset: 2 }, head: { kind: "beat", rowId: "r2", offset: 2 } });
  }, () => beforeInput(root(), "insertText", "x")],
  ["Ctrl+B", view => { view.caret("r1", 1, 3); }, () => press(root(), "b")],
  ["a rich paste", view => { view.caret("r1", 2); }, () => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    root().dispatchEvent(event);
    return event.defaultPrevented;
  }]
];
for (const [situation, place, act] of outOfScope) {
  test("Writer: " + situation + " is refused with the notice and loses nothing", async t => {
    const show = await enter(t, twoBeats), view = writer(t);
    view.caret("r1", 5);
    typeKeys(root(), "!");
    await flushed();
    place(view);
    const before = show.mock.callCount();
    assert.equal(act(), true);
    await flushed();
    assert.deepEqual(show.mock.calls.slice(before).map(call => call.arguments), [UNAVAILABLE]);
    assert.deepEqual([app(0), app(1)], ["Hello!", "World"]);
    assert.deepEqual([beat("r1").textContent, beat("r2").textContent].map(text => text.replace(/\u200b/g, "")), ["Hello!", "World"]);
    await Promise.resolve();
    assert.deepEqual([peer(0), peer(1)], ["Hello!", "World"]);
  });
}
