import "./_dom.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PREF_EVENT, preferences, startPreferences } from "../legacy/preferences-bridge.ts";
import { __init as initRundown, isRundownMinimized, toggleRundownMinimized } from "../js/05f-rundown.js";
import { __init as initZoom, scriptScale, setScriptScale } from "../js/05s-script-zoom.js";
import { dismissDesktopAppNotice, renderDesktopAppNotice } from "../js/20a-update.js";

const frames = new Map();
let nextFrame = 1;
globalThis.requestAnimationFrame = (fn) => {
  const id = nextFrame++;
  frames.set(id, fn);
  return id;
};
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
document.elementFromPoint = () => null;

function finishFrames() {
  for (let i = 0; frames.size && i < 100; i++) {
    const due = [...frames.values()];
    frames.clear();
    for (const fn of due) fn();
  }
  assert.equal(frames.size, 0);
}

const stop = startPreferences({
  storage: () => localStorage,
  announce: (change) => document.dispatchEvent(new window.CustomEvent(PREF_EVENT, { detail: change }))
});
after(stop);
document.body.innerHTML = '<div id="root"></div><div id="rows"></div><div id="rundown"></div><button id="menu-rundown-min"></button><div id="desktop-app-bar" hidden><span id="desktop-app-bar-text"></span><button id="desktop-app-bar-action"></button></div>';
initRundown();
initZoom();
const heard = [];
document.addEventListener(PREF_EVENT, (e) => { heard.push(e.detail); });

test("rundown toggles announce once to another listener and owner changes update its controls", () => {
  heard.length = 0;
  toggleRundownMinimized();
  assert.equal(isRundownMinimized(), true);
  assert.equal(preferences().rundownMin(), true);
  assert.equal(document.getElementById("menu-rundown-min").getAttribute("aria-checked"), "true");
  assert.deepEqual(heard, [{ key: "splitpage-rundown-min", value: "1" }]);
  preferences().setRundownMin(false);
  assert.equal(isRundownMinimized(), false);
  assert.equal(heard.length, 2);
});

test("rundown follows cross-tab storage changes without writing or announcing them again", () => {
  heard.length = 0;
  localStorage.setItem("splitpage-rundown-min", "1");
  window.dispatchEvent(new window.StorageEvent("storage", { key: "splitpage-rundown-min", newValue: "1" }));
  assert.equal(isRundownMinimized(), true);
  localStorage.removeItem("splitpage-rundown-min");
  window.dispatchEvent(new window.StorageEvent("storage", { key: "splitpage-rundown-min", newValue: null }));
  assert.equal(isRundownMinimized(), false);
  assert.equal(localStorage.getItem("splitpage-rundown-min"), null);
  assert.deepEqual(heard, []);
});

test("immediate and animated zoom changes announce once, keep the clamp and remove the default", () => {
  heard.length = 0;
  setScriptScale(9, { now: true, quiet: true });
  finishFrames();
  assert.equal(scriptScale(), 2);
  assert.equal(preferences().scriptScale(), 2);
  assert.deepEqual(heard, [{ key: "splitpage-script-scale", value: "2" }]);
  setScriptScale(0.1, { quiet: true });
  finishFrames();
  assert.equal(scriptScale(), 0.7);
  assert.equal(preferences().scriptScale(), 0.7);
  setScriptScale(1, { now: true, quiet: true });
  finishFrames();
  assert.equal(localStorage.getItem("splitpage-script-scale"), null);
  assert.deepEqual(heard, [
    { key: "splitpage-script-scale", value: "2" },
    { key: "splitpage-script-scale", value: "0.7" },
    { key: "splitpage-script-scale", value: null }
  ]);
});

test("zoom follows owner announcements and cross-tab storage changes without announcing them again", () => {
  preferences().setScriptScale(1.25);
  finishFrames();
  assert.equal(scriptScale(), 1.25);
  heard.length = 0;
  localStorage.setItem("splitpage-script-scale", "1.5");
  window.dispatchEvent(new window.StorageEvent("storage", { key: "splitpage-script-scale", newValue: "1.5" }));
  finishFrames();
  assert.equal(scriptScale(), 1.5);
  assert.equal(document.getElementById("root").style.getPropertyValue("--script-scale"), "1.5");
  localStorage.removeItem("splitpage-script-scale");
  window.dispatchEvent(new window.StorageEvent("storage", { key: "splitpage-script-scale", newValue: null }));
  finishFrames();
  assert.equal(scriptScale(), 1);
  assert.equal(localStorage.getItem("splitpage-script-scale"), null);
  assert.deepEqual(heard, []);
});

test("desktop notice dismissal persists and announces through the owner, and reset offers it again", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Windows" } });
  let dispose;
  try {
    const bar = document.getElementById("desktop-app-bar");
    dispose = renderDesktopAppNotice();
    assert.equal(bar.hidden, false);
    heard.length = 0;
    dismissDesktopAppNotice();
    assert.equal(bar.hidden, true);
    assert.equal(preferences().desktopNoticeDismissed(), true);
    assert.deepEqual(heard, [{ key: "splitpage-desktop-notice-dismissed", value: "1" }]);
    dispose();
    dispose = renderDesktopAppNotice();
    assert.equal(bar.hidden, true);
    preferences().resetDesktopNotice();
    dispose();
    dispose = renderDesktopAppNotice();
    assert.equal(bar.hidden, false);
  } finally {
    if (dispose) dispose();
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});
