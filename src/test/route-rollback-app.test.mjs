import "./_dom.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const { bootApp, closeApp } = await import("./_app-boot.mjs");
await bootApp();
const app = await import("../bootstrap/app.ts");
const { mountRowsFeature, routeRootClick, routeRootMouseDown, rootRoutesTaken, stopRowsFeature } = await import("../bootstrap/wiring/editor.ts");
const { mountTagsFeature, stopTagsFeature } = await import("../bootstrap/wiring/production.ts");

after(() => {
  app.stopApp();
  closeApp();
});

const ROWS_SLOTS = ["rows-add", "rows-scene", "rows-menu"];

test("a feature whose later route slot is taken releases the slots it already took, and a retry succeeds once the slot is free", () => {
  stopRowsFeature();
  const before = rootRoutesTaken().click;
  assert.deepEqual(before.filter((s) => ROWS_SLOTS.includes(s)), [], "the rows feature is stopped");
  const unblock = routeRootClick("rows-scene", () => false);
  assert.throws(() => mountRowsFeature(), /already taken/);
  assert.deepEqual(rootRoutesTaken().click.filter((s) => ROWS_SLOTS.includes(s)), ["rows-scene"],
    "only the blocker holds a rows slot; rows-add, taken before the failure, is released");
  unblock();
  assert.deepEqual(rootRoutesTaken().click, before);
  mountRowsFeature();
  assert.deepEqual(rootRoutesTaken().click.filter((s) => ROWS_SLOTS.includes(s)), ROWS_SLOTS, "the retry takes all three slots");
});

test("the tags feature releases both click routes when its later mousedown route is taken, and retries", () => {
  stopTagsFeature();
  const before = rootRoutesTaken();
  assert.deepEqual(before.click.filter((slot) => slot === "tags" || slot === "tags-jump"), []);
  assert.deepEqual(before.mousedown, []);
  const unblock = routeRootMouseDown("tags-anchor", () => false);
  try {
    assert.throws(() => mountTagsFeature(), /already taken/);
    assert.deepEqual(rootRoutesTaken(), { click: before.click, mousedown: ["tags-anchor"] });
  } finally {
    unblock();
  }
  assert.deepEqual(rootRoutesTaken(), before);
  mountTagsFeature();
  assert.deepEqual(rootRoutesTaken().click.filter((slot) => slot === "tags" || slot === "tags-jump"), ["tags-jump", "tags"]);
  assert.deepEqual(rootRoutesTaken().mousedown, ["tags-anchor"]);
});
