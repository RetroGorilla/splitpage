import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();
const { mountNoticesFeature } = await import("../bootstrap/wiring/views.ts");
after(closeApp);

for (const source of ["browser", "desktop"]) {
  for (const scenario of ["dispose while held", "stale completion after remount", "normal completion"]) {
    test("notices app: " + source + " update status, " + scenario, async () => {
      const priorDesktop = S.DESKTOP;
      const priorFetch = globalThis.fetch;
      let finish;
      let callback;
      const pending = new Promise((resolve) => { finish = resolve; });
      let activePending = pending;
      mountNoticesFeature().dispose();
      if (source === "desktop") {
        S.DESKTOP = {
          getUpdateStatus: () => activePending,
          onUpdateStatus: (fn) => { callback = fn; }
        };
      } else {
        S.DESKTOP = null;
        globalThis.fetch = (url, ...args) => url === "update-status.json" ? activePending : priorFetch(url, ...args);
      }
      const owner = mountNoticesFeature();
      const retained = callback;
      let replacement;
      try {
        if (scenario !== "normal completion") owner.dispose();
        if (source === "desktop" && scenario !== "normal completion") assert.equal(callback, null);
        if (scenario === "stale completion after remount") {
          activePending = new Promise(() => {});
          replacement = mountNoticesFeature();
        }
        const bar = document.getElementById("update-bar");
        const text = document.getElementById("update-bar-text");
        bar.hidden = true;
        text.textContent = "replacement notice";
        const status = { updateAvailable: true, version: "1", latest: "2", desktop: source === "desktop" };
        finish(source === "desktop" ? status : { ok: true, json: async () => status });
        await pending;
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        if (retained && scenario !== "normal completion") retained(status);
        const normal = scenario === "normal completion";
        assert.equal(bar.hidden, !normal);
        if (normal) assert.match(text.textContent, /2.*available/);
        else assert.equal(text.textContent, "replacement notice");
      } finally {
        owner.dispose();
        replacement?.dispose();
        S.DESKTOP = priorDesktop;
        globalThis.fetch = priorFetch;
      }
    });
  }
}
