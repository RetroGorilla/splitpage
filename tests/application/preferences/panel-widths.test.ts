import { test } from "node:test";
import assert from "node:assert/strict";
import { SIDE_PANEL_IDS, createPanelWidths } from "../../../src/application/preferences/panel-widths.ts";
import type { KeyValueStorage } from "../../../src/application/recovery/conflict-stash.ts";

function memoryStorage(): KeyValueStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items: items,
    getItem: function (key: string): string | null { return items.has(key) ? items.get(key) as string : null; },
    setItem: function (key: string, value: string): void { items.set(key, value); },
    removeItem: function (key: string): void { items.delete(key); }
  };
}

test("the side panels are the five the app has, in the order it closes them", () => {
  assert.deepEqual([...SIDE_PANEL_IDS], ["comments-panel", "production-panel", "gear-panel", "broll-panel", "history-panel"]);
  assert.equal(Object.isFrozen(SIDE_PANEL_IDS), true);
});

test("a width reads as the default until saved, is clamped to 280 to 720, and saving keeps the other panels' widths", () => {
  const storage = memoryStorage();
  const widths = createPanelWidths({ storage: () => storage });
  assert.equal(widths.defaultWidth("gear-panel"), 488);
  assert.equal(widths.read("gear-panel"), 488);
  assert.equal(widths.clamp(100, "gear-panel"), 280);
  assert.equal(widths.clamp(900, "gear-panel"), 720);
  assert.equal(widths.clamp(400.6, "gear-panel"), 401);
  assert.equal(widths.clamp(NaN, "gear-panel"), 488);
  widths.save("gear-panel", 300);
  widths.save("history-panel", 5000);
  assert.equal(widths.read("gear-panel"), 300);
  assert.equal(widths.read("history-panel"), 720);
  assert.equal(widths.read("broll-panel"), 488);
  assert.deepEqual(JSON.parse(storage.items.get("splitpage-panel-widths") as string), { "gear-panel": 300, "history-panel": 720 });
});

test("the comments panel falls back to its 3.x width key until it has its own saved width", () => {
  const storage = memoryStorage();
  const widths = createPanelWidths({ storage: () => storage });
  storage.items.set("splitpage-comments-panel-width", "350");
  assert.equal(widths.read("comments-panel"), 350);
  assert.equal(widths.read("gear-panel"), 488, "the fallback is for comments only");
  widths.save("comments-panel", 400);
  storage.items.set("splitpage-comments-panel-width", "600");
  assert.equal(widths.read("comments-panel"), 400);
});

test("a saved width that is not a number, a map that is not an object, and failing storage all read as the default", () => {
  const storage = memoryStorage();
  const widths = createPanelWidths({ storage: () => storage });
  storage.items.set("splitpage-panel-widths", JSON.stringify({ "gear-panel": "wide" }));
  assert.equal(widths.read("gear-panel"), 488);
  storage.items.set("splitpage-panel-widths", "7");
  assert.equal(widths.read("gear-panel"), 488);
  storage.items.set("splitpage-panel-widths", "{broken");
  assert.equal(widths.read("gear-panel"), 488);
  const fail = function (): never { throw new Error("storage is off"); };
  const broken = createPanelWidths({ storage: () => ({ getItem: fail, setItem: fail, removeItem: fail }) });
  assert.equal(broken.read("gear-panel"), 488);
  broken.save("gear-panel", 300);
  const none = createPanelWidths({ storage: () => null });
  assert.equal(none.read("gear-panel"), 488);
  none.save("gear-panel", 300);
});
