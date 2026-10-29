import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createRestoreNotice } = require(path.join(here, "..", "restore-notice.js"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function harness() {
  const tabs = new Map();
  const windows = [];
  const sent = [];
  const notice = createRestoreNotice({
    tabs,
    liveWindows: () => windows,
    send: (wc, payload) => {
      if (wc.throws) throw new Error("gone");
      sent.push({ to: wc.tabId, payload });
    }
  });
  function tab(id, opts) {
    const o = opts || {};
    const t = {
      id,
      ready: !!o.ready,
      view: { webContents: { tabId: id, throws: !!o.throws, isDestroyed: () => !!o.destroyed } }
    };
    tabs.set(id, t);
    return t;
  }
  return { notice, tabs, windows, sent, tab };
}

test("a notice is held for one tab and delivered to it once", () => {
  const h = harness();
  const a = h.tab("a", { ready: true });
  h.notice.set("a", ["x.splitpage"]);
  assert.equal(h.notice.isFor("a"), true);
  assert.equal(h.notice.isFor("b"), false);
  h.notice.deliver(a);
  assert.deepEqual(h.sent, [{ to: "a", payload: { skipped: ["x.splitpage"] } }]);
  assert.equal(h.notice.isFor("a"), false);
  h.notice.deliver(a);
  assert.equal(h.sent.length, 1);
});

test("nothing is sent with no notice, no tab or a destroyed tab", () => {
  const h = harness();
  h.notice.deliver(h.tab("a"));
  h.notice.set("b", ["y"]);
  h.notice.deliver(null);
  h.notice.deliver(h.tab("b", { destroyed: true }));
  assert.deepEqual(h.sent, []);
  assert.equal(h.notice.isFor("b"), true);
});

test("a failed send drops the notice", () => {
  const h = harness();
  h.notice.set("a", ["x"]);
  h.notice.deliver(h.tab("a", { throws: true }));
  assert.deepEqual(h.sent, []);
  assert.equal(h.notice.isFor("a"), false);
});

test("when its tab goes, the notice moves to that window's active tab, waiting until it is ready", () => {
  const h = harness();
  h.tab("b");
  h.notice.set("a", ["x"]);
  h.notice.retarget("a", { activeTabId: "b" });
  assert.deepEqual(h.sent, []);
  assert.equal(h.notice.isFor("b"), true);
});

test("a ready replacement tab gets the notice straight away", () => {
  const h = harness();
  h.tab("b", { ready: true });
  h.notice.set("a", ["x"]);
  h.notice.retarget("a", { activeTabId: "b" });
  assert.deepEqual(h.sent, [{ to: "b", payload: { skipped: ["x"] } }]);
});

test("with no active tab in the dead window, the first live window's active tab takes it", () => {
  const h = harness();
  h.tab("c");
  h.windows.push({ activeTabId: null }, { activeTabId: "missing" }, { activeTabId: "c" });
  h.notice.set("a", ["x"]);
  h.notice.retarget("a", null);
  assert.equal(h.notice.isFor("c"), true);
});

test("with nowhere to go the notice is dropped, and another tab closing leaves it alone", () => {
  const h = harness();
  h.notice.set("a", ["x"]);
  h.notice.retarget("other", null);
  assert.equal(h.notice.isFor("a"), true);
  h.notice.retarget("a", { activeTabId: null });
  assert.equal(h.notice.isFor("a"), false);
  assert.deepEqual(h.sent, []);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
