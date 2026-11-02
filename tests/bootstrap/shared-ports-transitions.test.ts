import "../../src/test/_dom.mjs";
import { opening, transitions as portTransitions } from "../../src/bootstrap/wiring/ports/transitions.ts";
import "../../src/test/_location-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { NO_DESTINATION } from "../../src/application/transitions/ports.ts";

import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { currentDocument, liveDocumentPort } from "../../src/bootstrap/wiring/session-owner.ts";
import { documentSources, startTransitions } from "../../src/bootstrap/wiring/transition-owners.ts";
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
