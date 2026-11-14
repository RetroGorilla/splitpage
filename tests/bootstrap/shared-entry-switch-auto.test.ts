import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootEntrySwitchFixture, stopEntrySwitchFixture, entrySwitchFixture } from "./shared-entry-switch-support.ts";
import { enterSharedSession, leaveRunningSharedSession } from "../../src/bootstrap/wiring/shared-session.ts";
import { onDocumentReplaced, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { localFilesOwnerPorts } from "../../src/bootstrap/wiring/ports/local-files.ts";
import { localFileMenuControls } from "../../src/bootstrap/wiring/local-files.ts";
import { createLocalFilesOwner } from "../../src/application/transitions/local-files.ts";

before(bootEntrySwitchFixture);
after(stopEntrySwitchFixture);

for (const phase of ["enter", "leave"] as const) {
  test("C8 " + phase + " keeps automatic resume from looking up a handle in a standalone switch callback", async () => {
    const f = entrySwitchFixture(), base = localFilesOwnerPorts(localFileMenuControls), owner = createLocalFilesOwner();
    let reads = 0, once = true;
    const jobs: Promise<void>[] = [];
    const stopOwner = owner.startLocalFiles({ ...base, lastFile: { ...base.lastFile, load: async () => { reads++; return null; } } });
    const attempt = () => { if (once) { once = false; jobs.push(owner.tryResumeLastProject()); } };
    const stop = onDocumentReplaced(() => { if (phase === "leave" && !sharedSession()) attempt(); });
    try {
      assert.deepEqual(await enterSharedSession({ ...f.ports, docId: () => { if (phase === "enter") attempt(); return f.ports.docId(); } }), { ok: true });
      if (phase === "leave") assert.deepEqual(leaveRunningSharedSession(), { ok: true });
      await Promise.all(jobs);
      assert.equal(jobs.length, 1); assert.equal(reads, 0); assert.deepEqual(f.errors, []);
    } finally { stop(); stopOwner(); f.close(); }
  });
}
