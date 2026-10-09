import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createFakeLocks,
  createGates,
  createHeldDesktop,
  createHeldDraftStore,
  createHeldFetch,
  createHeldFileHandle,
  declaredCases,
  firstWriteBeforeAdoption,
  judge,
  mockClock,
  rightToday,
  traceFields
} from "./_m4-matrix.mjs";

const HARNESS = new URL("./_m4-matrix.mjs", import.meta.url).href;

const nothing = async () => {};
const failing = async () => { assert.equal(1, 2); };
const throwing = async () => { throw new TypeError("boom"); };

test("judge: a rightToday case that passes passes, and one that fails fails with its own error", async () => {
  assert.equal(await judge("X", "right", nothing), "right");
  await assert.rejects(judge("X", "right", failing), assert.AssertionError);
  await assert.rejects(judge("X", "right", throwing), TypeError);
});

test("judge: a wrongToday case passes only by failing the assertion it names", async () => {
  const named = async () => { assert.equal(1, 2, "the defect shows"); };
  assert.equal(await judge("X9", "wrong", named, /the defect shows/), "wrong");
});

test("judge: an expectation that node's default assertion messages also match is refused before the case runs", async () => {
  for (const expects of [/Expected values to be strictly equal/, /strictly deep-equal/, /falsy value/, /did not match/, /unequal to/, /^Failed$/]) {
    let ran = false;
    await assert.rejects(judge("X9", "wrong", async () => { ran = true; }, expects), /X9 names an expected message that node's default assertion messages also match; use an assert with a label/, String(expects));
    assert.equal(ran, false);
  }
});

test("judge: an expectation with the g or y flag is refused before the case runs", async () => {
  for (const expects of [/the defect shows/g, /the defect shows/y]) {
    let ran = false;
    await assert.rejects(judge("X9", "wrong", async () => { ran = true; }, expects), /X9 names an expected message with the g or y flag/, String(expects));
    assert.equal(ran, false);
  }
});

test("judge: a wrongToday case that fails a different assertion fails, with the assertion it failed on", async () => {
  const setup = async () => { assert.ok(false, "the setup did not happen"); };
  await assert.rejects(judge("X9", "wrong", setup, /the defect shows/), (error) => {
    assert.match(error.message, /X9 is declared wrongToday to fail on \/the defect shows\/ but failed a different assertion: the setup did not happen/);
    assert.ok(error.cause instanceof assert.AssertionError);
    return true;
  });
});

test("judge: a wrongToday case with no named assertion is refused before it runs", async () => {
  let ran = false;
  await assert.rejects(judge("X9", "wrong", async () => { ran = true; }), /X9 is declared wrongToday without the assertion message it expects to fail on/);
  assert.equal(ran, false);
});

test("judge: a wrongToday case that starts passing fails with now right and the id", async () => {
  await assert.rejects(judge("X9", "wrong", nothing, /anything/), /X9 is declared wrongToday and now passes: it is now right/);
});

test("judge: a wrongToday case that dies of anything but an assertion fails", async () => {
  await assert.rejects(judge("X9", "wrong", throwing, /anything/), (error) => {
    assert.match(error.message, /X9 is declared wrongToday but failed with TypeError: boom, not with an assertion/);
    assert.ok(error.cause instanceof TypeError);
    return true;
  });
});

test("judge: a declaration that is neither right nor wrong is refused", async () => {
  await assert.rejects(judge("X9", "maybe", nothing), /neither|not right or wrong/);
});

const fixtureDir = mkdtempSync(join(tmpdir(), "m4-matrix-self-"));
test.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

function runFixture(name, body, env) {
  const file = join(fixtureDir, name + ".test.mjs");
  writeFileSync(file, 'import assert from "node:assert/strict";\nimport { rightToday, wrongToday } from ' + JSON.stringify(HARNESS) + ";\n" + body + "\n");
  const childEnv = Object.assign({}, process.env, env || {});
  delete childEnv.NODE_TEST_CONTEXT;
  if (!env || env.SPLITPAGE_M4_GATE === undefined) delete childEnv.SPLITPAGE_M4_GATE;
  const run = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env: childEnv });
  return { status: run.status, output: String(run.stdout) + String(run.stderr) };
}

test("the run: a wrongToday case that fails its named assertion and a rightToday case that passes make a green run", () => {
  const r = runFixture("green", 'wrongToday("W1", "broken", async () => { assert.equal(1, 2, "it is broken"); }, /it is broken/);\nrightToday("R1", "fine", async () => { assert.equal(1, 1); });');
  assert.equal(r.status, 0, r.output);
});

test("the run: a wrongToday case that starts passing fails the run", () => {
  const r = runFixture("wrong-passes", 'wrongToday("W2", "fixed by accident", async () => { assert.equal(1, 1); }, /anything/);');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /W2 is declared wrongToday and now passes/);
});

test("the run: a wrongToday case that fails a different assertion fails the run", () => {
  const r = runFixture("wrong-other", 'wrongToday("W5", "setup broke", async () => { assert.ok(false, "the setup did not happen"); }, /it is broken/);');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /W5 is declared wrongToday to fail on .* but failed a different assertion: the setup did not happen/);
});

test("the run: a rightToday case that fails fails the run", () => {
  const r = runFixture("right-fails", 'rightToday("R2", "broke", async () => { assert.equal(1, 2); });');
  assert.notEqual(r.status, 0);
});

test("the run: a wrongToday case that throws a plain error fails the run", () => {
  const r = runFixture("wrong-throws", 'wrongToday("W3", "crashes", async () => { throw new Error("crash"); }, /crash/);');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /not with an assertion/);
});

test("the run: a case that waits on a call nobody releases fails by timeout and names the case", () => {
  const r = runFixture("hangs", 'rightToday("H1", "never released", async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); });', { SPLITPAGE_M4_CASE_TIMEOUT_MS: "300" });
  assert.notEqual(r.status, 0);
  assert.match(r.output, /H1 never released/);
  assert.match(r.output, /timed out after 300ms/);
});

test("the run: at the gate, any wrongToday case fails the run even while it still fails", () => {
  const body = 'wrongToday("W4", "still broken", async () => { assert.equal(1, 2, "it is broken"); }, /it is broken/);';
  assert.equal(runFixture("gate-off", body).status, 0);
  const gated = runFixture("gate-on", body, { SPLITPAGE_M4_GATE: "1" });
  assert.notEqual(gated.status, 0);
  assert.match(gated.output, /W4 is still wrongToday at the gate/);
});

rightToday("SELF1", "declared in the self-test", async () => {});

test("declaredCases lists what this process declared", () => {
  assert.deepEqual(declaredCases().filter((c) => c.id === "SELF1"), [{ id: "SELF1", today: "right", title: "declared in the self-test" }]);
});

test("gates: a held call parks until released, in order, and later calls pass", async () => {
  const gates = createGates();
  gates.hold("op", { times: 2 });
  const order = [];
  const a = gates.pass("op", "a").then(() => order.push("a"));
  const b = gates.pass("op", "b").then(() => order.push("b"));
  const c = gates.pass("op", "c").then(() => order.push("c"));
  await c;
  assert.deepEqual(order, ["c"]);
  assert.deepEqual(gates.parked("op"), ["a", "b"]);
  gates.release("op");
  await a;
  assert.deepEqual(order, ["c", "a"]);
  gates.releaseAll("op");
  await b;
  assert.deepEqual(order, ["c", "a", "b"]);
  assert.throws(() => gates.release("op"), /nothing is parked/);
});

test("gates: a hold can match on what is passing, and arrived waits for the call", async () => {
  const gates = createGates();
  gates.hold("op", { when: (info) => info === "slow" });
  await gates.pass("op", "fast");
  const slow = gates.pass("op", "slow");
  await gates.arrived("op");
  assert.deepEqual(gates.parked("op"), ["slow"]);
  gates.release("op");
  await slow;
});

test("gates: arrived gives up when nothing comes", async () => {
  await assert.rejects(createGates().arrived("never"), /nothing reached the never gate/);
});

test("held fetch: a request is recorded with the connection it was sent on, and waits until released", async () => {
  let connection = { server: "one", token: "t1" };
  const held = createHeldFetch({ connection: () => ({ ...connection }), answer: (r) => ({ status: 200, body: { echoed: r.body } }) });
  held.holdWhen((r) => r.method === "PUT");
  const get = await held.fetch("https://s.test/api/docs/a");
  assert.equal(get.status, 200);
  const put = held.fetch("https://s.test/api/docs/a", { method: "PUT", body: JSON.stringify({ rev: 2 }) });
  await held.gates.arrived("fetch");
  connection = { server: "two", token: "t2" };
  const after = held.fetch("https://s.test/api/docs/a", { method: "PUT", body: JSON.stringify({ rev: 3 }) });
  assert.equal((await after).status, 200);
  assert.deepEqual(held.requests.map((r) => [r.method, r.released]), [["GET", true], ["PUT", false], ["PUT", true]]);
  held.gates.release("fetch");
  const reply = await put;
  assert.deepEqual(await reply.json(), { echoed: { rev: 2 } });
  assert.deepEqual(held.requests.map((r) => r.connection.server), ["one", "one", "two"]);
  assert.deepEqual(held.matching("PUT", "api/docs").map((r) => r.body), [{ rev: 2 }, { rev: 3 }]);
});

test("held fetch: install replaces the global fetch and the returned function puts it back", () => {
  const held = createHeldFetch({});
  const before = globalThis.fetch;
  const uninstall = held.install();
  assert.equal(globalThis.fetch, held.fetch);
  uninstall();
  assert.equal(globalThis.fetch, before);
});

test("held file handle: nothing is stored until close, a held write keeps the old bytes, and getFile sees the last close", async () => {
  const file = createHeldFileHandle({ name: "a.md", text: "old", lastModified: 5000 });
  file.holdOp("write");
  const writable = await file.handle.createWritable();
  const writing = writable.write("new");
  await file.arrivedAt("write");
  assert.equal(file.text(), "old");
  file.releaseOp("write");
  await writing;
  assert.equal(file.text(), "old");
  await writable.close();
  assert.equal(file.text(), "new");
  assert.equal(file.lastModified(), 6000);
  const read = await file.handle.getFile();
  assert.equal(await read.text(), "new");
  assert.equal(read.lastModified, 6000);
  assert.deepEqual(file.calls, ["createWritable", "write", "close", "getFile"]);
  assert.equal(file.commits.length, 1);
});

test("held file handle: a held close and getFile park, and a failure at close stores nothing", async () => {
  const file = createHeldFileHandle({ name: "b.md", text: "keep" });
  const writable = await file.handle.createWritable();
  await writable.write("lost");
  file.failNext("close", new Error("disk full"));
  await assert.rejects(writable.close(), /disk full/);
  assert.equal(file.text(), "keep");
  assert.equal(file.commits.length, 0);
  file.holdOp("getFile");
  const reading = file.handle.getFile();
  await file.arrivedAt("getFile");
  file.releaseOp("getFile");
  assert.equal(await (await reading).text(), "keep");
});

test("held file handle: permission answers come from setPermission", async () => {
  const file = createHeldFileHandle({});
  assert.equal(await file.handle.queryPermission({ mode: "readwrite" }), "granted");
  file.setPermission("denied");
  assert.equal(await file.handle.requestPermission({ mode: "readwrite" }), "denied");
  assert.equal(await file.handle.isSameEntry(file.handle), true);
});

test("held file handle: a handle whose permission is not granted refuses getFile and createWritable and stores nothing", async () => {
  const file = createHeldFileHandle({ name: "c.md", text: "keep", permission: "prompt" });
  await assert.rejects(file.handle.createWritable(), (error) => error.name === "NotAllowedError");
  await assert.rejects(file.handle.getFile(), (error) => error.name === "NotAllowedError");
  assert.equal(file.commits.length, 0);
  assert.deepEqual(file.calls, ["createWritable", "getFile"]);
  file.setPermission("granted");
  assert.equal(await (await file.handle.getFile()).text(), "keep");
});

test("held desktop: the history copy is gated and logged like the file calls", async () => {
  const seen = [];
  const held = createHeldDesktop({ historyCopy: async (from, to) => { seen.push([from, to]); return { ok: true, copied: 1 }; } });
  held.holdOp("historyCopy");
  const copying = held.desktop.historyCopy("d1", "d2");
  await held.arrivedAt("historyCopy");
  assert.deepEqual(seen, []);
  held.releaseOp("historyCopy");
  assert.deepEqual(await copying, { ok: true, copied: 1 });
  assert.deepEqual(seen, [["d1", "d2"]]);
  assert.deepEqual(held.calls.map((c) => c.op), ["historyCopy"]);
});

test("held desktop: a held call parks before it reaches the backend, and the backend keeps its own state", async () => {
  const calls = [];
  const backend = {
    tabId: "tab",
    writeFile: async function (id, data) { calls.push(["write", id, this === backend]); return { lastModified: 1, size: data.length }; },
    readFile: async function (id) { calls.push(["read", id]); return { id: id }; },
    other: function () { return "same"; }
  };
  const held = createHeldDesktop(backend);
  held.holdOp("writeFile");
  const writing = held.desktop.writeFile("f1", new Uint8Array(3));
  await held.arrivedAt("writeFile");
  assert.deepEqual(calls, []);
  assert.equal(held.desktop.tabId, "tab");
  assert.equal(held.desktop.other(), "same");
  held.releaseOp("writeFile");
  assert.deepEqual(await writing, { lastModified: 1, size: 3 });
  assert.deepEqual(calls, [["write", "f1", true]]);
  await held.desktop.readFile("f1");
  assert.deepEqual(held.calls.map((c) => c.op), ["writeFile", "readFile"]);
  assert.equal(held.calls[0].args[0], "f1");
});

test("held draft store: every store method is gated and logged, and the inner store gets the call on release", async () => {
  const seen = [];
  const inner = {
    put: async (rec) => { seen.push(["put", rec.key]); return { ok: true }; },
    remove: async (key) => { seen.push(["remove", key]); return true; },
    notAFunction: 1
  };
  const held = createHeldDraftStore(inner);
  assert.equal("notAFunction" in held.store, false);
  held.holdOp("put");
  const writing = held.store.put({ key: "k" });
  await held.arrivedAt("put");
  await held.store.remove("other");
  assert.deepEqual(seen, [["remove", "other"]]);
  held.releaseOp("put");
  assert.deepEqual(await writing, { ok: true });
  assert.deepEqual(seen, [["remove", "other"], ["put", "k"]]);
  assert.deepEqual(held.calls.map((c) => c.op), ["put", "remove"]);
});

test("fake locks: exclusive requests queue, ifAvailable answers null, steal takes over, and the lock goes when the callback settles", async () => {
  const locks = createFakeLocks();
  const order = [];
  let finish;
  const first = locks.request("w", async (lock) => {
    order.push("first:" + lock.mode);
    await new Promise((r) => { finish = r; });
  });
  await Promise.resolve();
  assert.equal(locks.isHeld("w"), true);
  const second = locks.request("w", async () => { order.push("second"); });
  const polite = await locks.request("w", { ifAvailable: true }, (lock) => lock);
  assert.equal(polite, null);
  assert.deepEqual((await locks.query()).held, [{ name: "w", mode: "exclusive" }]);
  assert.deepEqual((await locks.query()).pending.length, 1);
  finish();
  await first;
  await second;
  assert.deepEqual(order, ["first:exclusive", "second"]);
  assert.equal(locks.isHeld("w"), false);
  const holder = locks.request("x", () => new Promise(() => {}));
  holder.catch(() => {});
  await Promise.resolve();
  const stolen = await locks.request("x", { steal: true }, (lock) => lock.name);
  assert.equal(stolen, "x");
});

test("fake locks: install puts a navigator.locks on the global and the returned function takes it away", () => {
  const locks = createFakeLocks();
  const before = globalThis.navigator;
  const uninstall = locks.install();
  assert.equal(globalThis.navigator.locks, locks);
  assert.equal(typeof globalThis.navigator.userAgent, typeof before.userAgent);
  uninstall();
  assert.equal(globalThis.navigator, before);
});

test("mock clock: timers and Date move only when ticked", async (t) => {
  const clock = mockClock(t, 1000);
  const fired = [];
  setTimeout(() => fired.push("a"), 100);
  setTimeout(() => fired.push("b"), 300);
  assert.equal(clock.now(), 1000);
  clock.tick(99);
  assert.deepEqual(fired, []);
  clock.tick(1);
  assert.deepEqual(fired, ["a"]);
  clock.tick(500);
  assert.deepEqual(fired, ["a", "b"]);
  assert.equal(clock.now(), 1600);
  clock.reset();
});

let leftPending;

test("mock clock: a timer still pending when the test ends is fired for it", async (t) => {
  mockClock(t);
  leftPending = setTimeout(() => {}, 100);
});

test("mock clock: clearing that leftover handle in a later test does not remove the later test's timer", async (t) => {
  const clock = mockClock(t);
  let ran = false;
  setTimeout(() => { ran = true; }, 50);
  clearTimeout(leftPending);
  clock.tick(100);
  assert.equal(ran, true);
});

test("traceFields records each write with the probe's answer, keeps the field's own accessor, and stops cleanly", () => {
  let held = null;
  let backing = null;
  const owner = {
    dirty: false,
    get state() { return backing; },
    set state(v) { backing = v; }
  };
  const trace = traceFields(owner, ["state", "dirty"], { epoch: () => 3, held: () => held });
  const doc = { title: "A" };
  owner.state = doc;
  owner.dirty = true;
  held = doc;
  owner.dirty = false;
  assert.deepEqual(trace.events, [
    { field: "state", value: "object", epoch: 3, sessionHolds: false },
    { field: "dirty", value: true, epoch: 3, sessionHolds: false },
    { field: "dirty", value: false, epoch: 3, sessionHolds: true }
  ]);
  assert.equal(owner.state, doc);
  assert.equal(owner.dirty, false);
  trace.stop();
  owner.state = null;
  owner.dirty = true;
  assert.equal(backing, null);
  assert.equal(owner.dirty, true);
  assert.equal(trace.events.length, 3);
  assert.equal(Object.getOwnPropertyDescriptor(owner, "state").set !== undefined, true);
});

test("firstWriteBeforeAdoption names the first write made after a document was assigned and before the session held it", () => {
  const ev = (field, value, sessionHolds) => ({ field, value, epoch: 1, sessionHolds });
  assert.equal(firstWriteBeforeAdoption([ev("dirty", true, false), ev("state", "object", false), ev("dirty", false, true)], "state"), null);
  const lagging = ev("baseState", "object", false);
  assert.equal(firstWriteBeforeAdoption([ev("state", "object", false), lagging, ev("dirty", false, true)], "state"), lagging);
  assert.equal(firstWriteBeforeAdoption([ev("state", "object", false), ev("state", null, false), ev("dirty", true, false)], "state"), null);
  assert.equal(firstWriteBeforeAdoption([ev("state", "object", true), ev("baseState", "object", true)], "state"), null);
});
