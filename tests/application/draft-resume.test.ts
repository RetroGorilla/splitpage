import { test } from "node:test";
import { draftResume as portDraftResume } from "../../src/bootstrap/wiring/ports/startup.ts";
import assert from "node:assert/strict";
import { createDraftResume } from "../../src/application/recovery/draft-resume.ts";
import "../../src/test/_dom.mjs";

import { draftResume, startRecovery } from "../../src/bootstrap/wiring/recovery-owners.ts";

test("a new draft resume holds nothing: no restore is pending", () => {
  const resume = createDraftResume();
  assert.equal(resume.restorePending(), false);
  assert.deepEqual(Object.keys(resume).sort(), ["restorePending", "setRestorePending"]);
  assert.ok(Object.isFrozen(resume));
});

test("shared draft resume follows recovery restarts without capturing the owner", () => {
  const resume = portDraftResume;
  const start = () => startRecovery({
    desktop: () => null, sessionStorage: () => null, localStorage: () => null,
    internImage: () => {}, merge: () => { throw new Error("Unexpected merge"); },
    drafts: { flush: () => Promise.resolve({ ok: true }), noteChange: () => {} }
  });
  assert.throws(() => resume.restorePending(), /The draft recovery is not started yet/);
  let stop = start();
  try {
    assert.equal(resume.restorePending(), false);
    draftResume().setRestorePending(true);
    assert.equal(resume.restorePending(), true);
    stop();
    stop = start();
    assert.equal(resume.restorePending(), false);
  } finally {
    stop();
  }
});

test("the restore-pending flag is set and cleared as a boolean", () => {
  const resume = createDraftResume();
  resume.setRestorePending(true);
  assert.equal(resume.restorePending(), true);
  resume.setRestorePending(false);
  assert.equal(resume.restorePending(), false);
  resume.setRestorePending(1 as unknown as boolean);
  assert.equal(resume.restorePending(), true);
  resume.setRestorePending(undefined as unknown as boolean);
  assert.equal(resume.restorePending(), false);
});

test("two draft resumes share nothing", () => {
  const a = createDraftResume();
  const b = createDraftResume();
  a.setRestorePending(true);
  assert.equal(b.restorePending(), false);
});
