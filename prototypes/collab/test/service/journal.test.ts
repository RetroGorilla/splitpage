import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import * as Y from "yjs";
import { UpdateJournal } from "../../src/service/journal.ts";
import { ConnectionReceipts } from "../../src/service/receipts.ts";
import { syncFrame } from "../../src/service/wire.ts";
import { FixtureClient, JournalChild, characterIdentities, checkHistory, fixture, journalRows, readRecoveredRows, until, workspace } from "./harness.ts";
import type { HarnessSavedPromise } from "./harness.ts";
import { observeHooks } from "./observations.ts";

const expected = {
  T22: { text: "abcde", identities: ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "e:11:0"], status: "Your changes saved to server" },
  T23: {
    text: "abcdefgh", identities: ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "e:11:0", "f:11:1", "g:11:2", "h:11:3"],
    offline: "Offline, saved on this device", pending: "Saved on this device, sending", saved: "Your changes saved to server",
  },
  pureDelete: { text: "acde", identities: ["a:7:0", "c:7:2", "d:7:3", "e:11:0"], sequenceAdvance: 1 },
};

function nextUpdate(client: FixtureClient, character: string): Uint8Array {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(client.document));
    copy.clientID = client.document.clientID;
    const vector = Y.encodeStateVector(copy);
    copy.getText("R1").insert(copy.getText("R1").length, character);
    return Y.encodeStateAsUpdate(copy, vector);
  } finally { copy.destroy(); }
}

async function recover(server: JournalChild, path: string, history: FixtureClient["history"], promises: readonly HarnessSavedPromise[], identities: readonly string[]): Promise<void> {
  const late = new FixtureClient(server.port, new Y.Doc());
  try {
    await late.connect();
    await late.saved();
    const inspection = await server.command("inspect", {}, "inspection");
    assert.deepEqual(journalRows(inspection), readRecoveredRows(path));
    checkHistory(history, readRecoveredRows(path), promises);
    assert.deepEqual(characterIdentities(late.document), identities);
  } finally { late.destroy(); }
}

test("journal feasibility: the independent checker rejects the defect before endorsing traces", { timeout: 90000 }, async t => {
  await t.test("Premature receipt: acknowledged u1 is absent after hard kill (checker must fail)", async () => {
    const work = await workspace();
    let client: FixtureClient | undefined;
    try {
      const server = await work.start();
      client = new FixtureClient(server.port);
      await client.connect();
      await client.saved();
      await server.command("configure", { hold: Buffer.from(nextUpdate(client, "e")).toString("base64"), premature: true });
      client.edit("e");
      await until(() => server.events.some(e => e.event === "held"));
      await client.saved();
      await server.kill();
      const restarted = await work.start();
      const inspection = await restarted.command("inspect", {}, "inspection");
      const rows = readRecoveredRows(work.path);
      assert.deepEqual(journalRows(inspection), rows);
      const history = client.history;
      assert.throws(() => checkHistory(history, rows), /Acknowledged update missing/);
      await writeFile(new URL("../../histories/T22-premature-receipt.json", import.meta.url), `${JSON.stringify({
        shows: "Premature receipt falsely reports u1 durable; a hard kill before commit loses it.",
        trace: "T22", expected: expected.T22, sent: client.history, told: client.promises, recovered: rows,
      }, null, 2)}\n`);
    } finally { client?.destroy(); await work.clean(); }
  });

  await t.test("T22: receipt survives hard kill before debounced store, with duplicate raw delivery", async () => {
    const work = await workspace();
    let client: FixtureClient | undefined;
    try {
      const server = await work.start();
      client = new FixtureClient(server.port);
      await client.connect();
      await client.saved();
      const update = client.edit("e");
      await client.saved();
      client.socket.send(syncFrame("fixture", 2, update));
      await client.saved();
      assert.equal(client.provider.unsyncedChanges, 0);
      assert.equal(client.receipts.status, expected.T22.status);
      assert.equal(server.events.filter(e => e.event === "store-start").length, 0);
      await server.kill();
      await recover(await work.start(), work.path, client.history, client.promises, expected.T22.identities);
    } finally { client?.destroy(); await work.clean(); }
  });

  for (const mode of ["ordinary-close", "disconnect-connecting", "replace-connecting", "checker-early-close", "disconnect-null-control"] as const) {
    await t.test(`T23: ${mode}: FIFO receipts cover queued, unacknowledged and never-sent work`, async () => {
      const work = await workspace();
      let client: FixtureClient | undefined;
      try {
        const server = await work.start();
        client = new FixtureClient(server.port);
        await client.connect();
        await client.saved();
        client.edit("e");
        await client.saved();
        await server.command("configure", { hold: Buffer.from(nextUpdate(client, "f")).toString("base64") });
        client.edit("f");
        await until(() => server.events.some(e => e.event === "held"));
        if (mode === "checker-early-close") {
          client.socket.shouldConnect = false;
          client.socket.webSocket?.close();
          client.edit("g");
          client.socket.lastMessageReceived = 1;
          client.socket.checkConnection();
        }
        await client.drop();
        assert.equal(client.receipts.status, expected.T23.offline);
        if (mode === "disconnect-connecting" || mode === "replace-connecting") {
          void client.socket.createWebSocketConnection().catch(() => undefined);
          assert.equal(client.socket.webSocket?.readyState, 0);
          client.edit("g");
          if (mode === "disconnect-connecting") client.socket.disconnect();
          else {
            void client.socket.createWebSocketConnection().catch(() => undefined);
            client.socket.disconnect();
          }
          await until(() => client?.socket.webSocket === null, "cancel connecting socket");
        } else if (mode !== "checker-early-close") {
          client.edit("g");
          if (mode === "disconnect-null-control") client.socket.disconnect();
        }
        await server.command("configure", { hookDelay: 400 });
        if (mode === "ordinary-close" || mode === "disconnect-null-control") {
          const current = client;
          client.onOpen = () => current.edit("h");
        }
        const start = client.history.length;
        await client.connect();
        assert.equal(client.receipts.status, expected.T23.pending);
        await client.saved();
        assert.equal(client.syncStartCounts.at(-1), 1);
        const reconnectLifetime = client.history[start]?.lifetime;
        const initialReply = client.frames.find(frame => frame.direction === "out" && frame.kind === 0 && frame.subtype === 1 && frame.lifetime === reconnectLifetime);
        assert.ok(initialReply, "H11: provider sends its own SyncStep2 without an application filter");
        const structs = Y.decodeUpdate(Buffer.from(initialReply.payload, "base64")).structs;
        for (const clock of [1, 2]) {
          assert.ok(structs.some(struct => struct.id.client === 11 && struct.id.clock <= clock && struct.id.clock + struct.length > clock), "H11: initial SyncStep2 carries u2 and u3");
        }
        if (mode === "disconnect-connecting" || mode === "replace-connecting" || mode === "checker-early-close") {
          assert.equal(client.history.slice(start).length, 1);
          client.edit("h");
          assert.equal(client.receipts.status, expected.T23.pending);
          await client.saved();
        } else {
          assert.equal(client.history.slice(start).length, 3);
          assert.ok(client.observations.some(o => o.count === 0 && o.outstanding > 0 && o.status === expected.T23.pending));
        }
        assert.equal(client.document.getText("R1").toString(), expected.T23.text);
        assert.equal(client.receipts.status, expected.T23.saved);
        await server.kill();
        await recover(await work.start(), work.path, client.history, client.promises, expected.T23.identities);
      } finally { client?.destroy(); await work.clean(); }
    });
  }

  await t.test("pure delete from T14 / Y14: state vector unchanged, journal sequence and receipt advance", async () => {
    const work = await workspace();
    let client: FixtureClient | undefined;
    try {
      const server = await work.start();
      client = new FixtureClient(server.port);
      await client.connect();
      await client.saved();
      client.edit("e");
      await client.saved();
      const before = journalRows(await server.command("inspect", {}, "inspection"));
      const vector = Y.encodeStateVector(client.document);
      client.document.getText("R1").delete(1, 1);
      assert.deepEqual(Y.encodeStateVector(client.document), vector);
      assert.equal(client.receipts.status, expected.T23.pending);
      await client.saved();
      const after = journalRows(await server.command("inspect", {}, "inspection"));
      assert.equal(after.length - before.length, expected.pureDelete.sequenceAdvance);
      await server.kill();
      await recover(await work.start(), work.path, client.history, client.promises, expected.pureDelete.identities);
    } finally { client?.destroy(); await work.clean(); }
  });
  await observeHooks(t);
});

test("receipt coverage excludes never-sent work and ignores receipts from a closed lifetime", () => {
  const doc = fixture();
  const tracker = new ConnectionReceipts();
  const ack = Uint8Array.from([7, ...new TextEncoder().encode("fixture"), 8, 1]);
  try {
    const first = tracker.open();
    tracker.sent(first, syncFrame("fixture", 1, Y.encodeStateAsUpdate(doc)));
    tracker.received(first, ack);
    assert.equal(tracker.status, expected.T23.saved);
    let vector = Y.encodeStateVector(doc);
    doc.getText("R1").insert(4, "e");
    const u1 = Y.encodeStateAsUpdate(doc, vector);
    tracker.localUpdate(u1);
    assert.equal(tracker.status, expected.T23.pending);
    tracker.sent(first, syncFrame("fixture", 2, u1));
    tracker.close(first);
    const second = tracker.open();
    tracker.received(second, Uint8Array.of(9));
    tracker.received(first, ack);
    assert.equal(tracker.status, expected.T23.pending);
    tracker.sent(second, syncFrame("fixture", 1, Y.encodeStateAsUpdate(doc)));
    vector = Y.encodeStateVector(doc);
    doc.getText("R1").insert(5, "f");
    const unsent = Y.encodeStateAsUpdate(doc, vector);
    tracker.localUpdate(unsent);
    tracker.received(second, ack);
    assert.equal(tracker.outstanding, 0);
    assert.equal(tracker.status, expected.T23.pending);
    tracker.sent(second, syncFrame("fixture", 2, unsent));
    tracker.received(second, ack);
    assert.equal(tracker.status, expected.T23.saved);
    const pretend = [{ status: expected.T23.saved, local: [Buffer.from(unsent).toString("base64")], acknowledged: [] }];
    assert.throws(() => checkHistory([], [], pretend), /does not cover a local edit/);
  } finally { doc.destroy(); }
});

test("writer refuses startup unless read-back is WAL and FULL, before creating journal schema", async () => {
  const work = await workspace();
  try {
    assert.throws(() => new UpdateJournal(":memory:"), /Durability mismatch/);
    for (const settings of [{ journalMode: "DELETE", synchronous: "FULL" }, { journalMode: "WAL", synchronous: "NORMAL" }]) {
      assert.throws(() => new UpdateJournal(work.path, settings), /Durability mismatch/);
    }
    const child = new JournalChild(work.path, { JOURNAL_SYNC: "OFF" });
    try {
      await until(() => child.child.exitCode !== null);
      assert.match(child.stderr, /Durability mismatch/);
      assert.equal(child.events.some(e => e.event === "ready"), false);
    } finally { await child.kill(); }
    assert.throws(() => readRecoveredRows(work.path), /no such table: updates/);
  } finally { await work.clean(); }
});

test("failed transaction leaves no partial journal batch", async () => {
  const work = await workspace();
  const journal = new UpdateJournal(work.path);
  const doc = fixture();
  try {
    journal.database.exec("CREATE TRIGGER fail_second BEFORE INSERT ON updates WHEN NEW.payload = X'00' BEGIN SELECT RAISE(ABORT, 'injected disk write failure'); END");
    assert.throws(() => journal.append("fixture", [Y.encodeStateAsUpdate(doc), Uint8Array.of(0)]), /injected disk write failure/);
    assert.deepEqual(journal.read("fixture"), []);
  } finally { journal.close(); doc.destroy(); await work.clean(); }
});
