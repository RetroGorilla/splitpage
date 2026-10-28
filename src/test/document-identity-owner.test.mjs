import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentIdentityOwner } from "../application/identity/document-identity.js";
import { deriveDocId } from "../core/document/ids.ts";

const A = "d" + "1".repeat(32);
const B = "d" + "2".repeat(32);

function fake() {
  const log = [];
  const document = { docId: A, title: "My script", rows: [] };
  const home = { kind: "file", handle: { name: "copy.md" } };
  let writtenOut = true;
  let desktop = false;
  let copy = () => Promise.resolve({ ok: true, copied: 1 });
  const channel = { onmessage: null, postMessage: (message) => log.push(["message", message]), close: () => log.push(["close"]) };
  const ports = {
    session: {
      currentDocument: () => document,
      stampDocument: (stamp) => { log.push(["stamp", stamp.name]); stamp.plan(document).apply(document); }
    },
    location: { home: () => home, writtenOut: () => writtenOut, markWrittenOut: (value) => { log.push(["written", value]); writtenOut = value; } },
    history: { copyHistory: (from, to) => { log.push(["copy", from, to]); return copy(); }, historyDocumentChanged: () => log.push(["changed"]) },
    effects: { show: (...args) => log.push(["toast", ...args]) },
    desktop: { running: () => desktop },
    ids: { docId: () => B, randomHexBytes: (count) => { log.push(["nonce", count]); return "nonce-mine"; } },
    now: () => 1000,
    logger: { error: (error) => log.push(["error", error]) },
    channel: (name) => { log.push(["channel", name]); return channel; }
  };
  const owner = createDocumentIdentityOwner();
  return { owner, ports, log, document, home, channel, desktop: (value) => { desktop = value; }, copy: (run) => { copy = run; } };
}

function refused(owner) {
  for (const call of [() => owner.syncDocIdentity(), () => owner.noteMergedDocId(A), () => owner.copyDocHistorySafe(A, B), () => owner.reassignDocId(B, { fromId: A }), () => owner.initDocIdentityChannel(), () => owner.docIdEvents(), () => owner.documentIdentityPort.mint(), () => owner.documentIdentityPort.writtenOut(), () => owner.documentIdentityPort.markWrittenOut(false)]) assert.throws(call, /not started yet/);
}

test("identity refuses before start and after stop, closes its channel, and can restart", () => {
  const f = fake();
  refused(f.owner);
  const stop = f.owner.startIdentity(f.ports);
  assert.throws(() => f.owner.startIdentity(f.ports), /already started/);
  assert.deepEqual(f.log, [["nonce", 16]]);
  assert.equal(f.owner.documentIdentityPort.mint(), B);
  assert.equal(f.owner.documentIdentityPort.writtenOut(), true);
  f.owner.initDocIdentityChannel();
  stop();
  stop();
  refused(f.owner);
  assert.equal(f.channel.onmessage, null);
  assert.equal(f.log.filter(([kind]) => kind === "close").length, 1);
  const next = f.owner.startIdentity(f.ports);
  assert.deepEqual(f.owner.docIdEvents(), []);
  next();
});

test("reassignment stamps, clears written-out, copies history, synchronizes, announces, then warns", () => {
  const f = fake();
  const stop = f.owner.startIdentity(f.ports);
  f.owner.initDocIdentityChannel();
  f.log.length = 0;
  assert.equal(f.owner.reassignDocId(B, { fromId: A, otherTitle: "Other script" }), true);
  assert.equal(f.document.docId, B);
  assert.deepEqual(f.log.map(([kind]) => kind), ["stamp", "written", "copy", "changed", "message", "toast"]);
  assert.deepEqual(f.log[2], ["copy", A, B]);
  assert.deepEqual(f.owner.docIdEvents(), [{ type: "copy", from: A, to: B }]);
  const events = f.owner.docIdEvents(); events.length = 0;
  assert.equal(f.owner.docIdEvents().length, 1);
  assert.equal(f.log[5][2], "warn");
  assert.equal(f.log[5][3], true);
  assert.match(f.log[5][1], /Other script/);
  stop();
});

test("invalid and stale reassignment refuse without effects", () => {
  const f = fake(); const stop = f.owner.startIdentity(f.ports);
  for (const [to, from] of [["bad", A], [B, "bad"], [A, A], [B, B]]) assert.equal(f.owner.reassignDocId(to, { fromId: from }), false);
  assert.deepEqual(f.log, [["nonce", 16]]);
  stop();
});

test("merged identities copy history once per request and synchronize only when identity changes", () => {
  const f = fake(); const stop = f.owner.startIdentity(f.ports);
  f.owner.noteMergedDocId("bad"); f.owner.noteMergedDocId(A);
  assert.deepEqual(f.owner.docIdEvents(), []);
  f.owner.noteMergedDocId(B); f.owner.noteMergedDocId(B);
  assert.deepEqual(f.owner.docIdEvents(), [{ type: "copy", from: B, to: A }, { type: "copy", from: B, to: A }]);
  assert.equal(f.log.filter(([kind]) => kind === "changed").length, 1);
  stop();
});

test("channel name, claim bytes, duplicate loser replacement and winner reply stay fixed", () => {
  const f = fake(); const stop = f.owner.startIdentity(f.ports);
  f.owner.syncDocIdentity();
  f.owner.initDocIdentityChannel((name) => { assert.equal(name, "splitpage-doc-ids"); return f.channel; });
  const mine = { type: "claim", docId: A, home: "file:copy.md", at: 1000, nonce: "nonce-mine", title: "My script" };
  assert.deepEqual(f.log.at(-1), ["message", mine]);
  f.channel.onmessage({ data: { ...mine, nonce: "other", home: "file:original.md", at: 2000 } });
  assert.deepEqual(f.log.at(-1), ["message", { ...mine, type: "here" }]);
  assert.equal(f.document.docId, A);
  f.channel.onmessage({ data: { ...mine, type: "here", nonce: "other", home: "file:original.md", at: 1, title: "Original" } });
  assert.equal(f.document.docId, deriveDocId("splitpage-dup", A + "\nfile:copy.md"));
  assert.deepEqual(f.owner.docIdEvents(), [{ type: "copy", from: A, to: f.document.docId }]);
  stop();
});

test("desktop never opens or announces a cross-tab channel; replacing a channel closes the old one", () => {
  const f = fake(); const stop = f.owner.startIdentity(f.ports);
  f.desktop(true);
  assert.equal(f.owner.initDocIdentityChannel(() => { throw new Error("must not open"); }), null);
  f.owner.syncDocIdentity();
  assert.equal(f.log.some(([kind]) => kind === "message"), false);
  f.desktop(false);
  f.owner.initDocIdentityChannel(); f.owner.initDocIdentityChannel();
  assert.equal(f.log.filter(([kind]) => kind === "close").length, 1);
  stop();
});

test("history copying is not awaited, failed copies warn once, and invalid copies do nothing", async () => {
  const f = fake(); const stop = f.owner.startIdentity(f.ports);
  let release;
  f.copy(() => new Promise((resolve) => { release = resolve; }));
  assert.equal(f.owner.copyDocHistorySafe(A, B), undefined);
  assert.equal(f.log.some(([kind]) => kind === "toast"), false);
  release({ ok: false }); await Promise.resolve();
  f.copy(() => { throw new Error("unavailable"); });
  f.owner.copyDocHistorySafe(A, B); f.owner.copyDocHistorySafe("bad", B); f.owner.copyDocHistorySafe(A, A);
  assert.equal(f.log.filter(([kind]) => kind === "toast").length, 1);
  assert.equal(f.owner.docIdEvents().length, 2);
  stop();
});

for (const completion of ["failure result", "rejection"]) {
  test("a stopped identity ignores a late history-copy " + completion + " after restart", async () => {
    const f = fake();
    const stop = f.owner.startIdentity(f.ports);
    let resolveCopy, rejectCopy;
    f.copy(() => new Promise((resolve, reject) => { resolveCopy = resolve; rejectCopy = reject; }));
    assert.equal(f.owner.copyDocHistorySafe(A, B), undefined);
    stop();
    const stopNext = f.owner.startIdentity(f.ports);
    f.log.length = 0;
    if (completion === "failure result") resolveCopy({ ok: false });
    else rejectCopy(new Error("late copy failure"));
    await Promise.resolve();
    assert.deepEqual(f.log, []);
    assert.deepEqual(f.owner.docIdEvents(), []);
    f.copy(() => Promise.resolve({ ok: false }));
    assert.equal(f.owner.copyDocHistorySafe(A, B), undefined);
    await Promise.resolve();
    assert.equal(f.log.filter(([kind]) => kind === "toast").length, 1);
    stopNext();
  });
}
