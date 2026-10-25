import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";

window.Element.prototype.scrollIntoView = function () {};
await bootApp();
const { openBrollPanel, openBrollPage } = await import("../features/broll/panel.js");
const { mountBrollEventsFeature: mountBrollFeature } = await import("../bootstrap/wiring/production.ts");
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
        const before = currentDocument();
        open();
        assert.notEqual(currentDocument(), before);
        assert.equal(currentDocument().docId, before.docId);
      }
      if (scenario === "stale callback after remount" || scenario === "dispose and reopen") {
        replacement = mountBrollFeature();
        openBrollPanel();
      }
      document.getElementById("broll-add-input").value = "Held shot";
      const before = JSON.stringify(currentDocument());
      const panel = document.getElementById("broll-panel");
      const html = panel.innerHTML;
      held(new window.Event("click"));
      await Promise.resolve();
      if (scenario === "normal callback") assert.equal(currentDocument().brollShots.filter((shot) => shot.name === "Held shot").length, 1);
      else {
        assert.equal(JSON.stringify(currentDocument()), before);
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
    window.__hostedTest.setSession({ role: "review", docId: currentDocument().docId });
    const before = JSON.stringify(currentDocument().brollShots);
    document.getElementById("broll-add-input").value = "Review refused";
    fire(document.getElementById("broll-add-save"), "click");
    assert.equal(JSON.stringify(currentDocument().brollShots), before);
    window.__hostedTest.setSession({ role: "edit", docId: null });
    document.getElementById("broll-add-input").value = "Once after remount";
    fire(document.getElementById("broll-add-save"), "click");
    assert.equal(currentDocument().brollShots.filter((shot) => shot.name === "Once after remount").length, 1);
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
    replacement.dispose();
  }
});

test("export capture keeps the owner's live scope with the panel stopped", async () => {
  const { brollView } = await import("../application/preferences/broll-view.ts");
  const { exportRequest } = await import("../js/18-local-files.js");
  const { stopBrollPanelStateFeature, mountBrollPanelStateFeature } = await import("../bootstrap/wiring/broll.ts");
  const saved = brollView.current();
  open();
  try {
    brollView.setFilter("flagged");
    brollView.setPageGroup("person");
    stopBrollPanelStateFeature();
    assert.ok(currentDocument());
    const captured = exportRequest("b-roll csv");
    assert.deepEqual(captured.options.brollView, { filter: "flagged", group: "person" });
    brollView.setFilter("shot");
    assert.deepEqual(captured.options.brollView, { filter: "flagged", group: "person" });
    assert.deepEqual(exportRequest("b-roll csv").options.brollView, { filter: "shot", group: "person" });
    assert.deepEqual(exportRequest("b-roll csv", { brollView: { filter: "all", group: "scene" } }).options.brollView, { filter: "all", group: "scene" });
  } finally {
    brollView.setFilter(saved.filter);
    brollView.setGroup(saved.group);
    brollView.setPageGroup(saved.pageGroup);
    mountBrollPanelStateFeature();
  }
});

test("records lookup follows the booted instance, replacement and stop", async () => {
  const { currentBrollRecords, mountBrollFeature: mountRecords, stopBrollFeature: stopRecords } = await import("../bootstrap/wiring/broll.ts");
  const first = currentBrollRecords();
  assert.ok(first);
  try {
    const second = mountRecords();
    assert.notEqual(first, second);
    assert.equal(currentBrollRecords(), second);
    stopRecords();
    assert.equal(currentBrollRecords(), null);
  } finally {
    const replacement = mountRecords();
    assert.equal(currentBrollRecords(), replacement);
    assert.notEqual(currentBrollRecords(), first);
  }
});
