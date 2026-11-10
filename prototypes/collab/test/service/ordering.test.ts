import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import WebSocket from "ws";
import * as Y from "yjs";
import { readFrame, syncFrame } from "../../src/service/wire.ts";
import { FixtureClient, characterIdentities, checkHistory, fixture, readRecoveredRows, until, workspace } from "./harness.ts";

function checkLockedRoundTrip(prefix: readonly boolean[]): void {
  assert.deepEqual(prefix, [], "Acknowledgement crossed the harness write-lock gate before a commit was possible");
}

for (const mode of ["premature", "ack-wait-commit", "journal", "after-unlock-ack"] as const) {
  test(`harness-owned write lock and same-socket ping: ${mode}`, async () => {
    const work = await workspace();
    const doc = fixture();
    let socket: WebSocket | undefined;
    let lock: DatabaseSync | undefined;
    let locked = false;
    const handlingTimers: ReturnType<typeof setTimeout>[] = [];
    try {
      const server = await work.start();
      socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { perMessageDeflate: false });
      const wireStatuses: boolean[] = [];
      const handledStatuses: boolean[] = [];
      let handlingDelay = 0;
      socket.on("message", data => {
        assert.ok(Buffer.isBuffer(data));
        const frame = readFrame(data);
        if (frame.kind !== 8) return;
        wireStatuses.push(frame.subtype === 1);
        if (handlingDelay) handlingTimers.push(setTimeout(() => handledStatuses.push(frame.subtype === 1), handlingDelay));
        else handledStatuses.push(frame.subtype === 1);
      });
      await once(socket, "open", { signal: AbortSignal.timeout(8000) });
      socket.send(Uint8Array.from([7, ...new TextEncoder().encode("fixture"), 2, 0, 0, 5, ...new TextEncoder().encode("4.8.0")]));
      socket.send(syncFrame("fixture", 2, Y.encodeStateAsUpdate(doc)));
      await until(() => wireStatuses.length === 1, "seed acknowledgement");
      assert.deepEqual(wireStatuses, [true]);
      const vector = Y.encodeStateVector(doc);
      doc.getText("R1").insert(4, "e");
      const update = Y.encodeStateAsUpdate(doc, vector);
      if (mode === "after-unlock-ack") await server.command("configure", { acknowledgeBeforeCommit: true });
      else if (mode !== "journal") await server.command("configure", {
        hold: Buffer.from(update).toString("base64"), premature: mode === "premature", prematureAfter20: mode === "ack-wait-commit",
      });
      lock = new DatabaseSync(work.path, { timeout: 0 });
      lock.exec("BEGIN IMMEDIATE");
      locked = true;
      const competing = new DatabaseSync(work.path, { timeout: 0 });
      try { assert.throws(() => competing.exec("BEGIN IMMEDIATE"), /locked/); }
      finally { competing.close(); }
      const before = readRecoveredRows(work.path);
      assert.equal(before.length, 1);
      handlingDelay = 250;
      const start = server.events.length;
      socket.send(syncFrame("fixture", 2, update));
      await until(() => server.events.slice(start).some(event => event.event === "before" && event.payload === Buffer.from(update).toString("base64")), "hook entered before the round trip");
      const nonce = Buffer.from("journal-lock-roundtrip");
      const peer = socket;
      const roundTrip = new Promise<boolean[]>((resolve, reject) => {
        const signal = AbortSignal.timeout(8000);
        const abort = (): void => { peer.off("pong", pong); reject(new Error("No same-socket pong while commit was blocked")); };
        const pong = (payload: Buffer): void => {
          if (!payload.equals(nonce)) return;
          peer.off("pong", pong);
          signal.removeEventListener("abort", abort);
          resolve(wireStatuses.slice(1));
        };
        signal.addEventListener("abort", abort, { once: true });
        peer.on("pong", pong);
      });
      socket.ping(nonce);
      const prefix = await roundTrip;
      assert.deepEqual(readRecoveredRows(work.path), before);
      if (mode === "journal" || mode === "after-unlock-ack") checkLockedRoundTrip(prefix);
      else {
        assert.deepEqual(prefix, [true]);
        assert.throws(() => checkLockedRoundTrip(prefix), /Acknowledgement crossed the harness write-lock gate/);
      }
      if (mode === "premature") await server.kill();
      lock.exec("ROLLBACK");
      locked = false;
      if (mode === "journal") await until(() => wireStatuses.length === 2, "acknowledgement after unlocking");
      else if (mode === "ack-wait-commit" || mode === "after-unlock-ack") await until(() => server.events.some(event => event.event === "post-commit-held"), "mutation committed and held after its early acknowledgement");
      await server.kill();
      const rows = readRecoveredRows(work.path);
      assert.equal(rows.length, mode === "premature" ? 1 : 2);
      if (mode !== "premature") assert.equal(rows[1]?.payload, Buffer.from(update).toString("base64"));
      if (mode === "journal") {
        assert.deepEqual(wireStatuses, [true, true]);
        const recovered = new Y.Doc();
        try {
          for (const row of rows) Y.applyUpdate(recovered, Buffer.from(row.payload, "base64"));
          assert.deepEqual(characterIdentities(recovered), ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "e:11:0"]);
        } finally { recovered.destroy(); }
      }
      await writeFile(new URL(`../../histories/ordering-${mode}.json`, import.meta.url), `${JSON.stringify({
        shows: mode === "journal" ? "No acknowledgement precedes the matching pong while the harness holds the write lock; exact update bytes are present after unlocking and a hard kill."
          : mode === "after-unlock-ack" ? "Not detected by this harness: the early acknowledgement occurs after unlock, outside the frozen pong prefix, before COMMIT returns."
          : "A premature acknowledgement precedes the same-socket pong while an independent write lock makes commit impossible; the ordering checker rejects it even with delayed receipt handling.",
        mode, expectedDisposition: "accepted", writerBusyTimeoutMs: 15000, receiptHandlingDelayMs: 250, statusesBeforePong: prefix,
        rejectedByOrderingChecker: mode === "premature" || mode === "ack-wait-commit", recoveredRows: rows.length,
        rawUpdateJournaled: rows.some(row => row.payload === Buffer.from(update).toString("base64")),
      }, null, 2)}\n`);
    } finally {
      for (const timer of handlingTimers) clearTimeout(timer);
      if (locked) lock?.exec("ROLLBACK");
      lock?.close();
      socket?.terminate();
      doc.destroy();
      await work.clean();
    }
  });
}

test("harness-declared acceptance rejects a false refusal notice for an unjournaled combined snapshot", async () => {
  const work = await workspace();
  let client: FixtureClient | undefined;
  try {
    const server = await work.start();
    client = new FixtureClient(server.port);
    await client.connect(); await client.saved();
    client.edit("e"); await client.saved();
    client.edit("f"); await client.saved();
    const before = readRecoveredRows(work.path);
    await server.command("configure", { falseRefusal: true });
    client.expectNextMessage({ disposition: "accepted" });
    client.socket.send(syncFrame("fixture", 1, Y.encodeStateAsUpdate(client.document)));
    await client.saved();
    await server.kill();
    const rows = readRecoveredRows(work.path);
    assert.deepEqual(rows, before);
    const sent = client.history.at(-1);
    assert.ok(sent);
    assert.equal(sent.disposition, "accepted");
    assert.equal(sent.notice, "invalid-or-oversized");
    const history = client.history;
    const promises = client.promises;
    assert.throws(() => checkHistory(history, rows, promises), /notice disagrees with harness-declared acceptance/);
    assert.throws(() => checkHistory([{ ...sent, notice: null }], rows), /missing exact bytes/);
    assert.throws(() => checkHistory([{ ...sent, disposition: "refused", reason: "oversized", maximumBytes: 2097152 }], rows), /must exceed the configured limit/);
    await writeFile(new URL("../../histories/review-false-refusal.json", import.meta.url), `${JSON.stringify({
      shows: "A false refusal notice cannot downgrade a harness-declared accepted snapshot to coverage-only checking.",
      expectedDisposition: "accepted", observedNotice: sent.notice, applied: sent.applied, journalRows: rows.length,
      rejectedForNoticeMismatch: true, alsoRejectedWithoutNoticeForMissingExactBytes: true,
    }, null, 2)}\n`);
  } finally { client?.destroy(); await work.clean(); }
});
