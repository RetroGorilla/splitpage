import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { createTagOccurrenceEditor } from "../../../src/features/tags/occurrence-editor.ts";
import { isInsideProtectedTagOrLink, isInsideTagOrLink } from "../../../src/features/common/dom.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

function fixture() {
  document.body.innerHTML = '<div id="rows"><div class="cell-editable" contenteditable="true" tabindex="0">' +
    '<span class="tag-anchor" data-tag-cat="sound" data-tag-name="Weather" contenteditable="false">rain on ' +
    '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Umbrella" contenteditable="false">umbrella</span></span>' +
    '<span class="tag-anchor" data-tag-cat="sound" data-tag-name="Weather" contenteditable="false">rain</span></div></div>';
  const cell = document.querySelector<HTMLElement>(".cell-editable") as HTMLElement;
  const tags = Array.from(cell.querySelectorAll<HTMLElement>(".tag-anchor"));
  let settled = 0;
  const editor = createTagOccurrenceEditor(() => {}, () => { settled++; });
  const select = (tag: HTMLElement) => tag.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  const activate = () => (document.getElementById("tag-edit-action") as HTMLButtonElement).click();
  return { cell, tags, editor, select, activate, settled: () => settled };
}

test("Edit tag opens one occurrence, keeps completed children protected, and Done preserves the markup", () => {
  const h = fixture();
  const [outer, child, other] = h.tags as [HTMLElement, HTMLElement, HTMLElement];
  const before = h.cell.innerHTML;
  try {
    h.select(outer);
    h.activate();
    assert.equal(outer.getAttribute("contenteditable"), "true");
    assert.equal(other.getAttribute("contenteditable"), "false");
    assert.equal(isInsideProtectedTagOrLink(outer), false);
    assert.equal(isInsideTagOrLink(outer), true);
    assert.equal(isInsideProtectedTagOrLink(child), true);
    assert.equal(h.editor.finish(), true);
    assert.equal(h.cell.innerHTML, before);
    assert.equal(h.settled(), 1);
    assert.equal(h.editor.finish(), false);
  } finally { h.editor.dispose(); }
});

test("a model repaint restores only the same occurrence and a removed occurrence cannot reopen another one", () => {
  const h = fixture();
  const [outer, , other] = h.tags as [HTMLElement, HTMLElement, HTMLElement];
  try {
    h.select(other);
    h.activate();
    const restore = h.editor.beforeWrite(h.cell);
    assert.ok(restore);
    const shown = h.cell.innerHTML;
    h.cell.innerHTML = shown;
    restore();
    const after = h.cell.querySelectorAll<HTMLElement>('[data-tag-cat="sound"]');
    assert.equal(after[0]?.hasAttribute("data-tag-editing"), false);
    assert.equal(after[1]?.hasAttribute("data-tag-editing"), true);
    const removed = h.editor.beforeWrite(h.cell);
    h.cell.innerHTML = outer.outerHTML;
    removed?.();
    assert.equal(h.cell.querySelector("[data-tag-editing]"), null);
    assert.equal(h.editor.finish(), false);
  } finally { h.editor.dispose(); }
});

test("an opened inner occurrence keeps link restrictions and disposal protects it again", () => {
  const h = fixture();
  const child = h.tags[1] as HTMLElement;
  h.select(child);
  h.activate();
  assert.equal(isInsideProtectedTagOrLink(child), false);
  child.innerHTML = '<a href="https://example.com/">umbrella</a>';
  assert.equal(isInsideProtectedTagOrLink(child.firstElementChild), true);
  h.editor.dispose();
  assert.equal(h.settled(), 0);
  assert.equal(child.getAttribute("contenteditable"), "false");
  assert.equal(document.getElementById("tag-edit-action"), null);
});

test("ordinary caret changes do not mutate the hidden occurrence control", async () => {
  const h = fixture();
  const button = document.getElementById("tag-edit-action") as HTMLElement;
  const changes: MutationRecord[] = [];
  const observer = new win.MutationObserver(records => { changes.push(...records); });
  try {
    const selection = win.getSelection() as Selection;
    selection.setBaseAndExtent(h.cell, h.cell.childNodes.length, h.cell, h.cell.childNodes.length);
    observer.observe(button, { attributes: true });
    for (let i = 0; i < 20; i++) document.dispatchEvent(new win.Event("selectionchange"));
    await new Promise(resolve => win.setTimeout(resolve, 0));
    assert.equal(changes.length, 0);
  } finally { observer.disconnect(); h.editor.dispose(); }
});

test("the visible occurrence control reads geometry before writes and leaves unchanged positions alone", () => {
  const h = fixture();
  const outer = h.tags[0] as HTMLElement;
  const button = document.getElementById("tag-edit-action") as HTMLElement;
  const rect = outer.getBoundingClientRect();
  outer.getClientRects = () => [rect] as unknown as DOMRectList;
  h.select(outer);
  h.activate();
  button.textContent = "stale";
  const observer = new win.MutationObserver(() => {});
  observer.observe(button, { attributes: true, childList: true });
  const beforeRead: number[] = [];
  outer.getBoundingClientRect = () => { beforeRead.push(observer.takeRecords().length); return rect; };
  Object.defineProperty(button, "offsetWidth", { get: () => { beforeRead.push(observer.takeRecords().length); return 80; } });
  Object.defineProperty(button, "offsetHeight", { get: () => { beforeRead.push(observer.takeRecords().length); return 28; } });
  try {
    h.editor.refresh();
    assert.deepEqual(beforeRead, [0, 0, 0]);
    assert.ok(observer.takeRecords().length > 0);
    assert.equal(button.textContent, "Done");
    for (let i = 0; i < 20; i++) h.editor.refresh();
    assert.equal(observer.takeRecords().length, 0);
    assert.ok(beforeRead.every(count => count === 0));
  } finally { observer.disconnect(); h.editor.dispose(); }
});

test("activating Done from the keyboard returns focus and a caret beyond the protected occurrence", () => {
  const h = fixture();
  try {
    const outer = h.tags[0] as HTMLElement;
    outer.getClientRects = () => [outer.getBoundingClientRect()] as unknown as DOMRectList;
    h.select(outer);
    h.activate();
    const button = document.getElementById("tag-edit-action") as HTMLElement;
    button.focus();
    assert.equal(document.activeElement, button);
    h.activate();
    const range = win.getSelection()?.getRangeAt(0);
    assert.equal(document.activeElement, h.cell);
    assert.equal(range?.collapsed, true);
    assert.equal(range?.startContainer, h.cell);
    assert.equal(range?.startOffset, 1);
    assert.equal(h.cell.querySelector("[data-tag-editing]"), null);
  } finally { h.editor.dispose(); }
});
