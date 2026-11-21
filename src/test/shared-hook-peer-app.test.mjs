import { bootApp, closeApp } from "./_legacy-shared-app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(() => { closeApp(); });

const { adoptReplacement, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const hook = window.__legacySharedTest;

const ROWS = [{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "World", visualText: "" }];
const HELLO = ["h1", "h2", "h3", "h4", "h5"], WORLD = ["w1", "w2", "w3", "w4", "w5"];

function script(given = ROWS) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Peer", rows: given }));
  undoOwner().flush();
  writerControls().openWriter();
}

function appTypes(data) {
  const root = document.getElementById("writer-doc"), element = root.querySelector('.wr-beat[data-id="r1"]'), node = element.lastChild;
  root.focus();
  const range = document.createRange();
  range.setStart(node, node.data.length); range.collapse(true);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data });
  const target = range.cloneRange();
  Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
  assert.equal(element.dispatchEvent(before), true);
  node.data += data;
  return () => { element.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data })); };
}

const rows = doc => doc.rows.map(row => [row.id, row.audioText]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ORDERS = ["forward", "reverse", "duplicate"];

function nameAppTyping(p) {
  const app = hook.read().app.rows.find(row => row.id === "r1");
  if (!app) return;
  const units = p.identities("app").find(beat => beat.beat === "r1").units;
  p.nameIdentities("app", "r1", units.length - 1, ["a1"]);
}

for (const order of ORDERS) {
  test(`peer table: the peer formats a range, delivered ${order}: both copies and every late joiner agree, identities match, and the peer's undo reverses it everywhere`, async () => {
    script();
    assert.deepEqual(await hook.enter(), { ok: true });
    try {
      const p = hook.peer, counted = hook.counters();
      p.nameIdentities("app", "r1", 0, HELLO);
      p.nameIdentities("app", "r2", 0, WORLD);
      p.hold();
      assert.deepEqual(rows(p.lateJoiner("app")), rows(hook.read().app), "a joiner from the state before the action");
      assert.equal(p.format("r1", 0, 5, "b"), "applied");
      assert.deepEqual(rows(hook.read().peer), [["r1", "<strong>Hello</strong>"], ["r2", "World"]]);
      appTypes("!")();
      assert.deepEqual(rows(hook.read().app), [["r1", "Hello!"], ["r2", "World"]], "the app committed its own typing before delivery");
      nameAppTyping(p);
      assert.equal(p.release(order), 2);
      const app = hook.read().app;
      assert.deepEqual(rows(app), [["r1", "<strong>Hello</strong>!"], ["r2", "World"]]);
      assert.ok(same(app, hook.read().peer), "app and peer agree");
      assert.ok(same(p.catchUp(), app), "the joiner from before the action catches up to the same script");
      const units = p.identities("joiner");
      assert.ok(same(p.lateJoiner("app"), app), "a late joiner from the app's state agrees");
      assert.ok(same(p.lateJoiner("peer"), app), "a late joiner from the peer's state agrees");
      assert.deepEqual(units.map(beat => [beat.beat, beat.units]), [["r1", [...HELLO, "a1"]], ["r2", WORLD]]);
      assert.deepEqual([p.identities("app"), p.identities("peer"), p.identities("joiner")], [units, units, units], "every replica names the same characters");
      const recovery = p.recoveryEntries("app");
      assert.deepEqual(recovery, []);
      assert.deepEqual([p.recoveryEntries("peer"), p.recoveryEntries("joiner")], [recovery, recovery], "every replica reads the same recovery entries");
      const undone = p.undo();
      assert.deepEqual([undone.ok, undone.effective, undone.label], [true, true, "format"]);
      assert.equal(p.deliver(), 1);
      assert.deepEqual(rows(hook.read().app), [["r1", "Hello!"], ["r2", "World"]], "the peer's undo reverses only the peer's step");
      assert.ok(same(hook.read().app, hook.read().peer) && same(p.catchUp(), hook.read().app), "after the undo every copy agrees");
      assert.deepEqual([p.recoveryEntries("app"), p.recoveryEntries("peer"), p.recoveryEntries("joiner")], [[], [], []]);
      assert.deepEqual([hook.counters().recovered - counted.recovered, hook.counters().missingBase - counted.missingBase], [0, 0]);
    } finally { if (sharedSession()) hook.leave(); }
  });
}

test("legacy peer identity probe enumerates both UTF-16 units of an astral character", async () => {
  script();
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const p = hook.peer;
    p.nameIdentities("app", "r1", 0, HELLO);
    p.hold();
    assert.equal(p.type("r1", 0, "\u{1F600}").kind, "applied");
    p.nameIdentities("peer", "r1", 0, ["p1", "p2"]);
    assert.deepEqual(p.identities("peer").find(beat => beat.beat === "r1").units, ["p1", "p2", ...HELLO]);
  } finally { if (sharedSession()) hook.leave(); }
});
