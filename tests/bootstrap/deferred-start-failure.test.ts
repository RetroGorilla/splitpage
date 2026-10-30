import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { bootApp, closeApp } from "../../src/test/_app-boot.mjs";
import { stopApp } from "../../src/bootstrap/app.ts";

after(() => {
  stopApp();
  closeApp();
});

test("a mount that throws in the start deferred to DOMContentLoaded shows the panel and logs the error", async () => {
  const failure = new Error("the preference watch could not listen");
  const realAdd = window.addEventListener;
  const logged = mock.method(console, "error", () => {});
  let deferred = false;
  try {
    await bootApp(undefined, {
      beforeStart: () => {
        deferred = document.readyState === "loading";
        window.addEventListener = function (this: Window, ...args: Parameters<Window["addEventListener"]>): void {
          if (args[0] === "storage") throw failure;
          realAdd.apply(this, args);
        };
      }
    });
  } finally {
    window.addEventListener = realAdd;
    logged.mock.restore();
  }
  assert.ok(deferred, "main.ts ran while the document was loading, so the start waited for DOMContentLoaded");
  const reported = logged.mock.calls.map((call): unknown => call.arguments[0]);
  assert.ok(reported.some((error) => error === failure || (error instanceof AggregateError && error.errors[0] === failure)), "console.error got the failure");
  const panel = document.querySelector("#startup-failure");
  assert.ok(panel, "the panel is in the page");
  assert.equal(panel.querySelector("h1")?.textContent, "Splitpage couldn't start");
  assert.match(panel.querySelector("pre > code")?.textContent ?? "", /Error: the (preference watch could not listen|app failed to start)/);
  assert.deepEqual([...panel.querySelectorAll("button")].map((b) => b.textContent), ["Copy details", "Reload"]);
});
