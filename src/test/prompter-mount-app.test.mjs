import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";

await bootApp();
const { prompterState } = await import("../bootstrap/wiring/ports/preferences.ts");
const { mountPrompterVisibilityFeature } = await import("../bootstrap/wiring/views.ts");
const { documentTransitions } = await import("../bootstrap/wiring/transition-owners.ts");
after(closeApp);

function open() {
  documentTransitions().open({ from: { raw: {
    schema: 2, docId: "deeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", title: "Wake lock lifetime",
    rows: [{ id: "r1", status: "todo", visualText: "Scene", audioText: "One" }]
  } }, reason: "wake-lock-lifetime" });
  prompterState.setOpen(true);
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
        const held = currentDocument();
        open();
        assert.notEqual(currentDocument(), held);
        assert.equal(currentDocument().docId, held.docId);
      }
      finish({ release: async () => { released++; } });
      await pending;
      await Promise.resolve();
      assert.equal(released, scenario === "normal completion" ? 0 : 1);
    } finally {
      owner.dispose();
      replacement?.dispose();
      const { disposePrompterView } = await import("../features/prompter/prompter.js");
      disposePrompterView();
      prompterState.setOpen(false);
      if (prior) Object.defineProperty(navigator, "wakeLock", prior);
      else delete navigator.wakeLock;
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else delete document.visibilityState;
    }
  });
}
