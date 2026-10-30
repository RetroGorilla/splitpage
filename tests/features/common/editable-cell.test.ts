import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DIRECTION_BUTTON_TITLE, editableCellHtml } from "../../../src/features/common/editable-cell.js";

function parse(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

test("editableCellHtml: a bare cell is one editable div with a placeholder and no toolbar", () => {
  const host = parse(editableCellHtml({ value: "<b>hi</b>", placeholder: "Say it" }));
  assert.equal(host.children.length, 1);
  const cell = host.firstElementChild as HTMLElement;
  assert.equal(cell.className, "cell-editable");
  assert.equal(cell.getAttribute("contenteditable"), "true");
  assert.equal(cell.hasAttribute("tabindex"), false);
  assert.equal(cell.getAttribute("data-placeholder"), "Say it");
  assert.equal(cell.hasAttribute("data-id"), false);
  assert.equal(cell.innerHTML, "<b>hi</b>");
});

test("editableCellHtml: row id and field are escaped into data attributes", () => {
  const host = parse(editableCellHtml({ rowId: 'r"1<', field: "a&b", placeholder: 'p"q', className: "extra" }));
  const cell = host.firstElementChild as HTMLElement;
  assert.equal(cell.className, "extra cell-editable");
  assert.equal(cell.getAttribute("data-id"), 'r"1<');
  assert.equal(cell.getAttribute("data-field"), "a&b");
  assert.equal(cell.getAttribute("data-placeholder"), 'p"q');
  assert.equal(editableCellHtml({ rowId: 0, field: "f" }).includes('data-id="0"'), true);
});

test("editableCellHtml: a read-only cell is not editable but stays focusable", () => {
  const cell = parse(editableCellHtml({ readOnly: true })).firstElementChild as HTMLElement;
  assert.equal(cell.getAttribute("contenteditable"), "false");
  assert.equal(cell.getAttribute("tabindex"), "0");
});

test("editableCellHtml: script toolbar wraps the cell with formatting buttons and a hidden link popover", () => {
  const host = parse(editableCellHtml({ toolbar: "script", wrapStyle: "width:50%", value: "x" }));
  const wrap = host.firstElementChild as HTMLElement;
  assert.equal(wrap.className, "field-wrap");
  assert.equal(wrap.getAttribute("style"), "width:50%");
  const bar = wrap.querySelector(".mini-toolbar") as HTMLElement;
  assert.equal(bar.getAttribute("role"), "toolbar");
  assert.equal(bar.getAttribute("aria-label"), "Text formatting");
  const commands = [...bar.querySelectorAll("[data-cmd]")].map((b) => b.getAttribute("data-cmd"));
  assert.deepEqual(commands, ["bold", "italic", "underline", "strikeThrough", "highlight", "link", "comment", "tag"]);
  assert.equal(wrap.querySelectorAll(".cell-editable").length, 1);
  const popover = wrap.querySelector(".link-popover") as HTMLElement;
  assert.equal(popover.hasAttribute("hidden"), true);
  assert.ok(popover.querySelector('[data-role="link-input"]'));
  assert.ok(popover.querySelector('[data-action="link-confirm"]'));
  assert.ok(popover.querySelector('[data-action="link-cancel"]'));
});

test("editableCellHtml: the audio script toolbar adds the stage direction button", () => {
  const bar = parse(editableCellHtml({ toolbar: "scriptAudio" })).querySelector(".mini-toolbar") as HTMLElement;
  const commands = [...bar.querySelectorAll("[data-cmd]")].map((b) => b.getAttribute("data-cmd"));
  assert.equal(commands[commands.length - 1], "direction");
  assert.equal(commands.length, 9);
  assert.equal(bar.querySelector('[data-cmd="direction"]')?.getAttribute("title"), DIRECTION_BUTTON_TITLE);
});

test("editableCellHtml: the reply toolbar is smaller and labelled for replies", () => {
  const bar = parse(editableCellHtml({ toolbar: "reply" })).querySelector(".mini-toolbar") as HTMLElement;
  assert.equal(bar.getAttribute("aria-label"), "Reply formatting");
  const commands = [...bar.querySelectorAll("[data-cmd]")].map((b) => b.getAttribute("data-cmd"));
  assert.deepEqual(commands, ["bold", "italic", "underline", "link"]);
});

test("editableCellHtml: an unknown toolbar name falls back to the bare cell", () => {
  const host = parse(editableCellHtml({ toolbar: "nope", value: "x" }));
  assert.equal(host.querySelector(".field-wrap"), null);
  assert.equal(host.firstElementChild?.className, "cell-editable");
});
