import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { JournalWorkerClient } from "../../src/service/journal-client.ts";
import { FixtureClient, readRecoveredRows, until, workspace } from "./harness.ts";

test("append after worker exit rejects before the next event-loop turn", { timeout: 8000 }, async () => {
  const work = await workspace();
  const journal = new JournalWorkerClient(work.path, { journalMode: "WAL", synchronous: "FULL" });
  try {
    await journal.ready;
    await journal.worker.terminate();
    const rejected = assert.rejects(journal.append("fixture", [Uint8Array.of(0, 0)]), /Journal worker exited/);
    const nextTurn = new Promise<boolean>(resolve => setImmediate(() => resolve(false)));
    assert.equal(await Promise.race([rejected.then(() => true), nextTurn]), true);
    await assert.rejects(journal.append("fixture", [Uint8Array.of(0, 0)]), /Journal worker exited/);
  } finally { await journal.worker.terminate(); await work.clean(); }
});

test("an update sent after worker exit receives a negative status without apply or fanout", async () => {
  const work = await workspace();
  const clients: FixtureClient[] = [];
  try {
    const server = await work.start();
    const alice = new FixtureClient(server.port);
    clients.push(alice);
    await alice.connect(); await alice.saved();
    const bob = new FixtureClient(server.port, new Y.Doc());
    clients.push(bob);
    await bob.connect(); await bob.saved();
    const before = readRecoveredRows(work.path);
    const changes = server.events.filter(event => event.event === "change").length;
    await server.command("terminate-worker", {}, "worker-exited");
    const index = alice.history.length;
    alice.edit("e");
    await until(() => alice.history[index]?.applied === false, "negative status after worker exit");
    assert.deepEqual(readRecoveredRows(work.path), before);
    assert.equal(bob.document.getText("R1").toString(), "abcd");
    assert.equal(server.events.filter(event => event.event === "change").length, changes);
    assert.equal(alice.receipts.status, "Saved on this device, sending");
    assert.equal(server.child.exitCode, null);
  } finally { for (const client of clients) client.destroy(); await work.clean(); }
});
