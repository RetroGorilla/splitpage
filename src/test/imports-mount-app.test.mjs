import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

window.Element.prototype.scrollIntoView = function () {};
await bootApp();
const { mountImportsFeature } = await import("../js/21-events.js");
const { documentTransitions } = await import("../legacy/transition-bridge.ts");
const { render } = await import("../js/05-render.js");
const { openImportModal, closeImportModal } = await import("../js/11-import.js");
after(closeApp);

function open() {
  documentTransitions().open({
    from: { raw: {
      schema: 2, docId: "dcccccccccccccccccccccccccccccccc", title: "Import lifetime",
      rows: [{ id: "r1", status: "todo", visualText: "Scene", audioText: "One" }]
    } }, reason: "import-lifetime"
  });
  render();
  S.importModeTouched = false;
  document.querySelector('input[name="import-split"][value="paragraph"]').checked = true;
  document.getElementById("import-preview").textContent = "replacement preview";
}

for (const scenario of ["dispose and reopen", "same-ID replacement", "stale completion after remount", "same-document modal reopen", "normal completion"]) {
  test("imports app: S31 preview timer, " + scenario, async () => {
    open();
    const owner = mountImportsFeature();
    const set = window.setTimeout;
    const clear = window.clearTimeout;
    const pending = new Map();
    const held = [];
    const cancelled = [];
    let serial = 1000000;
    window.setTimeout = function (fn, ms, ...args) {
      if (ms !== 150) return set(fn, ms, ...args);
      const id = ++serial;
      const run = () => fn(...args);
      pending.set(id, run);
      held.push(run);
      return id;
    };
    window.clearTimeout = function (id) {
      if (pending.delete(id)) cancelled.push(id);
      else clear(id);
    };
    let replacement;
    try {
      const textarea = document.getElementById("import-textarea");
      textarea.value = "Visual: Forest\nAudio: Hello";
      textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
      assert.equal(pending.size, 1);
      if (scenario === "dispose and reopen" || scenario === "stale completion after remount") {
        owner.dispose();
        assert.equal(pending.size, 0);
        assert.equal(cancelled.length, 1);
        open();
        replacement = mountImportsFeature();
      } else if (scenario === "same-ID replacement") {
        const prior = S.state;
        open();
        assert.notEqual(S.state, prior);
        assert.equal(S.state.docId, prior.docId);
      } else if (scenario === "same-document modal reopen") {
        closeImportModal();
        openImportModal();
        document.getElementById("import-preview").textContent = "replacement preview";
      }
      const jobs = [...pending.values()];
      pending.clear();
      jobs.forEach((run) => run());
      if (scenario === "stale completion after remount") held.forEach((run) => run());
      await Promise.resolve();
      const normal = scenario === "normal completion";
      assert.equal(document.querySelector('input[name="import-split"][value="twocolumn"]').checked, normal);
      const preview = document.getElementById("import-preview").textContent;
      if (normal) assert.match(preview, /This will create 1 row.*Forest.*Hello/);
      else assert.equal(preview, "replacement preview");
      if (replacement) {
        textarea.value = "Fresh text";
        textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
        assert.equal(pending.size, 1);
        const fresh = [...pending.values()];
        pending.clear();
        fresh.forEach((run) => run());
        assert.match(document.getElementById("import-preview").textContent, /Fresh text/);
      }
    } finally {
      owner.dispose();
      replacement?.dispose();
      window.setTimeout = set;
      window.clearTimeout = clear;
    }
  });
}
