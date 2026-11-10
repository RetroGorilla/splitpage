import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import * as Y from "yjs";
import { instanceRequest, NodeInstanceReplica, MemoryCompletionStore } from "../../../src/service/instance/client.ts";
import { characterIdentities, until, workspace } from "../harness.ts";
import { membership, png, sha } from "../images/harness.ts";
import { OWNER, INVITE, checkpoint, releaseGate, waitGate } from "./harness.ts";
import { assertInvitation, assertSingleCreation, inspectInstance, recoverIndependently } from "./oracle.ts";
import { rejectInstanceDefects } from "./defects.ts";
import { ImageCreationHandoff, ImageLocalStore, ScopedImageReplica, assertPictureDocument, assertStoredP, initialInstance } from "./image-harness.ts";

const expected13 = ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "X:11:0", "Y:11:1"];
const expected17 = ["a:7:0", "b:7:1", "c:11:0", "d:12:0"];

function snapshot(bytes: Uint8Array): Y.Doc {
  const document = new Y.Doc(); Y.applyUpdate(document, bytes); return document;
}

test("image-bearing instance traces require all old defects and the lost-blob defect to be rejected first", { timeout: 180000 }, async t => {
  let rejected = 0;
  await t.test("existing duplicate/invitation/checkpoint/pruning defects still fail their independent checkers", async () => {
    await rejectInstanceDefects(); rejected++;
  });
  for (const design of ["pending-image", "upload-before-sync"] as const) {
    await t.test(`deliberate lost P after checkpoint/restart is rejected: ${design}`, async () => {
      const work = await workspace(); const clients: ScopedImageReplica[] = [];
      let source: Y.Doc | undefined;
      try {
        let server = await work.start({ INSTANCE_OWNER: OWNER, IMAGE_POLICY: "1" });
        const fixture = await initialInstance(server, "abcd"); source = fixture.source;
        const empty = new Y.Doc();
        const peer = new ScopedImageReplica(server, work.path, { instance: fixture.id, token: INVITE }, design, new ImageLocalStore(), empty);
        empty.destroy(); clients.push(peer);
        await peer.connect(); await peer.hydrate(server);
        peer.publishSnapshot(); await peer.fence();
        await checkpoint(server, fixture.id);
        await server.command("instance-prune", { document: fixture.id }, "instance-pruned");
        const receipts = peer.acknowledged();
        peer.destroy(); clients.length = 0;
        await until(() => peer.receipts.status === "Offline, saved on this device", "defect peer physically left");
        await server.kill();
        await unlink(join(`${work.path}.images`, sha));
        server = await work.start({ INSTANCE_OWNER: OWNER, IMAGE_POLICY: "1" });
        const recovered = recoverIndependently(work.path, fixture.id, receipts);
        try { assertPictureDocument(recovered, fixture.id, "abcd", ["a:7:0", "b:7:1", "c:7:2", "d:7:3"]); }
        finally { recovered.destroy(); }
        assert.deepEqual(membership(work.path, fixture.id), [sha]);
        await assert.rejects(assertStoredP(work.path, fixture.id), /Recovered picture bytes missing/);
        rejected++;
      } finally { clients.forEach(client => client.destroy()); source?.destroy(); await work.clean(); }
    });
  }
  assert.equal(rejected, 3, "No honest image-bearing trace may run before every defect is rejected");

  for (const design of ["pending-image", "upload-before-sync"] as const) {
    for (const variant of ["normal", "upload restart", "lost commit response"] as const) {
      await t.test(`T13 with P: ${design}, ${variant}, duplicate and late replica`, async () => {
        const work = await workspace(); const clients: ScopedImageReplica[] = [];
        let guest: NodeInstanceReplica | undefined;
        let releaseLocal: (() => void) | undefined;
        const localGate = new Promise<void>(resolve => { releaseLocal = resolve; });
        let membershipHeld = false;
        let localReleased = false;
        const store = new ImageLocalStore(async captured => {
          if (captured.membership) { membershipHeld = true; await localGate; }
        });
        let completion: Promise<void> | undefined;
        let failed: Promise<unknown> | undefined;
        try {
          let server = await work.start({ INSTANCE_OWNER: OWNER, IMAGE_POLICY: "1" });
          await server.command("image-configure", { hold: true }, "image-configured");
          const onInvitation = async (link: string): Promise<void> => {
            assert.equal(localReleased, true, "Invitation cannot publish while the harness forbids local commit");
            const record = await store.hydrate(); assert.ok(record?.membership);
            assertInvitation(work.path, record.membership, link, record.membership);
            await assertStoredP(work.path, record.membership);
          };
          let handoff = await ImageCreationHandoff.begin(server, work.path, design, store, undefined, onInvitation);
          clients.push(handoff.replica);
          const id = handoff.replica.configuration.instance;
          assert.match(id, /^d[0-9a-f]{32}$/);
          assert.notEqual(id, "d00000000000000000000000000000001");
          completion = handoff.complete(); failed = completion.catch((error: unknown) => error);
          await until(() => server.events.some(event => event.event === "image-staged"), "P staged behind harness-held membership gate");
          await until(() => {
            const db = new DatabaseSync(work.path, { readOnly: true });
            try { return db.prepare("SELECT COUNT(*) AS count FROM instance_uploads WHERE document=?").get(id)?.count === 1; }
            finally { db.close(); }
          }, "g0 upload completed while P membership is held");
          await handoff.type("X"); await handoff.type("Y");
          const local = await store.hydrate(); assert.ok(local);
          assert.equal(local.generation, 2); assert.deepEqual(local.manifest, [sha]);
          assert.deepEqual(local.blobs.map(blob => [blob.hash, Buffer.from(blob.bytes)]), [[sha, png]]);
          const retained = new Y.Doc();
          try {
            local.updates.forEach(bytes => Y.applyUpdate(retained, bytes));
            assert.equal(retained.getText("R1").toString(), "abcdXY");
            assert.deepEqual(characterIdentities(retained), expected13);
          } finally { retained.destroy(); }
          const network = snapshot(handoff.replica.publication.network.snapshot());
          try {
            assert.equal(network.getText("R1").toString(), design === "upload-before-sync" ? "" : "abcdXY");
            assert.equal(network.getMap("gallery").size, design === "upload-before-sync" ? 0 : 1);
          } finally { network.destroy(); }
          assert.deepEqual(membership(work.path, id), []);
          assert.equal(inspectInstance(work.path, id).instances[0]?.state, "pending");
          await assert.rejects(instanceRequest(server.port, OWNER, { action: "commit", operation: handoff.operation }), /409/);
          assert.equal(handoff.invitation, null);
          guest = new NodeInstanceReplica(server.port, id, INVITE, new MemoryCompletionStore());
          let guestRefused = false;
          guest.provider.on("authenticationFailed", () => { guestRefused = true; });
          await guest.connect(); await until(() => guestRefused, "pending guest refused with P");
          assert.equal(guest.hydrated, false); guest.destroy(); guest = undefined;

          if (variant === "upload restart") {
            await server.kill(); await failed;
            const saved = await store.hydrate(); assert.ok(saved?.creation);
            assert.equal(saved.creation.instance, id); assert.equal(saved.membership, null);
            handoff.replica.destroy(); clients.length = 0;
            server = await work.start({ INSTANCE_OWNER: OWNER, IMAGE_POLICY: "1" });
            handoff = await ImageCreationHandoff.begin(server, work.path, design, store, saved, onInvitation);
            clients.push(handoff.replica);
            completion = handoff.complete(); failed = completion.catch((error: unknown) => error);
          } else {
            if (variant === "lost commit response") await server.command("configure", { instanceHold: "after-commit" });
            server.child.send({ command: "image-release" });
            if (variant === "lost commit response") {
              await waitGate(server, "after-commit");
              await assertStoredP(work.path, id);
              await server.kill(); await failed;
              const saved = await store.hydrate(); assert.ok(saved?.creation);
              handoff.replica.destroy(); clients.length = 0;
              server = await work.start({ INSTANCE_OWNER: OWNER, IMAGE_POLICY: "1" });
              handoff = await ImageCreationHandoff.begin(server, work.path, design, store, saved, onInvitation);
              clients.push(handoff.replica);
              completion = handoff.complete(); failed = completion.catch((error: unknown) => error);
            }
          }
          await until(() => membershipHeld, "final local image membership completion held");
          assert.equal(handoff.invitation, null);
          assert.equal(inspectInstance(work.path, id).instances[0]?.state, "committed");
          await assertStoredP(work.path, id);
          assert.equal((await store.hydrate())?.membership, null);
          localReleased = true; releaseLocal?.(); await completion;
          const committed = await store.hydrate(); assert.ok(committed);
          assertInvitation(work.path, id, handoff.invitation, committed.membership);
          const retry = await instanceRequest(server.port, OWNER, { action: "create", operation: handoff.operation, invite: INVITE });
          assertSingleCreation(work.path, [id, String(retry.id)]);
          await server.command("configure", { instanceHold: "before-receipt" });
          await handoff.replica.connect(); await waitGate(server, "before-receipt");
          assert.equal(handoff.replica.status, "Saved on this device, sending");
          assert.equal(handoff.replica.acknowledged().length, 0);
          handoff.replica.publishSnapshot();
          await server.command("configure"); releaseGate(server, "before-receipt");
          await handoff.replica.saved(); await handoff.replica.fence();
          handoff.replica.publishSnapshot(); await handoff.replica.fence();
          await handoff.replica.persist(handoff.creation(), id);
          const owned = snapshot(handoff.replica.publication.editing.snapshot());
          try { assertPictureDocument(owned, id, "abcdXY", expected13); }
          finally { owned.destroy(); }
          assert.equal(handoff.replica.publication.picture(sha), "picture");
          assert.deepEqual(handoff.replica.publication.export(), { text: "abcdXY", images: [sha], missingImages: [] });
          const recovered = recoverIndependently(work.path, id, handoff.replica.acknowledged());
          try { assertPictureDocument(recovered, id, "abcdXY", expected13); }
          finally { recovered.destroy(); }
          const finalLocal = await store.hydrate(); assert.ok(finalLocal);
          const localDocument = snapshot(finalLocal.editor);
          try { assertPictureDocument(localDocument, id, "abcdXY", expected13); }
          finally { localDocument.destroy(); }
          handoff.replica.destroy(); clients.length = 0;
          await until(() => handoff.replica.receipts.status === "Offline, saved on this device", "handoff owner physically left");
          await server.kill();
          server = await work.start({ INSTANCE_OWNER: OWNER, IMAGE_POLICY: "1" });
          await assertStoredP(work.path, id);
          const seed = new Y.Doc();
          const late = new ScopedImageReplica(server, work.path, { instance: id, token: INVITE }, design, new ImageLocalStore(), seed);
          seed.destroy(); clients.push(late);
          await late.connect(); await late.hydrate(server);
          const document = snapshot(late.publication.editing.snapshot());
          try { assertPictureDocument(document, id, "abcdXY", expected13); }
          finally { document.destroy(); }
          assert.equal(late.publication.picture(sha), "picture");
          assert.equal(late.status, "Saved on this device");
          assert.deepEqual(late.publication.export(), { text: "abcdXY", images: [sha], missingImages: [] });
        } finally {
          releaseLocal?.(); guest?.destroy(); clients.forEach(client => client.destroy()); await work.clean(); await failed;
        }
      });
    }

    for (const withCheckpoint of [false, true]) {
      await t.test(`T17 with P: ${design}, ${withCheckpoint ? "checkpoint and tail" : "journal"}, invited C hydrates picture before editing`, async () => {
        const work = await workspace(); const clients: ScopedImageReplica[] = [];
        let source: Y.Doc | undefined; let releaseHydration: (() => void) | undefined; let releaseLocalHydration: (() => void) | undefined;
        try {
          let server = await work.start({ INSTANCE_OWNER: OWNER, IMAGE_POLICY: "1" });
          const fixture = await initialInstance(server, "ab"); source = fixture.source;
          const createPeer = (gate: () => Promise<void> = async () => {}, store = new ImageLocalStore()): ScopedImageReplica => {
            const empty = new Y.Doc();
            try { return new ScopedImageReplica(server, work.path, { instance: fixture.id, token: INVITE }, design, store, empty, undefined, undefined, gate); }
            finally { empty.destroy(); }
          };
          const alice = createPeer(); const bob = createPeer(); clients.push(alice, bob);
          await alice.connect(); await alice.hydrate(server);
          await bob.connect(); await bob.hydrate(server);
          alice.publication.editing.clientID = 11; bob.publication.editing.clientID = 12;
          alice.type("c"); await alice.persist(); await alice.saved();
          await until(() => bob.publication.editing.getText("R1").toString() === "abc", "B receives c before d");
          if (withCheckpoint) {
            await checkpoint(server, fixture.id);
            await server.command("instance-prune", { document: fixture.id }, "instance-pruned");
          }
          bob.type("d"); await bob.persist(); await bob.saved(); await bob.fence();
          await until(() => alice.publication.editing.getText("R1").toString() === "abcd", "A receives d");
          const receipts = [...alice.acknowledged(), ...bob.acknowledged()];
          const before = recoverIndependently(work.path, fixture.id, receipts);
          try { assertPictureDocument(before, fixture.id, "abcd", expected17); }
          finally { before.destroy(); }
          alice.destroy(); bob.destroy(); clients.length = 0;
          await until(() => alice.receipts.status === "Offline, saved on this device" && bob.receipts.status === "Offline, saved on this device", "A and B physically left");
          await server.kill();
          await assertStoredP(work.path, fixture.id);
          const recovered = recoverIndependently(work.path, fixture.id, receipts);
          try { assertPictureDocument(recovered, fixture.id, "abcd", expected17); }
          finally { recovered.destroy(); }
          server = await work.start({ INSTANCE_OWNER: OWNER, IMAGE_POLICY: "1" });
          let hydrationHeld = false;
          const gate = new Promise<void>(resolve => { releaseHydration = resolve; });
          let localHydrationHeld = false;
          const localGate = new Promise<void>(resolve => { releaseLocalHydration = resolve; });
          const store = new ImageLocalStore(async () => { localHydrationHeld = true; await localGate; });
          const carol = createPeer(async () => { hydrationHeld = true; await gate; }, store); clients.push(carol);
          assert.throws(() => carol.type("forbidden"), /not hydrated/);
          await carol.connect();
          const hydration = carol.hydrate(server);
          await until(() => hydrationHeld, "C state received but picture hydration held");
          assert.equal(carol.publication.picture(sha), "placeholder");
          assert.equal(carol.status, "Saving on this device");
          assert.throws(() => carol.type("forbidden"), /not hydrated/);
          releaseHydration?.();
          await until(() => localHydrationHeld, "C picture verified but local transaction still held");
          assert.equal(carol.publication.picture(sha), "picture");
          assert.equal(await store.hydrate(), null);
          assert.equal(carol.status, "Saving on this device");
          assert.throws(() => carol.type("forbidden"), /not hydrated/);
          releaseLocalHydration?.(); await hydration;
          const loaded = snapshot(carol.publication.editing.snapshot());
          try { assertPictureDocument(loaded, fixture.id, "abcd", expected17); }
          finally { loaded.destroy(); }
          assert.equal(carol.status, "Saved on this device");
          assert.equal(carol.publication.picture(sha), "picture");
          assert.deepEqual(carol.publication.export(), { text: "abcd", images: [sha], missingImages: [] });
          const local = await carol.store.hydrate(); assert.ok(local);
          assert.deepEqual(local.manifest, [sha]);
          assert.deepEqual(local.blobs.map(blob => [blob.hash, Buffer.from(blob.bytes)]), [[sha, png]]);
          await assertStoredP(work.path, fixture.id);
          carol.publication.editing.clientID = 13;
          carol.type("E"); await carol.persist(); await carol.saved();
          const edited = snapshot(carol.publication.editing.snapshot());
          try { assertPictureDocument(edited, fixture.id, "abcdE", ["a:7:0", "b:7:1", "c:11:0", "d:12:0", "E:13:0"]); }
          finally { edited.destroy(); }
        } finally { releaseHydration?.(); releaseLocalHydration?.(); clients.forEach(client => client.destroy()); source?.destroy(); await work.clean(); }
      });
    }
  }
});
