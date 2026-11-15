import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(() => { closeApp(); });

const { adoptReplacement, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { sharedSessionParts } = await import("../bootstrap/wiring/shared-session.ts");
const { encodeSharedState, encodeSharedStateVector, encodeSharedUpdate } = await import("../adapters/collab/document.ts");
const hook = window.__sharedTest;

const ROWS = [{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "World", visualText: "" }];

function script(given = ROWS) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Measure", rows: given }));
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

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const rows = doc => doc.rows.map(row => [row.id, row.audioText]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const marks = () => performance.getEntriesByType("mark").map(entry => entry.name).filter(name => name.startsWith("measure:"));
const queued = () => hook.counters().queued;
const snapshot = () => JSON.stringify([hook.read(), hook.peer.recoveryEntries("app"), hook.peer.recoveryEntries("peer")]);

function spans(names) {
  const open = new Map(), out = [];
  names.forEach((name, at) => {
    const [, seam, edge] = name.split(":");
    if (edge === "start") { if (!open.has(seam)) open.set(seam, []); open.get(seam).push(at); return; }
    const start = open.get(seam)?.pop();
    assert.notEqual(start, undefined, "every end mark has its start: " + name);
    out.push({ seam, start, end: at });
  });
  for (const [seam, starts] of open) assert.deepEqual(starts, [], "every start mark has its end: " + seam);
  return out;
}

const of = (found, seam) => found.filter(span => span.seam === seam);
const inside = (inner, outer) => outer.start < inner.start && inner.end < outer.end;
const insideOne = (inner, outers) => outers.some(outer => inside(inner, outer));

async function shared(run, given = ROWS) {
  script(given);
  assert.deepEqual(await hook.enter(), { ok: true });
  try { await run(hook.peer); } finally {
    hook.timing(false);
    performance.clearMarks();
    if (sharedSession()) hook.leave();
  }
}

test("timing marks: switched off nothing is marked; switched on, a remote update marks its trial, live apply, projection, session receive and render, nested in that order", async () => {
  await shared(p => {
    p.hold();
    assert.equal(p.type("r1", 0, "Y").kind, "applied");
    performance.clearMarks();
    assert.equal(p.deliver("forward", "app"), 1);
    assert.deepEqual(marks(), [], "a test build marks nothing until a measurement switches the marks on");
    hook.timing(true);
    assert.equal(p.type("r2", 0, "Z").kind, "applied");
    performance.clearMarks();
    assert.equal(p.deliver("forward", "app"), 1);
    const found = spans(marks());
    assert.deepEqual([...new Set(found.map(span => span.seam))].sort(),
      ["assembly", "document-entry", "live-apply", "mirror-apply", "projection-listeners", "render", "session-receive", "trial"]);
    const [trial] = of(found, "trial"), [live] = of(found, "live-apply"), [receive] = of(found, "session-receive");
    assert.ok(trial.end < live.start, "the trial ends before the live apply starts");
    for (const seam of ["mirror-apply", "assembly", "projection-listeners"]) assert.ok(of(found, seam).every(span => inside(span, live)), seam + " runs inside the live apply");
    assert.ok(inside(receive, of(found, "projection-listeners")[0]), "the session receive is a projection listener");
    for (const seam of ["document-entry", "render"]) assert.ok(of(found, seam).every(span => inside(span, receive)), seam + " runs inside the session receive");
    hook.timing(false);
    performance.clearMarks();
    assert.equal(p.type("r2", 0, "W").kind, "applied");
    assert.equal(p.deliver("forward", "app"), 1);
    assert.deepEqual(marks(), [], "switching the marks off stops them");
  });
});

test("timing marks: the app's own typing marks its input handler, command and write, with the projection and render inside the write and no trial", async () => {
  await shared(p => {
    p.hold();
    hook.timing(true);
    performance.clearMarks();
    appTypes("!")();
    const found = spans(marks()), seams = new Set(found.map(span => span.seam));
    assert.deepEqual(["trial", "live-apply"].filter(seam => seams.has(seam)), [], "a local write runs no trial and no remote apply");
    const commands = of(found, "input-command"), writes = of(found, "input-write"), handlers = of(found, "input-handler");
    assert.equal(writes.length, 1);
    assert.ok(handlers.length >= 1 && commands.length === 1);
    assert.ok(inside(writes[0], commands[0]) && insideOne(commands[0], handlers), "the write runs inside the command, inside the input handler");
    for (const seam of ["mirror-apply", "assembly", "session-receive", "document-entry", "render"]) {
      assert.ok(of(found, seam).length > 0 && of(found, seam).every(span => inside(span, writes[0])), seam + " runs inside the write");
    }
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello!"], ["r2", "World"]]);
  });
});

const STRUCTURE = [
  { name: "splits a beat", run: p => p.split("r1", 2), label: "split-scene", after: id => [["r1", "He"], [id, "llo"], ["r2", "World"]] },
  { name: "adds a beat", run: p => p.add("r2"), label: "add-scene", after: id => [["r1", "Hello"], ["r2", "World"], [id, ""]] },
  { name: "joins two beats", run: p => ({ kind: p.join("r1"), id: null }), label: "join-scenes", after: () => [["r1", "Hello World"]] }
];

for (const edit of STRUCTURE) test(`the peer ${edit.name} as a shared command, every copy agrees, and its undo takes it back everywhere`, async () => {
  await shared(p => {
    const done = edit.run(p);
    assert.equal(done.kind, "applied");
    assert.equal(p.deliver(), 1);
    assert.deepEqual(rows(hook.read().app), edit.after(done.id));
    assert.ok(same(hook.read().app, hook.read().peer), "app and peer agree");
    assert.ok(same(p.lateJoiner("app"), hook.read().app), "a late joiner agrees");
    const undone = p.undo();
    assert.deepEqual([undone.ok, undone.effective, undone.label], [true, true, edit.label]);
    assert.equal(p.deliver(), 1);
    assert.deepEqual(rows(hook.read().app), ROWS.map(row => [row.id, row.audioText]));
    assert.ok(same(hook.read().app, hook.read().peer) && same(p.catchUp(), hook.read().app), "after the undo every copy agrees");
  });
});

test("the peer's structural edits answer what the command answers: a split or add of a missing beat and a join of the last beat change nothing", async () => {
  await shared(p => {
    const before = snapshot();
    assert.deepEqual([p.split("gone", 1), p.add("gone"), p.join("r2")], [{ kind: "noop", id: null }, { kind: "noop", id: null }, "noop"]);
    assert.equal(queued(), 0);
    assert.equal(snapshot(), before);
  });
});

test("a refused update of each kind: throwing while applying and a zero-length struct are refused as invalid, and queue-full while the app's buffer is open; nothing changes, and the declined update is sent again after the commit", async () => {
  await shared(p => {
    const before = snapshot();
    const decoded = kind => Y.decodeUpdate(Uint8Array.from(atob(p.refusedUpdate(kind)), character => character.charCodeAt(0))).structs.map(struct => struct.length);
    assert.deepEqual(decoded("throws"), [1], "the throwing update decodes, with a positive length, so only applying it fails");
    assert.ok(decoded("zero-length").includes(0), "the zero-length update carries a struct of length zero");
    for (const kind of ["throws", "zero-length"]) {
      assert.deepEqual(p.inject(p.refusedUpdate(kind)), { ok: false, reason: "invalid-update" }, kind);
      assert.deepEqual(p.inject(p.refusedUpdate(kind), "peer"), { ok: false, reason: "invalid-update" }, kind + " to the peer");
      assert.equal(snapshot(), before, kind + " changes no copy");
    }
    assert.throws(() => p.refusedUpdate("queue-full"), /There is no refused update of that kind/);
    assert.throws(() => p.refusedUpdate("late"), /There is no refused update of that kind/);
    const full = p.refusedUpdate("queue-full", "r2");
    assert.equal(queued(), 0, "the refused update is handed out, not queued");
    assert.ok(hook.read().peer.rows[1].audioText.startsWith("xxxx"), "the peer wrote it");
    const app = JSON.stringify(hook.read().app);
    const commit = appTypes("!");
    assert.deepEqual(p.inject(full), { ok: false, reason: "queue-full" }, "an open buffer refuses an update larger than its queue");
    assert.equal(JSON.stringify(hook.read().app), app, "the refusal wrote nothing");
    commit();
    assert.equal(hook.read().app.rows[0].audioText, "Hello!");
    assert.ok(hook.read().app.rows[1].audioText.startsWith("xxxx"), "after the commit the declined change arrives again as one catch-up update");
    assert.equal(p.deliver(), 1);
    assert.ok(same(hook.read().app, hook.read().peer), "app and peer agree");
  });
});

test("catch-up delivery: held peer updates reach the app as one state-vector update with one trial, the same result as delivering each", async () => {
  await shared(p => {
    p.hold();
    for (const [at, letter] of [[0, "A"], [1, "B"], [2, "C"]]) assert.equal(p.type("r1", at, letter).kind, "applied");
    assert.equal(queued(), 3);
    hook.timing(true);
    performance.clearMarks();
    assert.equal(p.deliver("catch-up", "app"), 3);
    assert.equal(marks().filter(name => name === "measure:trial:start").length, 1, "one update, one trial");
    assert.deepEqual(rows(hook.read().app), [["r1", "ABCHello"], ["r2", "World"]]);
    assert.ok(same(hook.read().app, hook.read().peer));
    assert.deepEqual(p.appliedUpdates().map(entry => entry.to), ["app", "app", "app"]);
    assert.equal(queued(), 0);
    assert.equal(p.deliver("catch-up"), 0, "nothing held, nothing sent");
  });
});

test("replay: captured peer updates leave the queue and reach the app one per interval from a timer, while the app's own updates stay held for the peer", async () => {
  await shared(async p => {
    p.hold();
    for (const [at, letter] of [[0, "A"], [1, "B"], [2, "C"]]) assert.equal(p.type("r2", at, letter).kind, "applied");
    const captured = p.capture();
    assert.equal(captured.length, 3);
    assert.ok(captured.every(update => typeof update === "string"));
    assert.equal(queued(), 0);
    assert.deepEqual(rows(hook.read().app), ROWS.map(row => [row.id, row.audioText]), "capturing delivers nothing");
    p.release();
    assert.equal(p.replay(captured, 40), 3);
    assert.deepEqual(p.replayed(), { delivered: 0, refused: 0, remaining: 3, running: true }, "nothing is delivered before the first interval");
    appTypes("!")();
    assert.equal(queued(), 1, "the app's typing waits for the peer, so the peer does no work during the replay");
    await sleep(60);
    const early = p.replayed();
    assert.ok(early.delivered >= 1 && early.delivered < 3, "one interval in, not every update has arrived: " + JSON.stringify(early));
    await sleep(200);
    assert.deepEqual(p.replayed(), { delivered: 3, refused: 0, remaining: 0, running: false });
    assert.deepEqual(rows(hook.read().app), [["r1", "Hello!"], ["r2", "ABCWorld"]]);
    assert.equal(p.deliver(), 1);
    assert.ok(same(hook.read().app, hook.read().peer));
    p.hold();
    assert.equal(p.type("r2", 0, "D").kind, "applied");
    assert.equal(p.type("r2", 0, "E").kind, "applied");
    const second = p.capture();
    assert.equal(p.replay(second.map(update => Uint8Array.from(atob(update), character => character.charCodeAt(0))), 40), 2);
    await sleep(60);
    p.stopReplay();
    const stopped = p.replayed();
    await sleep(100);
    assert.deepEqual(p.replayed(), stopped, "a stopped replay delivers nothing more");
    assert.deepEqual([stopped.delivered, stopped.remaining, stopped.running], [1, 1, false]);
  });
});

test("entry from an encoded shared state: the app enters the stored document with its history and recovery, the undo stack starts empty, and an incomplete or unreadable state is refused with the standalone script kept", async () => {
  let stored = null, expected = null, recovery = null, partial = null;
  await shared(p => {
    const vector = encodeSharedStateVector(sharedSessionParts().handle);
    assert.equal(p.type("r1", 5, "?").kind, "applied");
    assert.equal(p.remove("r2"), "applied");
    assert.equal(p.deliver(), 2);
    stored = encodeSharedState(sharedSessionParts().handle);
    partial = encodeSharedUpdate(sharedSessionParts().handle, vector);
    expected = rows(hook.read().app);
    recovery = p.recoveryEntries("app");
    assert.equal(recovery.length, 1);
  });
  const other = [{ id: "o1", audioText: "Other", visualText: "" }];
  script(other);
  let text = "";
  for (const byte of stored) text += String.fromCharCode(byte);
  assert.deepEqual(await hook.enterFrom(btoa(text)), { ok: true });
  try {
    assert.deepEqual(rows(hook.read().app), expected, "the stored document, not the open standalone script");
    assert.deepEqual(hook.peer.recoveryEntries("app"), recovery, "the stored recovery entry comes with it");
    assert.ok(same(hook.read().app, hook.read().peer), "the peer copies the stored state");
    assert.deepEqual(sharedSessionParts().undo.sizes(), { undo: 0, redo: 0, dropped: 0 }, "the undo stack starts empty");
    assert.equal(hook.peer.type("r1", 0, "N").kind, "applied");
    assert.equal(hook.peer.deliver(), 1);
    assert.equal(hook.read().app.rows[0].audioText, "NHello?");
  } finally { if (sharedSession()) hook.leave(); }
  for (const [name, bytes] of [["an incomplete state", partial], ["unreadable bytes", new Uint8Array([1, 2, 3])]]) {
    script(other);
    const outcome = await hook.enterFrom(bytes);
    assert.deepEqual(outcome, { ok: false, reason: "enter-failed" }, name);
    assert.equal(sharedSession(), false, name);
    assert.deepEqual(rows(hook.read().app), [["o1", "Other"]], name + " keeps the standalone script");
  }
});
