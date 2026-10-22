import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraftResume } from "../../src/application/recovery/draft-resume.ts";
import type { ServerResume } from "../../src/application/recovery/draft-resume.ts";

function serverResume(id: string, heard: string[]): ServerResume {
  return { id: id, rev: 2, base: null, mine: { rows: [] }, at: 5, onDone: function (outcome: string): void { heard.push(id + ":" + outcome); } };
}

test("a new draft resume holds nothing: no server resume waits and no restore is pending", () => {
  const resume = createDraftResume();
  assert.equal(resume.serverResume(), null);
  assert.equal(resume.restorePending(), false);
  assert.ok(Object.isFrozen(resume));
});

test("an armed server resume is handed back as it was armed until it is dropped", () => {
  const heard: string[] = [];
  const resume = createDraftResume();
  const armed = serverResume("doc-a", heard);
  resume.armServerResume(armed);
  assert.equal(resume.serverResume(), armed);
  resume.serverResume()?.onDone("server-resumed");
  assert.deepEqual(heard, ["doc-a:server-resumed"]);
  const later = serverResume("doc-b", heard);
  resume.armServerResume(later);
  assert.equal(resume.serverResume(), later, "arming again replaces the one waiting");
  resume.dropServerResume();
  assert.equal(resume.serverResume(), null);
  resume.dropServerResume();
  assert.equal(resume.serverResume(), null, "dropping when nothing waits is harmless");
  assert.deepEqual(heard, ["doc-a:server-resumed"], "dropping does not settle the resume");
});

test("a server resume without its onDone function is refused and the one waiting stays", () => {
  const heard: string[] = [];
  const resume = createDraftResume();
  const armed = serverResume("doc-a", heard);
  resume.armServerResume(armed);
  const broken = { id: "doc-b", rev: 0, base: null, mine: null, at: 0 } as unknown as ServerResume;
  assert.throws(() => resume.armServerResume(broken), /needs its onDone function/);
  assert.throws(() => resume.armServerResume(null as unknown as ServerResume), /needs its onDone function/);
  assert.equal(resume.serverResume(), armed);
});

test("the restore-pending flag is set and cleared as a boolean, apart from the server resume", () => {
  const heard: string[] = [];
  const resume = createDraftResume();
  resume.setRestorePending(true);
  assert.equal(resume.restorePending(), true);
  resume.armServerResume(serverResume("doc-a", heard));
  resume.setRestorePending(false);
  assert.equal(resume.restorePending(), false);
  assert.notEqual(resume.serverResume(), null, "clearing the flag keeps the server resume");
  resume.setRestorePending(1 as unknown as boolean);
  assert.equal(resume.restorePending(), true);
  resume.setRestorePending(undefined as unknown as boolean);
  assert.equal(resume.restorePending(), false);
});

test("two draft resumes share nothing", () => {
  const a = createDraftResume();
  const b = createDraftResume();
  a.setRestorePending(true);
  a.armServerResume(serverResume("doc-a", []));
  assert.equal(b.restorePending(), false);
  assert.equal(b.serverResume(), null);
});
