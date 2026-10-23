import { bootApp, clearTimers, closeApp, rewireRunningApp } from "./_app-boot.mjs";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { S } from "../js/_state.js";
import { mockClock } from "./_m4-matrix.mjs";

const live = [];
const observers = new Set();
const subscribers = [];

const proto = window.EventTarget.prototype;
const realAdd = proto.addEventListener;
const realRemove = proto.removeEventListener;
proto.addEventListener = function (type, listener, options) {
  if (listener) live.push({ target: this, type: type, listener: listener, capture: options === true || !!(options && options.capture) });
  return realAdd.call(this, type, listener, options);
};
proto.removeEventListener = function (type, listener, options) {
  const capture = options === true || !!(options && options.capture);
  const at = live.findIndex((e) => e.target === this && e.type === type && e.listener === listener && e.capture === capture);
  if (at !== -1) live.splice(at, 1);
  return realRemove.call(this, type, listener, options);
};

for (const name of ["MutationObserver", "ResizeObserver"]) {
  const Real = window[name];
  if (typeof Real !== "function") continue;
  const Tracked = class extends Real {
    constructor(...args) {
      super(...args);
      observers.add({ kind: name, observer: this, target: null });
    }
    observe(target, ...rest) {
      for (const entry of observers) if (entry.observer === this) entry.target = target;
      return super.observe(target, ...rest);
    }
    disconnect() {
      for (const entry of observers) if (entry.observer === this) observers.delete(entry);
      return super.disconnect();
    }
  };
  window[name] = Tracked;
  globalThis[name] = Tracked;
}

const { currentDocument, liveSession } = await import("../legacy/session-bridge.ts");
const session = liveSession();
const realSubscribe = session.subscribe;
session.subscribe = function (listener) {
  subscribers.push(/\/src\/([\w./-]+\.(?:js|ts)):\d+:\d+/.exec(new Error().stack.split("\n").slice(2).join("\n"))?.[1] ?? "(unknown)");
  return realSubscribe.call(session, listener);
};

await bootApp();

after(closeApp);

const { runIdleRefresh } = await import("../js/07-production-tags.js");
const refreshed = { into: null };
await rewireRunningApp({ refresh: (due) => (refreshed.into ? refreshed.into.push(...due) : runIdleRefresh(due)) });

const { migrateRows } = await import("../js/02-state.js");
const { noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { confirmSavedNow } = await import("../legacy/save-bridge.ts");
const { flushEdits } = await import("../js/12a-undo.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { startNewScript } = await import("../js/18b-file-menu.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { grantVideoFile, hasSessionVideo, sessionVideoUrl } = await import("../js/06-rows.js");
const { normalizeVideoLink } = await import("../core/document/gallery.ts");
const { requestRefresh } = await import("../legacy/session-bridge.ts");
const { loadTestDocument } = await import("./_document.mjs");

function script(title) {
  return migrateRows({
    schema: 5, title: title, docId: "d" + "7".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  });
}

function useDocument(doc) {
  loadTestDocument(doc);
  flushEdits();
  confirmSavedNow();
  return doc;
}

async function settle(clock) {
  clock.tick(40000);
  for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve));
}

async function finish(clock) {
  clock.reset();
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
  clearTimers();
}

function targetName(target) {
  if (target === window) return "window";
  if (target === document) return "document";
  if (target === document.body) return "body";
  if (target && target.nodeType === 1) return "element#" + (target.id || target.tagName.toLowerCase());
  return "other";
}

function connected(target) {
  return target === window || target === document || (target && target.nodeType === 1 && target.isConnected);
}

function ledger() {
  const listeners = {};
  for (const e of live) {
    if (!connected(e.target)) continue;
    const key = targetName(e.target) + ":" + e.type;
    listeners[key] = (listeners[key] || 0) + 1;
  }
  const watching = {};
  for (const e of observers) {
    if (e.target && !connected(e.target)) continue;
    const key = e.kind + ":" + (e.target ? targetName(e.target) : "unbound");
    watching[key] = (watching[key] || 0) + 1;
  }
  return { listeners: listeners, observers: watching };
}

const APP_LIFETIME_SUBSCRIPTIONS_TO_THE_SESSION = [];
const APP_LIFETIME_LISTENERS = [
  "document:beforecopy",
  "document:beforecut",
  "document:click",
  "document:compositionend",
  "document:contextmenu",
  "document:copy",
  "document:cut",
  "document:dragend",
  "document:dragover",
  "document:dragstart",
  "document:drop",
  "document:focusin",
  "document:input",
  "document:keydown",
  "document:mousedown",
  "document:mousemove",
  "document:mouseup",
  "document:paste",
  "document:securitypolicyviolation",
  "document:selectionchange",
  "document:splitpage:pref",
  "document:undo-owner-cleared",
  "document:visibilitychange",
  "window:beforeinput",
  "window:beforeunload",
  "window:blur",
  "window:click",
  "window:compositionstart",
  "window:cut",
  "window:dragover",
  "window:dragstart",
  "window:drop",
  "window:focus",
  "window:focusin",
  "window:hashchange",
  "window:input",
  "window:keydown",
  "window:keyup",
  "window:mousedown",
  "window:mouseout",
  "window:mouseover",
  "window:mouseup",
  "window:pagehide",
  "window:pageshow",
  "window:paste",
  "window:pointerdown",
  "window:pointerup",
  "window:resize",
  "window:scroll",
  "window:storage",
  "window:touchmove",
  "window:wheel"
];
const APP_LIFETIME_UNNAMED_ELEMENT_LISTENERS = [
  "element#a:click",
  "element#button:click",
  "element#div:click",
  "element#div:mousedown",
  "element#div:pointerleave",
  "element#div:pointermove",
  "element#input:change"
];
const APP_LIFETIME_OBSERVERS = ["MutationObserver:element#comments-badge", "MutationObserver:element#div", "MutationObserver:element#html"];

test("E9: no app module subscribes to the document session, so none outlives a replacement", () => {
  assert.deepEqual(subscribers, APP_LIFETIME_SUBSCRIPTIONS_TO_THE_SESSION, "the sites that subscribed to the live session during boot");
});

test("E9: a replaced document leaves no listener, observer, timer, refresh or object URL of its own behind", async (t) => {
  const clock = mockClock(t);
  const created = [];
  const revoked = [];
  const make = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => { const url = "blob:m4-lifecycle/" + created.length; created.push(url); return url; };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  t.after(() => { URL.createObjectURL = make; URL.revokeObjectURL = revoke; });

  useDocument(script("First"));
  await settle(clock);
  const before = ledger();
  assert.ok(Object.keys(before.listeners).length > 0, "setup: the app registered its listeners at boot");

  const jobs = [];
  refreshed.into = jobs;
  t.after(() => { refreshed.into = null; });
  const link = normalizeVideoLink({ name: "clip.mp4", size: 5 });

  for (let round = 0; round < 3; round++) {
    useDocument(script("Round " + round));
    grantVideoFile(new File(["12345"], "clip.mp4"), link);
    assert.ok(sessionVideoUrl(link), "the session video has an object URL while its document is open");
    requestRefresh("m4-lifecycle-" + round);
    S.state.rows[0].audioText = "Typed in round " + round + ".";
    noteSessionEdit();
    startNewScript();
    assert.equal(S.state.title, "Untitled Script", "the replacement happened");
    assert.ok(hasSessionVideo(link), "the file grant survives the replacement");
  }
  jobs.length = 0;
  await openProjectFile(new File([buildSplitpageFile(exportDocumentOf(script("Opened")))], "a.splitpage", { lastModified: 1 }), null, { skipSnapshot: true, silent: true });
  await openProjectFile(new File([buildSplitpageFile(exportDocumentOf(script("Opened again")))], "b.splitpage", { lastModified: 1 }), null, { skipSnapshot: true, silent: true });
  clock.tick(60 * 60 * 1000);
  await settle(clock);

  assert.deepEqual(jobs.filter((job) => job.startsWith("m4-lifecycle")), [], "no refresh an old document asked for ran after the replacements");
  assert.deepEqual(created.filter((url) => !revoked.includes(url)), [], "every object URL made for a replaced document is revoked");
  assert.deepEqual(ledger(), before, "the listeners and observers after five replacements are exactly those after boot");
  await finish(clock);
});

test("E9: the listeners and observers that live as long as the app are these", () => {
  const { listeners, observers: watching } = ledger();
  const global = Object.keys(listeners).filter((key) => /^(window|document|body):/.test(key)).sort();
  assert.deepEqual(global, APP_LIFETIME_LISTENERS, "the listeners on the window, the document and the body, by event");
  const unnamedElements = Object.keys(listeners).filter((key) => /^element#(a|button|div|input):/.test(key)).sort();
  assert.deepEqual(unnamedElements, APP_LIFETIME_UNNAMED_ELEMENT_LISTENERS, "the listeners on page elements that have no id");
  assert.deepEqual(Object.keys(watching).sort(), APP_LIFETIME_OBSERVERS, "the observers, by kind and target");
});

test("E9: the session's own dispose stops its timers and drops its listeners", async (t) => {
  const clock = mockClock(t);
  useDocument(script("Disposed"));
  const heard = [];
  const jobs = [];
  refreshed.into = jobs;
  t.after(() => { refreshed.into = null; });
  session.subscribe((change) => heard.push(change.kind));
  S.state.rows[0].audioText = "Before dispose.";
  noteSessionEdit();
  assert.deepEqual(heard, ["edit"], "setup: the subscription hears an edit");
  requestRefresh("m4-lifecycle-disposed");
  const doc = currentDocument();
  session.dispose();
  assert.equal(currentDocument(), null, "a disposed session holds no document");
  doc.rows[0].audioText = "After dispose.";
  noteSessionEdit();
  clock.tick(60 * 60 * 1000);
  await settle(clock);
  assert.deepEqual(heard, ["edit"], "nothing is heard after dispose");
  assert.deepEqual(jobs, [], "no refresh runs after dispose");
  await finish(clock);
});
