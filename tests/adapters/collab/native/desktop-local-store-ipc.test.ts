import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { desktopFixture } from "./desktop-local-store-fixture.ts";
import { eventResult } from "./indexeddb-fixture.ts";
import { STORED } from "./local-store-fixture.ts";

const locked = { kind: "failed", reason: "locked" };
const closed = { kind: "failed", reason: "closed" };
const bytes = new Uint8Array([0, 0]);

test("desktop main validates every argument before accepting a replica request", async t => {
  const { directory, main, first } = await desktopFixture(t);
  const id = "valid";
  const opened = await first.invoke(["open", id]);
  assert.equal(opened.kind, "opened");
  const { lease } = opened;
  for (const request of [
    null, { op: "open", name: id }, [], ["initialize", id], ["open"], ["open", id, null],
    ["delete", id, null], ["delete", false], ["open", ""], ["open", "a".repeat(65)],
    ["open", "name\n"], ["open", "../outside"], ["open", "a/../b"], ["open", "a/b/c"], ["open", "/name"],
    ["open", "a\\b"], ["open", "c:name"], ["open", "a\0b"], ["close", id, lease, false],
    ["close", id, lease.toUpperCase() + "!"], ["read", id, false, null], ["read", id, lease],
    ["read", id, lease, -1], ["read", id, lease, 1.5], ["read", id, lease, Infinity], ["read", id, lease, "1"],
    ["write", id, lease, 0, false, bytes], ["write", id, lease, 2 ** 53, false, bytes],
    ["write", id, lease, 1, 0, bytes], ["write", id, lease, 1, false, "bytes"],
    ["write", id, lease, 1, false, []], ["write", id, lease, 1, false, new Uint8Array()],
    ["write", id, lease, 1, false, bytes.buffer], ["write", id, lease, 1, false, new Uint8ClampedArray(2)],
    ["write", id, lease, 1, false, new Uint8Array(new SharedArrayBuffer(2))],
    ["write", id, lease, 1, false, new DataView(bytes.buffer)], ["write", id, lease, 1, false, new Uint16Array(2)],
    ["write", id, lease, 1, false, new Uint8Array(32_000_001).subarray(0, 1)], ["write", id, lease, 1, false, bytes, 0],
    ["write", id, lease, 1, false, bytes, new Uint8Array()],
    ["write", id, lease, 1, false, bytes, new Uint8Array(16_000_001).subarray(0, 1)],
    ["write", id, lease, 1, false, bytes, bytes, 0],
    ["read-journal", id, lease, null],
    ["write-journal", id, lease],
    ["write-journal", id, lease, "bytes"],
    ["write-journal", id, lease, new Uint8Array()],
    ["write-journal", id, lease, new Uint8Array(new SharedArrayBuffer(2))],
    ["write-journal", id, lease, new Uint8Array(16_000_001).subarray(0, 1)],
    ["write-journal", id, lease, bytes, 0]
  ]) {
    await assert.rejects(main.handle(first.sender, request), /Invalid native replica request/);
  }
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(await first.invoke(["read", id, lease, 0]), { kind: "read", entries: [] });
  assert.deepEqual(await first.invoke(["read-journal", id, lease]), { kind: "journal", bytes: null });
  const journalBytes = new Uint8Array([123, 125]);
  assert.deepEqual(await first.invoke(["write", id, lease, 1, false, bytes, journalBytes]), STORED);
  assert.deepEqual(await first.invoke(["read", id, lease, null]), {
    kind: "read", entries: [{ generation: 1, checkpoint: false, bytes }]
  });
  assert.deepEqual(await first.invoke(["read-journal", id, lease]), { kind: "journal", bytes: journalBytes });
  const updatedJournal = new Uint8Array([91, 93]);
  assert.deepEqual(await first.invoke(["write-journal", id, lease, updatedJournal]), STORED);
  assert.deepEqual(await first.invoke(["read-journal", id, lease]), { kind: "journal", bytes: updatedJournal });
  assert.deepEqual(await first.invoke(["write-journal", id, lease, new Uint8Array(16_000_001)]), { kind: "failed", reason: "quota" });
  const invalidGeneration = await first.invoke(["write", id, lease, 1, false, bytes]);
  assert.deepEqual(invalidGeneration, { kind: "failed", reason: "io" });
  assert.deepEqual(await first.invoke(["close", id, lease]), STORED);
});

test("leases belong to the claiming window and expire when a replacement opens", async t => {
  const { first, second } = await desktopFixture(t);
  const id = "lease";
  const opened = await first.invoke(["open", id]);
  assert.equal(opened.kind, "opened");
  const { lease } = opened;
  assert.deepEqual(await second.invoke(["open", id]), locked);
  assert.deepEqual(await second.invoke(["read", id, lease, null]), closed);
  assert.deepEqual(await second.invoke(["read-journal", id, lease]), closed);
  assert.deepEqual(await second.invoke(["write", id, lease, 1, false, bytes]), closed);
  assert.deepEqual(await second.invoke(["write-journal", id, lease, bytes]), closed);
  assert.deepEqual(await second.invoke(["close", id, lease]), closed);
  assert.deepEqual(await first.invoke(["close", id, lease]), STORED);
  const replacement = await first.invoke(["open", id]);
  assert.equal(replacement.kind, "opened");
  assert.deepEqual(await first.invoke(["read", id, lease, null]), closed);
  assert.deepEqual(await first.invoke(["read-journal", id, lease]), closed);
  assert.deepEqual(await first.invoke(["close", id, replacement.lease]), STORED);
});

for (const event of ["destroyed", "render-process-gone"] as const) {
  test(`desktop keeps a lost renderer's lease until its active disk operation settles (${event})`, { timeout: 5000 }, async t => {
    const { first, second, intercept } = await desktopFixture(t);
    const id = "gone";
    const opened = await first.invoke(["open", id]);
    assert.equal(opened.kind, "opened");
    const entered = eventResult<undefined>(), finish = eventResult<undefined>();
    intercept("append:sync", async perform => {
      entered.resolve(undefined);
      await finish.promise;
      await perform();
    });
    const writing = first.invoke(["write", id, opened.lease, 1, false, bytes]);
    first.sender.emit(event);
    try {
      await entered.promise;
      assert.deepEqual(await second.invoke(["open", id]), locked);
      assert.deepEqual(await first.invoke(["read", id, opened.lease, null]), closed);
    } finally { finish.resolve(undefined); }
    assert.deepEqual(await writing, STORED);
    await setImmediate();
    const next = await second.invoke(["open", id]);
    assert.equal(next.kind, "opened");
    assert.deepEqual(await second.invoke(["read", id, next.lease, null]), {
      kind: "read", entries: [{ generation: 1, checkpoint: false, bytes }]
    });
    assert.deepEqual(await second.invoke(["close", id, next.lease]), STORED);
  });
}
