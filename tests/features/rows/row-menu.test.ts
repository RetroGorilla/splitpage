import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { closeRowMenus, rowMenuKeydown, toggleRowMenu } from "../../../src/features/rows/row-menu.js";

function rowHtml(id: string): string {
  return '<div class="row" data-id="' + id + '">' +
    '<button class="row-more" aria-expanded="false">more</button>' +
    '<div class="row-menu" hidden>' +
    '<button class="row-menu-item" data-n="1">One</button>' +
    '<button class="row-menu-item" data-n="2">Two</button>' +
    '<button class="row-menu-item" data-n="3">Three</button>' +
    '</div></div>';
}

function page(count = 2): void {
  document.body.innerHTML = '<div id="rows">' + Array.from({ length: count }, (_, i) => rowHtml("r" + i)).join("") + "</div>";
}

function more(row: number): HTMLElement {
  return document.querySelectorAll<HTMLElement>("#rows .row-more")[row] as HTMLElement;
}

function menu(row: number): HTMLElement {
  return document.querySelectorAll<HTMLElement>("#rows .row-menu")[row] as HTMLElement;
}

function item(row: number, n: number): HTMLElement {
  return menu(row).querySelectorAll<HTMLElement>(".row-menu-item")[n] as HTMLElement;
}

function key(target: Element, name: string): { event: KeyboardEvent; prevented: () => boolean; stopped: () => boolean } {
  let prevented = false;
  let stopped = false;
  const event = {
    key: name,
    target,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; }
  } as unknown as KeyboardEvent;
  return { event, prevented: () => prevented, stopped: () => stopped };
}

test("toggleRowMenu: opens a hidden menu and marks the button and row", () => {
  page();
  toggleRowMenu(more(0), false);
  assert.equal(menu(0).hidden, false);
  assert.equal(more(0).getAttribute("aria-expanded"), "true");
  assert.equal(menu(0).closest(".row")?.classList.contains("has-menu-open"), true);
  assert.equal(document.activeElement === item(0, 0), false);
});

test("toggleRowMenu: a second toggle closes the menu again", () => {
  page();
  toggleRowMenu(more(0), false);
  toggleRowMenu(more(0), false);
  assert.equal(menu(0).hidden, true);
  assert.equal(more(0).getAttribute("aria-expanded"), "false");
  assert.equal(menu(0).closest(".row")?.classList.contains("has-menu-open"), false);
});

test("toggleRowMenu: opening one menu closes the other open menu", () => {
  page();
  toggleRowMenu(more(0), false);
  toggleRowMenu(more(1), false);
  assert.equal(menu(0).hidden, true);
  assert.equal(more(0).getAttribute("aria-expanded"), "false");
  assert.equal(menu(0).closest(".row")?.classList.contains("has-menu-open"), false);
  assert.equal(menu(1).hidden, false);
  assert.equal(menu(1).closest(".row")?.classList.contains("has-menu-open"), true);
});

test("toggleRowMenu: focuses the first item only when asked", () => {
  page();
  toggleRowMenu(more(0), true);
  assert.equal(document.activeElement, item(0, 0));
});

test("toggleRowMenu: does nothing for a button with no menu beside it", () => {
  document.body.innerHTML = '<div id="rows"><div class="row"><button class="row-more" aria-expanded="false"></button></div></div>';
  const btn = document.querySelector(".row-more") as HTMLElement;
  toggleRowMenu(btn, true);
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(document.querySelector(".has-menu-open"), null);
});

test("toggleRowMenu: opens upward when the menu would run past the bottom of the window", () => {
  page(1);
  const btn = more(0);
  const m = menu(0);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  m.getBoundingClientRect = () => ({ top: 560, bottom: 700, height: 140 }) as DOMRect;
  Object.defineProperty(btn, "offsetHeight", { configurable: true, value: 30 });
  toggleRowMenu(btn, false);
  assert.equal(m.classList.contains("opens-up"), true);
  toggleRowMenu(btn, false);
  m.getBoundingClientRect = () => ({ top: 100, bottom: 240, height: 140 }) as DOMRect;
  toggleRowMenu(btn, false);
  assert.equal(m.classList.contains("opens-up"), false);
});

test("toggleRowMenu: stays downward when there is no room above either", () => {
  page(1);
  const btn = more(0);
  const m = menu(0);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  m.getBoundingClientRect = () => ({ top: 30, bottom: 640, height: 610 }) as DOMRect;
  Object.defineProperty(btn, "offsetHeight", { configurable: true, value: 30 });
  toggleRowMenu(btn, false);
  assert.equal(m.classList.contains("opens-up"), false);
});

test("toggleRowMenu: leaves room for the phone bar when deciding to open upward", () => {
  page(1);
  const btn = more(0);
  const m = menu(0);
  const bar = document.createElement("div");
  bar.id = "phone-bar";
  Object.defineProperty(bar, "offsetHeight", { configurable: true, value: 60 });
  document.body.appendChild(bar);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  m.getBoundingClientRect = () => ({ top: 400, bottom: 520, height: 120 }) as DOMRect;
  Object.defineProperty(btn, "offsetHeight", { configurable: true, value: 30 });
  toggleRowMenu(btn, false);
  assert.equal(m.classList.contains("opens-up"), false);
  toggleRowMenu(btn, false);
  m.getBoundingClientRect = () => ({ top: 400, bottom: 540, height: 140 }) as DOMRect;
  toggleRowMenu(btn, false);
  assert.equal(m.classList.contains("opens-up"), true);
});

test("closeRowMenus: closes every open menu, or every one except the named menu", () => {
  page(3);
  toggleRowMenu(more(0), false);
  toggleRowMenu(more(1), false);
  menu(2).hidden = false;
  closeRowMenus(menu(1));
  assert.equal(menu(0).hidden, true);
  assert.equal(menu(1).hidden, false);
  assert.equal(menu(2).hidden, true);
  closeRowMenus();
  assert.equal(menu(1).hidden, true);
  assert.equal(more(1).getAttribute("aria-expanded"), "false");
  assert.equal(document.querySelector(".has-menu-open"), null);
});

test("rowMenuKeydown: ArrowDown on a closed menu button opens the menu and focuses the first item", () => {
  page(1);
  const k = key(more(0), "ArrowDown");
  assert.equal(rowMenuKeydown(k.event), true);
  assert.equal(k.prevented(), true);
  assert.equal(menu(0).hidden, false);
  assert.equal(document.activeElement, item(0, 0));
});

test("rowMenuKeydown: ArrowUp on an already open menu button is handled but changes nothing", () => {
  page(1);
  toggleRowMenu(more(0), false);
  const k = key(more(0), "ArrowUp");
  assert.equal(rowMenuKeydown(k.event), true);
  assert.equal(k.prevented(), true);
  assert.equal(menu(0).hidden, false);
  assert.notEqual(document.activeElement, item(0, 0));
});

test("rowMenuKeydown: arrows move through the items and wrap at both ends", () => {
  page(1);
  toggleRowMenu(more(0), true);
  assert.equal(rowMenuKeydown(key(item(0, 0), "ArrowDown").event), true);
  assert.equal(document.activeElement, item(0, 1));
  rowMenuKeydown(key(item(0, 1), "ArrowDown").event);
  assert.equal(document.activeElement, item(0, 2));
  rowMenuKeydown(key(item(0, 2), "ArrowDown").event);
  assert.equal(document.activeElement, item(0, 0));
  rowMenuKeydown(key(item(0, 0), "ArrowUp").event);
  assert.equal(document.activeElement, item(0, 2));
  rowMenuKeydown(key(item(0, 2), "ArrowUp").event);
  assert.equal(document.activeElement, item(0, 1));
});

test("rowMenuKeydown: Home and End jump to the first and last item", () => {
  page(1);
  toggleRowMenu(more(0), true);
  const end = key(item(0, 0), "End");
  assert.equal(rowMenuKeydown(end.event), true);
  assert.equal(end.prevented(), true);
  assert.equal(document.activeElement, item(0, 2));
  assert.equal(rowMenuKeydown(key(item(0, 2), "Home").event), true);
  assert.equal(document.activeElement, item(0, 0));
});

test("rowMenuKeydown: Escape closes the menus, returns focus to the button and stops the event", () => {
  page(2);
  toggleRowMenu(more(0), true);
  const k = key(item(0, 1), "Escape");
  assert.equal(rowMenuKeydown(k.event), true);
  assert.equal(k.prevented(), true);
  assert.equal(k.stopped(), true);
  assert.equal(menu(0).hidden, true);
  assert.equal(document.activeElement, more(0));
});

test("rowMenuKeydown: Tab closes the menus but leaves the event to the browser", () => {
  page(1);
  toggleRowMenu(more(0), true);
  const k = key(item(0, 0), "Tab");
  assert.equal(rowMenuKeydown(k.event), false);
  assert.equal(k.prevented(), false);
  assert.equal(menu(0).hidden, true);
});

test("rowMenuKeydown: ignores keys outside an open menu and other keys inside it", () => {
  page(1);
  assert.equal(rowMenuKeydown(key(item(0, 0), "ArrowDown").event), false);
  assert.equal(rowMenuKeydown(key(more(0), "Enter").event), false);
  assert.equal(rowMenuKeydown({ key: "ArrowDown", target: null } as unknown as KeyboardEvent), false);
  assert.equal(rowMenuKeydown({ key: "ArrowDown", target: {} } as unknown as KeyboardEvent), false);
  toggleRowMenu(more(0), true);
  const k = key(item(0, 0), "a");
  assert.equal(rowMenuKeydown(k.event), false);
  assert.equal(k.prevented(), false);
  assert.equal(menu(0).hidden, false);
});
