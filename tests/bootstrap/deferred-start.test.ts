import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { bootApp, closeApp } from "../../src/test/_app-boot.mjs";
import { stopApp } from "../../src/bootstrap/app.ts";

after(() => {
  stopApp();
  closeApp();
});

test("the start deferred to DOMContentLoaded succeeds without a panel or a logged error", async () => {
  const logged = mock.method(console, "error", () => {});
  let deferred = false;
  try {
    await bootApp(undefined, { beforeStart: () => { deferred = document.readyState === "loading"; } });
  } finally {
    logged.mock.restore();
  }
  assert.ok(deferred, "main.ts ran while the document was loading, so the start waited for DOMContentLoaded");
  assert.deepEqual(logged.mock.calls.map((call): unknown => call.arguments[0]), []);
  assert.equal(document.querySelector("#startup-failure"), null);
  assert.ok(document.querySelectorAll("#rows > *").length > 0, "the app started and drew the document");
});
