import assert from "node:assert/strict";
import test from "node:test";
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
