import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { ReadTimePorts } from "../../../src/features/rows/ports.ts";
import { startReadTime as mountReadTime, readTimeEditing, setBeatLength } from "../../../src/features/rows/read-time.ts";
import { productionReaders } from "../../../src/bootstrap/document-ports.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeEdits, fakeNotices, fakeUndo } from "../fakes.ts";

function setup() {
  document.body.innerHTML = '<div id="rows"><div class="row" data-id="r1"><button class="row-read" data-id="r1">0:05</button></div></div>';
  const doc = migrateRows({ title: "Read time", rows: [{ id: "r1", visualText: "", audioText: "One two three.", status: "todo" }] }, fakeMigration().ports);
  const edits = fakeEdits();
  const undo = fakeUndo();
  const notices = fakeNotices();
  const painted: string[] = [];
  const ports: ReadTimePorts = {
    document: fakeDocument(doc).document,
    text: { productionReaders },
    edits: edits.edits,
    undo: undo.undo,
    paint: { afterThisPaint: (fn) => { painted.push("after"); fn(); } },
    notices: notices.notices
  };
  const button = document.querySelector<HTMLButtonElement>(".row-read");
  assert.ok(button);
  return { edits, undo, notices, painted, button, owner: mountReadTime(ports) };
}

function key(target: Element, init: KeyboardEventInit): void {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

test("read time: a click opens the length editor, and Enter runs the scene length command after this paint", () => {
  const { edits, painted, button, owner } = setup();
  button.click();
  assert.equal(readTimeEditing(), "r1");
  const input = document.querySelector<HTMLInputElement>(".row-read-input");
  assert.ok(input);
  assert.equal(input.getAttribute("aria-label"), "Scene 1 length");
  input.value = "1:30";
  key(input, { key: "Enter" });
  assert.equal(readTimeEditing(), null);
  assert.deepEqual(painted, ["after"]);
  assert.deepEqual(edits.ran.map((c) => c.name), ["set-scene-length"]);
  assert.equal(document.querySelector(".row-read-input"), null);
  owner.dispose();
});

test("read time: undo and redo keys on a length button run through the undo port", () => {
  const { undo, button, owner } = setup();
  key(button, { key: "z", ctrlKey: true });
  key(button, { key: "z", ctrlKey: true, shiftKey: true });
  key(button, { key: "y", metaKey: true });
  assert.deepEqual(undo.calls, ["undo", "redo", "redo"]);
  owner.dispose();
});

test("read time: dispose closes an open editor, removes the listeners and stops edits", () => {
  const { edits, undo, button, owner } = setup();
  button.click();
  assert.equal(readTimeEditing(), "r1");
  owner.dispose();
  assert.equal(readTimeEditing(), null);
  assert.equal(document.querySelector(".row-read-input"), null);
  button.click();
  key(button, { key: "z", ctrlKey: true });
  assert.equal(readTimeEditing(), null);
  assert.deepEqual(undo.calls, []);
  assert.equal(setBeatLength("r1", 30), false);
  assert.deepEqual(edits.ran, []);
});
