import assert from "node:assert/strict";
import test, { after } from "node:test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { encodeStateAsUpdate, encodeStateVector, decodeStateVector, applyUpdate, Doc } from "yjs";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { exportDocumentOf } from "../bootstrap/wiring/export-capture.ts";
import { openDocument } from "../bootstrap/wiring/transition-owners.ts";
import { buildSplitpageCopy } from "../adapters/formats/project-file.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { cells } from "../../tests/adapters/collab/native/helpers.ts";
import { appendText, serverHarness, storedState, TOKEN } from "../../tests/adapters/collab/native/server-harness.ts";

await bootApp();
after(closeApp);

test("an oversized offline merge preserves the refused script for export and a fresh shared session", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const base = kit.seed();
  const run = kit.launch();
  const port = await run.port();
  const options = { actor: "writer", sanitize: text => typeof text === "string" ? text : "" };
  const firstText = " first " + "a".repeat(8_000_000);
  const secondText = " second " + "b".repeat(8_000_000);
  const offline = suffix => {
    const copy = openNativeSession({ kind: "state", state: base }, options);
    t.after(copy.close);
    appendText(copy, suffix, 4);
    const state = copy.encodeState();
    assert.ok(state.byteLength < 15_000_000);
    return state;
  };
  const firstState = offline(firstText);
  const secondState = offline(secondText);
  const candidate = new Doc();
  t.after(() => candidate.destroy());
  applyUpdate(candidate, firstState);
  applyUpdate(candidate, secondState);
  assert.ok(encodeStateAsUpdate(candidate).byteLength > 15_000_000);
  const first = kit.copy(port, { kind: "state", state: firstState });
  const witness = kit.copy(port);
  await kit.until(() => first.pending() === 0 && first.relay.status().firstSyncDone && witness.text() === "word" + firstText || undefined);
  const prior = witness.session.encodeState();

  let provider;
  const attach = HocuspocusProvider.prototype.attach;
  t.mock.method(HocuspocusProvider.prototype, "attach", function () {
    provider = this;
    return attach.call(this);
  });
  const second = kit.copy(port, { kind: "state", state: secondState });
  const notice = await kit.until(() => second.events.find(event =>
    event.kind === "merge-too-large" || (event.kind === "status" && event.status.firstSyncDone && event.status.pendingChangeCount === 0)));
  assert.equal(notice.kind, "merge-too-large");
  assert.match(notice.message, /15 MB.*Export it as a fresh \.splitpage project/);
  assert.deepEqual(second.relay.status(), { connected: false, firstSyncDone: false, pendingChangeCount: 1 });
  assert.ok(second.events.every(event => event.kind !== "status" || !event.status.firstSyncDone));
  assert.equal(provider.configuration.websocketProvider.shouldConnect, false);
  assert.equal(second.session.ydoc.isDestroyed, false);
  assert.ok(second.text() === "word" + secondText);
  assert.deepEqual(second.session.encodeState(), secondState);
  assert.deepEqual(first.session.encodeState(), prior);
  assert.deepEqual(witness.session.encodeState(), prior);

  const bytes = buildSplitpageCopy(exportDocumentOf(second.session.document()));
  assert.equal(new RegExp(TOKEN + "| first ").test(bytes), false);
  assert.equal("docId" in JSON.parse(bytes), false);
  await openDocument({ kind: "file", file: new File([bytes], "local-copy.splitpage"), handle: null });
  const reopened = currentDocument();
  assert.ok(reopened.rows[0].audioText === "word" + secondText);
  assert.notEqual(reopened.docId, second.session.document().docId);
  const fresh = kit.copy(port, {
    kind: "document", document: reopened,
    conversion: { cells, creation: reopened.docId, at: "2026-11-19T00:00:00Z", by: "writer" }
  }, reopened.docId);
  await kit.until(() => fresh.relay.status().firstSyncDone && fresh.pending() === 0 || undefined);
  const newPeer = kit.copy(port, undefined, reopened.docId);
  await kit.until(() => newPeer.relay.status().firstSyncDone || undefined);
  assert.ok(newPeer.text() === "word" + secondText);
  assert.deepEqual(fresh.session.commands.undo(), { kind: "unchanged" });
  const oldClients = decodeStateVector(encodeStateVector(second.session.ydoc));
  for (const client of decodeStateVector(encodeStateVector(newPeer.session.ydoc)).keys()) {
    assert.equal(oldClients.has(client), false);
  }
  assert.equal(second.events.filter(event => event.kind === "merge-too-large").length, 1);
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  assert.deepEqual(storedState(kit.directory), prior);
  assert.doesNotMatch(run.errors() + run.output(), new RegExp(TOKEN + "|word (first|second)"));
});
