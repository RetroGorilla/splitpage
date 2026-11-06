import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const script = readFileSync(new URL("../tabstrip/tabstrip.js", import.meta.url), "utf8");
const state = {
  windowId: "window-a", activeTabId: "a".repeat(32),
  tabs: [
    { tabId: "a".repeat(32), title: "<First>", dirty: true, crashed: false, fullPathForTooltip: null },
    { tabId: "b".repeat(32), title: "Second", dirty: false, crashed: true, fullPathForTooltip: "C:/second.splitpage" }
  ]
};

async function page({ bridge = true, overlay = null } = {}) {
  const dom = new JSDOM('<!doctype html><div id="tabstrip"></div>', { runScripts: "outside-only" });
  const calls = [];
  let changed;
  if (bridge) {
    dom.window.splitpageTabStrip = {
      windowId: state.windowId, platform: "win32",
      getShellState: () => Promise.resolve(state),
      onShellStateChanged: callback => { changed = callback; }
    };
    for (const name of ["newTab", "activateTab", "closeTab", "reorderTab", "moveTabHere", "tearOffToNewWindow"]) {
      dom.window.splitpageTabStrip[name] = (...args) => { calls.push([name, ...args]); };
    }
  }
  if (overlay) Object.defineProperty(dom.window.navigator, "windowControlsOverlay", { value: overlay(dom.window) });
  dom.window.eval(script);
  await new Promise(resolve => setImmediate(resolve));
  return { dom, calls, change: next => changed(next) };
}

function drag(window, target, type, data, fields = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: data });
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
}

{
  const { dom } = await page({ bridge: false });
  try { assert.equal(dom.window.document.querySelector("#tabstrip").children.length, 0); }
  finally { dom.window.close(); }
}

{
  const { dom, calls, change } = await page();
  try {
    const document = dom.window.document;
    const tabs = document.querySelectorAll(".tab");
    assert.equal(tabs.length, 2);
    assert.equal(tabs[0].querySelector(".tab__title").textContent, "<First>");
    assert.equal(tabs[0].getAttribute("aria-selected"), "true");
    assert.ok(tabs[0].querySelector(".tab__dot"));
    assert.ok(tabs[1].querySelector(".tab__broken"));
    assert.match(tabs[1].title, /^C:\/second\.splitpage/);
    document.querySelector(".tabstrip__new").click();
    tabs[0].click();
    tabs[0].querySelector(".tab__close").click();
    tabs[1].dispatchEvent(new dom.window.MouseEvent("auxclick", { button: 1 }));
    assert.deepEqual(calls, [["newTab"], ["activateTab", state.tabs[0].tabId], ["closeTab", state.tabs[0].tabId], ["closeTab", state.tabs[1].tabId]]);
    assert.equal(document.documentElement.style.getPropertyValue("--titlebar-inset"), "150px");
    change(null);
    assert.equal(document.querySelectorAll(".tab").length, 0);
  } finally { dom.window.close(); }
}

{
  const { dom, calls } = await page();
  try {
    const target = dom.window.document.querySelector(".tabstrip__tabs");
    const drop = payload => drag(dom.window, target, "drop", { getData: () => payload }, { clientX: 0 });
    drop(JSON.stringify({ tabId: state.tabs[0].tabId, sourceWindowId: state.windowId }));
    drop(JSON.stringify({ tabId: state.tabs[1].tabId, sourceWindowId: "window-b" }));
    drop(JSON.stringify({ tabId: 42, sourceWindowId: state.windowId }));
    drop(JSON.stringify({ tabId: { unexpected: true }, sourceWindowId: "window-b" }));
    for (const value of ["null", "42", "[]", "not JSON", '{"tabId":0}']) drop(value);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      ["reorderTab", state.tabs[0].tabId, 2], ["moveTabHere", state.tabs[1].tabId, 2]
    ]);
    const data = { effectAllowed: null, setData: (type, value) => { data.type = type; data.value = value; }, dropEffect: "none" };
    const tab = dom.window.document.querySelector(".tab");
    drag(dom.window, tab, "dragstart", data);
    assert.equal(data.effectAllowed, "move");
    assert.equal(data.type, "application/x-splitpage-tab");
    assert.deepEqual(JSON.parse(data.value), { tabId: state.tabs[0].tabId, sourceWindowId: state.windowId });
    drag(dom.window, tab, "dragend", data, { clientX: -1, clientY: 0, screenX: 30, screenY: 40 });
    assert.deepEqual(calls.at(-1), ["tearOffToNewWindow", state.tabs[0].tabId, 30, 40]);
  } finally { dom.window.close(); }
}

{
  let overlay;
  const { dom } = await page({ overlay: window => {
    overlay = new window.EventTarget();
    overlay.getTitlebarAreaRect = () => new window.DOMRect(0, 0, 800, 30);
    return overlay;
  } });
  try {
    assert.equal(dom.window.document.documentElement.style.getPropertyValue("--titlebar-inset"), "224px");
    Object.defineProperty(dom.window, "innerWidth", { value: 1200 });
    overlay.dispatchEvent(new dom.window.Event("geometrychange"));
    assert.equal(dom.window.document.documentElement.style.getPropertyValue("--titlebar-inset"), "400px");
  } finally { dom.window.close(); }
}

console.log("ALL PASS (tab strip rendering, controls, drop forwarding, tear-off and titlebar geometry)");
