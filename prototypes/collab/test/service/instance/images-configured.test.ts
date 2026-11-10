import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { ImagePublication } from "../../../src/service/images/publication.ts";
import { imageControl } from "../../../src/service/images/configuration.ts";
import { readFrame } from "../../../src/service/wire.ts";
import { observeCapabilityInventory, observeNetworkWrites } from "../images/capabilities.ts";
import { observeImageReview } from "../images/review.ts";
import { ImageClient, imagePort, initial, membership, png, sha, upload } from "../images/harness.ts";
import type { ImageProbeTarget } from "../images/target.ts";
import { workspace } from "../harness.ts";
import { OWNER, INVITE, createFixture } from "./harness.ts";
import { instanceRequest } from "../../../src/service/instance/client.ts";

const target: ImageProbeTarget = {
  environment: { INSTANCE_OWNER: OWNER },
  async configure(server) {
    const fixture = await createFixture(server, "image-probe-k", "");
    fixture.source.destroy();
    return { instance: fixture.id, token: INVITE };
  },
};

test("real-instance image contract retains the literal closed inventory and hold assertions", async t => {
  await observeCapabilityInventory(t, target);
  await observeNetworkWrites(t, target);
  await observeImageReview(t, target);

  await t.test("blob upload/download admission is scoped to the instance invitation", async () => {
    const work = await workspace(); let longTokenClient: ImageClient | undefined;
    try {
      const server = await work.start({ IMAGE_POLICY: "1", INSTANCE_OWNER: OWNER });
      const first = await target.configure(server);
      const anotherInvite = `unrelated-invitation-${"x".repeat(160)}`;
      const other = await instanceRequest(server.port, OWNER, { action: "create", operation: "second-image-k", invite: anotherInvite });
      const second = { id: String(other.id) };
      const pendingDenied = await upload(server, png, sha, { instance: second.id, token: anotherInvite });
      assert.equal(pendingDenied.status, 403); await pendingDenied.arrayBuffer();
      assert.deepEqual(membership(work.path, second.id), []);
      assert.deepEqual(await readdir(`${work.path}.images`), []);
      const empty = new Y.Doc();
      try {
        await instanceRequest(server.port, OWNER, { action: "upload", operation: "second-image-k", payload: Buffer.from(Y.encodeStateAsUpdate(empty)).toString("base64") });
      } finally { empty.destroy(); }
      await instanceRequest(server.port, OWNER, { action: "commit", operation: "second-image-k" });
      const unauthorized = await upload(server, png, sha, { instance: first.instance, token: anotherInvite });
      assert.equal(unauthorized.status, 403); await unauthorized.arrayBuffer();
      assert.deepEqual(membership(work.path, first.instance), []);
      assert.deepEqual(await readdir(`${work.path}.images`), []);
      const valid = await upload(server, png, sha, first);
      assert.equal(valid.status, 201); await valid.arrayBuffer();
      assert.deepEqual(membership(work.path, first.instance), [sha]);
      for (const [instance, token] of [[first.instance, anotherInvite], [second.id, INVITE], [first.instance, ""]]) {
        const denied = await fetch(`http://127.0.0.1:${imagePort(server)}/api/images/${instance}/${sha}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
        });
        assert.equal(denied.status, 403); await denied.arrayBuffer();
      }
      const missingMembership = await fetch(`http://127.0.0.1:${imagePort(server)}/api/images/${second.id}/${sha}`, {
        headers: { Authorization: `Bearer ${anotherInvite}` }, signal: AbortSignal.timeout(15000),
      });
      assert.equal(missingMembership.status, 404); await missingMembership.arrayBuffer();
      const downloaded = await fetch(`http://127.0.0.1:${imagePort(server)}/api/images/${first.instance}/${sha}`, {
        headers: { Authorization: `Bearer ${first.token}` }, signal: AbortSignal.timeout(15000),
      });
      assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
      const configuration = { instance: second.id, token: anotherInvite };
      const image = new ImagePublication(initial(), "upload-before-sync", "two-documents", undefined, configuration);
      longTokenClient = new ImageClient(server.port, work.path, image, ["accepted"], null, configuration);
      await longTokenClient.connect(); await longTokenClient.saved();
      image.insert(png, sha);
      const auth = longTokenClient.frames.find(frame => frame.kind === 2); assert.ok(auth);
      const authBytes = Buffer.from(auth.bytes, "base64");
      assert.ok((readFrame(authBytes).payload[1] ?? 0) >= 128);
      assert.equal(image.allow(authBytes), true);
    } finally { longTokenClient?.destroy(); await work.clean(); }
  });

  await t.test("configuration is copied into private fields; noncanonical auth/control frames stay refused", async () => {
    const work = await workspace(); let client: ImageClient | undefined;
    try {
      const server = await work.start({ IMAGE_POLICY: "1", INSTANCE_OWNER: OWNER });
      const configuration = await target.configure(server);
      const input = { ...configuration };
      const image = new ImagePublication(initial(), "upload-before-sync", "two-documents", undefined, input);
      input.instance = "d00000000000000000000000000000000";
      input.token = "mutated-input-must-not-change-authentication";
      client = new ImageClient(server.port, work.path, image, ["accepted"], null, configuration);
      await client.connect(); await client.saved();
      const auth = client.frames.find(frame => frame.kind === 2); assert.ok(auth);
      assert.equal(readFrame(Buffer.from(auth.bytes, "base64")).name, configuration.instance);
      assert.ok(Buffer.from(auth.bytes, "base64").includes(Buffer.from(configuration.token)));
      assert.equal(Buffer.from(auth.bytes, "base64").includes(Buffer.from(input.token)), false);
      image.insert(png, sha);
      const active = client;
      const count = active.frames.length;
      assert.equal(image.allow(Buffer.from(auth.bytes, "base64")), true);
      for (const bytes of [
        imageControl(configuration.instance, 2, [0, "different-token", "4.8.0"]),
        imageControl(configuration.instance, 2, [0, configuration.token, "4.8.1"]),
        Buffer.concat([Buffer.from(auth.bytes, "base64"), Buffer.from([0])]),
        imageControl(input.instance, 2, [0, configuration.token, "4.8.0"]),
      ]) assert.throws(() => active.provider.send(bytes), /refuses outgoing frame kind 2/);
      assert.equal(active.frames.length, count);
      await active.drop();
      input.token = "changed-again-after-attach";
      active.expect("accepted");
      await active.connect(); await active.fence();
      const reconnectAuth = active.frames.findLast(frame => frame.kind === 2); assert.ok(reconnectAuth);
      assert.equal(reconnectAuth.bytes, auth.bytes);
      assert.equal(image.allow(imageControl(configuration.instance, 7)), true);
      assert.equal(image.allow(new Uint8Array([9])), true);
      assert.equal(image.allow(new Uint8Array([10])), true);
      for (const object of [image, image.editing, image.network, active.provider, image.capture(), image.export()]) {
        assert.equal(Reflect.ownKeys(object).some(key => /token|configuration|instance/i.test(String(key))), false);
        const serialized = JSON.stringify(object);
        assert.equal(serialized.includes(configuration.token), false);
      }
      const captured = image.capture();
      for (const encoded of [captured.editing, captured.network].filter((value): value is string => value !== null)) {
        const bytes = Buffer.from(encoded, "base64");
        const document = new Y.Doc();
        try {
          Y.applyUpdate(document, bytes);
          for (const key of document.share.keys()) assert.ok(["R1", "gallery", "identity"].includes(key));
          document.getText("R1"); document.getMap("gallery"); document.getMap("identity");
          for (const value of [configuration.token, createHash("sha256").update(configuration.token).digest("hex")]) {
            assert.equal(JSON.stringify(document.toJSON()).includes(value), false);
            assert.equal(bytes.includes(Buffer.from(value)), false);
          }
        } finally { document.destroy(); }
      }
      await active.fence();
      assert.deepEqual(membership(work.path, configuration.instance), []);
    } finally { client?.destroy(); await work.clean(); }
  });
});
