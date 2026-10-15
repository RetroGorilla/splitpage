import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Wiring } from "../../src/bootstrap/wiring.ts";

test("the app module refuses a second start, and a start waiting for DOM ready is cancelled by stop", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  let released = 0;
  const wiring = { dispose: () => { released++; } } as unknown as Wiring;
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
