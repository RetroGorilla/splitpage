import "../../src/test/_dom.mjs";
import "../../src/test/_preferences-started.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../src/application/actions.ts";
import { createExportRegistry } from "../../src/application/export/registry.ts";
import type { Wiring } from "../../src/bootstrap/wiring.ts";
import { liveSession } from "../../src/legacy/session-bridge.ts";

test("the app module refuses a second start, and a start waiting for DOM ready is cancelled by stop", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  let released = 0;
  const wiring: Wiring = {
    actions: createActionRegistry(),
    exports: createExportRegistry(),
    session: liveSession(),
    keyTarget: new EventTarget(),
    dispose: () => { released++; }
  };
  const loading = Object.assign(new EventTarget(), { readyState: "loading" }) as unknown as Document;
  app.startAppWhenReady(loading, wiring);
  assert.throws(() => app.startAppWhenReady(loading, wiring), /already started or waiting/);
  app.stopApp();
  assert.equal(released, 1);
  loading.dispatchEvent(new Event("DOMContentLoaded"));
  app.startAppWhenReady(loading, wiring);
  app.stopApp();
  assert.equal(released, 2);
});

test("the saved theme and tag icons apply while the page is still loading, before DOM ready, and a stop before ready removes the listener", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  const root = document.documentElement;
  const wiring: Wiring = {
    actions: createActionRegistry(),
    exports: createExportRegistry(),
    session: liveSession(),
    keyTarget: new EventTarget(),
    dispose: () => {}
  };
  localStorage.setItem("splitpage-theme", "dark");
  localStorage.setItem("splitpage-tag-icons", "1");
  try {
    const loading = Object.assign(new EventTarget(), { readyState: "loading" }) as unknown as Document;
    app.startAppWhenReady(loading, wiring);
    assert.equal(root.getAttribute("data-theme"), "dark", "applied before DOMContentLoaded");
    assert.equal(root.getAttribute("data-tag-icons"), "");
    app.stopApp();
    localStorage.setItem("splitpage-theme", "light");
    const changed = new window.Event("storage");
    Object.defineProperty(changed, "key", { value: "splitpage-theme" });
    window.dispatchEvent(changed);
    assert.equal(root.getAttribute("data-theme"), "dark", "the other-tab listener went with the stop");
  } finally {
    localStorage.removeItem("splitpage-theme");
    localStorage.removeItem("splitpage-tag-icons");
    root.removeAttribute("data-theme");
    root.removeAttribute("data-tag-icons");
  }
});
