import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { MemoryCompletionStore, NodeInstanceReplica, StandaloneHandoff, instanceRequest } from "../../../src/service/instance/client.ts";
import { JournalWorkerClient } from "../../../src/service/journal-client.ts";
import { InstanceGateway } from "../../../src/service/instance/gateway.ts";
import { syncFrame } from "../../../src/service/wire.ts";
import { characterIdentities, until, workspace } from "../harness.ts";
import { OWNER, INVITE, acknowledged, captureCheckpoint, checkpoint, createFixture, joinFixture, releaseGate, waitGate } from "./harness.ts";
import { assertInvitation, assertNoCredentials, assertSingleCreation, inspectInstance, recoverIndependently } from "./oracle.ts";
import { observeInstanceFacts } from "./facts.ts";
import { rejectInstanceDefects } from "./defects.ts";

const expected13 = ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "X:11:0", "Y:11:1"];
const expected17 = ["a:7:0", "b:7:1", "c:11:0", "d:12:0"];

test("instance feasibility: four deliberate defects must fail before traces count", { timeout: 180000 }, async t => {
  await t.test("defects: duplicate retry, early invitation, lying coverage and over-pruning are rejected", async () => {
    await rejectInstanceDefects();
  });

  await t.test("T13: g0 upload retains g1/g2, completion gates invitation, receipt gates server-saved, retry is unique", async () => {
    const work = await workspace();
    const source = new Y.Doc();
    source.clientID = 7;
    source.getText("R1").insert(0, "abcd");
    source.clientID = 11;
    let localRelease: (() => void) | undefined;
    let localEntered = false;
    const localGate = new Promise<void>(resolve => { localRelease = resolve; });
    const store = new MemoryCompletionStore(async write => {
      if (write.membership) {
        localEntered = true;
        await localGate;
      }
    });
    const originalFile = { docId: "d00000000000000000000000000000001", text: "abcd", history: ["source-history"] };
    let beginUpload: (() => void) | undefined;
    let preparing = false;
    const handoff = new StandaloneHandoff(source, store, () => true, async () => {
      preparing = true;
      await new Promise<void>(resolve => { beginUpload = resolve; });
    });
    let client: NodeInstanceReplica | undefined;
    const peers: NodeInstanceReplica[] = [];
    try {
      const server = await work.start({ INSTANCE_OWNER: OWNER });
      await server.command("configure", { instanceHold: "during-upload" });
      const completion = handoff.complete(server.port, "creation-k", OWNER, INVITE);
      await until(() => preparing, "pending creation returned");
      assert.equal(handoff.invitation, null);
      const pending = inspectInstance(work.path).instances[0];
      assert.ok(pending);
      assert.equal(pending.state, "pending");
      const refused = new NodeInstanceReplica(server.port, pending.id, INVITE, new MemoryCompletionStore());
      peers.push(refused);
      let rejected = false;
      refused.provider.on("authenticationFailed", () => { rejected = true; });
      await refused.connect();
      await until(() => rejected, "pending guest refused");
      assert.equal(refused.hydrated, false);
      assert.equal(refused.document.getText("R1").toString(), "");
      beginUpload?.();
      await waitGate(server, "during-upload");
      source.getText("R1").insert(4, "X");
      source.getText("R1").insert(5, "Y");
      releaseGate(server, "during-upload");
      await until(() => localEntered, "local membership transaction entered");
      assert.equal(inspectInstance(work.path).instances[0]?.state, "committed");
      assert.equal(handoff.invitation, null);
      assert.equal((await store.hydrate())?.membership, null);
      localRelease?.();
      beginUpload?.();
      client = await completion;
      const id = client.id;
      assert.match(id, /^d[0-9a-f]{32}$/);
      assert.notEqual(id, originalFile.docId);
      assert.deepEqual(originalFile, { docId: "d00000000000000000000000000000001", text: "abcd", history: ["source-history"] });
      const local = await store.hydrate();
      assert.equal(local?.generation, 2);
      assert.equal(local?.membership, id);
      assert.ok(local);
      const localDoc = new Y.Doc();
      try {
        local.updates.forEach(update => Y.applyUpdate(localDoc, update));
        assert.equal(localDoc.getText("R1").toString(), "abcdXY");
        assert.deepEqual(characterIdentities(localDoc), expected13);
        assert.equal(localDoc.getMap("identity").get("docId"), id);
        assertNoCredentials(localDoc, [OWNER, INVITE]);
      } finally { localDoc.destroy(); }
      assertInvitation(work.path, id, handoff.invitation, local.membership);
      const retry = await instanceRequest(server.port, OWNER, { action: "create", operation: "creation-k", invite: INVITE });
      assertSingleCreation(work.path, [id, String(retry.id)]);
      await server.command("configure", { instanceHold: "before-receipt" });
      await client.connect();
      await waitGate(server, "before-receipt");
      await client.settled();
      assert.equal(client.status, "Saved on this device, sending");
      assert.equal(acknowledged(client).length, 0);
      await server.command("configure");
      releaseGate(server, "before-receipt");
      await until(() => client?.status === "Your changes saved to server", "g2 covering receipt");
      assert.equal(client.document.getText("R1").toString(), "abcdXY");
      assert.deepEqual(characterIdentities(client.document), expected13);
      const accepted = acknowledged(client);
      client.socket.send(syncFrame(id, 2, Y.encodeStateAsUpdate(source)));
      await until(() => client?.receipts.outstanding === 0, "duplicate receipt");
      const recovered = recoverIndependently(work.path, id, [...accepted, ...acknowledged(client)]);
      try {
        assert.deepEqual(characterIdentities(recovered), expected13);
        assertNoCredentials(recovered, [OWNER, INVITE]);
      } finally { recovered.destroy(); }
      const late = await joinFixture(server, id);
      peers.push(late);
      assert.deepEqual(characterIdentities(late.document), expected13);
      assert.equal(late.document.getMap("identity").get("docId"), id);
      assertNoCredentials(late.document, [OWNER, INVITE]);
    } finally {
      localRelease?.();
      for (const peer of peers) peer.destroy();
      client?.destroy(); handoff.destroy(); source.destroy(); await work.clean();
    }
  });

  for (const phase of ["before-pending", "pending-write", "after-pending", "during-upload", "commit-write", "after-commit"]) {
    await t.test(`T13 kill ${phase}: retry recovers exactly one creation`, async () => {
      const work = await workspace();
      const source = new Y.Doc();
      source.clientID = 7;
      source.getText("R1").insert(0, "abcd");
      try {
        let server = await work.start({ INSTANCE_OWNER: OWNER });
        await server.command("configure", { instanceHold: phase });
        let request: Promise<unknown>;
        let id: string | undefined;
        if (["before-pending", "pending-write", "after-pending"].includes(phase)) {
          request = instanceRequest(server.port, OWNER, { action: "create", operation: "creation-k", invite: INVITE });
        } else {
          id = String((await instanceRequest(server.port, OWNER, { action: "create", operation: "creation-k", invite: INVITE })).id);
          if (phase !== "during-upload") await instanceRequest(server.port, OWNER, {
            action: "upload", operation: "creation-k", payload: Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64"),
          });
          request = instanceRequest(server.port, OWNER, phase === "during-upload" ? {
            action: "upload", operation: "creation-k", payload: Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64"),
          } : { action: "commit", operation: "creation-k" });
        }
        const failed = request.catch(() => null);
        await waitGate(server, phase);
        await server.kill();
        await failed;
        const afterKill = inspectInstance(work.path);
        assert.equal(afterKill.instances.length, phase === "before-pending" || phase === "pending-write" ? 0 : 1);
        if (phase === "after-commit") assert.equal(afterKill.instances[0]?.state, "committed");
        else if (afterKill.instances.length) assert.equal(afterKill.instances[0]?.state, "pending");
        const survivingId = afterKill.instances[0]?.id;
        server = await work.start({ INSTANCE_OWNER: OWNER });
        const retry = await instanceRequest(server.port, OWNER, { action: "create", operation: "creation-k", invite: INVITE });
        if (survivingId) assert.equal(retry.id, survivingId);
        if (id) assert.equal(retry.id, id);
        await instanceRequest(server.port, OWNER, { action: "upload", operation: "creation-k", payload: Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64") });
        await instanceRequest(server.port, OWNER, { action: "commit", operation: "creation-k" });
        assertSingleCreation(work.path, [String(retry.id)]);
        const recovered = recoverIndependently(work.path, String(retry.id));
        try { assert.deepEqual(characterIdentities(recovered), ["a:7:0", "b:7:1", "c:7:2", "d:7:3"]); }
        finally { recovered.destroy(); }
      } finally { source.destroy(); await work.clean(); }
    });
  }

  await t.test("T13: changed initiating epoch refuses authority switch; original edits stay available", async () => {
    const work = await workspace();
    const source = new Y.Doc();
    source.clientID = 7;
    source.getText("R1").insert(0, "abcd");
    let owns = true;
    const handoff = new StandaloneHandoff(source, new MemoryCompletionStore(), () => owns);
    try {
      const server = await work.start({ INSTANCE_OWNER: OWNER });
      await server.command("configure", { instanceHold: "after-commit" });
      const completion = handoff.complete(server.port, "creation-k", OWNER, INVITE);
      const refused = assert.rejects(completion, /no longer owns/);
      await waitGate(server, "after-commit");
      owns = false;
      source.getText("R1").insert(4, "X");
      releaseGate(server, "after-commit");
      await refused;
      assert.equal(handoff.invitation, null);
      assert.equal(source.getText("R1").toString(), "abcdX");
    } finally { handoff.destroy(); source.destroy(); await work.clean(); }
  });

  await t.test("checkpoints: newer finish wins, failures preserve coverage, pure delete advances sequence only", async () => {
    const work = await workspace();
    const clients: NodeInstanceReplica[] = [];
    let source: Y.Doc | undefined;
    try {
      const server = await work.start({ INSTANCE_OWNER: OWNER });
      const fixture = await createFixture(server);
      source = fixture.source;
      const client = await joinFixture(server, fixture.id);
      clients.push(client);
      await captureCheckpoint(server, fixture.id, "old");
      const vector = Y.encodeStateVector(client.document);
      client.document.getText("R1").delete(1, 1);
      await until(() => client.status === "Your changes saved to server", "delete receipt");
      assert.deepEqual(Y.encodeStateVector(client.document), vector);
      await checkpoint(server, fixture.id, "new");
      const newer = inspectInstance(work.path, fixture.id).checkpoint;
      assert.ok(newer);
      const result = await server.command("instance-checkpoint", { label: "old" }, "instance-checkpointed");
      assert.equal(result.installed, false);
      assert.equal(inspectInstance(work.path, fixture.id).checkpoint?.sequence, newer.sequence);
      client.edit("X");
      await until(() => client.status === "Your changes saved to server", "new insert receipt");
      await captureCheckpoint(server, fixture.id, "failed");
      const db = new DatabaseSync(work.path);
      try { db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON instance_checkpoints BEGIN SELECT RAISE(ABORT, 'injected'); END"); }
      finally { db.close(); }
      await server.command("instance-checkpoint", { label: "failed" }, "instance-checkpoint-failed");
      assert.equal(inspectInstance(work.path, fixture.id).checkpoint?.sequence, newer.sequence);
      await server.command("instance-prune", { document: fixture.id }, "instance-pruned");
      const pruned = inspectInstance(work.path, fixture.id);
      assert.equal(pruned.pruned, newer.sequence);
      assert.ok(pruned.rows.every(row => row.sequence > newer.sequence));
      assert.ok(pruned.rows.length > 0);
      const recovered = recoverIndependently(work.path, fixture.id, acknowledged(client));
      try { assert.equal(recovered.getText("R1").toString(), "acdX"); }
      finally { recovered.destroy(); }
    } finally { clients.forEach(client => client.destroy()); source?.destroy(); await work.clean(); }
  });

  for (const phase of ["checkpoint-write", "after-checkpoint", "pruning-write"]) {
    await t.test(`checkpoint kill ${phase}: checkpoint plus unpruned tail retains every receipt`, async () => {
      const work = await workspace();
      const clients: NodeInstanceReplica[] = [];
      let source: Y.Doc | undefined;
      try {
        let server = await work.start({ INSTANCE_OWNER: OWNER });
        const fixture = await createFixture(server);
        source = fixture.source;
        const client = await joinFixture(server, fixture.id);
        clients.push(client);
        await checkpoint(server, fixture.id, "baseline");
        client.document.getText("R1").delete(1, 1);
        await until(() => client.status === "Your changes saved to server", "delete receipt");
        await captureCheckpoint(server, fixture.id, "delete");
        await server.command("configure", { instanceHold: phase });
        if (phase === "checkpoint-write") {
          server.child.send({ command: "instance-checkpoint", label: "delete" });
          await waitGate(server, phase);
        } else {
          await server.command("instance-checkpoint", { label: "delete" }, "instance-checkpointed");
          if (phase === "pruning-write") {
            server.child.send({ command: "instance-prune", document: fixture.id });
            await waitGate(server, phase);
          }
        }
        const receipts = acknowledged(client);
        await server.kill();
        const recovered = recoverIndependently(work.path, fixture.id, receipts);
        try { assert.deepEqual(characterIdentities(recovered), ["a:7:0", "c:7:2", "d:7:3"]); }
        finally { recovered.destroy(); }
        server = await work.start({ INSTANCE_OWNER: OWNER });
        const late = await joinFixture(server, fixture.id);
        clients.push(late);
        assert.deepEqual(characterIdentities(late.document), ["a:7:0", "c:7:2", "d:7:3"]);
      } finally { clients.forEach(client => client.destroy()); source?.destroy(); await work.clean(); }
    });
  }

  for (const useCheckpoint of [false, true]) {
    await t.test(`T17: A/B leave, kill, invited C hydrates before editing (${useCheckpoint ? "checkpoint and tail" : "whole journal"})`, async () => {
      const work = await workspace();
      const clients: NodeInstanceReplica[] = [];
      let source: Y.Doc | undefined;
      let releaseLocal: (() => void) | undefined;
      try {
        let server = await work.start({ INSTANCE_OWNER: OWNER });
        const fixture = await createFixture(server, "creation-k", "ab");
        source = fixture.source;
        const alice = await joinFixture(server, fixture.id);
        const bob = await joinFixture(server, fixture.id);
        clients.push(alice, bob);
        alice.document.clientID = 11;
        bob.document.clientID = 12;
        alice.edit("c");
        await until(() => alice.status === "Your changes saved to server" && bob.document.getText("R1").toString() === "abc", "A receipt and B delivery");
        if (useCheckpoint) {
          await checkpoint(server, fixture.id);
          await server.command("instance-prune", { document: fixture.id }, "instance-pruned");
        }
        bob.edit("d");
        await until(() => bob.status === "Your changes saved to server" && alice.document.getText("R1").toString() === "abcd", "last receipt");
        const accepted = [...acknowledged(alice), ...acknowledged(bob)];
        alice.destroy(); bob.destroy();
        clients.length = 0;
        await server.kill();
        const recovered = recoverIndependently(work.path, fixture.id, accepted);
        try { assert.deepEqual(characterIdentities(recovered), expected17); }
        finally { recovered.destroy(); }
        server = await work.start({ INSTANCE_OWNER: OWNER });
        let localHeld = false;
        const localGate = new Promise<void>(resolve => { releaseLocal = resolve; });
        const store = new MemoryCompletionStore(async write => {
          const doc = new Y.Doc();
          try {
            write.updates.forEach(update => Y.applyUpdate(doc, update));
            if (doc.getText("R1").toString() === "abcd") {
              localHeld = true;
              await localGate;
            }
          } finally { doc.destroy(); }
        });
        const carol = new NodeInstanceReplica(server.port, fixture.id, INVITE, store);
        clients.push(carol);
        assert.throws(() => carol.edit("forbidden"), /not hydrated/);
        await carol.connect();
        await until(() => localHeld, "received state awaits local commit");
        assert.equal(carol.hydrated, false);
        assert.throws(() => carol.edit("forbidden"), /not hydrated/);
        assert.equal(carol.status, "Saving on this device");
        releaseLocal?.();
        await until(() => carol.hydrated, "local hydration completed");
        await carol.settled();
        assert.equal(carol.status, "Saved on this device");
        assert.equal(carol.document.getText("R1").toString(), "abcd");
        assert.deepEqual(characterIdentities(carol.document), expected17);
        assert.equal(carol.document.getMap("identity").get("docId"), fixture.id);
        assertNoCredentials(carol.document, [OWNER, INVITE]);
        const bad = new NodeInstanceReplica(server.port, fixture.id, "invalid-invitation", new MemoryCompletionStore());
        clients.push(bad);
        let refused = false;
        bad.provider.on("authenticationFailed", () => { refused = true; });
        await bad.connect();
        await until(() => refused, "invalid token refused");
        assert.equal(bad.document.getText("R1").length, 0);
      } finally { releaseLocal?.(); clients.forEach(client => client.destroy()); source?.destroy(); await work.clean(); }
    });
  }

  await t.test("checkpoint install refuses a captured payload with a later sequence", async () => {
    const work = await workspace();
    let worker: JournalWorkerClient | undefined;
    let source: Y.Doc | undefined;
    try {
      const server = await work.start({ INSTANCE_OWNER: OWNER });
      const fixture = await createFixture(server);
      source = fixture.source;
      await server.kill();
      worker = new JournalWorkerClient(work.path, { journalMode: "WAL", synchronous: "FULL" });
      await worker.ready;
      const gateway = new InstanceGateway(worker);
      const old = await gateway.capture(fixture.id);
      const vector = Y.encodeStateVector(source);
      source.getText("R1").insert(4, "X");
      const [sequence] = await worker.append(fixture.id, [Y.encodeStateAsUpdate(source, vector)]);
      assert.ok(sequence);
      await assert.rejects(gateway.checkpoint({ ...old, sequence }), /coverage mismatch/);
      assert.equal(inspectInstance(work.path, fixture.id).checkpoint, null);
    } finally { await worker?.close(); source?.destroy(); await work.clean(); }
  });
  await observeInstanceFacts(t);
});
