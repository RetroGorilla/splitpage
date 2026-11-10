import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { ImagePublication } from "../../../src/service/images/publication.ts";
import { ConnectionReceipts } from "../../../src/service/receipts.ts";
import { syncFrame } from "../../../src/service/wire.ts";
import { workspace } from "../harness.ts";
import { ImageClient, checkHeld, checkText, imageIdentities, initial, journalDocument, membership, png, saved, sha, upload, waiting } from "./harness.ts";

function opaqueFrame(kind: number, payload: Uint8Array): Uint8Array {
  let length = payload.length;
  const size: number[] = [];
  while (length > 127) { size.push(length & 127 | 128); length >>>= 7; }
  size.push(length);
  return Buffer.concat([Buffer.from([7, ...Buffer.from("fixture"), kind, ...size]), payload]);
}

export async function observeImageReview(t: TestContext): Promise<void> {
  for (const mechanism of ["one-document", "two-documents"] as const) {
  for (const probe of ["stateless", "awareness", "second provider"] as const) {
    await t.test(`review: exclusive ${mechanism} gate refuses ${probe} publication before membership`, async () => {
      const work = await workspace(); let client: ImageClient | undefined;
      let otherSocket: HocuspocusProviderWebsocket | undefined;
      const awarenessDocument = new Y.Doc(); const awareness = new Awareness(awarenessDocument);
      try {
        const server = await work.start({ IMAGE_POLICY: "1" });
        const image = new ImagePublication(initial(), "upload-before-sync", mechanism);
        client = new ImageClient(server.port, work.path, image);
        await client.connect(); await client.saved(); await client.drop();
        image.insert(png, sha); image.editing.getText("R1").insert(2, "Z");
        if (mechanism === "two-documents") client.expect("accepted");
        await client.connect(); await client.fence(); assert.equal(client.status, waiting);
        const sent = client.frames.length;
        const payload = { imageFence: 0, gallery: image.items, text: image.export().text };
        if (probe === "stateless") {
          const active = client;
          assert.throws(() => active.provider.sendStateless(JSON.stringify(payload)), /refuses outgoing frame kind 5/);
          assert.throws(() => active.provider.send(opaqueFrame(5, Buffer.from(JSON.stringify(payload)))), /refuses outgoing frame kind 5/);
          assert.throws(() => active.provider.sendStateless('{"imageFence":999}'), /refuses outgoing frame kind 5/);
        } else if (probe === "awareness") {
          awareness.setLocalState(payload);
          const active = client;
          assert.throws(() => active.provider.send(opaqueFrame(1, encodeAwarenessUpdate(awareness, [awarenessDocument.clientID]))), /refuses outgoing frame kind 1/);
          assert.throws(() => active.provider.send(new Uint8Array([7, ...Buffer.from("fixture"), 3])), /refuses outgoing frame kind 3/);
          assert.throws(() => active.provider.send(new Uint8Array([7, ...Buffer.from("fixture"), 42])), /refuses outgoing frame kind 42/);
          assert.throws(() => active.provider.send(syncFrame("fixture", 1, image.editing.snapshot())), /refuses caller-provided sync frames/);
        } else {
          let constructions = 0;
          class Ungated extends WebSocket {
            constructor(url: string | URL) { super(url); constructions++; }
          }
          assert.throws(() => image.attach(`ws://127.0.0.1:${server.port}`, Ungated, new ConnectionReceipts(work.path), () => {}), /exclusive transport/);
          otherSocket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${server.port}`, autoConnect: false, WebSocketPolyfill: Ungated });
          otherSocket.shouldConnect = false;
          const external = otherSocket;
          assert.throws(() => new HocuspocusProvider({ name: "fixture", document: image.editing as unknown as Y.Doc,
            awareness: null, websocketProvider: external }), /publication is exclusively owned/);
          assert.throws(() => Reflect.apply(image.editing.on, image.editing, ["update", () => {}]), /publication is exclusively owned/);
          assert.equal(constructions, 0, "A refused publisher must not even construct another socket");
        }
        assert.equal(client.frames.length, sent, "Refused content must not reach the actual transport observer");
        await client.fence(); assert.equal(client.frames.length, sent + 1, "Only the module-generated content-free fence may pass");
        checkHeld(client.sent.map(item => item.payload)); assert.deepEqual(membership(work.path), []);
        checkText(image.editing, true);
        const recovered = journalDocument(work.path);
        try { checkText(recovered, false); assert.deepEqual([...recovered.getMap("gallery").values()], []); }
        finally { recovered.destroy(); }
        client.check(work.path);
      } finally { otherSocket?.destroy(); awareness.destroy(); awarenessDocument.destroy(); client?.destroy(); await work.clean(); }
    });
  }
  }

  await t.test("review: persisted positive receipts refuse another instance before a negative SyncStep2", () => {
    const document = initial();
    try {
      const update = Y.encodeStateAsUpdate(document);
      const tracker = new ConnectionReceipts("deployment-A/instance-new");
      assert.throws(() => tracker.restoreAcknowledged({ instance: "deployment-A/instance-old", updates: [update] }), /Receipt instance mismatch/);
      assert.throws(() => new ConnectionReceipts().restoreAcknowledged({ instance: "deployment-A/instance-old", updates: [update] }), /Receipt instance mismatch/);
      tracker.localUpdate(update);
      const lifetime = tracker.open(); tracker.sent(lifetime, syncFrame("fixture", 1, update));
      tracker.received(lifetime, new Uint8Array([7, ...Buffer.from("fixture"), 8, 0]));
      assert.equal(tracker.status, "Saved on this device, sending");
      const same = new ConnectionReceipts("deployment-A/instance-old");
      same.restoreAcknowledged({ instance: "deployment-A/instance-old", updates: [update] });
      same.localUpdate(update); const current = same.open(); same.sent(current, syncFrame("fixture", 1, update));
      same.received(current, new Uint8Array([7, ...Buffer.from("fixture"), 8, 1])); assert.equal(same.status, saved);
    } finally { document.destroy(); }
  });

  for (const mechanism of ["one-document", "two-documents"] as const) {
    await t.test(`review: pre-picture queued W and later Z under ${mechanism}; release regenerates state`, async () => {
      const work = await workspace(); let client: ImageClient | undefined;
      const documents: Y.Doc[] = [];
      try {
        const server = await work.start({ IMAGE_POLICY: "1" });
        const image = new ImagePublication(initial(), "upload-before-sync", mechanism);
        client = new ImageClient(server.port, work.path, image);
        await client.connect(); await client.saved(); await client.drop();
        image.editing.getText("R1").insert(2, "W"); image.insert(png, sha); image.editing.getText("R1").insert(3, "Z");
        if (mechanism === "two-documents") client.expect("accepted", "accepted");
        await client.connect(); await client.fence();
        assert.deepEqual(imageIdentities(image.editing), ["a:7:0", "b:7:1", "W:11:0", "Z:11:2"]);
        const before = journalDocument(work.path); documents.push(before);
        assert.deepEqual(imageIdentities(before), mechanism === "one-document" ? ["a:7:0", "b:7:1"] : ["a:7:0", "b:7:1", "W:11:0"]);
        const prefix = client.sent.length;
        const response = await upload(server); assert.equal(response.status, 201); await response.arrayBuffer();
        client.expect(...(mechanism === "one-document" ? ["accepted"] as const : ["accepted", "accepted"] as const));
        image.durable(sha); await client.saved(); await client.fence();
        assert.deepEqual(client.sent.slice(prefix).map(item => item.subtype), mechanism === "one-document" ? [1] : [2, 1]);
        assert.deepEqual(imageIdentities(image.editing), ["a:7:0", "b:7:1", "W:11:0", "Z:11:2"]);
        const after = journalDocument(work.path); documents.push(after);
        assert.deepEqual(imageIdentities(after), ["a:7:0", "b:7:1", "W:11:0", "Z:11:2"]); client.check(work.path);
      } finally { for (const document of documents) document.destroy(); client?.destroy(); await work.clean(); }
    });
  }
}
