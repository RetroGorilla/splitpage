import "./_dom.mjs";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { startupReady } from "../legacy/startup-bridge.ts";

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
  if (target.tagName) {
    const classes = typeof target.className === "string" ? target.className.trim().split(/\s+/).filter(Boolean) : [];
    return target.tagName.toLowerCase() + classes.map((c) => "." + c).join("");
  }
  return target.constructor.name;
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

const LEDGER = readFileSync(new URL("../../docs/architecture/milestone-6.md", import.meta.url), "utf8");
const CLASS_TARGETS = { ".add-row-bar": "div.add-row-bar", ".toolbar": "div.toolbar", ".writer-bar": "div.writer-bar" };
const REGISTRATION = /(?:((?:`[^`]+`(?:, `[^`]+`)*|document|window|D|Each `[^`]+`)(?:, if present)?(?:, only while loading)?): )?([a-zA-Z]+)\/([BC])(?:, passive)? `21-events\.js:(\d+)`/g;

function ledgerRows() {
  const table = LEDGER.slice(LEDGER.indexOf("| Owning step | Rows | Target"), LEDGER.indexOf("**Row counts.**"));
  const rows = [];
  for (const line of table.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| Owning") || line.startsWith("| ---")) continue;
    const [step, count, refs] = line.slice(1).split("|").map((c) => c.trim());
    const registrations = [];
    let target = null;
    for (const m of refs.matchAll(REGISTRATION)) {
      if (m[1]) target = m[1];
      registrations.push({ target, type: m[2], phase: m[3], line: Number(m[4]) });
    }
    rows.push({ step, count: Number(count), registrations });
  }
  return rows;
}

function labelsFor(target) {
  if (target === "D") return ["#comment-modal", "#comments-panel"];
  if (target.startsWith("Each ")) return ["input", "input", "input", "input"];
  const named = [...target.matchAll(/`([^`]+)`/g)].map((m) => CLASS_TARGETS[m[1]] ?? m[1]);
  return named.length ? named : [target.replace(/, only while loading$/, "")];
}

const CONDITIONAL = {
  "document DOMContentLoaded/B": "only while the page is loading; the test boots a loaded page, and tests/bootstrap/startup.test.ts covers the deferred dispatch",
  "window load/B": "only where service workers are supported and the page is not a file; jsdom has none, and tests/bootstrap/startup.test.ts covers the registration"
};

const RESOURCE_ROWS = {
  appearance: ["window storage/B"],
  shortcuts: ["window keydown/B"],
  topbar: [
    "#btn-production pointerenter/B", "#btn-production focus/B", "#btn-production pointerleave/B",
    "#btn-gear pointerenter/B", "#btn-gear focus/B", "#btn-gear pointerleave/B",
    "#btn-broll pointerenter/B", "#btn-broll focus/B", "#btn-broll pointerleave/B",
    "#btn-comments pointerenter/B", "#btn-comments focus/B", "#btn-comments pointerleave/B",
    "#btn-collab pointerenter/B", "#btn-collab focus/B", "#btn-collab pointerleave/B",
    "#doc-title mouseenter/B", "window resize/B", "window scroll/B"
  ],
  cellReach: ["#rows mousedown/B"],
  phoneBar: ["#phone-bar click/B"],
  S13: ["#production-list click/C", "#production-list contextmenu/B", "#production-list pointercancel/B", "#production-list pointerdown/B", "#production-list pointermove/B", "#production-list pointerup/B"],
  S26: ["#production-panel change/B", "#production-panel click/B", "#production-panel focusout/B", "#production-panel input/B", "#production-panel keydown/B"],
  S27: ["#gear-panel change/B", "#gear-panel click/B", "#gear-panel focusout/B", "#gear-panel input/B", "#gear-panel keydown/B"],
  S28: [
    "#btn-broll click/B", "#broll-close click/B", "#broll-add-save click/B",
    "#broll-panel click/B", "#broll-panel change/B", "#broll-panel focusout/B", "#broll-panel keydown/B", "#broll-panel input/B",
    "#broll-page click/B", "#broll-page change/B", "#broll-page change/B", "#broll-page focusout/B", "#broll-page keydown/B", "#broll-page keydown/B", "#broll-page input/B",
    "window keydown/B", "window keydown/B", "document focusin/B", "document mousedown/B"
  ],
  S29: ["production", "gear", "broll", "comments", "history"].flatMap((panel) =>
    ["dblclick/B", "mousedown/B", "touchstart/B"].map((ev) => `#${panel}-panel-resize-handle ${ev}`))
};

const { bootApp, closeApp, rewireApp } = await import("./_app-boot.mjs");
await bootApp();
const app = await import("../bootstrap/app.ts");
const { rootRoutesTaken } = await import("../bootstrap/wiring/editor.ts");
const { ROOT_CLICK_ORDER, ROOT_MOUSEDOWN_ORDER } = await import("../features/routing/root-router.ts");

after(() => {
  proto.addEventListener = realAdd;
  proto.removeEventListener = realRemove;
  closeApp();
});

app.stopApp();
const stopped = snapshot();
const stoppedRoutes = rootRoutesTaken();
app.startApp(await rewireApp());
await startupReady();
const first = minus(snapshot(), stopped);
const firstRoutes = rootRoutesTaken();
app.stopApp();
const afterStop = minus(snapshot(), stopped);
app.startApp(await rewireApp());
await startupReady();
const second = minus(snapshot(), stopped);

test("the ledger has 294 rows: 204 registrations, and 90 delegated branches and startup or resource rows", () => {
  const rows = ledgerRows();
  assert.equal(rows.reduce((n, r) => n + r.count, 0), 294);
  const registrations = rows.reduce((n, r) => n + r.registrations.length, 0);
  assert.equal(registrations, 204);
  for (const row of rows) {
    if (row.registrations.length) assert.equal(row.registrations.length, row.count, `${row.step}: every row of a registration line is a registration`);
  }
});

test("stopping the app removes every listener it registered, and its root routes", () => {
  assert.deepEqual(afterStop, {});
  assert.deepEqual(stoppedRoutes, { click: [], mousedown: [] });
});

test("after a remount every registration has exactly one handler: each ledger registration once, plus the named resource rows", () => {
  const expected = new Map();
  const bump = (key) => expected.set(key, (expected.get(key) ?? 0) + 1);
  for (const row of ledgerRows()) {
    for (const r of row.registrations) {
      for (const label of labelsFor(r.target)) {
        const key = `${label} ${r.type}/${r.phase}`;
        if (!CONDITIONAL[key]) bump(key);
      }
    }
  }
  for (const keys of Object.values(RESOURCE_ROWS)) keys.forEach(bump);
  const want = Object.fromEntries([...expected].sort());
  const got = Object.fromEntries(Object.entries(second).sort());
  assert.deepEqual(got, want);
  assert.deepEqual(second, first, "the second mount registers exactly what the first did");
});

test("every delegated click route and the tag anchor route are taken once, in the ledger's order", () => {
  assert.equal(firstRoutes.click.length, 13);
  assert.equal(firstRoutes.mousedown.length, 1);
  assert.deepEqual(firstRoutes, { click: [...ROOT_CLICK_ORDER], mousedown: [...ROOT_MOUSEDOWN_ORDER] });
  assert.deepEqual(rootRoutesTaken(), firstRoutes);
});
