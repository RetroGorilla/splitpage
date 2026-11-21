import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesktopNativeLocalStore } from "../../../../src/adapters/collab/native/desktop-local-store.ts";
import type { NativeLocalStoreReceipt } from "../../../../src/adapters/collab/native/local-store.ts";
import { desktopFixture } from "./desktop-local-store-fixture.ts";
import { eventResult } from "./indexeddb-fixture.ts";
import { localStoreContract } from "./local-store-contract.ts";
import { STORE_OPTIONS, stored } from "./local-store-fixture.ts";

localStoreContract("desktop", desktopFixture, 30000);

test("desktop compacts an idle tail at 512 and a busy tail before append 2049", { timeout: 60000 }, async t => {
  // why: the fault tests exercise fsync, and this test counts records across the two thresholds
  const { first, phases, intercept, restart } = await desktopFixture(t, false);
  let oversized = false;
  const store = createDesktopNativeLocalStore(request => {
    if (oversized && request[0] === "write" && request[4]) {
      return first.invoke(["write", request[1], request[2], request[3], true, new Uint8Array(32_000_001)]);
    }
    return first.invoke(request);
  });
  const opened = await store.open("compaction", STORE_OPTIONS);
  assert.equal(opened.kind, "opened");
  t.after(async () => { opened.session.close(); await opened.closed; });
  assert.equal(await opened.persistent, true);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const text = opened.session.ydoc.getText("written");
  for (let index = 0; index < 511; index++) text.insert(index, "a");
  assert.deepEqual(await opened.flush(), stored(511));
  t.mock.timers.tick(0);
  assert.equal(phases.includes("checkpoint.new:write"), false);
  text.insert(511, "a");
  assert.deepEqual(await opened.flush(), stored(512));
  const compacted = eventResult<undefined>();
  intercept("updates.new:rename", async perform => { await perform(); compacted.resolve(undefined); });
  t.mock.timers.tick(0);
  await compacted.promise;

  const failures: NativeLocalStoreReceipt[] = [];
  opened.subscribe(receipt => { if (receipt.kind === "failed") failures.push(receipt); });
  oversized = true;
  for (let index = 512; index < 2561; index++) text.insert(index, "b");
  const failure = await opened.flush();
  oversized = false;
  assert.equal(failure.kind, "failed");
  assert.equal(failure.reason, "quota");
  assert.equal(failure.operation, "compact");
  assert.equal(failure.generation, 2561);
  assert.equal(failure.committed, 2560);
  assert.deepEqual(failures, [failure]);

  let appendsAtCheckpoint = 0;
  intercept("checkpoint.new:rename", async perform => {
    await perform();
    appendsAtCheckpoint = phases.filter(phase => phase === "append:write").length;
  });
  assert.deepEqual(await opened.flush(), stored(2561));
  assert.equal(appendsAtCheckpoint, 2560);
  opened.session.close();
  await opened.closed;
  const recovered = await restart().store.open("compaction", STORE_OPTIONS);
  assert.equal(recovered.kind, "opened");
  try {
    assert.equal(recovered.generation, 2561);
    assert.equal(recovered.session.ydoc.getText("written").toString(), "a".repeat(512) + "b".repeat(2049));
  } finally { recovered.session.close(); await recovered.closed; }
});
