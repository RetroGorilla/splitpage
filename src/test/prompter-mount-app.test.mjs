import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();
const { setPrompterOpen } = await import("../application/prompter-state.ts");
const { mountPrompterVisibilityFeature } = await import("../js/22d-views-wiring.js");
const { documentTransitions } = await import("../legacy/transition-bridge.ts");
after(closeApp);

function open() {
  documentTransitions().open({ from: { raw: {
    schema: 2, docId: "deeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", title: "Wake lock lifetime",
    rows: [{ id: "r1", status: "todo", visualText: "Scene", audioText: "One" }]
  } }, reason: "wake-lock-lifetime" });
  setPrompterOpen(true);
}

for (const scenario of ["dispose and reopen", "same-ID replacement", "stale completion after remount", "normal completion"]) {
  test("prompter app: held visibility wake lock, " + scenario, async () => {
    open();
    const prior = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let finish;
    let released = 0;
    const pending = new Promise((resolve) => { finish = resolve; });
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: () => pending } });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const owner = mountPrompterVisibilityFeature();
    let replacement;
    try {
      document.dispatchEvent(new window.Event("visibilitychange"));
      if (scenario === "dispose and reopen" || scenario === "stale completion after remount") {
        owner.dispose();
        open();
        replacement = mountPrompterVisibilityFeature();
      } else if (scenario === "same-ID replacement") {
        const held = S.state;
        open();
        assert.notEqual(S.state, held);
        assert.equal(S.state.docId, held.docId);
      }
      finish({ release: async () => { released++; } });
      await pending;
      await Promise.resolve();
      assert.equal(released, scenario === "normal completion" ? 0 : 1);
    } finally {
      owner.dispose();
      replacement?.dispose();
      const { disposePrompterView } = await import("../js/20-teleprompter.js");
      disposePrompterView();
      setPrompterOpen(false);
      if (prior) Object.defineProperty(navigator, "wakeLock", prior);
      else delete navigator.wakeLock;
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else delete document.visibilityState;
    }
  });
}
