import assert from "node:assert/strict";
import { once } from "node:events";
import type { TestContext } from "node:test";
import type WebSocket from "ws";
import { Server } from "@hocuspocus/server";
import type { Connection } from "@hocuspocus/server";
import * as Y from "yjs";
import { JournalWorkerClient } from "../../../src/service/journal-client.ts";
import { refusalBoundary } from "../../../src/service/refusal/boundary.ts";
import { fixture, readRecoveredRows, until, workspace } from "../harness.ts";
import { RefusalClient } from "./harness.ts";

export async function observeStateLimit(t: TestContext): Promise<void> {
  await t.test("T18 state size: concurrent individually small updates cannot both pass a stale candidate check", async () => {
    const work = await workspace();
    const journal = new JournalWorkerClient(work.path, { journalMode: "WAL", synchronous: "FULL" });
    const clients: RefusalClient[] = [];
    const connections: Connection[] = [];
    let release: (() => void) | undefined;
    let held = false;
    let hold = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = new Server({
      port: 0, address: "127.0.0.1", quiet: true, stopOnSignals: false,
      extensions: [refusalBoundary()],
      async connected({ connection }) { connections.push(connection); },
      async onLoadDocument({ document, documentName }) {
        for (const row of await journal.read(documentName)) Y.applyUpdate(document, row.payload);
        return document;
      },
      async beforeSync({ type, payload, connection, documentName }) {
        if (type !== 1 && type !== 2 || connection.readOnly) return;
        if (hold) { hold = false; held = true; await gate; }
        await journal.append(documentName, [payload]);
      },
    });
    try {
      await journal.ready; await server.listen();
      const first = new RefusalClient(server.address.port, ["accepted"]);
      const otherDoc = fixture(); otherDoc.clientID = 22;
      const second = new RefusalClient(server.address.port, ["accepted"], otherDoc, false);
      clients.push(first, second);
      await first.connect(); await first.saved(); await second.connect(); await second.saved();
      const before = readRecoveredRows(work.path);
      hold = true;
      first.expect("accepted"); first.edit("a".repeat(1100000));
      await until(() => held, "first candidate validated, harness prevents journal commit and apply");
      second.expect("merged-state-too-large"); second.edit("b".repeat(1100000));
      const connection = connections[1]; assert.ok(connection);
      const transport = connection.webSocket as unknown as WebSocket;
      const pong = once(transport, "pong", { signal: AbortSignal.timeout(8000) });
      transport.ping("second-arrived-before-first-commit");
      const [nonce] = await pong;
      assert.ok(Buffer.isBuffer(nonce));
      assert.equal(nonce.toString(), "second-arrived-before-first-commit");
      await new Promise<void>(resolve => { setImmediate(resolve); });
      const heldRows = readRecoveredRows(work.path);
      assert.equal(heldRows.length, before.length, "No second candidate may journal while the first validated candidate is held");
      assert.deepEqual(heldRows, before);
      release?.();
      await until(() => first.sent.at(-1)?.applied === true && second.sent.at(-1)?.applied !== null, "both candidate decisions");
      assert.equal(second.sent.at(-1)?.applied, false);
      assert.deepEqual(second.notice(), { rejected: "state-too-large", permanent: true });
      assert.equal(first.sent.at(-1)?.payload.byteLength, 1100011);
      assert.equal(second.sent.at(-1)?.payload.byteLength, 1100011);
      const firstPayload = first.sent.at(-1)?.payload;
      const secondPayload = second.sent.at(-1)?.payload;
      assert.ok(firstPayload && secondPayload);
      const inserted = (payload: Uint8Array): { client: number; clock: number; length: number }[] =>
        Y.decodeUpdate(payload).structs.map(struct => ({ client: struct.id.client, clock: struct.id.clock, length: struct.length }));
      assert.deepEqual(inserted(firstPayload), [{ client: 11, clock: 0, length: 1100000 }]);
      assert.deepEqual(inserted(secondPayload), [{ client: 22, clock: 0, length: 1100000 }]);
      assert.ok(1100000 + 1100000 + 4 > 2097152);
      assert.equal(readRecoveredRows(work.path).length, before.length + 1);
      first.checkJournal(work.path); second.checkJournal(work.path);
      const late = new RefusalClient(server.address.port, ["accepted"], new Y.Doc());
      clients.push(late);
      await late.connect(); await late.saved();
      assert.equal(late.document.getText("R1").toString(), `abcd${"a".repeat(1100000)}`);
    } finally {
      release?.(); for (const client of clients) client.destroy();
      await server.destroy(); await journal.close(); await work.clean();
    }
  });
}
