import "./_dom.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const live = new Map();
const proto = window.EventTarget.prototype;
const realAdd = proto.addEventListener;
const realRemove = proto.removeEventListener;
const captureOf = (options) => (typeof options === "boolean" ? options : !!(options && options.capture));

proto.addEventListener = function (type, listener, options) {
  if (listener) {
    let entries = live.get(this);
    if (!entries) live.set(this, entries = []);
    const capture = captureOf(options);
    if (!entries.some((e) => e.type === type && e.capture === capture && e.listener === listener)) entries.push({ type, capture, listener });
  }
  return realAdd.call(this, type, listener, options);
};
proto.removeEventListener = function (type, listener, options) {
  const entries = live.get(this);
  if (entries) {
    const capture = captureOf(options);
    const at = entries.findIndex((e) => e.type === type && e.capture === capture && e.listener === listener);
    if (at >= 0) entries.splice(at, 1);
  }
  return realRemove.call(this, type, listener, options);
};

function labelOf(target) {
  if (target === window) return "window";
  if (target === document) return "document";
  if (target.id) return "#" + target.id;
  return target.tagName ? target.tagName.toLowerCase() : target.constructor.name;
}

function snapshot() {
  const counts = new Map();
  for (const [target, entries] of live) {
    for (const e of entries) {
      const key = `${labelOf(target)} ${e.type}/${e.capture ? "C" : "B"}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function minus(a, b) {
  const out = {};
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const d = (a.get(key) ?? 0) - (b.get(key) ?? 0);
    if (d) out[key] = d;
  }
  return out;
}

const { bootApp, closeApp, rewireApp } = await import("./_app-boot.mjs");
const { S } = await import("../js/_state.js");
await bootApp();
const app = await import("../bootstrap/app.ts");
const { rootRoutesTaken } = await import("../bootstrap/wiring/editor.ts");

async function restart() {
  app.startApp(await rewireApp());
  await settled();
}

function settled() {
  return S.initialStateReady;
}

after(() => {
  proto.addEventListener = realAdd;
  proto.removeEventListener = realRemove;
  app.stopApp();
  closeApp();
});

test("one throwing disposer does not stop the rest: every other mount is released, the app counts as stopped, and the failure is reported", async () => {
  app.stopApp();
  const stopped = snapshot();
  await restart();

  const rows = document.getElementById("rows");
  const failure = new Error("rows cleanup failed");
  rows.removeEventListener = function (type, listener, options) {
    if (type === "dragstart") throw failure;
    return proto.removeEventListener.call(this, type, listener, options);
  };
  let thrown = null;
  try {
    app.stopApp();
  } catch (error) {
    thrown = error;
  }
  delete rows.removeEventListener;

  assert.ok(thrown instanceof AggregateError, "stop reports the collected failures");
  assert.deepEqual(thrown.errors, [failure]);
  assert.deepEqual(rootRoutesTaken(), { click: [], mousedown: [] }, "features mounted before and after the failing one released their routes");
  assert.deepEqual(minus(snapshot(), stopped), {
    "#rows dragstart/B": 1,
    "#rows dragend/B": 1,
    "document mouseup/B": 1,
    "window dragover/B": 1
  }, "only the listeners of the disposer that threw survive");

  const wiring = await rewireApp();
  assert.doesNotThrow(() => app.startApp(wiring), "the app is not left marked as running");
  await settled();
});

test("two throwing disposers are both reported, each cuts only its own feature short, and the app can be started again", async () => {
  app.stopApp();
  const stopped = snapshot();
  await restart();

  const rows = document.getElementById("rows");
  const title = document.getElementById("doc-title");
  const rowsFailure = new Error("rows cleanup failed");
  const titleFailure = new Error("title cleanup failed");
  rows.removeEventListener = function (type, listener, options) {
    if (type === "dragstart") throw rowsFailure;
    return proto.removeEventListener.call(this, type, listener, options);
  };
  title.removeEventListener = function (type, listener, options) {
    if (type === "input") throw titleFailure;
    return proto.removeEventListener.call(this, type, listener, options);
  };
  let thrown = null;
  try {
    app.stopApp();
  } catch (error) {
    thrown = error;
  }
  delete rows.removeEventListener;
  delete title.removeEventListener;

  assert.ok(thrown instanceof AggregateError, "stop reports the collected failures");
  assert.equal(thrown.errors.length, 2, "both failures are reported");
  assert.ok(thrown.errors.includes(rowsFailure) && thrown.errors.includes(titleFailure), "each failure is the one its disposer threw");
  assert.deepEqual(rootRoutesTaken(), { click: [], mousedown: [] }, "the other features released their routes");
  assert.deepEqual(minus(snapshot(), stopped), {
    "#rows dragstart/B": 1,
    "#rows dragend/B": 1,
    "document mouseup/B": 1,
    "window dragover/B": 1,
    "#doc-title input/B": 1,
    "#writer-title input/B": 1
  }, "only the listeners of the two disposers that threw survive");

  const wiring = await rewireApp();
  assert.doesNotThrow(() => app.startApp(wiring), "the app is not left marked as running");
  await settled();
});
