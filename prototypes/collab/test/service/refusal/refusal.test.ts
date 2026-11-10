import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import * as Y from "yjs";
import { characterIdentities, fixture, readRecoveredRows, until, workspace } from "../harness.ts";
import { countingProxy, frame, RefusalClient } from "./harness.ts";
import { observeDependencies } from "./dependencies.ts";
import { observeRevocation } from "./revocation.ts";
import { observeStateLimit } from "./state-limit.ts";

const keptView = {
  status: "Saved on this device", explanation: "refusal.export-standalone-then-rejoin",
  reason: "state-too-large", publication: "detached", export: "Standalone copy",
};

test("refusal checker rejects reconnecting policy before endorsing T18/T19", async t => {
  let mutationRejected = false;
  await t.test("deliberate defect: reconnect after the first permanent refusal", async () => {
    const work = await workspace();
    const clients: RefusalClient[] = [];
    let proxy: Awaited<ReturnType<typeof countingProxy>> | undefined;
    try {
      const server = await work.start({ REFUSAL_POLICY: "1" });
      proxy = await countingProxy(server.port);
      const client = new RefusalClient(proxy.port, ["accepted"]);
      clients.push(client);
      await client.connect(); await client.saved();
      const reconnect = (): void => {
        client.socket.off("close", reconnect);
        client.expect("state-too-large");
        client.provider.attach();
        void client.socket.connect();
      };
      client.socket.on("close", reconnect);
      client.expect("state-too-large");
      client.edit("Z".repeat(3145728));
      const counter = proxy;
      await until(() => counter.attempts() >= 2, "mutation opens a second real TCP connection");
      client.socket.disconnect();
      assert.throws(() => client.assertDetached(counter.attempts(), 1), /must not reconnect/);
      mutationRejected = true;
      await writeFile(new URL("../../../histories/T19-reconnecting-policy.json", import.meta.url), `${JSON.stringify({
        shows: "The harness rejects a policy that reconnects after its first permanent refusal, before any passing trace counts.",
        replay: "node --test --test-concurrency=1 test/service/refusal/refusal.test.ts",
        initial: "abcd", insertion: { character: "Z", count: 3145728 },
        expectedAttempts: 1, observedAttempts: proxy.attempts(), checker: "Refused policy must not reconnect",
      }, null, 2)}\n`);
    } finally { for (const client of clients) client.destroy(); await proxy?.close(); await work.clean(); }
  });

  assert.equal(mutationRejected, true, "No passing trace counts until the reconnect defect is rejected");
  await observeDependencies(t);
  await observeRevocation(t);
  await observeStateLimit(t);

  for (const mode of ["incremental", "restart-syncstep2"] as const) {
    await t.test(`T19 ${mode}: first refusal detaches, preserves export, and permits deliberate fresh rejoin`, async () => {
      const work = await workspace();
      const clients: RefusalClient[] = [];
      let proxy: Awaited<ReturnType<typeof countingProxy>> | undefined;
      try {
        const server = await work.start({ REFUSAL_POLICY: "1" });
        proxy = await countingProxy(server.port);
        const seed = new RefusalClient(server.port, ["accepted"]);
        clients.push(seed);
        await seed.connect(); await seed.saved();
        const before = readRecoveredRows(work.path);
        let client: RefusalClient;
        if (mode === "incremental") {
          client = new RefusalClient(proxy.port, ["accepted"]);
          clients.push(client);
          await client.connect(); await client.saved();
          assert.equal(client.policy.current(client.receipts.status).status, "Your changes saved to server");
          client.expect("state-too-large");
          client.edit("Z".repeat(3145728));
          assert.equal(client.policy.current(client.receipts.status).status, "Saved on this device, sending");
        } else {
          const previous = fixture();
          previous.getText("R1").insert(4, "Z".repeat(3145728));
          const persisted = Y.encodeStateAsUpdate(previous);
          previous.destroy();
          const restarted = new Y.Doc();
          Y.applyUpdate(restarted, persisted);
          client = new RefusalClient(proxy.port, ["state-too-large"], restarted);
          clients.push(client);
          assert.equal(client.policy.current(client.receipts.status).status, "Offline, saved on this device");
          await client.connect();
        }
        await until(() => client.closes.length === 1, "first refusal disconnects the dedicated socket");
        assert.equal(client.notices.length, 1);
        assert.deepEqual(client.notice(), { rejected: "state-too-large", permanent: true });
        assert.deepEqual(client.policy.current(client.receipts.status), keptView);
        assert.equal(client.sent.at(-1)?.subtype, mode === "incremental" ? 2 : 1);
        assert.equal(client.sent.at(-1)?.applied, false);
        const snapshot = Y.encodeStateAsUpdate(client.document);
        assert.deepEqual(Y.decodeUpdate(snapshot).structs.map(struct => ({
          client: struct.id.client, clock: struct.id.clock, length: struct.length,
        })), [
          { client: 11, clock: 0, length: 3145728 }, { client: 7, clock: 0, length: 4 },
        ]);
        const standalone = new Y.Doc();
        try {
          Y.applyUpdate(standalone, snapshot);
          assert.equal(standalone.getText("R1").length, 3145732);
          assert.equal(standalone.getText("R1").toString(), `abcd${"Z".repeat(3145728)}`);
          const end = Y.createRelativePositionFromTypeIndex(standalone.getText("R1"), 3145731).item;
          assert.equal(end?.client, 11);
          assert.equal(end?.clock, 3145727);
        } finally { standalone.destroy(); }
        client.assertDetached(proxy.attempts(), 1);
        assert.equal(client.views.includes("Your changes saved to server"), mode === "incremental");
        assert.equal(seed.document.getText("R1").toString(), "abcd");
        assert.equal(readRecoveredRows(work.path).length, before.length + (mode === "incremental" ? 1 : 0));
        const retained = Y.encodeStateAsUpdate(client.document);
        let fresh: RefusalClient | undefined;
        client.policy.deliberateRejoin(() => {
          fresh = new RefusalClient(server.port, ["accepted"], new Y.Doc());
          clients.push(fresh);
        });
        assert.ok(fresh);
        await fresh.connect(); await fresh.saved();
        assert.deepEqual(characterIdentities(fresh.document), ["a:7:0", "b:7:1", "c:7:2", "d:7:3"]);
        assert.deepEqual(Y.encodeStateAsUpdate(client.document), retained);
        client.assertDetached(proxy.attempts(), 1);
        client.checkJournal(work.path);
        assert.equal(server.stderr.includes("exception"), false);
      } finally { for (const client of clients) client.destroy(); await proxy?.close(); await work.clean(); }
    });
  }

  for (const subtype of [2, 1] as const) {
    await t.test(`T18 truncated delete-set tail, sync subtype ${subtype}`, async () => {
      const work = await workspace();
      const clients: RefusalClient[] = [];
      try {
        const server = await work.start({ REFUSAL_POLICY: "1" });
        const peer = new RefusalClient(server.port, ["accepted"]);
        const bad = new RefusalClient(server.port, ["accepted"], fixture(), false);
        clients.push(peer, bad);
        await peer.connect(); await peer.saved(); await bad.connect(); await bad.saved();
        const copy = fixture();
        const vector = Y.encodeStateVector(copy);
        copy.getText("R1").insert(4, "e");
        const update = Y.encodeStateAsUpdate(copy, vector).slice(0, -3);
        copy.destroy();
        assert.throws(() => Y.decodeUpdate(update));
        const before = readRecoveredRows(work.path);
        bad.expect("invalid-update");
        bad.socket.send(frame(subtype, update));
        if (subtype === 2) {
          await until(() => bad.sent.at(-1)?.applied === false, "negative incremental receipt");
          assert.equal(bad.socket.status, "connected");
          assert.equal(server.stderr.includes("exception"), false);
        } else {
          await until(() => bad.incoming.some(item => item.kind === 7), "library logical close after malformed SyncStep2");
          assert.equal(bad.sent.at(-1)?.applied, null);
          assert.match(server.stderr, /because of exception Error: Unexpected end of array/);
          await writeFile(new URL("../../../histories/T18-malformed-syncstep2.json", import.meta.url), `${JSON.stringify({
            shows: "The normally returning read-only refusal hook sends its reason, but malformed SyncStep2 throws in the library snapshot check and closes the logical connection.",
            replay: "node --test --test-concurrency=1 test/service/refusal/refusal.test.ts",
            update: Buffer.from(update).toString("base64"), subtype: 1,
            observed: { notice: bad.notice(), positiveReceipt: false, logicalClose: true, journalAdded: 0 },
            requiredLibraryChange: "A supported reject-this-sync-message result that bypasses snapshotContainsUpdate without throwing or closing.",
          }, null, 2)}\n`);
        }
        assert.deepEqual(readRecoveredRows(work.path), before);
        assert.equal(peer.document.getText("R1").toString(), "abcd");
        assert.deepEqual(bad.notice(), { rejected: "invalid-update", permanent: true });
        bad.checkJournal(work.path);
        const sends = peer.sent.length;
        peer.expect("accepted"); peer.provider.forceSync();
        await until(() => peer.sent.length > sends && peer.sent.at(-1)?.applied === true, "peer resync after completed refusal");
        assert.deepEqual(characterIdentities(peer.document), ["a:7:0", "b:7:1", "c:7:2", "d:7:3"]);
        peer.expect("accepted"); peer.edit("q"); await peer.saved();
        assert.equal(readRecoveredRows(work.path).length, before.length + 2);
      } finally { for (const client of clients) client.destroy(); await work.clean(); }
    });
  }

  await t.test("T18 malformed SyncStep2 with policy: first notice detaches before the library close can republish", async () => {
    const work = await workspace();
    let client: RefusalClient | undefined;
    let proxy: Awaited<ReturnType<typeof countingProxy>> | undefined;
    try {
      const server = await work.start({ REFUSAL_POLICY: "1" });
      proxy = await countingProxy(server.port);
      client = new RefusalClient(proxy.port, ["accepted"]);
      await client.connect(); await client.saved();
      const before = readRecoveredRows(work.path);
      client.expect("invalid-update");
      client.socket.send(frame(1, Buffer.from("AQELAIQHAw==", "base64")));
      await until(() => client?.closes.length === 1, "logical close triggers dedicated-socket shutdown");
      client.assertDetached(proxy.attempts(), 1);
      assert.deepEqual(client.policy.current(client.receipts.status), { ...keptView, reason: "invalid-update" });
      assert.equal(client.notices.length, 1);
      assert.deepEqual(readRecoveredRows(work.path), before);
      client.checkJournal(work.path);
    } finally { client?.destroy(); await proxy?.close(); await work.clean(); }
  });

  await t.test("T18 20 MiB socket frame: close 1009 before hook, policy stops retries", async () => {
    const work = await workspace();
    const clients: RefusalClient[] = [];
    let proxy: Awaited<ReturnType<typeof countingProxy>> | undefined;
    try {
      const server = await work.start({ REFUSAL_POLICY: "1" });
      proxy = await countingProxy(server.port);
      const client = new RefusalClient(proxy.port, ["accepted"]);
      const peer = new RefusalClient(server.port, ["accepted"]);
      clients.push(client, peer);
      await client.connect(); await client.saved(); await peer.connect(); await peer.saved();
      const before = readRecoveredRows(work.path);
      const hooks = server.events.filter(event => event.event === "before").length;
      client.expect("frame-too-large");
      client.socket.send(frame(2, new Uint8Array(20971520)));
      await until(() => client.closes.length === 1, "socket 1009 close");
      assert.deepEqual(client.closes, [1009]);
      client.assertDetached(proxy.attempts(), 1);
      assert.deepEqual(client.policy.current(client.receipts.status), { ...keptView, reason: "frame-too-large" });
      assert.deepEqual(readRecoveredRows(work.path), before);
      assert.equal(server.events.filter(event => event.event === "before").length, hooks);
      client.checkJournal(work.path);
      peer.expect("accepted"); peer.edit("q"); await peer.saved();
      assert.equal(readRecoveredRows(work.path).length, before.length + 1);
    } finally { for (const client of clients) client.destroy(); await proxy?.close(); await work.clean(); }
  });

  await t.test("T18 rate limit: 200 updates in a frozen one-second window, 50 accepted and 150 temporary refusals", async () => {
    const work = await workspace();
    let client: RefusalClient | undefined;
    try {
      const server = await work.start({ REFUSAL_POLICY: "1", REFUSAL_FROZEN_CLOCK: "1" });
      client = new RefusalClient(server.port, ["accepted"]);
      await client.connect(); await client.saved();
      client.expect(...Array.from({ length: 50 }, () => "accepted" as const), ...Array.from({ length: 150 }, () => "rate-window" as const));
      for (let i = 0; i < 200; i++) client.edit("e");
      await until(() => client?.sent.filter(item => item.applied !== null).length === 201, "all rate-limited statuses");
      assert.equal(client.sent.filter(item => item.applied).length, 51);
      assert.equal(client.notices.length, 150);
      for (const notice of client.notices) assert.deepEqual(JSON.parse(notice), { retryAfter: "rate-window", permanent: false });
      assert.deepEqual(client.policy.current(client.receipts.status), {
        status: "Saved on this device, sending", explanation: "refusal.retry-after", reason: "rate-window",
        publication: "retry-after", export: "Standalone copy",
      });
      assert.equal(client.socket.configuration.providerMap.has("fixture"), true);
      assert.equal(client.closes.length, 0);
      assert.equal(readRecoveredRows(work.path).length, 51);
      client.checkJournal(work.path);
      client.expect("accepted");
      client.provider.forceSync();
      await until(() => client?.sent.length === 202 && client.sent.at(-1)?.applied === true, "temporary read-only flag cleared before retry");
      assert.equal(readRecoveredRows(work.path).length, 52);
      assert.equal(server.stderr.includes("exception"), false);
    } finally { client?.destroy(); await work.clean(); }
  });
});
