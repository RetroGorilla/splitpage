import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
const { mountOverlayFeature } = await import("../bootstrap/wiring/overlay.ts");
after(closeApp);

function install() {
  const owner = mountOverlayFeature();
  owner.mountToolbar(); owner.mountCommentsEscape(); owner.mountWriterBar(); owner.mountWriterFocus();
  return owner;
}

test("overlay app: six registrations retain order, phase and multiplicity through disposal and remount", () => {
  mountOverlayFeature().dispose();
  const order = [];
  const records = [
    ["document", document, ["mousedown/C", "focusin/B"]],
    ["toolbar", document.querySelector(".toolbar"), ["mousedown/B"]],
    ["window", window, ["keydown/B", "keydown/B"]],
    ["writer-bar", document.querySelector(".writer-bar"), ["mousedown/B"]]
  ].map(([id, target, expected]) => {
    assert.ok(target, id);
    const added = [];
    const active = [];
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    const key = (type, options) => type + ((typeof options === "boolean" ? options : options?.capture) ? "/C" : "/B");
    target.addEventListener = function (type, fn, options) {
      const entry = { fn, key: key(type, options) };
      added.push(entry.key); active.push(entry); order.push(id + ":" + entry.key);
      return add.call(this, type, fn, options);
    };
    target.removeEventListener = function (type, fn, options) {
      const index = active.findIndex((entry) => entry.fn === fn && entry.key === key(type, options));
      assert.ok(index >= 0, id + ":" + type);
      active.splice(index, 1);
      return remove.call(this, type, fn, options);
    };
    return { id, target, expected, added, active, add, remove };
  });
  let owner;
  try {
    owner = install();
    const expectedOrder = ["document:mousedown/C", "toolbar:mousedown/B", "window:keydown/B", "writer-bar:mousedown/B", "document:focusin/B", "window:keydown/B"];
    assert.deepEqual(order, expectedOrder);
    for (const r of records) { assert.deepEqual(r.added, r.expected, r.id); assert.equal(r.active.length, r.expected.length, r.id); }
    owner.dispose(); owner.dispose();
    for (const r of records) assert.equal(r.active.length, 0, r.id);
    owner = install();
    assert.deepEqual(order, [...expectedOrder, ...expectedOrder]);
    for (const r of records) { assert.deepEqual(r.added, [...r.expected, ...r.expected], r.id); assert.equal(r.active.length, r.expected.length, r.id); }
    owner.dispose();
    for (const r of records) assert.equal(r.active.length, 0, r.id);
  } finally {
    owner?.dispose();
    for (const r of records) { r.target.addEventListener = r.add; r.target.removeEventListener = r.remove; }
  }
});

test("overlay app: captured menu dismissal and selection retention use the live ports after remount", () => {
  const rows = document.getElementById("rows");
  assert.ok(rows);
  const wrap = document.createElement("div");
  wrap.className = "row-menu-wrap";
  wrap.innerHTML = '<button class="row-more" aria-expanded="true"></button><div class="row-menu"><button>Item</button></div>';
  rows.appendChild(wrap);
  const menu = wrap.querySelector(".row-menu");
  const item = menu?.querySelector("button");
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  outside.addEventListener("mousedown", (event) => { event.stopPropagation(); });
  const toolbarButton = document.querySelector(".toolbar .btn");
  const writerButton = document.querySelector(".writer-bar .wr-fmt");
  assert.ok(menu && item && toolbarButton && writerButton);
  let owner = install();
  owner.dispose();
  owner = install();
  const down = (target) => {
    const event = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  try {
    down(item);
    assert.equal(menu.hidden, false);
    down(outside);
    assert.equal(menu.hidden, true);
    assert.equal(down(toolbarButton).defaultPrevented, true);
    assert.equal(down(writerButton).defaultPrevented, true);
    owner.dispose(); menu.hidden = false;
    down(outside);
    assert.equal(menu.hidden, false);
    assert.equal(down(toolbarButton).defaultPrevented, false);
    assert.equal(down(writerButton).defaultPrevented, false);
  } finally { owner.dispose(); wrap.remove(); outside.remove(); }
});
