import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const { adoptReplacement, currentDocument } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { appActions } = await import("../bootstrap/wiring/ports/actions.ts");
const hook = window.__sharedTest;

const audio = () => currentDocument().rows.map(row => row.audioText);
const peerAudio = () => hook.read().peer.rows.map(row => row.audioText);
const toasts = () => Array.from(document.getElementById("toast-host").children).map(element => element.textContent);

function search(find, put) {
  const input = document.getElementById("find-input");
  input.value = find;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  document.getElementById("replace-input").value = put;
}

function undoKey() {
  document.activeElement?.blur();
  document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
}

test("in the real app, Split Replace and Replace all run as shared commands that the other copy shows, keep its typing, and Ctrl+Z takes back each", async () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Shared find", rows: [{ id: "r1", audioText: "a cup of tea", visualText: "", status: "todo" },
    { id: "r2", audioText: "one cup", visualText: "", status: "todo" }] }));
  undoOwner().flush();
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    appActions.invoke("find", "command-menu");
    search("cup", "mug");
    document.getElementById("find-replace").click();
    hook.peer.deliver();
    assert.deepEqual(audio(), ["a mug of tea", "one cup"]);
    assert.deepEqual(peerAudio(), ["a mug of tea", "one cup"]);
    hook.peer.hold();
    document.getElementById("find-replace-all").click();
    hook.peer.type("r2", 0, "X");
    hook.peer.release("reverse");
    assert.deepEqual(audio(), ["a mug of tea", "Xone mug"]);
    assert.deepEqual(peerAudio(), audio());
    assert.ok(toasts().includes("Replaced 1 match"));
    undoKey();
    hook.peer.deliver();
    assert.deepEqual(audio(), ["a mug of tea", "Xone cup"]);
    assert.deepEqual(peerAudio(), audio());
    undoKey();
    hook.peer.deliver();
    assert.deepEqual(audio(), ["a cup of tea", "Xone cup"]);
    assert.deepEqual(peerAudio(), audio());
  } finally {
    assert.deepEqual(hook.leave(), { ok: true });
  }
});

test("in the real app, a Replace whose line the other copy changed after the search says so once, writes nothing, and the next Replace works", async () => {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Shared find", rows: [{ id: "r1", audioText: "a cup of tea", visualText: "", status: "todo" }] }));
  undoOwner().flush();
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    appActions.invoke("find", "command-menu");
    search("cup", "mug");
    hook.peer.type("r1", 0, "X");
    hook.peer.deliver();
    const shown = toasts().length;
    document.getElementById("find-replace").click();
    assert.deepEqual(toasts().slice(shown), ["This line changed. Try replacing again."]);
    assert.deepEqual(audio(), ["Xa cup of tea"]);
    document.getElementById("find-replace").click();
    hook.peer.deliver();
    assert.deepEqual(audio(), ["Xa mug of tea"]);
    assert.deepEqual(peerAudio(), audio());
  } finally {
    assert.deepEqual(hook.leave(), { ok: true });
  }
});
