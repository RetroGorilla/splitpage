import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { once } from "node:events";
import type WebSocket from "ws";
import { Server } from "@hocuspocus/server";
import type { Connection } from "@hocuspocus/server";
import * as Y from "yjs";
import { JournalWorkerClient } from "../../../src/service/journal-client.ts";
import { refusalBoundary } from "../../../src/service/refusal/boundary.ts";
import { readFrame } from "../../../src/service/wire.ts";
import { readRecoveredRows, until, workspace } from "../harness.ts";
import { RefusalClient } from "./harness.ts";

export async function observeRevocation(t: TestContext): Promise<void> {
  await t.test("H12: close leaves queued updates; a revocation check before sync refuses them before journal", async () => {
    const work = await workspace();
    const journal = new JournalWorkerClient(work.path, { journalMode: "WAL", synchronous: "FULL" });
    const clients: RefusalClient[] = [];
    const connections: Connection[] = [];
    const revoked = new Set<Connection>();
    let release: (() => void) | undefined;
    let entered = false;
    let hold = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = new Server({
      port: 0, address: "127.0.0.1", quiet: true, stopOnSignals: false,
      extensions: [refusalBoundary(Date.now, connection => revoked.has(connection))],
      async connected({ connection }) { connections.push(connection); },
      async onLoadDocument({ document, documentName }) {
        for (const row of await journal.read(documentName)) Y.applyUpdate(document, row.payload);
        return document;
      },
      async beforeHandleMessage({ update }) {
        const parsed = readFrame(update);
        if (hold && parsed.kind === 0 && parsed.subtype === 2) {
          hold = false; entered = true; await gate;
        }
      },
      async beforeSync({ type, payload, connection, documentName }) {
        if ((type === 1 || type === 2) && !connection.readOnly) await journal.append(documentName, [payload]);
      },
    });
    try {
      await journal.ready; await server.listen();
      const bad = new RefusalClient(server.address.port, ["accepted"], undefined, false);
      const peer = new RefusalClient(server.address.port, ["accepted"]);
      clients.push(bad, peer);
      await bad.connect(); await bad.saved(); await peer.connect(); await peer.saved();
      const before = readRecoveredRows(work.path);
      hold = true;
      bad.expect("access-removed", "access-removed");
      bad.edit("e");
      await until(() => entered, "harness gate before the first queued update's beforeSync");
      bad.edit("f");
      assert.equal(bad.sent.length, 3);
      const connection = connections[0];
      assert.ok(connection);
      const transport = connection.webSocket as unknown as WebSocket;
      assert.equal(typeof transport.ping, "function");
      const pong = once(transport, "pong", { signal: AbortSignal.timeout(8000) });
      transport.ping("queued-before-revoke");
      const [nonce] = await pong;
      assert.ok(Buffer.isBuffer(nonce));
      assert.equal(nonce.toString(), "queued-before-revoke");
      revoked.add(connection);
      connection.close();
      release?.();
      await until(() => bad.sent.every(sent => sent.applied !== null), "both queued messages refused even after logical close");
      assert.deepEqual(bad.sent.map(sent => sent.applied), [true, false, false]);
      assert.deepEqual(readRecoveredRows(work.path), before);
      assert.equal(peer.document.getText("R1").toString(), "abcd");
      assert.deepEqual(bad.notice(), { rejected: "access-removed", permanent: true });
      bad.checkJournal(work.path);
      peer.expect("accepted"); peer.edit("q"); await peer.saved();
      assert.equal(readRecoveredRows(work.path).length, before.length + 1);
      const protectedClient = new RefusalClient(server.address.port, ["accepted"], new Y.Doc());
      clients.push(protectedClient);
      await protectedClient.connect(); await protectedClient.saved();
      const protectedConnection = connections[2]; assert.ok(protectedConnection);
      revoked.add(protectedConnection);
      protectedClient.expect("access-removed"); protectedClient.edit("x");
      await until(() => protectedClient.closes.length === 1, "access refusal detaches protected device");
      assert.deepEqual(protectedClient.policy.current(protectedClient.receipts.status), {
        status: "Access removed, local work kept", explanation: "refusal.export-standalone-then-rejoin",
        reason: "access-removed", publication: "detached", export: "Standalone copy",
      });
      protectedClient.checkJournal(work.path);
    } finally {
      release?.();
      for (const client of clients) client.destroy();
      await server.destroy(); await journal.close(); await work.clean();
    }
  });
}
