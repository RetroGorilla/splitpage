import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DB_NAME } from "../../../../collab-server/storage.ts";
import { appendText, serverHarness, storedText } from "./server-harness.ts";

for (const how of ["clean", "kill"] as const) {
  for (const point of ["before", "during", "after"] as const) {
    for (const survivors of [true, false]) {
      test(`${how} stop ${point} store with ${survivors ? "returning copies" : "all copies gone"}`, { timeout: 30_000 }, async t => {
        const kit = serverHarness(t);
        kit.seed();
        const first = kit.launch(point === "before" ? {
          SPLITPAGE_STORE_DEBOUNCE_MS: "60000", SPLITPAGE_STORE_MAX_DEBOUNCE_MS: "60000"
        } : {});
        const port = await first.port();
        const writer = kit.copy(port);
        const peer = kit.copy(port);
        await kit.until(() => [writer, peer].every(copy =>
          copy.relay.status().firstSyncDone && copy.pending() === 0 && copy.text() === "word") || undefined);

        if (point === "during") {
          first.send("hold");
          await kit.until(() => first.messages.includes("armed") || undefined);
        }
        const pendingBefore = writer.pending();
        const from = writer.events.length;
        appendText(writer.session, " returned", 4);
        await kit.until(() => (writer.pending() === 0 && peer.text() === "word returned") || undefined);
        const pendingAfterApply = writer.pending();
        const wentPending = writer.events.slice(from).some(event => event.kind === "status" && event.status.pendingChangeCount === 1);
        assert.equal(wentPending, true);

        if (point === "before") assert.equal(first.messages.includes("store-started"), false);
        if (point === "during") await kit.until(() => first.messages.includes("store-started") || undefined);
        if (point === "after") await kit.until(() => first.messages.includes("stored") || undefined);
        assert.equal(storedText(kit.directory), point === "after" ? "word returned" : "word");
        const pendingAtStop = writer.pending();

        if (how === "clean" && point === "during") {
          first.requestStop();
          await kit.until(() => first.messages.includes("stopping") || undefined);
          first.send("release");
        } else if (how === "clean") {
          first.requestStop();
        }
        const exited = how === "clean" ? await first.exit : await first.stop("kill");
        assert.deepEqual(exited, how === "clean" ? { code: 0, exitSignal: null } : { code: null, exitSignal: "SIGKILL" });
        await kit.until(() => (!writer.relay.status().connected && !peer.relay.status().connected) || undefined);
        const pendingOffline = writer.pending();
        if (!survivors) {
          writer.close();
          peer.close();
        }
        const reconnectFrom = writer.events.length;
        const expectedOnDisk = how === "clean" || point === "after" ? "word returned" : "word";
        assert.equal(storedText(kit.directory), expectedOnDisk);
        const restarted = kit.launch({ SPLITPAGE_PORT: String(port) });
        assert.equal(await restarted.port(), port);
        const fresh = kit.copy(port);
        const expectedFinal = survivors ? "word returned" : expectedOnDisk;
        await kit.until(() => (fresh.relay.status().firstSyncDone && fresh.text() === expectedFinal) || undefined);
        let pendingReturned: number | null = null;
        if (survivors) {
          await kit.until(() => [writer, peer].every(copy =>
            copy.relay.status().connected && copy.pending() === 0 && copy.text() === expectedFinal) || undefined);
          pendingReturned = writer.pending();
          assert.equal(writer.events.slice(reconnectFrom).some(event =>
            event.kind === "status" && event.status.pendingChangeCount === 1), true);
          if (expectedOnDisk !== expectedFinal) {
            await kit.until(() => restarted.messages.includes("stored") || undefined);
            assert.equal(storedText(kit.directory), expectedFinal);
          }
        }
        assert.deepEqual([pendingBefore, pendingAfterApply, pendingAtStop, pendingOffline, pendingReturned],
          [0, 0, 0, 0, survivors ? 0 : null]);
        t.diagnostic(`disk at restart: ${expectedOnDisk}; fresh copy: ${expectedFinal}; pending: 0 → 1 → 0 → 0 → 0 → ${survivors ? "1 → 0" : "closed"}`);
      });
    }
  }
}

test("one relay owns a data folder until it exits, and a crash releases the lock", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const first = kit.launch();
  const port = await first.port();
  const writer = kit.copy(port);
  await kit.until(() => writer.text() === "word" || undefined);
  const second = kit.launch();
  const refused = await Promise.race([second.exit, second.port().catch(() => undefined)]);
  assert.deepEqual(refused, { code: 1, exitSignal: null });
  assert.match(second.errors(), /Another relay already owns this data directory/);
  const peer = kit.copy(port);
  await kit.until(() => peer.text() === "word" || undefined);
  appendText(writer.session, " kept", 4);
  await kit.until(() => first.messages.includes("stored") && peer.text() === "word kept" || undefined);
  assert.equal(storedText(kit.directory), "word kept");
  assert.deepEqual(await first.stop("kill"), { code: null, exitSignal: "SIGKILL" });
  writer.close();
  peer.close();
  const fresh = kit.copy(await kit.launch().port());
  await kit.until(() => fresh.relay.status().firstSyncDone || undefined);
  assert.equal(fresh.text(), "word kept");
});

test("a refused final SQLite write exits non-zero with one message and preserves the previous snapshot", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch({ SPLITPAGE_STORE_DEBOUNCE_MS: "60000", SPLITPAGE_STORE_MAX_DEBOUNCE_MS: "60000" });
  const writer = kit.copy(await run.port());
  await kit.until(() => writer.text() === "word" || undefined);
  appendText(writer.session, " pending", 4);
  await kit.until(() => writer.pending() === 0 || undefined);
  assert.equal(run.messages.includes("store-started"), false);
  {
    using other = new DatabaseSync(join(kit.directory, DB_NAME));
    other.exec("CREATE TRIGGER refuse_write BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'private-test-value'); END");
  }
  assert.deepEqual(await run.stop("clean"), { code: 1, exitSignal: null });
  assert.equal(run.errors().trim(), "Relay shutdown failed. The last edits were not stored.");
  assert.equal(run.messages.includes("stored"), false);
  assert.equal(storedText(kit.directory), "word");
});

test("a shutdown that cannot finish a held store exits at its deadline", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch();
  const writer = kit.copy(await run.port());
  await kit.until(() => writer.text() === "word" || undefined);
  run.send("hold");
  await kit.until(() => run.messages.includes("armed") || undefined);
  appendText(writer.session, " held", 4);
  await kit.until(() => run.messages.includes("store-started") || undefined);
  run.requestStop();
  assert.deepEqual(await run.exit, { code: 1, exitSignal: null });
  assert.equal(run.errors().trim(), "Relay shutdown timed out. Some edits may not have been stored.");
  assert.equal(storedText(kit.directory), "word");
});
