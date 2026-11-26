import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startWriter } from "../../../src/features/writer/writer.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeWriterPorts } from "../fakes.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";

function harness() {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver, CSS: { escape: (s: string) => s } });
  document.documentElement.innerHTML = readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8");
  return fakeWriterPorts(migrateRows({ title: "Writer mount", rows: [] }, fakeMigration().ports));
}

test("a refused flow disposal preserves the Writer and its owner until disposal succeeds", () => {
  const h = harness(), create = h.ports.flow.create;
  let allowed = false;
  const writer = startWriter({ ...h.ports, flow: { ...h.ports.flow, create: (...args) => {
    const flow = create(...args);
    return { ...flow, settle: () => true, dispose: () => allowed ? flow.dispose() : false };
  } } });
  try {
    writer.openWriter();
    const flow = writer.writerFlowControl();
    writer.closeWriter();
    assert.equal(h.state.open, true);
    assert.equal(writer.writerFlowControl(), flow);
    assert.equal(writer.dispose(), false);
    assert.equal(h.state.open, true);
    assert.equal(writer.writerFlowControl(), flow);
    allowed = true;
    writer.closeWriter();
    assert.equal(h.state.open, false);
    assert.equal(writer.writerFlowControl(), null);
  } finally { allowed = true; writer.dispose(); }
});

test("a refused buffer settlement keeps the Writer open through close, undo and owner disposal", () => {
  const h = harness(), create = h.ports.flow.create;
  let allowed = false, replayed = false;
  const writer = startWriter({ ...h.ports, flow: { ...h.ports.flow, create: (...args) => {
    const flow = create(...args);
    return { ...flow, settle: () => allowed, beforeReplay: direction => { replayed = true; flow.beforeReplay(direction); } };
  } } });
  try {
    writer.openWriter();
    const root = document.getElementById("writer-doc"); assert.ok(root);
    root.textContent = "held native text";
    writer.closeWriter();
    assert.equal(h.state.open, true);
    assert.equal(root.textContent, "held native text");
    assert.equal(writer.writerUndoStep("undo"), true);
    assert.equal(replayed, false);
    assert.equal(writer.dispose(), false);
    assert.equal(h.state.open, true);
    assert.equal(root.textContent, "held native text");
    allowed = true;
    writer.closeWriter();
    assert.equal(h.state.open, false);
    assert.equal(root.textContent, "");
  } finally { allowed = true; writer.dispose(); }
});

test("viewing-only flow host cancels input and editing keys before its surface handlers", () => {
  const h = harness();
  h.state.allowed = false;
  const root = document.getElementById("writer-doc") as HTMLElement;
  root.classList.add("is-flow");
  let bubbled = 0;
  root.addEventListener("beforeinput", () => { bubbled++; });
  const writer = startWriter(h.ports);
  try {
    const input = new window.InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true });
    root.dispatchEvent(input);
    assert.equal(input.defaultPrevented, true);
    assert.equal(bubbled, 0);
    const key = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    root.dispatchEvent(key);
    assert.equal(key.defaultPrevented, true);
  } finally { writer.dispose(); }
});

test("writer runtime opens comments before opening, schedules its existing idle job, and clears modal and redo state on dispose", () => {
  const h = harness();
  const first = startWriter(h.ports);
  first.openWriter();
  assert.deepEqual(h.calls.slice(0, 2), [["openPanel", "comments-panel"], ["setOpen", true]]);
  assert.equal(document.getElementById("writer")?.hidden, false);
  first.scheduleWriterStats();
  assert.equal(h.calls.filter(call => call[0] === "schedule").length, 1);
  assert.deepEqual(h.calls.find(call => call[0] === "schedule"), ["schedule", "writerStats"]);
  assert.equal(first.writerUndoStep("undo"), true);
  first.dispose();
  assert.equal(h.state.open, false);
  assert.equal(document.getElementById("writer")?.hidden, true);
  assert.equal(document.getElementById("writer")?.inert, true);
  assert.equal(h.calls.filter(call => call[0] === "cancelStats").length, 1);
  const second = startWriter(h.ports);
  try {
    assert.equal(second.writerUndoStep("redo"), false);
    second.openWriter();
    first.dispose();
    assert.equal(h.state.open, true);
    second.dispose();
    assert.equal(h.state.open, false);
  } finally {
    second.dispose();
  }
});

test("a Writer repaint writes contenteditable only when editing permission changes", () => {
  const h = harness();
  const writer = startWriter(h.ports);
  try {
    writer.openWriter();
    const root = document.getElementById("writer-doc") as HTMLElement;
    const writes: string[] = [];
    const setAttribute = root.setAttribute.bind(root);
    root.setAttribute = (name: string, value: string) => { if (name === "contenteditable") writes.push(value); setAttribute(name, value); };
    writer.renderWriter();
    writer.renderWriter();
    assert.equal(root.getAttribute("contenteditable"), "true");
    assert.deepEqual(writes, []);
    h.state.allowed = false;
    writer.renderWriter();
    writer.renderWriter();
    assert.equal(root.getAttribute("contenteditable"), "false");
    assert.deepEqual(writes, ["false"]);
    h.state.allowed = true;
    writer.renderWriter();
    assert.equal(root.getAttribute("contenteditable"), "true");
    assert.deepEqual(writes, ["false", "true"]);
  } finally { writer.dispose(); }
});

test("a second Writer paint in the same task repaints unless it shows the same frozen document over an untouched DOM", async () => {
  const h = harness(), create = h.ports.flow.create;
  const current = h.ports.document.current();
  assert.ok(current);
  const frozen = (title: string) => deepFreeze(structuredClone({ ...current, title }));
  let shown: typeof current = frozen("One");
  let repaints = 0;
  const writer = startWriter({ ...h.ports, document: { ...h.ports.document, current: () => shown },
    flow: { ...h.ports.flow, create: (...args) => {
      const flow = create(...args);
      return { ...flow, repaint: (restore?: boolean) => { repaints++; flow.repaint(restore); } };
    } } });
  try {
    writer.openWriter();
    await Promise.resolve();
    const root = document.getElementById("writer-doc") as HTMLElement;
    repaints = 0;
    writer.renderWriter();
    writer.paintWriterDraw(writer.drawWriter());
    assert.equal(repaints, 1, "the same frozen document painted twice in one task repaints once");
    shown = frozen("One");
    writer.renderWriter();
    assert.equal(repaints, 2, "another document object repaints");
    root.append(document.createElement("span"));
    writer.renderWriter();
    assert.equal(repaints, 3, "a Writer DOM change since the last paint repaints");
    h.state.allowed = false;
    writer.renderWriter();
    assert.equal(repaints, 4, "a permission change repaints");
    await Promise.resolve();
    writer.renderWriter();
    assert.equal(repaints, 5, "a paint in a later task repaints");
    const mutable = structuredClone({ ...current, title: "Two" });
    shown = mutable;
    writer.renderWriter();
    writer.renderWriter();
    assert.equal(repaints, 7, "a document that can still change repaints every time");
  } finally { writer.dispose(); }
});

test("writer capture guard is removed on dispose and remount refuses once before bubble listeners", () => {
  const h = harness();
  h.state.allowed = false;
  const root = document.getElementById("writer") as HTMLElement;
  const title = document.getElementById("writer-title") as HTMLInputElement;
  let bubbled = 0;
  root.addEventListener("keydown", () => { bubbled++; });
  const key = () => {
    const event = new window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    title.dispatchEvent(event);
    return event;
  };
  const first = startWriter(h.ports);
  assert.equal(key().defaultPrevented, true);
  assert.equal(bubbled, 0);
  assert.equal(h.notices.shown.length, 1);
  first.dispose();
  assert.equal(key().defaultPrevented, false);
  assert.equal(bubbled, 1);
  const second = startWriter(h.ports);
  try {
    first.dispose();
    assert.equal(key().defaultPrevented, true);
    assert.equal(bubbled, 1);
    assert.equal(h.notices.shown.length, 2);
  } finally {
    second.dispose();
  }
});
