import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { browserPrintDialog } from "../../../src/adapters/print/browser-print.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const popup = new globalThis.EventTarget();
  const host = new globalThis.EventTarget();
  const fonts = deferred();
  const image = deferred();
  const timers = new Map();
  const intervals = new Map();
  let prints = 0;
  let alive = true;
  let blocked = false;
  let failPrint = false;
  Object.assign(popup, {
    document: dom.window.document, closed: false, opener: host,
    focus() {}, close() { popup.closed = true; },
    print() { if (failPrint) throw new Error("print failed"); prints++; }
  });
  Object.defineProperty(popup.document, "fonts", { value: { ready: fonts.promise } });
  dom.window.HTMLImageElement.prototype.decode = async function () {
    await image.promise;
    Object.defineProperty(this, "naturalWidth", { value: 10 });
  };
  Object.assign(host, {
    open: () => blocked ? null : popup,
    setInterval: (fn) => { intervals.set(1, fn); return 1; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { timers.set(2, fn); return 2; },
    clearTimeout: (id) => timers.delete(id)
  });
  const reserve = () => browserPrintDialog(host).reserve(() => alive);
  return { popup, host, fonts, image, timers, intervals, reserve, prints: () => prints,
    retire: () => { alive = false; }, block: () => { blocked = true; }, failPrint: () => { failPrint = true; } };
}

test("reserves synchronously, waits for fonts and images, and retains the window until afterprint", async () => {
  const h = harness();
  const job = h.reserve();
  assert.equal(h.popup.opener, null);
  const pending = job.print('<!doctype html><title>Captured title</title><img src="data:image/png;base64,eA==">');
  h.fonts.resolve();
  await Promise.resolve();
  assert.equal(h.prints(), 0);
  h.image.resolve();
  assert.equal(await pending, "opened");
  assert.equal(h.prints(), 1);
  assert.equal(h.popup.closed, false);
  assert.equal(h.timers.size, 0, "no preparation deadline can close an active dialog");
  h.popup.dispatchEvent(new globalThis.Event("afterprint"));
  assert.equal(h.popup.closed, true);
  assert.equal(h.intervals.size, 0);
  job.close();
});

test("a blocked popup gives actionable wording", () => {
  const h = harness();
  h.block();
  assert.throws(h.reserve, /Allow pop-ups for Splitpage/);
  assert.equal(h.timers.size + h.intervals.size, 0);
});

test("closing during preparation, retiring the mount, and leaving the page clean up without printing", async () => {
  for (const action of ["closed", "retired", "pagehide"]) {
    const h = harness();
    const job = h.reserve();
    const pending = job.print("<!doctype html><title>Held</title>");
    if (action === "closed") h.popup.closed = true;
    if (action === "retired") h.retire();
    if (action === "pagehide") h.host.dispatchEvent(new globalThis.Event("pagehide"));
    else h.intervals.get(1)();
    assert.equal(await pending, "closed");
    assert.equal(h.prints(), 0);
    assert.equal(h.popup.closed, true);
    assert.equal(h.timers.size + h.intervals.size, 0);
  }
});

test("a preparation timeout and print failure report failure and release resources", async () => {
  const h = harness();
  const job = h.reserve();
  const pending = job.print("<!doctype html><title>Held</title>");
  h.timers.get(2)();
  await assert.rejects(pending, /preparation ended/);
  assert.equal(h.popup.closed, true);
  assert.equal(h.timers.size + h.intervals.size, 0);
  const other = harness();
  other.failPrint();
  other.fonts.resolve();
  await assert.rejects(other.reserve().print("<!doctype html>"), /print failed/);
  assert.equal(other.popup.closed, true);
  assert.equal(other.timers.size + other.intervals.size, 0);
});
