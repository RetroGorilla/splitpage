import "../../src/test/_dom.mjs";
import { opening, transitions as portTransitions } from "../../src/bootstrap/wiring/ports/transitions.ts";
import "../../src/test/_location-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { NO_DESTINATION } from "../../src/application/transitions/ports.ts";

import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { currentDocument, liveDocumentPort } from "../../src/bootstrap/wiring/session-owner.ts";
import { documentOpenings, documentSources, documentTransitions, startTransitions } from "../../src/bootstrap/wiring/transition-owners.ts";
import { startTestSession, unwiredSessionDeps } from "../../src/test/_session.mjs";
import { fakeTransitions } from "../features/fakes.ts";

startTestSession(unwiredSessionDeps().deps);

function script(title: string) {
  return migrateRows({ title, docId: "d" + "1".repeat(32), rows: [{ id: "r1", visualText: "", audioText: "", status: "todo" }] });
}

test("the transitions port reaches the running transitions when called, and refuses before they start", async () => {
  const transitions = portTransitions;
  assert.throws(() => transitions.copyId(), /not started yet/);
  const log: string[] = [];
  const stop = startTransitions({
    live: liveDocumentPort,
    destination: { set: (d) => { log.push("destination:" + d.kind); }, confirm: (_doc, why) => { log.push("baseline:" + why); } },
    identity: { mint: () => "d" + "9".repeat(32), writtenOut: () => false, markWrittenOut: (out) => { log.push("writtenOut:" + String(out)); } },
    history: { keep: () => null }
  });
  try {
    const next = script("New");
    const arrived = transitions.startNew({ from: { document: next }, reason: "a new script", destination: NO_DESTINATION });
    assert.equal(arrived.document, next);
    assert.equal(currentDocument(), next);
    assert.deepEqual(log, ["destination:none", "baseline:a new script", "writtenOut:false"]);
    assert.equal(transitions.copyId(), next.docId);
    const source = { kind: "file" as const, file: new File([], "File.splitpage"), handle: null };
    const opened: unknown[] = [];
    const remove = documentSources().register({ id: "newtab-port", takes: () => true, open: (request) => { opened.push(request); return next; } });
    try {
      assert.equal(await opening.open(source), next);
      assert.equal(opened[0], source);
    } finally { remove(); }
  } finally {
    stop();
  }
  assert.throws(() => transitions.copyId(), /not started yet/);
});

test("no destination is one frozen value", () => {
  assert.deepEqual(NO_DESTINATION, { kind: "none" });
  assert.ok(Object.isFrozen(NO_DESTINATION));
});

test("C8 opening metadata is owned by the started lifetime and preserves sync results and promise identity", async () => {
  assert.equal(documentOpenings.openingPending(), false);
  const begin = () => startTransitions({ live: liveDocumentPort,
    destination: { set: () => {}, confirm: () => {} },
    identity: { mint: () => "d" + "9".repeat(32), writtenOut: () => false, markWrittenOut: () => {} }, history: { keep: () => null } });
  const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  let stop = begin();
  try {
    assert.equal(documentOpenings.track(() => 7), 7); assert.equal(documentOpenings.openingPending(), false);
    assert.throws(() => documentOpenings.track(() => { throw new Error("sync failure"); }), /sync failure/);
    assert.equal(documentOpenings.openingPending(), false);
    for (const outcome of ["landed", "failed", "cancelled"] as const) {
      const next = deferred<string>(), result = documentOpenings.track(() => next.promise);
      assert.equal(result === next.promise, true); assert.equal(documentOpenings.openingPending(), true);
      if (outcome === "landed") { next.resolve("same result"); assert.equal(await result, "same result"); }
      else { next.reject(new Error(outcome)); await assert.rejects(result, new RegExp(outcome)); }
      assert.equal(documentOpenings.openingPending(), false);
    }
    const old = deferred<undefined>(); documentOpenings.track(() => old.promise);
    assert.equal(documentOpenings.openingPending(), true);
    documentTransitions().startNew({ from: { document: script("Replacement") }, reason: "epoch loss" });
    assert.equal(documentOpenings.openingPending(), false);
    const current = deferred<undefined>(); documentOpenings.track(() => current.promise);
    old.resolve(undefined); await old.promise; assert.equal(documentOpenings.openingPending(), true);
    stop(); assert.equal(documentOpenings.openingPending(), false);
    stop = begin(); const newest = deferred<undefined>(); documentOpenings.track(() => newest.promise);
    current.resolve(undefined); await current.promise; assert.equal(documentOpenings.openingPending(), true);
    newest.resolve(undefined); await newest.promise; assert.equal(documentOpenings.openingPending(), false);
  } finally { stop(); }
  assert.equal(documentOpenings.openingPending(), false);
});

test("the transitions fake records each arrival and hands back the document it is given", () => {
  const next = script("Fake");
  const fake = fakeTransitions(() => next);
  assert.equal(fake.transitions.startNew({ from: { raw: {} }, reason: "a new script", destination: NO_DESTINATION }).document, next);
  assert.equal(fake.transitions.open({ from: { document: next }, reason: "opened" }).document, next);
  assert.deepEqual(fake.calls, [
    { kind: "startNew", reason: "a new script", destination: NO_DESTINATION },
    { kind: "open", reason: "opened", destination: undefined }
  ]);
});
