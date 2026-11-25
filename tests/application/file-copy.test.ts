import assert from "node:assert/strict";
import { test } from "node:test";
import type { SharedFileInfo, SharedFileResult } from "../../shared/shared-file-copy.d.ts";
import { createFileCopy } from "../../src/application/collaboration/file-copy.ts";
import type { FileCopyMode } from "../../src/application/collaboration/file-copy.ts";

const file = { name: "Pilot.splitpage", docId: "d" + "a".repeat(32), missing: 0 };

function setup(freshRevision?: number) {
  let now = 0;
  let pending: { run: () => void; at: number } | undefined;
  let missing = 0, captures = 0, forgot = 0;
  let fail: SharedFileResult | undefined;
  let afterWrite: (() => void) | undefined;
  const writes: number[] = [];
  const modes: FileCopyMode[] = [];
  let info: SharedFileInfo | null = null, problem: string | null = null;
  const owner = createFileCopy(file, {
    now: () => now,
    startTimer(run, ms) {
      const timer = { run, at: now + ms };
      pending = timer;
      return () => { if (pending === timer) pending = undefined; };
    },
    async capture() { captures++; return { bytes: Uint8Array.of(1), missing, docId: file.docId }; },
    async write(_bytes, missing, mode) {
      writes.push(now);
      modes.push(mode);
      afterWrite?.();
      return fail ?? { kind: "file-copy-written", file: { ...file, missing }, id: "file" };
    },
    async forget() { forgot++; return true; },
    publish(file, next) { info = file; problem = next; }
  }, freshRevision);
  return {
    owner, writes, modes,
    setMissing(value: number) { missing = value; },
    setFailure(value: SharedFileResult | undefined) { fail = value; },
    afterWrite(run: () => void) { afterWrite = run; },
    async advance(at: number) {
      now = at;
      if (pending && pending.at <= now) {
        const { run } = pending;
        pending = undefined;
        run();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    },
    facts: () => ({ info, problem, captures, forgot }),
    due: () => pending?.at
  };
}

test("shared publications defer the copy until idle and limit the frequency of background writing", async () => {
  const h = setup();
  h.owner.changed(1);
  await h.advance(1500);
  h.owner.changed(2);
  assert.equal(h.facts().captures, 0);
  await h.advance(3499);
  assert.deepEqual(h.writes, []);
  await h.advance(3500);
  await h.advance(4000);
  h.owner.changed(3);
  assert.equal(h.due(), 33_500);
  await h.advance(33_499);
  assert.deepEqual(h.writes, [3500]);
  await h.advance(33_500);
  assert.deepEqual(h.writes, [3500, 33_500]);
  assert.equal(h.due(), undefined);
});

test("a close flush bypasses the interval, and late picture bytes rewrite the same shared revision", async () => {
  const h = setup();
  h.setMissing(2);
  h.owner.changed(1);
  await h.advance(2000);
  assert.equal(h.facts().info?.missing, 2);
  h.setMissing(0);
  h.owner.picturesChanged();
  assert.equal(h.due(), 32_000);
  await h.advance(2300);
  assert.equal((await h.owner.flush(true) as { kind?: string }).kind, "file-copy-written");
  assert.equal(h.facts().info?.missing, 0);
  assert.deepEqual(h.writes, [2000, 2300]);
  h.owner.picturesChanged();
  assert.equal(h.due(), undefined);
  h.setMissing(1);
  h.owner.changed(2);
  await h.advance(32_300);
  h.setMissing(0);
  h.owner.picturesChanged();
  await h.advance(62_300);
  assert.deepEqual(h.writes, [2000, 2300, 32_300, 62_300]);
});

test("fresh sharing leaves the file alone until a publication changes its revision", async () => {
  const h = setup(1);
  h.owner.changed(1);
  h.owner.picturesChanged();
  await h.advance(4000);
  assert.equal(h.owner.pending(), false);
  assert.deepEqual(h.writes, []);
  h.owner.changed(2);
  assert.equal(h.owner.pending(), true);
  await h.advance(6000);
  assert.deepEqual(h.writes, [6000]);
});

test("missing pictures block complete writes, and disk changes halt background writes until a choice", async () => {
  const h = setup();
  h.setMissing(1);
  assert.equal(await h.owner.flush(true), "missing");
  assert.deepEqual(h.writes, []);
  assert.equal(h.facts().forgot, 0);
  h.setMissing(0);
  h.setFailure({ kind: "file-copy-problem", problem: "changed" });
  assert.equal(await h.owner.flush(true), "changed");
  h.owner.changed(2);
  assert.equal(h.due(), undefined);
  assert.equal(h.facts().problem, "changed");
  assert.equal(h.facts().forgot, 0);
  assert.equal(await h.owner.stop(), true);
  assert.equal(h.facts().forgot, 1);
  assert.equal(h.facts().info, null);
});

test("departure checks again if a peer publishes while the file is being written", async () => {
  const h = setup();
  h.owner.changed(1);
  h.afterWrite(() => { h.owner.changed(2); });
  const result = await h.owner.beforeDeparture(async () => assert.fail("A newer revision can be written directly"));
  assert.equal(result && result.kind, "file-copy-written");
  assert.deepEqual(h.modes, ["check", "check"]);
});

for (const failure of ["changed", "unavailable", "missing"] as const) {
  for (const choice of ["retry", "new", "continue", "cancel"] as const) {
    test(`a ${failure} file copy preserves the replica until the person chooses ${choice}`, async () => {
      const h = setup();
      if (failure === "missing") h.setMissing(1);
      else h.setFailure({ kind: "file-copy-problem", problem: failure });
      const result = await h.owner.beforeDeparture(async problem => {
        assert.equal(problem, failure);
        assert.equal(h.facts().forgot, 0);
        assert.equal(h.facts().info?.name, file.name);
        h.setFailure(undefined);
        h.setMissing(0);
        return choice;
      });
      assert.equal(h.facts().forgot, 0);
      if (choice === "cancel") assert.equal(result, false);
      else if (choice === "continue") assert.equal(result, null);
      else {
        assert.equal(result && result.kind, "file-copy-written");
        assert.equal(h.modes.at(-1), choice === "new" ? "new" : "check");
      }
    });
  }
}
