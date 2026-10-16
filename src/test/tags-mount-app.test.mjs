import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();
const { mountTagsFeature } = await import("../js/22b-production-wiring.js");
const { documentTransitions } = await import("../legacy/transition-bridge.ts");
const { render } = await import("../js/05-render.js");
const { openProductionPanel } = await import("../js/08-production-panels.js");
const { selectedKeys, clearProductionSelection, tagKey } = await import("../js/07-production-tags.js");
after(closeApp);

function open() {
  documentTransitions().open({
    from: { raw: {
      schema: 2, docId: "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Tags lifetime",
      rows: [{ id: "r1", status: "todo", visualText: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Hat" contenteditable="false">Hat</span>', audioText: "One" }],
      productionTags: [{ id: "t_hat", cat: "prop", name: "Hat", owner: "", notes: "", status: "needed" }]
    } },
    reason: "tags-lifetime"
  });
  render();
  clearProductionSelection();
  openProductionPanel();
}

function fire(target, type, props = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

for (const work of ["card", "touch"]) {
  for (const scenario of ["dispose and reopen", "same-ID replacement", "stale completion after remount", "normal completion"]) {
    test("tags app: " + work + ", " + scenario, async () => {
      open();
      const owner = mountTagsFeature();
      const previousSet = window.setTimeout;
      const previousClear = window.clearTimeout;
      const pending = new Map();
      const held = [];
      const cancelled = [];
      let serial = 1000000;
      window.setTimeout = function (fn, ms, ...args) {
        if (ms !== 30 && ms !== 450) return previousSet(fn, ms, ...args);
        const id = ++serial;
        pending.set(id, { fn, ms });
        held.push(fn);
        return id;
      };
      window.clearTimeout = function (id) {
        if (pending.has(id)) { cancelled.push(id); pending.delete(id); }
        else previousClear(id);
      };
      let replacement;
      try {
        if (work === "card") fire(document.querySelector("#rows .tag-anchor"), "mousedown");
        else fire(document.querySelector("#production-list .tag-entity"), "pointerdown", { pointerType: "touch", clientX: 2, clientY: 3 });
        assert.equal(pending.size, 1);
        assert.equal([...pending.values()][0].ms, work === "card" ? 30 : 450);
        if (scenario === "dispose and reopen" || scenario === "stale completion after remount") {
          owner.dispose();
          assert.equal(pending.size, 0);
          assert.equal(cancelled.length, 1);
          open();
          replacement = mountTagsFeature();
        } else if (scenario === "same-ID replacement") {
          const before = S.state;
          open();
          assert.notEqual(S.state, before);
          assert.equal(S.state.docId, before.docId);
        }
        let scrolled = 0;
        const card = document.querySelector("#production-list .tag-entity");
        card.scrollIntoView = () => { scrolled++; };
        const jobs = [...pending.values()];
        pending.clear();
        jobs.forEach(({ fn }) => fn());
        if (scenario === "stale completion after remount") held.forEach((fn) => fn());
        await Promise.resolve();
        assert.equal(scrolled, work === "card" && scenario === "normal completion" ? 1 : 0);
        assert.equal(card.classList.contains("flash"), work === "card" && scenario === "normal completion");
        assert.deepEqual(selectedKeys(), work === "touch" && scenario === "normal completion" ? [tagKey("prop", "Hat")] : []);
      } finally {
        owner.dispose();
        replacement?.dispose();
        window.setTimeout = previousSet;
        window.clearTimeout = previousClear;
      }
    });
  }
}

test("tags app: the shared review gate still precedes moved click branches after remount", () => {
  open();
  const owner = mountTagsFeature();
  const button = document.createElement("button");
  button.dataset.action = "tag-rename";
  button.dataset.key = tagKey("prop", "Hat");
  document.getElementById("production-panel").append(button);
  const prior = S.tagRenaming;
  window.__hostedTest.setSession({ role: "review", docId: "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  try {
    fire(button, "click");
    assert.equal(S.tagRenaming, prior);
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
    owner.dispose();
    button.remove();
  }
});
