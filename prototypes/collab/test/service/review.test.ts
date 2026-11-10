import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import * as Y from "yjs";
import { syncFrame } from "../../src/service/wire.ts";
import { FixtureClient, checkHistory, readRecoveredRows, until, workspace } from "./harness.ts";

const coveredExpected = {
  snapshotBytes: 2200025, journalRows: 3, applied: true, status: "Your changes saved to server", checkerAccepts: true,
};

async function coveredSnapshot(delivery: "normal" | "ack-before-ipc"): Promise<void> {
  const work = await workspace();
  let client: FixtureClient | undefined;
  try {
    const server = await work.start();
    client = new FixtureClient(server.port);
    await client.connect(); await client.saved();
    client.edit("a".repeat(1100000)); await client.saved();
    client.edit("b".repeat(1100000)); await client.saved();
    const snapshot = Y.encodeStateAsUpdate(client.document);
    assert.equal(snapshot.length, coveredExpected.snapshotBytes);
    const before = readRecoveredRows(work.path);
    assert.equal(before.length, coveredExpected.journalRows);
    const release = delivery === "ack-before-ipc" ? server.holdEvent("refused") : null;
    const index = client.history.length;
    client.socket.send(syncFrame("fixture", 1, snapshot));
    await until(() => client?.history[index]?.applied !== null);
    assert.equal(client.history[index]?.applied, coveredExpected.applied);
    if (release) {
      assert.equal(server.events.some(event => event.event === "refused"), false);
      await writeFile(new URL("../../histories/review-ipc-order.json", import.meta.url), `${JSON.stringify({
        shows: "The WebSocket acknowledgement can be observed before the separate IPC refusal event; an immediate IPC assertion races.",
        replay: "node --test --test-name-pattern=ack-before-ipc test/service/review.test.ts",
        originalFailure: { head: "4795effc70d3c2745486d21315f51d455311cf59", ciJob: "https://github.com/RetroGorilla/splitpage/actions/runs/42730575166/job/129547319640" },
        observedBeforeIpcRelease: { applied: true, disposition: client.history[index]?.disposition, ipcRefusalVisible: false },
        required: "Await the IPC event independently; keep the refusal assertion and all literal outcomes unchanged.",
      }, null, 2)}\n`);
      setImmediate(release);
    }
    await until(() => server.events.some(event => event.event === "refused"), "IPC refusal event independent of WebSocket acknowledgement");
    assert.ok(server.events.some(event => event.event === "refused"));
    const statusAtReceipt = client.receipts.status;
    assert.equal(statusAtReceipt, coveredExpected.status);
    await server.kill();
    const rows = readRecoveredRows(work.path);
    assert.deepEqual(rows, before);
    let checkerError: string | null = null;
    try { checkHistory(client.history, rows, client.promises); }
    catch (error) { checkerError = error instanceof Error ? error.message.split(":")[0] ?? "Checker rejected" : "Checker rejected"; }
    if (checkerError) {
      const digest = (payload: string): string => createHash("sha256").update(Buffer.from(payload, "base64")).digest("hex");
      await writeFile(new URL("../../histories/review-covered-syncstep2.json", import.meta.url), `${JSON.stringify({
        shows: "The original checker rejects a truthful positive receipt for a refused oversized snapshot already covered by three journal rows.",
        replay: "node --test test/service/review.test.ts",
        fixture: { initial: "abcd", appended: [{ character: "a", count: 1100000 }, { character: "b", count: 1100000 }] },
        expected: coveredExpected, observed: { applied: client.history[index]?.applied, statusAtReceipt, statusAfterKill: client.receipts.status, checkerError },
        snapshotSha256: createHash("sha256").update(snapshot).digest("hex"),
        recovered: rows.map(row => ({ sequence: row.sequence, bytes: Buffer.from(row.payload, "base64").length, sha256: digest(row.payload) })),
      }, null, 2)}\n`);
    }
    assert.equal(checkerError, null, "a refused, fully covered snapshot must pass the independent checker");
    const acknowledged = client.history[index];
    assert.ok(acknowledged);
    assert.equal(acknowledged.disposition, "refused");
    assert.throws(() => checkHistory([{ ...acknowledged, disposition: "accepted" }], rows), /missing exact bytes/);
  } finally { client?.destroy(); await work.clean(); }
}
for (const delivery of ["normal", "ack-before-ipc"] as const) {
  test(`review: refused oversized SyncStep2 containing only committed content has a truthful positive receipt (${delivery})`, () => coveredSnapshot(delivery));
}

for (const change of ["insertion", "deletion"] as const) {
  test(`review: refused oversized SyncStep2 with an uncovered ${change} cannot receive a truthful positive receipt`, async () => {
    const work = await workspace();
    let client: FixtureClient | undefined;
    const candidate = new Y.Doc();
    const expected = { applied: false, journalRows: 3, status: "Saved on this device, sending" };
    try {
      const server = await work.start();
      client = new FixtureClient(server.port);
      await client.connect(); await client.saved();
      client.edit("a".repeat(1100000)); await client.saved();
      client.edit("b".repeat(1100000)); await client.saved();
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(client.document));
      candidate.clientID = 11;
      const vector = Y.encodeStateVector(candidate);
      if (change === "insertion") candidate.getText("R1").insert(candidate.getText("R1").length, "Z");
      else candidate.getText("R1").delete(1, 1);
      if (change === "deletion") assert.deepEqual(Y.encodeStateVector(candidate), vector);
      const snapshot = Y.encodeStateAsUpdate(candidate);
      const before = readRecoveredRows(work.path);
      const index = client.history.length;
      client.socket.send(syncFrame("fixture", 1, snapshot));
      await until(() => client?.history[index]?.applied !== null);
      const refused = client.history[index];
      assert.ok(refused);
      assert.equal(refused.disposition, "refused");
      assert.equal(refused.applied, expected.applied);
      assert.equal(client.receipts.status, expected.status);
      await server.kill();
      const rows = readRecoveredRows(work.path);
      assert.equal(rows.length, expected.journalRows);
      assert.deepEqual(rows, before);
      checkHistory(client.history, rows, client.promises);
      const falsePositive = { ...refused, applied: true };
      assert.throws(() => checkHistory([falsePositive], rows), /lacks insertion or deletion coverage/);
      const committedLater = [...rows, { sequence: 4, payload: Buffer.from(snapshot).toString("base64") }];
      assert.throws(() => checkHistory([falsePositive], committedLater), /lacks insertion or deletion coverage/);
    } finally { client?.destroy(); candidate.destroy(); await work.clean(); }
  });
}

test("review: socket maxPayload closes a covered oversized snapshot, then reconnect synchronizes a small difference", async () => {
  const work = await workspace();
  let client: FixtureClient | undefined;
  try {
    const server = await work.start({ MAX_PAYLOAD: "2097152" });
    client = new FixtureClient(server.port);
    await client.connect(); await client.saved();
    client.edit("a".repeat(1100000)); await client.saved();
    client.edit("b".repeat(1100000)); await client.saved();
    const before = readRecoveredRows(work.path);
    client.socket.configuration.delay = 50;
    client.socket.configuration.minDelay = 50;
    client.socket.send(syncFrame("fixture", 1, Y.encodeStateAsUpdate(client.document)));
    await until(() => client?.sockets.length === 2, "automatic reconnect");
    await client.saved();
    client.socket.disconnect();
    assert.deepEqual(client.closes.map(close => close.code), [1009]);
    const after = readRecoveredRows(work.path);
    assert.deepEqual(after.slice(0, 3), before);
    assert.equal(after.length, 4);
    checkHistory(client.history, after, client.promises);
    assert.equal(server.events.some(event => event.event === "before" && typeof event.payload === "string" && Buffer.from(event.payload, "base64").length > 2097152), false);
  } finally { client?.destroy(); await work.clean(); }
});

test("review: socket maxPayload repeatedly closes an uncovered oversized local update on automatic reconnect", async () => {
  const work = await workspace();
  let client: FixtureClient | undefined;
  const expected = { closeCodes: [1009, 1009, 1009], journalRows: 1, status: "Offline, saved on this device", positiveReceiptsForOversize: 0 };
  try {
    const server = await work.start({ MAX_PAYLOAD: "2097152" });
    client = new FixtureClient(server.port);
    await client.connect(); await client.saved();
    client.socket.configuration.delay = 50;
    client.socket.configuration.minDelay = 50;
    client.edit("Z".repeat(2200000));
    await until(() => (client?.closes.length ?? 0) >= 3, "three automatic socket-limit closes");
    client.socket.disconnect();
    assert.deepEqual(client.closes.map(close => close.code), expected.closeCodes);
    assert.equal(client.receipts.status, expected.status);
    assert.equal(client.history.filter(sent => sent.applied && Buffer.from(sent.bytes, "base64").length > 2097152).length, expected.positiveReceiptsForOversize);
    assert.equal(server.events.some(event => event.event === "before" && typeof event.payload === "string" && Buffer.from(event.payload, "base64").length > 2097152), false);
    const rows = readRecoveredRows(work.path);
    assert.equal(rows.length, expected.journalRows);
    checkHistory(client.history, rows, client.promises);
    await writeFile(new URL("../../histories/review-socket-limit-loop.json", import.meta.url), `${JSON.stringify({
      shows: "A socket maximum payload blocks oversized processing but repeatedly closes on the provider's automatic initial sync while the local update is not committed.",
      replay: "node --test test/service/review.test.ts", fixture: { initial: "abcd", appended: { character: "Z", count: 2200000 } },
      maxPayloadBytes: 2097152, reconnectDelayMs: 50, expected,
      observed: { closes: client.closes, connections: client.sockets.length, status: client.receipts.status, journalRows: rows.length },
    }, null, 2)}\n`);
  } finally { client?.destroy(); await work.clean(); }
});
