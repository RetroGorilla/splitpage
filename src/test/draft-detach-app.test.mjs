import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const { adoptReplacement, currentDocument, noteSessionEdit } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { flushDraftNow } = await import("../bootstrap/wiring/recovery-owners.ts");
const { draftSource, draftsTesting } = await import("../bootstrap/wiring/drafts.ts");
const { useDesktopForTest, restoreDesktop } = await import("../adapters/desktop/desktop-port.ts");

test("through the real draft wiring, a detached writer writes and discards nothing and resumes with increasing sequence numbers", async () => {
  let floor = -Infinity;
  const sent = [], discards = [];
  useDesktopForTest({ writeDraft: async payload => {
    sent.push(payload.seq);
    if (payload.seq <= floor) return { ok: false, code: "STALE_SEQ" };
    floor = payload.seq;
    return { ok: true, seq: payload.seq };
  }, discardDraft: async seq => { discards.push(seq); return { ok: true }; }, setDocumentState: () => {}, draftRestoreDone: () => {} });
  try {
    adoptReplacement(migrateRows({ title: "Detach", rows: [{ id: "r1", audioText: "Hello", visualText: "" }] }));
    currentDocument().rows[0].audioText = "Source"; noteSessionEdit();
    assert.equal((await flushDraftNow()).ok, true);
    assert.equal(sent.length, 1);
    draftsTesting().noteChange();
    assert.equal(draftSource.detachSource(), true);
    assert.equal(draftsTesting().status().pending, false);
    currentDocument().rows[0].audioText = "While detached"; noteSessionEdit();
    assert.deepEqual(await flushDraftNow(), { ok: true });
    assert.deepEqual(sent.length, 1);
    assert.equal(draftSource.resumeWriting(), true);
    assert.equal(draftSource.resumeWriting(), false);
    currentDocument().rows[0].audioText = "After resume"; noteSessionEdit();
    const result = await flushDraftNow();
    assert.equal(result.ok, true, JSON.stringify({ result, sent }));
    assert.equal(sent.length, 2);
    assert.ok(sent[1] > sent[0]);
    assert.deepEqual(discards, []);
  } finally {
    draftSource.resumeWriting();
    restoreDesktop();
  }
});
