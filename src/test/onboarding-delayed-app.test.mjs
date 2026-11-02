import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { startupReady } from "../application/startup-signal.ts";

after(closeApp);

test("pristine onboarding waits for delayed DOM readiness and mounted panels before deciding (#845)", async () => {
  const dispatch = document.dispatchEvent;
  const errors = [];
  let dispatched;
  const ready = new Promise(resolve => { dispatched = resolve; });
  let decided = false;
  document.dispatchEvent = function (event) {
    if (event.type !== "DOMContentLoaded") return dispatch.call(this, event);
    setTimeout(() => {
      dispatch.call(this, event);
      dispatched();
    }, 75);
    return true;
  };
  try {
    await bootApp(undefined, { beforeStart() {
      window.__onboarding.autoShowDecided().then(() => { decided = true; }, error => { errors.push(error.message); });
    } });
    await ready;
    await startupReady();
    await window.__onboarding.autoShowDecided().catch(() => {});
    assert.deepEqual(errors, []);
    assert.equal(decided, true);
    assert.equal(document.querySelectorAll("#rows .row").length, 2);
    assert.equal(document.getElementById("onboarding-modal").hidden, false);
    assert.equal(document.activeElement, document.querySelector("#onboarding-modal .modal-close"));
  } finally {
    document.dispatchEvent = dispatch;
  }
});
