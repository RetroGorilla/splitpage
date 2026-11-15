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
const { undoOwner, sharedUndoRoute, stepSharedUndo } = await import("../bootstrap/wiring/undo.ts");
const hook = window.__sharedTest;

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

function appEdits(from, to, data) {
  const root = document.getElementById("writer-doc"), element = root.querySelector('.wr-beat[data-id="r1"]'), node = element.lastChild;
  root.focus();
  const range = document.createRange();
  range.setStart(node, from); range.setEnd(node, to);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  const inputType = data ? "insertText" : "deleteContentBackward";
  const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data: data || null });
  const target = range.cloneRange();
  Object.defineProperty(before, "getTargetRanges", { value: () => [target] });
  assert.equal(element.dispatchEvent(before), true, "the Writer let the browser make the edit");
  node.data = node.data.slice(0, from) + data + node.data.slice(to);
  element.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType, data: data || null }));
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const rows = doc => doc.rows.map(row => [row.id, row.audioText]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const PEER_ACTIONS = [
  { name: "the peer types", run: p => p.type("r1", 0, "Y").kind, typed: ["p1"], before: [["r1", "YHello"], ["r2", "World"]],
    after: [["r1", "YHello!"], ["r2", "World"]], units: [["r1", ["p1", ...HELLO, "a1"]], ["r2", WORLD]], undoLabel: "typing" },
  { name: "the peer types a character outside the basic plane", run: p => p.type("r1", 0, "\u{1F600}").kind, typed: ["p1", "p2"],
    before: [["r1", "\u{1F600}Hello"], ["r2", "World"]], after: [["r1", "\u{1F600}Hello!"], ["r2", "World"]],
    units: [["r1", ["p1", "p2", ...HELLO, "a1"]], ["r2", WORLD]], undoLabel: "typing" },
  { name: "the peer deletes inside a beat", run: p => p.erase("r1", 1, 3), before: [["r1", "Hlo"], ["r2", "World"]],
    after: [["r1", "Hlo!"], ["r2", "World"]], units: [["r1", ["h1", "h4", "h5", "a1"]], ["r2", WORLD]], undoLabel: "typing" },
  { name: "the peer formats a range", run: p => p.format("r1", 0, 5, "b"), before: [["r1", "<strong>Hello</strong>"], ["r2", "World"]],
    after: [["r1", "<strong>Hello</strong>!"], ["r2", "World"]], units: [["r1", [...HELLO, "a1"]], ["r2", WORLD]], undoLabel: "format" },
  { name: "the peer deletes a range across beats", run: p => p.deleteRange("r1", 3, "r2", 2), before: [["r1", "Hel"], ["r2", "rld"]],
    after: [["r1", "Hel!"], ["r2", "rld"]], units: [["r1", ["h1", "h2", "h3", "a1"]], ["r2", ["w3", "w4", "w5"]]], undoLabel: "delete-selection" },
  { name: "the peer removes the beat the app is typing in", run: p => p.remove("r1"), before: [["r2", "World"]],
    after: [["r2", "World"]], units: [["r2", WORLD]], undoLabel: "delete-scene", removed: ["r1", "Hello!"], announcedInD3: true },
  { name: "the peer removes the other beat", run: p => p.remove("r2"), before: [["r1", "Hello"]],
    after: [["r1", "Hello!"]], units: [["r1", [...HELLO, "a1"]]], undoLabel: "delete-scene", removed: ["r2", "World"] }
];

const ORDERS = ["forward", "reverse", "duplicate", "D3"];

const TWINS = [{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "Hello", visualText: "" }];
const GROUPING = [
  { name: "two erases inside the window undo as one", steps: [["erase", 4, 5], ["erase", 3, 4]], edited: "Hel",
    undos: ["true:Hello", "false:Hello", "false:Hello"] },
  { name: "two erases across the window undo as two", steps: [["erase", 4, 5], ["wait"], ["erase", 3, 4]], edited: "Hel",
    undos: ["true:Hell", "true:Hello", "false:Hello"] },
  { name: "typing then erasing inside the window undo as one", steps: [["type", 5, "!"], ["erase", 0, 1]], edited: "ello!",
    undos: ["true:Hello", "false:Hello", "false:Hello"] }
];

async function walk(steps, act) {
  for (const step of steps) {
    if (step[0] === "wait") await sleep(1100);
    else act(step);
  }
}

for (const row of GROUPING) {
  test(`peer grouping matches the Writer: ${row.name}`, async () => {
    script(TWINS);
    assert.deepEqual(await hook.enter(), { ok: true });
    try {
      const p = hook.peer, text = index => hook.read().app.rows[index].audioText;
      await walk(row.steps, ([kind, from, at]) => { if (kind === "erase") appEdits(from, at, ""); else appEdits(from, from, at); });
      const app = [text(0)];
      for (let step = 0; step < 3; step++) app.push(stepSharedUndo(sharedUndoRoute(), "undo", () => {}).ok + ":" + text(0));
      await walk(row.steps, ([kind, from, at]) => { if (kind === "erase") p.erase("r2", from, at); else p.type("r2", from, at); });
      p.deliver();
      const peer = [text(1)];
      for (let step = 0; step < 3; step++) { const undone = p.undo(); p.deliver(); peer.push(undone.ok + ":" + text(1)); }
      assert.deepEqual(app, [row.edited, ...row.undos], "the Writer, with native edits");
      assert.deepEqual(peer, app, "the peer groups as the Writer does");
    } finally { if (sharedSession()) hook.leave(); }
  });
}

test("peer grouping: a plan that changes nothing leaves the open group open, and an applied plan ends it", async () => {
  script(TWINS);
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const p = hook.peer, text = () => hook.read().peer.rows[1].audioText;
    assert.equal(p.type("r2", 5, "a").kind, "applied");
    assert.equal(p.format("nope", 0, 1), "failed");
    assert.equal(p.format("r2", 2, 2), "noop");
    assert.equal(p.type("r2", 6, "b").kind, "applied");
    assert.equal(text(), "Helloab");
    assert.deepEqual([p.undo().label, text(), p.undo().ok, text()], ["typing", "Hello", false, "Hello"]);
    assert.equal(p.type("r2", 5, "a").kind, "applied");
    assert.equal(p.format("r2", 0, 1), "applied");
    assert.equal(p.type("r2", 6, "b").kind, "applied");
    assert.equal(text(), "<strong>H</strong>elloab");
    const steps = [0, 1, 2].map(() => [p.undo().label, text()]);
    assert.deepEqual(steps, [["typing", "<strong>H</strong>elloa"], ["format", "Helloa"], ["typing", "Hello"]]);
  } finally { if (sharedSession()) hook.leave(); }
});

test("naming refuses a name already given to another identity, for characters and for beats, and a refused call names nothing", async () => {
  script();
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const p = hook.peer, units = (which, beat) => p.identities(which).find(entry => entry.beat === beat).units;
    assert.throws(() => p.nameIdentities("app", "r1", 0, ["h", "e", "same", "same", "o"]), /The name is already given to another identity: same/);
    assert.deepEqual(units("app", "r1"), [null, null, null, null, null]);
    p.nameIdentities("app", "r1", 0, HELLO);
    assert.throws(() => p.nameIdentities("app", "r2", 0, ["w1", "h1"]), /The name is already given to another identity: h1/);
    assert.deepEqual(units("app", "r2"), [null, null, null, null, null]);
    p.nameIdentities("peer", "r1", 0, ["h1"]);
    assert.deepEqual([units("app", "r1"), units("peer", "r1")], [HELLO, HELLO], "the same character may take its own name again");
    p.nameBeat("r1", "first");
    assert.throws(() => p.nameBeat("r2", "first"), /The name is already given to another identity: first/);
    p.nameBeat("r1", "first");
    assert.deepEqual(p.identities("app").map(entry => entry.beat), ["first", "r2"]);
  } finally { if (sharedSession()) hook.leave(); }
});

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
      const p = hook.peer, counted = hook.counters();
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
      const announced = order === "D3" && action.announcedInD3 ? 1 : 0;
      assert.deepEqual([hook.counters().recovered - counted.recovered, hook.counters().missingBase - counted.missingBase], [announced, 0],
        "only the commit that drains the removal of its own beat announces kept writing (rule 29)");
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
