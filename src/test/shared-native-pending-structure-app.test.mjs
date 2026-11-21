import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { adoptReplacement, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { cellSelection, setCellSelection } from "../features/common/cell-selection.ts";
import { BEATS_MIME, buildBeatPayload } from "../features/clipboard/beat-clip.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const peer = hook.nativePeer;
const warning = ["This is not available in a shared session yet.", "warn"];
const noticesShown = show => show.mock.calls.map(call => call.arguments);
const rows = (first = "abcdef") => [
  { id: "r1", audioText: first, visualText: "Wide", paragraphStart: true },
  { id: "r2", audioText: "Other" },
  { id: "r3", audioText: "Third" }
];
const read = () => hook.read().app.rows;
const narration = () => read().map(row => row.audioText);
const ids = () => read().map(row => row.id);

function written(result) {
  assert.equal(result.kind, "written");
  return result;
}

async function enter(t, view, initial = rows()) {
  adoptReplacement(migrateRows({ schema: 2, title: "Pending structure", paragraphsDecided: true, rows: initial }));
  const show = t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enter(), { ok: true });
  const writer = writerControls();
  if (view === "Writer") writer.openWriter();
  t.after(() => {
    writer.closeWriter();
    if (sharedSession()) assert.deepEqual(hook.leave(), { ok: true });
  });
  const host = id => document.querySelector(view === "Writer" ? `#writer-doc .wr-beat[data-id="${id}"]`
    : `#rows .cell-editable[data-id="${id}"][data-field="audioText"]`);
  const caret = (id, from, to = from) => {
    const cell = host(id);
    (view === "Writer" ? document.getElementById("writer-doc") : cell).focus();
    setCellSelection(cell, from, to);
    if (view === "Writer") document.dispatchEvent(new window.Event("selectionchange"));
  };
  const press = (key, modifiers = {}) => {
    const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...modifiers });
    document.activeElement.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  const pending = (id, at) => {
    const before = narration();
    caret(id, at);
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "X" });
    document.activeElement.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    const old = read().find(row => row.id === id).audioText;
    assert.equal(host(id).textContent.replace(/\u200b/g, ""), old.slice(0, at) + "X" + old.slice(at));
    assert.deepEqual(narration(), before);
  };
  const deliver = edit => {
    const before = hook.read().app;
    peer.hold();
    const result = edit();
    peer.deliver();
    assert.deepEqual(hook.read().app, before, "the peer change is still held out of the editor projection");
    return result;
  };
  return { host, show, caret, press, pending, deliver, split: () => press("Enter", { altKey: view === "Split" }),
    blank: () => press("Enter", { ctrlKey: view === "Split" }) };
}

async function agreed(expected) {
  assert.deepEqual(narration(), expected);
  await Promise.resolve();
  assert.deepEqual(hook.read().peer, hook.read().app);
}

async function undoStructure(f, typed, peerOnly) {
  f.press("z", { ctrlKey: true });
  await agreed(typed);
  f.press("z", { ctrlKey: true });
  await agreed(peerOnly);
  f.press("y", { ctrlKey: true });
  await agreed(typed);
}

const offsets = {
  before: { typed: 1, peer: 0, selection: [3, 7] },
  inside: { typed: 4, peer: 3, selection: [2, 7] },
  after: { typed: 7, peer: 8, selection: [2, 6] }
};
const settled = {
  before: { before: ["ZaXb", "gh"], inside: ["aXb", "gh"], after: ["aXb", "ghZ"] },
  inside: { before: ["Zab", "gh"], inside: ["ab", "gh"], after: ["ab", "ghZ"] },
  after: { before: ["Zab", "gXh"], inside: ["ab", "gXh"], after: ["ab", "gXhZ"] }
};
const boundaries = [
  { name: "first selected character", erase: [[2, 3]], text: "abZdef", cut: ["ab", "efX"] },
  { name: "last selected character", erase: [[4, 5]], text: "abcZef", cut: ["ab", "efX"] },
  { name: "every selected character", erase: [[2, 3], [3, 4]], text: "abZef", cut: ["ab", "efX"] },
  { name: "character before selection", erase: [[1, 2]], text: "acZdef", cut: ["a", "efX"] },
  { name: "character after selection", erase: [[5, 6]], text: "abcZdf", cut: ["ab", "fX"] }
];
const peerStructure = [
  { label: "split before the selection", offset: 4, peerRows: ["aXbcd", "efgh"], retryAt: 1, retried: ["Lead", "aXbcd", "e", "fgh"] },
  { label: "split inside the selection", offset: 6, peerRows: ["aXbcdef", "gh"], retryAt: 1, retried: ["Lead", "aXbcdef", "g", "h"] },
  { label: "split after the selection", offset: 7, peerRows: ["aXbcdefg", "h"], retryAt: 5, retried: ["Lead", "aXbcd", "efg", "h"] },
  { label: "join into the row above", offset: null, peerRows: ["Lead aXbcdefgh"], retryAt: 11, retried: ["Lead aXbcde", "fgh"] }
];

function insert(text, offset, value) {
  return text.slice(0, offset) + value + text.slice(offset);
}

for (const view of ["Split", "Writer"]) {
  for (const [typed, local] of Object.entries(offsets)) for (const [remote, { peer: offset }] of Object.entries(offsets)) {
    test(`${view}: split with typing ${typed} and a peer insertion ${remote} the selection`, async t => {
      const original = "abcdefgh", f = await enter(t, view, rows(original));
      f.pending("r1", local.typed);
      f.caret("r1", ...local.selection);
      f.deliver(() => written(peer.type("r1", offset, "Z")));
      f.split();
      await agreed([...settled[typed][remote], "Other", "Third"]);
      const created = ids()[1];
      assert.deepEqual(ids(), ["r1", created, "r2", "r3"]);
      assert.deepEqual(cellSelection(f.host(created)), { from: 0, to: 0 });
      assert.deepEqual(noticesShown(f.show), []);
      const peerText = insert(original, offset, "Z");
      const merged = insert(peerText, local.typed + Number(offset < local.typed), "X");
      await undoStructure(f, [merged, "Other", "Third"], [peerText, "Other", "Third"]);
    });
    if (view === "Split") {
      test(`Split: blank insertion with typing ${typed} and a peer insertion ${remote} the selection`, async t => {
        const original = "abcdefgh", f = await enter(t, view, rows(original));
        f.pending("r1", local.typed);
        f.caret("r1", ...local.selection);
        f.deliver(() => written(peer.type("r1", offset, "Z")));
        f.blank();
        const peerText = insert(original, offset, "Z");
        const merged = insert(peerText, local.typed + Number(offset < local.typed), "X");
        await agreed([merged, "", "Other", "Third"]);
        assert.deepEqual(cellSelection(f.host(ids()[1])), { from: 0, to: 0 });
        assert.deepEqual(noticesShown(f.show), []);
        await undoStructure(f, [merged, "Other", "Third"], [peerText, "Other", "Third"]);
      });
    }
  }

  for (const at of [0, 3]) {
    test(`${view}: split over the pending letter with the peer insertion at offset ${at}`, async t => {
      const f = await enter(t, view);
      f.pending("r1", 3);
      f.caret("r1", 2, 5);
      f.deliver(() => written(peer.type("r1", at, "Z")));
      f.split();
      await agreed([at === 0 ? "Zab" : "ab", "ef", "Other", "Third"]);
      assert.deepEqual(noticesShown(f.show), []);
    });
  }

  for (const boundary of boundaries) {
    for (const gesture of view === "Split" ? ["split", "blank insertion"] : ["split"]) {
      test(`${view}: ${gesture} with a peer deleting ${boundary.name}`, async t => {
        const f = await enter(t, view);
        f.pending("r1", 6);
        f.caret("r1", 2, 4);
        f.deliver(() => {
          written(peer.type("r1", 3, "Z"));
          for (const [from, to] of boundary.erase) written(peer.delete("r1", from, to));
        });
        assert.equal(hook.read().peer.rows[0].audioText, boundary.text);
        if (gesture === "split") f.split();
        else f.blank();
        await agreed([...(gesture === "split" ? boundary.cut : [boundary.text + "X", ""]), "Other", "Third"]);
        assert.deepEqual(noticesShown(f.show), []);
        await undoStructure(f, [boundary.text + "X", "Other", "Third"], [boundary.text, "Other", "Third"]);
      });
    }
  }

  for (const { label, offset, peerRows, retryAt, retried } of peerStructure) {
    const afterPeer = [...(offset === null ? [] : ["Lead"]), ...peerRows, "Other", "Third"];
    const afterUntyped = afterPeer.map(value => value.replace("aX", "a"));
    test(`${view}: split after a held peer ${label}`, async t => {
      const f = await enter(t, view, [{ id: "r0", audioText: "Lead" }, ...rows("abcdefgh")]);
      f.pending("r1", 1);
      f.caret("r1", 6, 8);
      const remote = f.deliver(() => offset === null ? written(peer.join("r1", "r0")) : written(peer.split("r1", offset)).created);
      f.split();
      if (offset === 7 && view === "Split") {
        await agreed(["Lead", "aXbcde", "", "h", "Other", "Third"]);
        assert.deepEqual(noticesShown(f.show), []);
        await undoStructure(f, afterPeer, afterUntyped);
        return;
      }
      await agreed(afterPeer);
      assert.deepEqual(noticesShown(f.show), [warning]);
      const live = offset === null ? "r0" : offset === 7 ? "r1" : remote;
      f.caret(live, retryAt);
      f.split();
      await agreed([...retried, "Other", "Third"]);
      await undoStructure(f, afterPeer, afterUntyped);
      assert.deepEqual(noticesShown(f.show), [warning]);
    });
    if (view === "Split") {
      test(`Split: blank insertion after a held peer ${label}`, async t => {
        const f = await enter(t, view, [{ id: "r0", audioText: "Lead" }, ...rows("abcdefgh")]);
        f.pending("r1", 1);
        f.caret("r1", 6, 8);
        const remote = f.deliver(() => offset === null ? written(peer.join("r1", "r0")) : written(peer.split("r1", offset)).created);
        f.blank();
        await agreed(afterPeer);
        assert.deepEqual(noticesShown(f.show), [warning]);
        const live = offset === null ? "r0" : remote;
        const index = ids().indexOf(live);
        f.caret(live, 1);
        f.blank();
        await agreed(afterPeer.toSpliced(index + 1, 0, ""));
        assert.deepEqual(cellSelection(f.host(ids()[index + 1])), { from: 0, to: 0 });
        await undoStructure(f, afterPeer, afterUntyped);
        assert.deepEqual(noticesShown(f.show), [warning]);
      });
    }
  }

  test(`${view}: a changed insertion gap refuses once, then inserts one blank on the new gap`, async t => {
    const f = await enter(t, view);
    f.pending("r1", 6);
    f.deliver(() => written(peer.moveBeat("r2", null)));
    f.blank();
    await agreed(["abcdefX", "Third", "Other"]);
    assert.deepEqual(noticesShown(f.show), [warning]);
    f.caret("r1", 7);
    f.blank();
    await agreed(["abcdefX", "", "Third", "Other"]);
    assert.deepEqual(cellSelection(f.host(ids()[1])), { from: 0, to: 0 });
    await undoStructure(f, ["abcdefX", "Third", "Other"], ["abcdef", "Third", "Other"]);
  });

  test(`${view}: join flushes typing and joins the live neighbour once`, async t => {
    const f = await enter(t, view);
    f.pending("r1", 6);
    f.deliver(() => written(peer.moveBeat("r2", null)));
    f.press("Delete");
    await agreed(["abcdefX Third", "Other"]);
    assert.deepEqual(cellSelection(f.host("r1")), { from: 8, to: 8 });
    await undoStructure(f, ["abcdefX", "Third", "Other"], ["abcdef", "Third", "Other"]);
    assert.deepEqual(noticesShown(f.show), []);
  });

  test(`${view}: join refuses a vanished target and the next press joins the live neighbour once`, async t => {
    const f = await enter(t, view);
    f.pending("r1", 2);
    f.caret("r2", 0);
    f.deliver(() => written(peer.join("r2", "r1")));
    f.press("Backspace");
    await agreed(["abXcdef Other", "Third"]);
    assert.deepEqual(noticesShown(f.show), [warning]);
    f.caret("r1", 13);
    f.press("Delete");
    await agreed(["abXcdef Other Third"]);
    assert.deepEqual(ids(), ["r1"]);
    await undoStructure(f, ["abXcdef Other", "Third"], ["abcdef Other", "Third"]);
    assert.deepEqual(noticesShown(f.show), [warning]);
  });

  test(`${view}: script beat paste refuses without consuming the pending typing`, async t => {
    const f = await enter(t, view);
    const { json, text } = buildBeatPayload(hook.read().app, ["r2"], {});
    f.pending("r1", 2);
    f.deliver(() => written(peer.type("r1", 0, "Z")));
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      types: [BEATS_MIME, "text/plain"], getData: type => type === BEATS_MIME ? json : type === "text/plain" ? text : ""
    } });
    document.activeElement.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(noticesShown(f.show), [warning]);
    assert.deepEqual(narration(), ["abcdef", "Other", "Third"]);
    assert.equal(f.host("r1").textContent, "abXcdef");
    window.dispatchEvent(new window.Event("pagehide"));
    await agreed(["ZabXcdef", "Other", "Third"]);
  });

  test(`${view}: a changed move neighbour refuses once, then moves the live beat once`, async t => {
    const f = await enter(t, view);
    f.pending("r1", 3);
    f.deliver(() => written(peer.moveBeat("r2", null)));
    const move = () => f.press("ArrowDown", { altKey: true });
    move();
    await agreed(["abcXdef", "Third", "Other"]);
    assert.deepEqual(noticesShown(f.show), [warning]);
    f.caret("r1", 4);
    move();
    await agreed(["Third", "abcXdef", "Other"]);
    assert.deepEqual(cellSelection(f.host("r1")), { from: 4, to: 4 });
    await undoStructure(f, ["abcXdef", "Third", "Other"], ["abcdef", "Third", "Other"]);
    assert.deepEqual(noticesShown(f.show), [warning]);
  });
}

function removeButton(id) {
  return document.querySelector(`#rows .row[data-id="${id}"] [data-action="delete-row"]`);
}

test("Split: pending typing and a held insertion keep Remove on the armed beat", async t => {
  const f = await enter(t, "Split");
  f.pending("r1", 2);
  const old = removeButton("r2");
  const blank = f.deliver(() => written(peer.split("r1", 6)).created);
  old.click();
  assert.deepEqual(narration(), ["abcdef", "Other", "Third"]);
  assert.equal(old.classList.contains("armed"), true);
  assert.equal(document.querySelectorAll("#rows .armed").length, 1);
  removeButton("r2").click();
  await agreed(["abXcdef", "", "Third"]);
  assert.equal(old.isConnected, false);
  assert.deepEqual(ids(), ["r1", blank, "r3"]);
  await undoStructure(f, ["abXcdef", "", "Other", "Third"], ["abcdef", "", "Other", "Third"]);
  assert.deepEqual(noticesShown(f.show), []);
});

test("Split: Remove refuses when the armed beat was hidden by a held join", async t => {
  const f = await enter(t, "Split");
  f.pending("r1", 2);
  const old = removeButton("r2");
  f.deliver(() => written(peer.join("r2", "r1")));
  old.click();
  assert.equal(old.classList.contains("armed"), true);
  old.click();
  await agreed(["abXcdef Other", "Third"]);
  assert.equal(removeButton("r2"), null);
  assert.equal(document.querySelectorAll("#rows .armed").length, 0);
  assert.deepEqual(noticesShown(f.show), [warning]);
  f.press("z", { ctrlKey: true });
  await agreed(["abcdef Other", "Third"]);
});

for (const view of ["Split", "Writer"]) {
  test(`${view}: Backspace removes one live blank after a held peer split`, async t => {
    const initial = rows();
    initial[1].audioText = "";
    const f = await enter(t, view, initial);
    f.pending("r1", 2);
    f.caret("r2", 0);
    const blank = f.deliver(() => written(peer.split("r1", 6)).created);
    f.press("Backspace");
    await agreed(["abXcdef", "", "Third"]);
    assert.deepEqual(ids(), ["r1", blank, "r3"]);
    await undoStructure(f, ["abXcdef", "", "", "Third"], ["abcdef", "", "", "Third"]);
    assert.deepEqual(noticesShown(f.show), []);
  });
}
