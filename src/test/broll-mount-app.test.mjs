import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

window.Element.prototype.scrollIntoView = function () {};
await bootApp();
const { mountBrollFeature, openBrollPanel, openBrollPage } = await import("../js/08d-broll-panel.js");
const { documentTransitions } = await import("../legacy/transition-bridge.ts");
const { render } = await import("../js/05-render.js");
after(closeApp);

function open() {
  documentTransitions().open({
    from: { raw: {
      schema: 2, docId: "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", title: "B-roll lifetime",
      rows: [{ id: "r1", status: "todo", visualText: "Scene", audioText: "One" }],
      brollShots: [{ id: "b_one", name: "First shot", origin: "list", status: "unshot", notes: "", props: [] }]
    } },
    reason: "broll-lifetime"
  });
  render();
  openBrollPanel();
}

function fire(target, type, props = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

for (const scenario of ["dispose and reopen", "same-ID document replacement", "stale callback after remount", "normal callback"]) {
  test("b-roll app: retained handler, " + scenario, async () => {
    open();
    mountBrollFeature().dispose();
    const button = document.getElementById("broll-add-save");
    const previous = button.addEventListener;
    let held;
    button.addEventListener = function (type, fn, options) {
      if (type === "click") held = fn;
      return previous.call(this, type, fn, options);
    };
    const owner = mountBrollFeature();
    button.addEventListener = previous;
    openBrollPanel();
    assert.equal(typeof held, "function");
    let replacement;
    try {
      if (scenario !== "normal callback") owner.dispose();
      if (scenario === "dispose and reopen" || scenario === "same-ID document replacement") {
        const before = S.state;
        open();
        assert.notEqual(S.state, before);
        assert.equal(S.state.docId, before.docId);
      }
      if (scenario === "stale callback after remount" || scenario === "dispose and reopen") {
        replacement = mountBrollFeature();
        openBrollPanel();
      }
      document.getElementById("broll-add-input").value = "Held shot";
      const before = JSON.stringify(S.state);
      const panel = document.getElementById("broll-panel");
      const html = panel.innerHTML;
      held(new window.Event("click"));
      await Promise.resolve();
      if (scenario === "normal callback") assert.equal(S.state.brollShots.filter((shot) => shot.name === "Held shot").length, 1);
      else {
        assert.equal(JSON.stringify(S.state), before);
        assert.equal(panel.innerHTML, html);
        assert.equal(document.getElementById("broll-add-input").value, "Held shot");
      }
    } finally {
      owner.dispose();
      replacement?.dispose();
    }
  });
}

test("b-roll app: remount adds once, preserves review refusal, and disposal clears menus, selection and page focus resources", () => {
  open();
  const owner = mountBrollFeature();
  openBrollPanel();
  fire(document.querySelector('.broll-row-main[data-id="b_one"]'), "click", { ctrlKey: true });
  assert.deepEqual(window.__brollTest.selected(), ["b_one"]);
  fire(document.querySelector('[data-action="broll-group-menu"]'), "click");
  assert.ok(document.querySelector(".broll-group-menu"));
  openBrollPage();
  assert.equal(document.body.classList.contains("broll-page-open"), true);
  owner.dispose();
  assert.deepEqual(window.__brollTest.selected(), []);
  assert.equal(document.getElementById("broll-page").hidden, true);
  assert.equal(document.getElementById("broll-panel").hidden, true);
  assert.equal(document.body.classList.contains("broll-page-open"), false);
  const replacement = mountBrollFeature();
  try {
    openBrollPanel();
    assert.equal(document.querySelector(".broll-group-menu"), null);
    assert.equal(document.querySelector(".broll-card"), null);
    window.__hostedTest.setSession({ role: "review", docId: S.state.docId });
    const before = JSON.stringify(S.state.brollShots);
    document.getElementById("broll-add-input").value = "Review refused";
    fire(document.getElementById("broll-add-save"), "click");
    assert.equal(JSON.stringify(S.state.brollShots), before);
    window.__hostedTest.setSession({ role: "edit", docId: null });
    document.getElementById("broll-add-input").value = "Once after remount";
    fire(document.getElementById("broll-add-save"), "click");
    assert.equal(S.state.brollShots.filter((shot) => shot.name === "Once after remount").length, 1);
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
    replacement.dispose();
  }
});
