import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
const { findMatchesCase, setFindMatchCase } = await import("../application/find-options.ts");
const { mountFindEventsFeature: mountFindFeature } = await import("../bootstrap/wiring/find.ts");
after(closeApp);

const targets = {
  "find-close": "click", "find-next": "click", "find-prev": "click",
  "find-replace": "click", "find-replace-all": "click", "find-tag": "click",
  "find-tag-go": "click", "find-tag-cancel": "click", "find-tag-cats": "click",
  "find-case": "click", "find-input": "input", findbar: "keydown"
};

test("find app: all 12 listeners retain order and bubble phase, dispose fully and remount once", () => {
  mountFindFeature().dispose();
  const order = [];
  const records = Object.entries(targets).map(([id, expected]) => {
    const target = document.getElementById(id);
    assert.ok(target, id);
    const added = [];
    const active = [];
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    const phase = (options) => typeof options === "boolean" ? options : !!options?.capture;
    target.addEventListener = function (type, fn, options) {
      assert.equal(phase(options), false, id + ":" + type);
      added.push(type); active.push({ type, fn, capture: phase(options) }); order.push(id + ":" + type);
      return add.call(this, type, fn, options);
    };
    target.removeEventListener = function (type, fn, options) {
      const index = active.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === phase(options));
      assert.ok(index >= 0, id + ":" + type);
      active.splice(index, 1);
      return remove.call(this, type, fn, options);
    };
    return { id, target, expected, added, active, add, remove };
  });
  let owner;
  const priorCase = findMatchesCase();
  const caseButton = document.getElementById("find-case");
  const priorClass = caseButton.className;
  const priorAria = caseButton.getAttribute("aria-pressed");
  try {
    owner = mountFindFeature();
    const expectedOrder = Object.entries(targets).map(([id, type]) => id + ":" + type);
    assert.equal(order.length, 12);
    assert.deepEqual(order, expectedOrder);
    for (const r of records) { assert.deepEqual(r.added, [r.expected], r.id); assert.equal(r.active.length, 1, r.id); }
    owner.dispose(); owner.dispose();
    for (const r of records) assert.equal(r.active.length, 0, r.id);
    owner = mountFindFeature();
    assert.deepEqual(order, [...expectedOrder, ...expectedOrder]);
    for (const r of records) { assert.deepEqual(r.added, [r.expected, r.expected], r.id); assert.equal(r.active.length, 1, r.id); }
    caseButton.click();
    assert.equal(findMatchesCase(), !priorCase);
    assert.equal(caseButton.classList.contains("is-active"), !priorCase);
    assert.equal(caseButton.getAttribute("aria-pressed"), priorCase ? "false" : "true");
    owner.dispose();
    for (const r of records) assert.equal(r.active.length, 0, r.id);
    caseButton.click();
    assert.equal(findMatchesCase(), !priorCase);
  } finally {
    owner?.dispose();
    for (const r of records) { r.target.addEventListener = r.add; r.target.removeEventListener = r.remove; }
    setFindMatchCase(priorCase);
    caseButton.className = priorClass;
    if (priorAria === null) caseButton.removeAttribute("aria-pressed");
    else caseButton.setAttribute("aria-pressed", priorAria);
  }
});
