import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { externalLinks } from "../bootstrap/wiring/ports/desktop.ts";
import { IS_MAC } from "../features/common/key-chips.ts";

window.Element.prototype.scrollIntoView = function () {};
await bootApp(JSON.stringify({ schema: 2, title: "Link gestures", rows: [1, 2, 3, 4].map((n) => ({
  id: "r" + n, visualText: "Visual", status: "todo",
  audioText: n === 2 ? '<a href="https://example.com/beat"><strong>Link</strong></a>' : "Words"
})) }));
after(closeApp);

const T = window.__sceneSelectTest;
const cell = (id) => document.querySelector('#rows .audio-cell .cell-editable[data-id="' + id + '"]');
const link = () => cell("r2").querySelector("strong");
function fire(target, type, init = {}) {
  const e = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ctrlKey: !IS_MAC, metaKey: IS_MAC, ...init });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  mock.restoreAll();
  T.clear();
  document.activeElement.blur();
  document.getElementById("toast-host").replaceChildren();
  for (let n = 1; n <= 4; n++) {
    const bounds = () => ({ top: n * 100, bottom: n * 100 + 60, left: 0, right: 800, width: 800, height: 60 });
    cell("r" + n).getBoundingClientRect = bounds;
    cell("r" + n).closest(".row").getBoundingClientRect = bounds;
  }
  fire(cell("r1"), "mousedown");
  fire(cell("r3"), "mousedown");
  assert.deepEqual(T.ids(), ["r1", "r3"]);
});

for (const ending of ["r4", "link", "header"]) {
  test("a modified press on a link preserves beat selection when released on " + ending, () => {
    fire(link(), "mousedown", { clientY: 220 });
    fire(cell("r4"), "mousemove", { buttons: 1, clientY: 420 });
    assert.deepEqual(T.ids(), ["r1", "r3"]);
    assert.equal(T.tracking(), null);
    const target = ending === "link" ? link() : ending === "header" ? document.querySelector("header") : cell("r4");
    if (ending === "link") fire(link(), "mousemove", { buttons: 1, clientY: 220 });
    fire(target, "mouseup");
    assert.deepEqual(T.ids(), ["r1", "r3"]);
  });
}

for (const desktop of [false, true]) {
  test("an incomplete link warns before opening in the " + (desktop ? "desktop app" : "browser"), () => {
    const opens = [];
    mock.method(externalLinks, "available", () => desktop);
    mock.method(externalLinks, "open", (href) => opens.push(href));
    mock.method(window, "open", (href) => opens.push(href));
    const a = link().closest("a");
    const href = a.getAttribute("href");
    try {
      a.setAttribute("href", "https://");
      fire(link(), "mousedown");
      fire(link(), "click");
      assert.equal(document.getElementById("toast-host").textContent,
        "That link could not be opened — its address is not complete.");
      assert.deepEqual(opens, []);
      assert.deepEqual(T.ids(), ["r1", "r3"]);
    } finally {
      a.setAttribute("href", href);
    }
  });
}
