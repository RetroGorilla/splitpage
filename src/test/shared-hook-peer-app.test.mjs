import { bootApp, closeApp } from "./_app-boot.mjs";
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
const hook = window.__sharedTest;

const ROWS = [{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "World", visualText: "" }];
const HELLO = ["h1", "h2", "h3", "h4", "h5"], WORLD = ["w1", "w2", "w3", "w4", "w5"];

function script() {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Peer", rows: ROWS }));
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

const PEER_ACTIONS = [
  { name: "the peer types", run: p => p.type("r1", 0, "Y").kind, typed: ["p1"], before: [["r1", "YHello"], ["r2", "World"]],
    after: [["r1", "YHello!"], ["r2", "World"]], units: [["r1", ["p1", ...HELLO, "a1"]], ["r2", WORLD]], undoLabel: "typing" },
  { name: "the peer deletes inside a beat", run: p => p.erase("r1", 1, 3), before: [["r1", "Hlo"], ["r2", "World"]],
    after: [["r1", "Hlo!"], ["r2", "World"]], units: [["r1", ["h1", "h4", "h5", "a1"]], ["r2", WORLD]], undoLabel: "typing" },
  { name: "the peer formats a range", run: p => p.format("r1", 0, 5, "b"), before: [["r1", "<strong>Hello</strong>"], ["r2", "World"]],
    after: [["r1", "<strong>Hello</strong>!"], ["r2", "World"]], units: [["r1", [...HELLO, "a1"]], ["r2", WORLD]], undoLabel: "format" },
  { name: "the peer deletes a range across beats", run: p => p.deleteRange("r1", 3, "r2", 2), before: [["r1", "Hel"], ["r2", "rld"]],
    after: [["r1", "Hel!"], ["r2", "rld"]], units: [["r1", ["h1", "h2", "h3", "a1"]], ["r2", ["w3", "w4", "w5"]]], undoLabel: "delete-selection" },
  { name: "the peer removes the beat the app is typing in", run: p => p.remove("r1"), before: [["r2", "World"]],
    after: [["r2", "World"]], units: [["r2", WORLD]], undoLabel: "delete-scene", removed: ["r1", "Hello!"] },
  { name: "the peer removes the other beat", run: p => p.remove("r2"), before: [["r1", "Hello"]],
    after: [["r1", "Hello!"]], units: [["r1", [...HELLO, "a1"]]], undoLabel: "delete-scene", removed: ["r2", "World"] }
];

const ORDERS = ["forward", "reverse", "duplicate", "D3"];

function nameTyped(p, action) {
  if (!action.typed) return;
  p.nameIdentities("peer", "r1", 0, action.typed);
}

function nameAppTyping(p) {
  const app = hook.read().app.rows.find(row => row.id === "r1");
  if (!app) return;
  const units = p.identities("app").find(beat => beat.beat === "r1").units;
  p.nameIdentities("app", "r1", units.length - 1, ["a1"]);
}

for (const action of PEER_ACTIONS) for (const order of ORDERS) {
  test(`peer table: ${action.name}, delivered ${order === "D3" ? "D3 (the peer's change arrives while the app's typing is still buffered, without a composition)" : order}: both copies and every late joiner agree, identities match, and the peer's undo reverses it everywhere`, async () => {
    script();
    assert.deepEqual(await hook.enter(), { ok: true });
    try {
      const p = hook.peer;
      p.nameIdentities("app", "r1", 0, HELLO);
      p.nameIdentities("app", "r2", 0, WORLD);
      p.hold();
      assert.deepEqual(rows(p.lateJoiner("app")), rows(hook.read().app), "a joiner from the state before the action");
      assert.equal(action.run(p), "applied");
      nameTyped(p, action);
      assert.deepEqual(rows(hook.read().peer), action.before);
      const commit = appTypes("!");
      if (order === "D3") {
        assert.equal(p.deliver("forward", "app"), 1);
        assert.deepEqual(rows(hook.read().app), [["r1", "Hello"], ["r2", "World"]], "the open buffer holds the peer's change back, and the typing is still only in the buffer");
        commit();
        assert.deepEqual(rows(hook.read().app), action.after, "the commit releases the held change together with the typing");
        assert.equal(p.release(), 1);
      } else {
        commit();
        assert.deepEqual(rows(hook.read().app), [["r1", "Hello!"], ["r2", "World"]], "the app committed its own typing before delivery");
        nameAppTyping(p);
        assert.equal(p.release(order), 2);
      }
      if (order === "D3") nameAppTyping(p);
      const app = hook.read().app;
      assert.deepEqual(rows(app), action.after);
      assert.ok(same(app, hook.read().peer), "app and peer agree");
      assert.ok(same(p.catchUp(), app), "the joiner from before the action catches up to the same script");
      const units = p.identities("joiner");
      assert.ok(same(p.lateJoiner("app"), app), "a late joiner from the app's state agrees");
      assert.ok(same(p.lateJoiner("peer"), app), "a late joiner from the peer's state agrees");
      assert.deepEqual(units.map(beat => [beat.beat, beat.units]), action.units);
      assert.deepEqual([p.identities("app"), p.identities("peer"), p.identities("joiner")], [units, units, units], "every replica names the same characters");
      const recovery = p.recoveryEntries("app");
      assert.deepEqual(recovery.map(entry => entry.kind === "removed-beat" ? [entry.kind, entry.row.id, entry.row.audioText] : [entry.kind]),
        action.removed ? [["removed-beat", ...action.removed]] : []);
      assert.deepEqual([p.recoveryEntries("peer"), p.recoveryEntries("joiner")], [recovery, recovery], "every replica reads the same recovery entries");
      const undone = p.undo();
      assert.deepEqual([undone.ok, undone.effective, undone.label], [true, true, action.undoLabel]);
      assert.equal(p.deliver(), 1);
      assert.deepEqual(rows(hook.read().app), [["r1", "Hello!"], ["r2", "World"]], "the peer's undo reverses only the peer's step");
      assert.ok(same(hook.read().app, hook.read().peer) && same(p.catchUp(), hook.read().app), "after the undo every copy agrees");
      assert.deepEqual([p.recoveryEntries("app"), p.recoveryEntries("peer"), p.recoveryEntries("joiner")], [[], [], []]);
      assert.deepEqual([hook.counters().recovered, hook.counters().missingBase], [0, 0]);
    } finally { if (sharedSession()) hook.leave(); }
  });
}

test("the peer's undo and redo walk its own history through the shared undo, and an empty history refuses without changing anything", async () => {
  script();
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const p = hook.peer, start = hook.read().app;
    const empty = p.undo();
    assert.equal(empty.ok === false || empty.effective === false, true);
    assert.ok(same(hook.read().peer, start));
    assert.equal(p.type("r1", 5, "?").kind, "applied");
    assert.equal(p.format("r2", 0, 5, "i"), "applied");
    p.deliver();
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello?"], ["r2", "<em>World</em>"]]);
    assert.equal(p.undo().label, "format"); p.deliver();
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello?"], ["r2", "World"]]);
    assert.equal(p.undo().label, "typing"); p.deliver();
    assert.ok(same(rows(hook.read().app), rows(start)));
    assert.equal(p.redo().label, "typing"); p.redo(); p.deliver();
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello?"], ["r2", "<em>World</em>"]]);
    assert.ok(same(hook.read().app, hook.read().peer));
  } finally { if (sharedSession()) hook.leave(); }
});

test("a joiner built at a chosen moment holds that moment until it catches up, and leaving the session disposes it", async () => {
  script();
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const p = hook.peer;
    assert.equal(p.type("r2", 5, "!").kind, "applied"); p.deliver();
    assert.deepEqual(rows(p.lateJoiner("peer")), [["r1", "Hello"], ["r2", "World!"]]);
    p.remove("r1"); p.deliver();
    assert.deepEqual(rows(p.joined()), [["r1", "Hello"], ["r2", "World!"]], "the joiner still holds the moment it joined");
    assert.deepEqual(p.recoveryEntries("joiner"), []);
    assert.deepEqual(rows(p.catchUp()), [["r2", "World!"]]);
    assert.deepEqual(p.recoveryEntries("joiner").map(entry => entry.kind), ["removed-beat"]);
    p.nameBeat("r2", "second");
    assert.deepEqual(p.identities("joiner").map(beat => beat.beat), ["second"]);
  } finally { if (sharedSession()) hook.leave(); }
  assert.deepEqual([hook.peer.joined(), hook.peer.recoveryEntries("joiner"), hook.peer.identities("app"), hook.peer.catchUp()], [null, null, null, undefined]);
});
