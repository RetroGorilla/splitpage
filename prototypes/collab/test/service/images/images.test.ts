import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import * as Y from "yjs";
import { ImagePublication } from "../../../src/service/images/publication.ts";
import type { ImageDesign, ImageReplicaCapture } from "../../../src/service/images/publication.ts";
import { readRecoveredRows, until, workspace } from "../harness.ts";
import { ImageClient, checkHeld, checkImagePromises, checkText, checkUploadReceipt, imagePort, initial, journalDocument,
  membership, offline, png, recoveredStore, saved, sha, upload, waiting, imageIdentities as characterIdentities } from "./harness.ts";
import type { ImageAcknowledgedCapture } from "./harness.ts";
import { observeImageReview } from "./review.ts";
import { observeNetworkWrites, observeCapabilityInventory } from "./capabilities.ts";

function publication(design: ImageDesign): ImagePublication { return new ImagePublication(initial(), design); }

test("image checker rejects all three premature-save defects before T16/T19 passes count", async t => {
  let defectsRejected = 0;
  for (const design of ["upload-before-sync", "pending-image"] as const) {
    await t.test(`deliberate defect: ${design} reports a gallery receipt saved before image durability`, async () => {
      const work = await workspace(); let client: ImageClient | undefined;
      class Premature extends ImagePublication {
        override status(receiptStatus: string): string { return receiptStatus; }
        override allow(): boolean { return true; }
      }
      try {
        const server = await work.start({ IMAGE_POLICY: "1", IMAGE_MISSING_RECEIPT: "1" });
        const image = new Premature(initial(), design);
        client = new ImageClient(server.port, work.path, image, ["accepted"]);
        await client.connect(); await client.saved();
        client.expect("accepted"); image.insert(png, sha);
        await client.saved(); await client.fence();
        client.observe(work.path);
        assert.ok(client.observed.some(view => view.status === saved && view.refs.includes(sha)));
        assert.throws(() => checkImagePromises(client?.observed ?? []), /Saved picture lacks durable server membership/);
        defectsRejected++;
        await writeFile(new URL(`../../../histories/T16-${design}-premature.json`, import.meta.url), `${JSON.stringify({
          shows: "An actual acknowledged gallery update and receipt-only saved status lack independently read durable image membership; the checker rejects it.",
          design, statuses: client.observed.filter(view => view.refs.length), recoveredMembership: membership(work.path),
          replay: "node --test --test-concurrency=1 test/service/images/images.test.ts",
        }, null, 2)}\n`);
      } finally { client?.destroy(); await work.clean(); }
    });
  }
  await t.test("deliberate defect: upload acknowledged before membership COMMIT", async () => {
    const work = await workspace();
    try {
      const server = await work.start({ IMAGE_POLICY: "1" });
      await server.command("image-configure", { hold: true, early: true }, "image-configured");
      const response = await upload(server); assert.equal(response.status, 201); await response.arrayBuffer();
      await server.kill();
      const recovered = await recoveredStore(work.path);
      assert.deepEqual(recovered.refs, []); assert.deepEqual(recovered.files, [sha]);
      assert.throws(() => checkUploadReceipt(sha, response.status, recovered), /Acknowledged upload lacks recovered membership/);
      defectsRejected++;
      await writeFile(new URL("../../../histories/T16-upload-before-membership.json", import.meta.url), `${JSON.stringify({
        shows: "HTTP 201 arrives while the harness keeps the pre-membership gate closed; hard kill leaves the file but no membership row. The upload checker rejects it.",
        httpStatus: response.status, recovered, replay: "node --test --test-concurrency=1 test/service/images/images.test.ts",
      }, null, 2)}\n`);
    } finally { await work.clean(); }
  });

  assert.equal(defectsRejected, 3, "All deliberate image defects must be rejected before any passing trace counts");
  await observeImageReview(t);
  await observeNetworkWrites(t);
  await observeCapabilityInventory(t);

  await t.test("blob upload: hash/size/header refusal before storage, duplicate and 2 MiB upload survive immediate hard kill", async () => {
    const work = await workspace();
    try {
      const server = await work.start({ IMAGE_POLICY: "1" });
      const wrong = await upload(server, Buffer.from("wrong")); assert.equal(wrong.status, 422); await wrong.arrayBuffer();
      const invalid = Buffer.from("not an image");
      const invalidRef = createHash("sha256").update(invalid).digest("hex");
      const header = await upload(server, invalid, invalidRef); assert.equal(header.status, 422); await header.arrayBuffer();
      const large = await upload(server, Buffer.alloc(16777217)); assert.equal(large.status, 413); await large.arrayBuffer();
      assert.deepEqual(await recoveredStore(work.path), { refs: [], files: [] });
      const response = await upload(server); assert.equal(response.status, 201); await response.arrayBuffer();
      assert.deepEqual(membership(work.path), [sha]);
      const duplicate = await upload(server); assert.equal(duplicate.status, 201); await duplicate.arrayBuffer();
      const bytes = Buffer.concat([png, Buffer.alloc(2097152 - png.length)]);
      const ref = createHash("sha256").update(bytes).digest("hex");
      const capacity = await upload(server, bytes, ref); assert.equal(capacity.status, 201); await capacity.arrayBuffer();
      await server.kill();
      const recovered = await recoveredStore(work.path);
      checkUploadReceipt(sha, response.status, recovered); checkUploadReceipt(ref, capacity.status, recovered);
      assert.deepEqual(recovered.refs, [sha, ref].sort());
      const restarted = await work.start({ IMAGE_POLICY: "1" });
      const get = await fetch(`http://127.0.0.1:${imagePort(restarted)}/api/images/fixture/${sha}`);
      assert.equal(get.status, 200); assert.deepEqual(Buffer.from(await get.arrayBuffer()), png);
      const absent = await fetch(`http://127.0.0.1:${imagePort(restarted)}/api/images/fixture/${"0".repeat(64)}`);
      assert.equal(absent.status, 404); await absent.arrayBuffer();
    } finally { await work.clean(); }
  });

  for (const mechanism of ["one-document", "two-documents"] as const) {
    for (const reload of [false, true]) {
      await t.test(`T16 upload-before-sync: ${mechanism}, reconnect${reload ? " after reload" : " with queued updates"}`, async () => {
        const work = await workspace(); const clients: ImageClient[] = []; const docs: Y.Doc[] = [];
        let pendingUpload: Promise<Response> | undefined;
        try {
          const server = await work.start({ IMAGE_POLICY: "1", REFUSAL_POLICY: "1" });
          let image = new ImagePublication(initial(), "upload-before-sync", mechanism);
          let client = new ImageClient(server.port, work.path, image); clients.push(client);
          await client.connect(); await client.saved(); checkText(image.editing, false); await client.drop();
          image.insert(png, sha); image.editing.getText("R1").insert(2, "Z");
          assert.equal(client.status, offline); checkText(image.editing, true);
          assert.deepEqual(image.export(), { text: "abZ", images: [sha], missingImages: [] });
          const states = [client.status];
          if (reload) {
            client.check(work.path, "abZ");
            const capture = { replica: image.capture(), acknowledged: { instance: work.path, updates: client.sent.filter(sent => sent.applied).map(sent => sent.payload) } };
            await writeFile(`${work.path}.local`, JSON.stringify(capture)); client.destroy(); clients.pop();
            const restored = JSON.parse(await readFile(`${work.path}.local`, "utf8")) as { replica: ImageReplicaCapture; acknowledged: ImageAcknowledgedCapture };
            const editing = new Y.Doc();
            image = new ImagePublication(editing, "upload-before-sync", mechanism, restored.replica);
            client = new ImageClient(server.port, work.path, image, mechanism === "two-documents" ? ["accepted"] : [], restored.acknowledged); clients.push(client);
            checkText(image.editing, true); assert.deepEqual(image.blobs.get(sha), png);
          } else if (mechanism === "two-documents") client.expect("accepted");
          await server.command("image-configure", { hold: true }, "image-configured");
          pendingUpload = upload(server);
          await until(() => server.events.some(event => event.event === "image-staged"), "upload staged while harness holds membership gate");
          await client.connect();
          await until(() => client.attempts.some(frame => frame.lifetime >= (reload ? 1 : 2) && frame.kind === 0 && frame.subtype === 1), "actual provider reconnect SyncStep2 attempt");
          await client.fence();
          states.push(client.status); assert.equal(client.status, waiting);
          checkText(image.editing, true);
          assert.deepEqual(membership(work.path), []);
          checkHeld(client.sent.map(sent => sent.payload));
          checkHeld(readRecoveredRows(work.path).map(row => row.payload));
          const before = journalDocument(work.path); docs.push(before); checkText(before, false);
          assert.deepEqual([...before.getMap("gallery").values()], []);
          if (mechanism === "two-documents") {
            checkText(image.network, false); assert.deepEqual([...image.network.getMap("gallery").values()], []);
          } else {
            assert.deepEqual(image.network.snapshot(), image.editing.snapshot());
            assert.throws(() => checkHeld([Buffer.from(image.network.snapshot()).toString("base64")]), /Held image or subsequent text/);
            const attempted = client.attempts.filter(frame => frame.kind === 0 && frame.subtype === 1).at(-1);
            assert.ok(attempted); assert.throws(() => checkHeld([attempted.payload]), /Held image or subsequent text/);
            if (!reload) await writeFile(new URL("../../../histories/T16-one-document-N.json", import.meta.url), `${JSON.stringify({
              shows: "A one-document transport gate holds every actual update/SyncStep2 before membership, but the provider document already contains gP and Z. It cannot satisfy the literal separate-N clause.",
              providerDocument: characterIdentities(image.network), providerGallery: image.items,
              outgoingUpdatesBeforeMembership: client.sent.map(sent => ({ subtype: sent.subtype, payload: sent.payload })),
              membership: membership(work.path), replay: "node --test --test-concurrency=1 test/service/images/images.test.ts",
            }, null, 2)}\n`);
          }
          const vector = Y.encodeStateVector(before);
          const released = new Y.Doc(); docs.push(released); Y.applyUpdate(released, image.editing.snapshot());
          const release = Y.encodeStateAsUpdate(released, vector);
          await server.command("configure", { hold: Buffer.from(release).toString("base64") });
          server.child.send({ command: "image-release" });
          const uploaded = await pendingUpload; pendingUpload = undefined;
          assert.equal(uploaded.status, 201); await uploaded.arrayBuffer();
          assert.deepEqual(membership(work.path), [sha]);
          client.expect(...(mechanism === "two-documents" ? ["accepted", "accepted"] as const : ["accepted"] as const));
          image.durable(sha);
          await until(() => server.events.some(event => event.event === "held"), "covering receipt held after image upload");
          assert.equal(client.status, "Saved on this device, sending");
          server.child.send({ command: "release", gate: "held" });
          await client.saved(); await client.fence(); states.push(client.status);
          checkText(image.editing, true); checkText(image.network, true);
          assert.deepEqual(states, [offline, waiting, saved]);
          client.observe(work.path); client.check(work.path, "abZ");
          await server.kill(); assert.deepEqual((await recoveredStore(work.path)).refs, [sha]);
          const recovered = journalDocument(work.path); docs.push(recovered); checkText(recovered, true);
          assert.deepEqual([...recovered.getMap("gallery").values()], [{ id: "gP", beat: "R1", ref: sha, pending: false }]);
          const restarted = await work.start({ IMAGE_POLICY: "1" });
          const peerImage = new ImagePublication(new Y.Doc(), "upload-before-sync");
          const peer = new ImageClient(restarted.port, work.path, peerImage); clients.push(peer);
          await peer.connect(); await peer.fence(); checkText(peerImage.editing, true);
          assert.equal(peerImage.picture(sha), "placeholder"); assert.equal(peer.status, waiting);
          const download = await fetch(`http://127.0.0.1:${imagePort(restarted)}/api/images/fixture/${sha}`);
          const bytes = Buffer.from(await download.arrayBuffer()); assert.deepEqual(bytes, png);
          peerImage.blobs.set(sha, bytes); peer.expect("accepted"); peerImage.durable(sha);
          await peer.saved(); await peer.fence(); checkText(peerImage.editing, true);
          assert.equal(peerImage.picture(sha), "picture"); peer.check(work.path, "abZ");
        } finally {
          for (const client of clients) client.destroy(); for (const doc of docs) doc.destroy();
          await work.clean(); await pendingUpload?.catch(() => {});
        }
      });
    }
  }

  for (const neverReturns of [false, true]) {
    await t.test(`T16 pending-image: reconnect, duplicate sync, late peer; uploader ${neverReturns ? "never returns" : "uploads"}`, async () => {
      const work = await workspace(); const clients: ImageClient[] = []; const docs: Y.Doc[] = [];
      try {
        const server = await work.start({ IMAGE_POLICY: "1", REFUSAL_POLICY: "1" });
        const image = publication("pending-image"); const client = new ImageClient(server.port, work.path, image); clients.push(client);
        await client.connect(); await client.saved(); checkText(image.editing, false); await client.drop();
        image.insert(png, sha); image.editing.getText("R1").insert(2, "Z"); assert.equal(client.status, offline);
        checkText(image.editing, true);
        assert.deepEqual(image.export(), { text: "abZ", images: [sha], missingImages: [] });
        client.expect("accepted", "accepted", "accepted"); await client.connect(); await client.fence();
        assert.equal(client.status, waiting); checkText(image.editing, true);
        const durable = journalDocument(work.path); docs.push(durable); checkText(durable, true);
        assert.deepEqual([...durable.getMap("gallery").values()], [{ id: "gP", beat: "R1", ref: sha, pending: true }]);
        client.expect("accepted"); client.provider.forceSync(); await client.fence(); checkText(image.editing, true);
        const peerImage = new ImagePublication(new Y.Doc(), "pending-image");
        const peer = new ImageClient(server.port, work.path, peerImage); clients.push(peer);
        await peer.connect(); await peer.fence(); checkText(peerImage.editing, true);
        assert.deepEqual(peerImage.items, [{ id: "gP", beat: "R1", ref: sha, pending: true }]);
        assert.equal(peerImage.picture(sha), "placeholder"); assert.equal(peer.status, waiting);
        assert.deepEqual(peerImage.export(), { text: "abZ", images: [], missingImages: [sha] });
        assert.deepEqual(membership(work.path), []); client.check(work.path, "abZ"); peer.check(work.path, "abZ");
        if (neverReturns) {
          await client.drop(); checkText(image.editing, true); checkText(peerImage.editing, true); await server.kill();
          const restarted = await work.start({ IMAGE_POLICY: "1" });
          const lateImage = new ImagePublication(new Y.Doc(), "pending-image");
          const late = new ImageClient(restarted.port, work.path, lateImage); clients.push(late);
          await late.connect(); await late.fence(); checkText(lateImage.editing, true);
          assert.deepEqual(lateImage.items, [{ id: "gP", beat: "R1", ref: sha, pending: true }]);
          assert.equal(lateImage.picture(sha), "placeholder"); assert.equal(late.status, waiting);
          assert.deepEqual(lateImage.export(), { text: "abZ", images: [], missingImages: [sha] }); late.check(work.path, "abZ");
          checkText(peerImage.editing, true); checkText(image.editing, true);
        } else {
          const uploaded = await upload(server); assert.equal(uploaded.status, 201); await uploaded.arrayBuffer();
          const next = new Y.Doc(); docs.push(next); Y.applyUpdate(next, image.editing.snapshot()); next.clientID = 11;
          const vector = Y.encodeStateVector(next); const item = image.items[0]; assert.ok(item);
          next.getMap("gallery").set("gP", { ...item, pending: false });
          await server.command("configure", { hold: Buffer.from(Y.encodeStateAsUpdate(next, vector)).toString("base64") });
          client.expect("accepted", "accepted"); image.durable(sha);
          await until(() => server.events.some(event => event.event === "held"), "pending flag receipt held");
          checkText(image.editing, true); checkText(peerImage.editing, true);
          assert.equal(client.status, "Saved on this device, sending"); assert.equal(peerImage.picture(sha), "placeholder");
          server.child.send({ command: "release", gate: "held" }); await client.saved(); await client.fence();
          await until(() => peerImage.items[0]?.pending === false, "peer receives completed image flag");
          checkText(image.editing, true); checkText(peerImage.editing, true);
          assert.equal(peer.status, waiting);
          const get = await fetch(`http://127.0.0.1:${imagePort(server)}/api/images/fixture/${sha}`);
          const bytes = Buffer.from(await get.arrayBuffer()); assert.deepEqual(bytes, png);
          peerImage.blobs.set(sha, bytes); peer.expect("accepted"); peerImage.durable(sha);
          await peer.saved(); await peer.fence(); assert.equal(peerImage.picture(sha), "picture");
          checkText(image.editing, true); checkText(peerImage.editing, true);
          client.observe(work.path); peer.observe(work.path); client.check(work.path, "abZ"); peer.check(work.path, "abZ");
        }
      } finally { for (const client of clients) client.destroy(); for (const doc of docs) doc.destroy(); await work.clean(); }
    });
  }

  for (const mechanism of ["one-document", "two-documents"] as const) {
    await t.test(`upload hold with concurrent inbound text: ${mechanism}`, async () => {
      const work = await workspace(); const clients: ImageClient[] = []; const docs: Y.Doc[] = [];
      try {
        const server = await work.start({ IMAGE_POLICY: "1", REFUSAL_POLICY: "1" });
        const image = new ImagePublication(initial(), "upload-before-sync", mechanism);
        const client = new ImageClient(server.port, work.path, image); clients.push(client);
        await client.connect(); await client.saved(); await client.drop();
        image.insert(png, sha); image.editing.getText("R1").insert(2, "Z");
        if (mechanism === "two-documents") client.expect("accepted");
        await client.connect(); await client.fence(); assert.equal(client.status, waiting);
        const peerImage = new ImagePublication(new Y.Doc(), "upload-before-sync");
        const peer = new ImageClient(server.port, work.path, peerImage); clients.push(peer);
        await peer.connect(); await peer.saved(); peerImage.editing.clientID = 22;
        peer.expect("accepted"); peerImage.editing.getText("R1").insert(2, "X"); await peer.saved();
        assert.deepEqual(characterIdentities(peerImage.editing), ["a:7:0", "b:7:1", "X:22:0"]);
        await until(() => image.editing.getText("R1").length === 4, "inbound integrates while image holds outbound work");
        assert.deepEqual(characterIdentities(image.editing), ["a:7:0", "b:7:1", "Z:11:1", "X:22:0"]);
        await client.fence(); checkHeld(client.sent.map(sent => sent.payload));
        const before = journalDocument(work.path); docs.push(before);
        assert.deepEqual(characterIdentities(before), ["a:7:0", "b:7:1", "X:22:0"]);
        const uploaded = await upload(server); assert.equal(uploaded.status, 201); await uploaded.arrayBuffer();
        client.expect(...(mechanism === "two-documents" ? ["accepted", "accepted"] as const : ["accepted"] as const));
        image.durable(sha); await client.saved(); await client.fence();
        client.check(work.path, ["a:7:0", "b:7:1", "Z:11:1", "X:22:0"]);
        await peer.fence();
        assert.deepEqual(characterIdentities(image.editing), ["a:7:0", "b:7:1", "Z:11:1", "X:22:0"]);
        assert.deepEqual(characterIdentities(peerImage.editing), ["a:7:0", "b:7:1", "Z:11:1", "X:22:0"]);
        peer.check(work.path, ["a:7:0", "b:7:1", "Z:11:1", "X:22:0"]);
        const after = journalDocument(work.path); docs.push(after);
        assert.deepEqual(characterIdentities(after), ["a:7:0", "b:7:1", "Z:11:1", "X:22:0"]);
      } finally { for (const client of clients) client.destroy(); for (const doc of docs) doc.destroy(); await work.clean(); }
    });
  }

  await t.test("pending-image reload restores pending flag, local bytes and receipt coverage before upload retry", async () => {
    const work = await workspace(); const clients: ImageClient[] = [];
    try {
      const server = await work.start({ IMAGE_POLICY: "1" });
      const image = publication("pending-image"); const client = new ImageClient(server.port, work.path, image); clients.push(client);
      await client.connect(); await client.saved(); await client.drop();
      image.insert(png, sha); image.editing.getText("R1").insert(2, "Z");
      client.expect("accepted", "accepted", "accepted"); await client.connect(); await client.fence(); client.check(work.path, "abZ");
      checkText(image.editing, true);
      const capture = { replica: image.capture(), acknowledged: { instance: work.path, updates: client.sent.filter(sent => sent.applied).map(sent => sent.payload) } };
      await writeFile(`${work.path}.local`, JSON.stringify(capture)); client.destroy(); clients.pop();
      const restored = JSON.parse(await readFile(`${work.path}.local`, "utf8")) as { replica: ImageReplicaCapture; acknowledged: ImageAcknowledgedCapture };
      const resumedImage = new ImagePublication(new Y.Doc(), "pending-image", "one-document", restored.replica);
      const resumed = new ImageClient(server.port, work.path, resumedImage, ["accepted"], restored.acknowledged); clients.push(resumed);
      checkText(resumedImage.editing, true); assert.deepEqual(resumedImage.blobs.get(sha), png);
      assert.deepEqual(resumedImage.items, [{ id: "gP", beat: "R1", ref: sha, pending: true }]);
      await resumed.connect(); await resumed.fence(); assert.equal(resumed.status, waiting);
      const response = await upload(server); assert.equal(response.status, 201); await response.arrayBuffer();
      resumed.expect("accepted", "accepted"); resumedImage.durable(sha); await resumed.saved(); await resumed.fence(); resumed.check(work.path, "abZ");
      checkText(resumedImage.editing, true);
    } finally { for (const client of clients) client.destroy(); await work.clean(); }
  });

  await t.test("H11: outgoingMessage listener cannot cancel incremental or reconnect SyncStep2", async () => {
    const work = await workspace(); let client: ImageClient | undefined;
    try {
      const server = await work.start({ IMAGE_POLICY: "1" });
      const image = publication("pending-image"); client = new ImageClient(server.port, work.path, image);
      await client.connect(); await client.saved();
      let notifications = 0;
      client.provider.outgoing(() => { notifications++; return false; });
      client.expect("accepted"); image.insert(png, sha); await client.fence();
      assert.equal(client.sent.at(-1)?.subtype, 2); assert.equal(client.sent.at(-1)?.applied, true);
      await client.drop(); client.expect("accepted"); await client.connect(); await client.fence();
      assert.equal(client.sent.at(-1)?.subtype, 1); assert.equal(client.sent.at(-1)?.applied, true);
      assert.ok(notifications >= 2); client.check(work.path, "ab");
    } finally { client?.destroy(); await work.clean(); }
  });

  await t.test("T19 (c): missing blob refusal is message-only; upload and forceSync get a covering receipt without detach", async () => {
    const work = await workspace(); const clients: ImageClient[] = []; const docs: Y.Doc[] = [];
    try {
      const server = await work.start({ IMAGE_POLICY: "1", REFUSAL_POLICY: "1" });
      const image = publication("pending-image"); const client = new ImageClient(server.port, work.path, image); clients.push(client);
      await client.connect(); await client.saved();
      const peerImage = new ImagePublication(new Y.Doc(), "pending-image");
      const peer = new ImageClient(server.port, work.path, peerImage); clients.push(peer);
      await peer.connect(); await peer.saved(); const before = readRecoveredRows(work.path);
      image.blobs.set(sha, png); client.expect("missing-blob");
      image.editing.getMap("gallery").set("gP", { id: "gP", beat: "R1", ref: sha, pending: false });
      await client.fence();
      await peer.fence(); checkText(image.editing, false); checkText(peerImage.editing, false); assert.deepEqual(peerImage.items, []);
      assert.deepEqual(client.notices.filter(notice => !notice.startsWith('{"imageFence":')), [JSON.stringify({ retryAfter: sha, permanent: false })]);
      assert.equal(client.sent.at(-1)?.applied, false); assert.deepEqual(readRecoveredRows(work.path), before);
      assert.equal(client.policy.current(client.status).publication, "retry-after"); assert.equal(client.status, waiting);
      const state = journalDocument(work.path); docs.push(state); checkText(state, false);
      assert.deepEqual([...state.getMap("gallery").values()], []);
      const uploaded = await upload(server); assert.equal(uploaded.status, 201); await uploaded.arrayBuffer();
      const retry = new Y.Doc(); docs.push(retry); Y.applyUpdate(retry, image.editing.snapshot());
      const difference = Y.encodeStateAsUpdate(retry, Y.encodeStateVector(state));
      await server.command("configure", { hold: Buffer.from(difference).toString("base64") });
      client.expect("accepted"); image.durable(sha);
      await until(() => server.events.some(event => event.event === "held"), "retry forceSync held before receipt");
      assert.equal(client.status, "Saved on this device, sending"); assert.equal(client.receipts.outstanding, 1);
      server.child.send({ command: "release", gate: "held" });
      await client.saved(); await client.fence();
      await peer.fence(); checkText(image.editing, false); checkText(peerImage.editing, false);
      assert.deepEqual(peerImage.items, [{ id: "gP", beat: "R1", ref: sha, pending: false }]);
      assert.equal(client.sent.at(-1)?.subtype, 1); assert.equal(client.sent.at(-1)?.applied, true);
      assert.equal(client.policy.current(client.status).publication, "attached"); assert.equal(client.provider.shouldConnect(), true);
      assert.equal(client.receipts.outstanding, 0);
      client.expect("accepted"); image.editing.getText("R1").insert(2, "Z");
      await client.saved(); await client.fence(); assert.equal(new Set(client.frames.map(frame => frame.lifetime)).size, 1);
      await peer.fence(); checkText(image.editing, true); checkText(peerImage.editing, true);
      client.check(work.path, "abZ"); peer.check(work.path, "abZ");
      const recovered = journalDocument(work.path); docs.push(recovered); checkText(recovered, true);
      assert.deepEqual([...recovered.getMap("gallery").values()], [{ id: "gP", beat: "R1", ref: sha, pending: false }]);
    } finally { for (const client of clients) client.destroy(); for (const doc of docs) doc.destroy(); await work.clean(); }
  });
});
