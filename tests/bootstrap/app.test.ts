import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("the app module refuses a second start, and a start waiting for DOM ready is cancelled by stop", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  const loading = Object.assign(new EventTarget(), { readyState: "loading" }) as unknown as Document;
  app.startAppWhenReady(loading);
  assert.throws(() => app.startAppWhenReady(loading), /already started or waiting/);
  app.stopApp();
  loading.dispatchEvent(new Event("DOMContentLoaded"));
  app.startAppWhenReady(loading);
  app.stopApp();
});
