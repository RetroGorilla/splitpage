import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { request } from "node:http";
import type { ClientRequest } from "node:http";
import * as Y from "yjs";
import { MemoryCompletionStore, NodeInstanceReplica, StandaloneHandoff, instanceRequest } from "../../../src/service/instance/client.ts";
import { syncFrame } from "../../../src/service/wire.ts";
import { characterIdentities, until, workspace } from "../harness.ts";
import { OWNER, INVITE, acknowledged, checkpoint, createFixture, joinFixture, waitGate } from "./harness.ts";
import { assertSingleCreation, inspectInstance, recoverIndependently } from "./oracle.ts";

export async function observeInstanceFacts(t: TestContext): Promise<void> {
  await t.test("T13 kill while initial HTTP upload is incomplete: withheld suffix cannot initialize an instance", async () => {
    const work = await workspace();
    const source = new Y.Doc();
    source.clientID = 7;
    source.getText("R1").insert(0, "abcd");
    let upload: ClientRequest | undefined;
    let client: NodeInstanceReplica | undefined;
    try {
      let server = await work.start({ INSTANCE_OWNER: OWNER });
      const creation = await instanceRequest(server.port, OWNER, { action: "create", operation: "creation-k", invite: INVITE });
      const body = Buffer.from(JSON.stringify({
        action: "upload", operation: "creation-k", payload: Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64"),
      }));
      const start = server.events.length;
      upload = request(`http://127.0.0.1:${server.port}/api/instance`, {
        method: "POST", headers: { Authorization: `Bearer ${OWNER}`, "Content-Length": body.byteLength },
      });
      let interrupted = false;
      upload.on("error", () => { interrupted = true; });
      upload.write(body.subarray(0, Math.floor(body.byteLength / 2)));
      await until(() => server.events.slice(start).some(event => event.event === "instance-request-chunk"), "upload prefix received");
      await server.kill();
      await until(() => interrupted, "incomplete upload connection interrupted");
      const recovered = inspectInstance(work.path, String(creation.id));
      assert.equal(recovered.instances[0]?.state, "pending");
      assert.equal(recovered.rows.length, 0);
      assert.equal(recovered.checkpoint, null);
      const db = new DatabaseSync(work.path, { readOnly: true });
      try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM instance_uploads").get()?.count, 0); }
      finally { db.close(); }
      server = await work.start({ INSTANCE_OWNER: OWNER });
      const fixture = await createFixture(server);
      fixture.source.destroy();
      assert.equal(fixture.id, creation.id);
      assertSingleCreation(work.path, [fixture.id]);
      client = await joinFixture(server, fixture.id);
      assert.deepEqual(characterIdentities(client.document), ["a:7:0", "b:7:1", "c:7:2", "d:7:3"]);
    } finally { upload?.destroy(); client?.destroy(); source.destroy(); await work.clean(); }
  });

  await t.test("concurrent same-k retries allocate once; changed initial upload cannot alter a committed creation", async () => {
    const work = await workspace();
    let source: Y.Doc | undefined;
    try {
      const server = await work.start({ INSTANCE_OWNER: OWNER });
      const attempts = await Promise.all(Array.from({ length: 3 }, () => instanceRequest(server.port, OWNER, {
        action: "create", operation: "creation-k", invite: INVITE,
      })));
      assertSingleCreation(work.path, attempts.map(record => String(record.id)));
      const fixture = await createFixture(server);
      source = fixture.source;
      source.getText("R1").insert(4, "changed");
      await assert.rejects(instanceRequest(server.port, OWNER, {
        action: "upload", operation: "creation-k", payload: Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64"),
      }), /409/);
      await assert.rejects(instanceRequest(server.port, OWNER, { action: "create", operation: "creation-k", invite: "different-invitation" }), /409/);
      const recovered = recoverIndependently(work.path, fixture.id);
      try { assert.deepEqual(characterIdentities(recovered), ["a:7:0", "b:7:1", "c:7:2", "d:7:3"]); }
      finally { recovered.destroy(); }
    } finally { source?.destroy(); await work.clean(); }
  });

  await t.test("local model matches save/hydrate completion: captured binary state and sequence, never live state", async () => {
    const document = new Y.Doc();
    document.clientID = 7;
    document.getText("R1").insert(0, "abcd");
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = new MemoryCompletionStore(async () => { await gate; });
    try {
      const completion = store.save(document, document, 2, [], new Map(), () => true);
      document.getText("R1").insert(4, "newer");
      assert.equal(await store.hydrate(), null);
      release?.();
      assert.equal(await completion, 2);
      const saved = await store.hydrate();
      assert.ok(saved);
      assert.equal(saved.sequence, 2);
      for (const bytes of [saved.editor, saved.network]) {
        const recovered = new Y.Doc();
        try {
          Y.applyUpdate(recovered, bytes);
          assert.deepEqual(characterIdentities(recovered), ["a:7:0", "b:7:1", "c:7:2", "d:7:3"]);
        } finally { recovered.destroy(); }
      }
    } finally { release?.(); document.destroy(); }
  });

  await t.test("T13 restart during upload: persisted k and g0/g1/g2 resume into the same pending instance", async () => {
    const work = await workspace();
    const store = new MemoryCompletionStore();
    const source = new Y.Doc();
    source.clientID = 7;
    source.getText("R1").insert(0, "abcd");
    source.clientID = 11;
    const handoff = new StandaloneHandoff(source, store, () => true);
    let resumed: StandaloneHandoff | undefined;
    let restored: Y.Doc | undefined;
    let client: NodeInstanceReplica | undefined;
    try {
      let server = await work.start({ INSTANCE_OWNER: OWNER });
      await server.command("configure", { instanceHold: "during-upload" });
      const completion = handoff.complete(server.port, "creation-k", OWNER, INVITE).catch(() => null);
      await waitGate(server, "during-upload");
      source.getText("R1").insert(4, "X");
      source.getText("R1").insert(5, "Y");
      await handoff.settled();
      const pending = inspectInstance(work.path).instances[0];
      assert.ok(pending);
      await server.kill();
      await completion;
      handoff.destroy();
      const saved = await store.hydrate();
      assert.ok(saved?.creation);
      assert.equal(saved.generation, 2);
      assert.equal(saved.creation.operation, "creation-k");
      assert.equal(saved.creation.instance, pending.id);
      assert.equal(saved.membership, null);
      restored = new Y.Doc();
      saved.updates.forEach(update => Y.applyUpdate(restored as Y.Doc, update));
      assert.deepEqual(characterIdentities(restored), ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "X:11:0", "Y:11:1"]);
      resumed = new StandaloneHandoff(restored, store, () => true, async () => {}, saved);
      server = await work.start({ INSTANCE_OWNER: OWNER });
      client = await resumed.complete(server.port, saved.creation.operation, OWNER, INVITE);
      assert.equal(client.id, pending.id);
      assertSingleCreation(work.path, [client.id]);
      await client.connect();
      await until(() => client?.status === "Your changes saved to server", "resumed g2 receipt");
      const recovered = recoverIndependently(work.path, client.id, acknowledged(client));
      try { assert.deepEqual(characterIdentities(recovered), ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "X:11:0", "Y:11:1"]); }
      finally { recovered.destroy(); }
    } finally { client?.destroy(); resumed?.destroy(); restored?.destroy(); handoff.destroy(); source.destroy(); await work.clean(); }
  });

  await t.test("Y8: hard-deleted payload is GC'd; soft-removed text remains in a checkpoint", async () => {
    const hard = new Y.Doc();
    const soft = new Y.Doc();
    try {
      assert.equal(hard.gc, true);
      hard.getText("R1").insert(0, "removed-payload");
      hard.getText("R1").delete(0, 15);
      const bytes = Y.encodeStateAsUpdate(hard);
      const decoded = Y.decodeUpdate(bytes);
      assert.equal(Buffer.from(bytes).includes(Buffer.from("removed-payload")), false);
      assert.ok(decoded.structs.some(struct => struct instanceof Y.Item && struct.content.constructor.name === "ContentDeleted"));
      soft.getText("removed:R1").insert(0, "removed-payload");
      soft.getMap("removed").set("R1", true);
      const restored = new Y.Doc();
      try {
        Y.applyUpdate(restored, Y.encodeStateAsUpdate(soft));
        assert.equal(restored.getText("removed:R1").toString(), "removed-payload");
      } finally { restored.destroy(); }
      const sizes: number[] = [];
      for (let i = 0; i < 100; i++) {
        soft.getText(`removed:${i}`).insert(0, "x".repeat(100));
        soft.getMap("removed").set(String(i), true);
        if (i === 9 || i === 99) sizes.push(Y.encodeStateAsUpdate(soft).byteLength);
      }
      assert.ok((sizes[1] ?? 0) > (sizes[0] ?? 0) + 9000);
      t.diagnostic(`Y8 retained soft-removal bytes at 10/100 x 100 chars: ${sizes.join("/")}`);
    } finally { hard.destroy(); soft.destroy(); }
  });

  await t.test("H14: checkpoint load enters broadcast batching with zero connections, no change/store hook", async () => {
    const work = await workspace();
    const clients: NodeInstanceReplica[] = [];
    let source: Y.Doc | undefined;
    try {
      let server = await work.start({ INSTANCE_OWNER: OWNER });
      const fixture = await createFixture(server);
      source = fixture.source;
      await checkpoint(server, fixture.id);
      await server.command("instance-prune", { document: fixture.id }, "instance-pruned");
      await server.kill();
      server = await work.start({ INSTANCE_OWNER: OWNER, INSTANCE_PROBE: "1" });
      const client = await joinFixture(server, fixture.id);
      clients.push(client);
      const loaded = server.events.find(event => event.event === "instance-loaded");
      assert.ok(loaded);
      assert.equal(loaded.changes, 0);
      assert.equal(loaded.stores, 0);
      assert.equal(loaded.flushes, 1);
      assert.deepEqual(loaded.observations, [{ loading: true, connections: 0, gc: true }]);
      assert.deepEqual(characterIdentities(client.document), ["a:7:0", "b:7:1", "c:7:2", "d:7:3"]);
      client.edit("X");
      await until(() => client.status === "Your changes saved to server", "probe live edit control");
      await until(() => server.events.some(event => event.event === "change"), "live change hook control");
    } finally { clients.forEach(client => client.destroy()); source?.destroy(); await work.clean(); }
  });

  await t.test("checkpoint captures pending dependencies: reverse g2/g1, duplicate, kill and late join", async () => {
    const work = await workspace();
    const clients: NodeInstanceReplica[] = [];
    let source: Y.Doc | undefined;
    try {
      let server = await work.start({ INSTANCE_OWNER: OWNER });
      const fixture = await createFixture(server);
      source = fixture.source;
      const client = await joinFixture(server, fixture.id);
      clients.push(client);
      source.clientID = 11;
      const updates: Uint8Array[] = [];
      source.on("update", (update: Uint8Array) => updates.push(update));
      source.getText("R1").insert(4, "X");
      source.getText("R1").insert(5, "Y");
      const [g1, g2] = updates;
      assert.ok(g1 && g2);
      let count = acknowledged(client).length;
      client.socket.send(syncFrame(fixture.id, 2, g2));
      await until(() => acknowledged(client).length === count + 1, "out of order receipt");
      await checkpoint(server, fixture.id);
      await server.command("instance-prune", { document: fixture.id }, "instance-pruned");
      await server.kill();
      server = await work.start({ INSTANCE_OWNER: OWNER });
      const late = await joinFixture(server, fixture.id);
      clients.push(late);
      assert.equal(late.document.getText("R1").toString(), "abcd");
      count = acknowledged(late).length;
      late.socket.send(syncFrame(fixture.id, 2, g1));
      late.socket.send(syncFrame(fixture.id, 2, g1));
      await until(() => acknowledged(late).length === count + 2, "dependency and duplicate receipts");
      const recovered = recoverIndependently(work.path, fixture.id, [g1, g2]);
      try { assert.deepEqual(characterIdentities(recovered), ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "X:11:0", "Y:11:1"]); }
      finally { recovered.destroy(); }
    } finally { clients.forEach(client => client.destroy()); source?.destroy(); await work.clean(); }
  });

  await t.test("newest valid checkpoint falls back before pruning; corruption after pruning quarantines", async () => {
    const work = await workspace();
    let source: Y.Doc | undefined;
    const clients: NodeInstanceReplica[] = [];
    try {
      let server = await work.start({ INSTANCE_OWNER: OWNER });
      const fixture = await createFixture(server);
      source = fixture.source;
      await checkpoint(server, fixture.id, "old");
      const client = await joinFixture(server, fixture.id);
      clients.push(client);
      client.edit("X");
      await until(() => client.status === "Your changes saved to server", "tail receipt");
      await checkpoint(server, fixture.id, "new");
      await server.kill();
      let db = new DatabaseSync(work.path);
      try { db.prepare("UPDATE instance_checkpoints SET digest = 'damaged' WHERE document = ? AND sequence = (SELECT MAX(sequence) FROM instance_checkpoints WHERE document = ?)").run(fixture.id, fixture.id); }
      finally { db.close(); }
      server = await work.start({ INSTANCE_OWNER: OWNER });
      const late = await joinFixture(server, fixture.id);
      clients.push(late);
      assert.equal(late.document.getText("R1").toString(), "abcdX");
      await server.command("instance-prune", { document: fixture.id }, "instance-pruned");
      await server.kill();
      db = new DatabaseSync(work.path);
      try { db.prepare("UPDATE instance_checkpoints SET digest = 'damaged' WHERE document = ?").run(fixture.id); }
      finally { db.close(); }
      server = await work.start({ INSTANCE_OWNER: OWNER });
      const broken = new NodeInstanceReplica(server.port, fixture.id, INVITE, new MemoryCompletionStore());
      clients.push(broken);
      await broken.connect();
      await until(() => server.stderr.includes("No valid checkpoint covers pruned journal"), "corrupt recovery refused");
      assert.equal(broken.hydrated, false);
      assert.equal(broken.document.getText("R1").length, 0);
    } finally { clients.forEach(client => client.destroy()); source?.destroy(); await work.clean(); }
  });

  await t.test("local completion failure leaves handoff uninvited and source available", async () => {
    const work = await workspace();
    const source = new Y.Doc();
    source.getText("R1").insert(0, "abcd");
    const store = new MemoryCompletionStore(async write => { if (write.membership) throw new Error("injected local failure"); });
    const handoff = new StandaloneHandoff(source, store, () => true);
    try {
      const server = await work.start({ INSTANCE_OWNER: OWNER });
      await assert.rejects(handoff.complete(server.port, "creation-k", OWNER, INVITE), /local failure/);
      assert.equal(handoff.invitation, null);
      assert.equal(source.getText("R1").toString(), "abcd");
      const retry = await instanceRequest(server.port, OWNER, { action: "create", operation: "creation-k", invite: INVITE });
      assertSingleCreation(work.path, [String(retry.id)]);
    } finally { handoff.destroy(); source.destroy(); await work.clean(); }
  });
}
