import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import { checkModel, IdentityBook } from "../../../src/model.ts";
import type { CollabCharacter } from "../../../src/model.ts";
import { ConnectionReceipts } from "../../../src/service/receipts.ts";
import { RefusedDevicePolicy } from "../../../src/service/refusal/policy.ts";
import { imageSocket } from "../../../src/service/images/publication.ts";
import type { ImagePublication } from "../../../src/service/images/publication.ts";
import { readFrame } from "../../../src/service/wire.ts";
import { readRecoveredRows, until } from "../harness.ts";
import type { JournalChild } from "../harness.ts";

export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
export const sha = "6b1048f8a6d40bac0b2954c18fefa40c4ea7a96120fc2e54b7317c0e43c2bbec";
export const saved = "Your changes saved to server";
export const waiting = "Saved on this device, waiting for images to upload";
export const offline = "Offline, saved on this device";
export type ImageSend = { lifetime: number; subtype: number; payload: string; disposition: "accepted" | "missing-blob";
  applied: boolean | null; membership: string[]; journalBefore: number; journalAtRefusal: number | null };

export function initial(): Y.Doc {
  const document = new Y.Doc(); document.clientID = 7;
  document.getText("R1").insert(0, "ab"); document.clientID = 11;
  return document;
}

export function membership(path: string): string[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return database.prepare("SELECT sha FROM image_membership WHERE document='fixture' ORDER BY sha").all().map(row => String(row.sha)); }
  finally { database.close(); }
}

export async function recoveredStore(path: string): Promise<{ refs: string[]; files: string[] }> {
  const database = new DatabaseSync(path, { readOnly: true });
  let rows;
  try { rows = database.prepare("SELECT sha, size FROM image_membership WHERE document='fixture' ORDER BY sha").all(); }
  finally { database.close(); }
  for (const row of rows) {
    const bytes = await readFile(join(`${path}.images`, String(row.sha)));
    assert.equal(bytes.length, row.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha);
  }
  return { refs: rows.map(row => String(row.sha)), files: await readdir(`${path}.images`) };
}

export function imagePort(server: JournalChild): number {
  const port = Number(server.events.find(event => event.event === "ready")?.imagePort);
  assert.ok(port > 0); return port;
}

export async function upload(server: JournalChild, bytes: Uint8Array = png, ref = sha): Promise<Response> {
  return fetch(`http://127.0.0.1:${imagePort(server)}/api/images/fixture/${ref}`, {
    method: "PUT", headers: { "content-type": "image/png" }, body: Uint8Array.from(bytes), signal: AbortSignal.timeout(15000),
  });
}

export class ImageClient {
  readonly publication: ImagePublication;
  readonly receipts = new ConnectionReceipts();
  readonly socket: HocuspocusProviderWebsocket;
  readonly provider: HocuspocusProvider;
  readonly policy: RefusedDevicePolicy;
  readonly sent: ImageSend[] = [];
  readonly attempts: { lifetime: number; kind: number; subtype: number; payload: string }[] = [];
  readonly frames: { lifetime: number; kind: number; subtype: number; bytes: string }[] = [];
  readonly notices: string[] = [];
  readonly observed: { status: string; refs: string[]; membership: string[] }[] = [];
  private readonly expectations: ("accepted" | "missing-blob")[];
  private fenceCount = 0;
  private lifetime = 0;
  private readonly update: (bytes: Uint8Array, origin: unknown) => void;

  constructor(port: number, path: string, publication: ImagePublication, expected: ("accepted" | "missing-blob")[] = ["accepted"], defect = false,
    acknowledged: readonly string[] = []) {
    this.publication = publication;
    this.receipts.restoreAcknowledged(acknowledged.map(bytes => Buffer.from(bytes, "base64")));
    this.expectations = [...expected];
    function observed(owner: ImageClient): typeof WebSocket {
    class ObservedSocket extends WebSocket {
      private readonly generation: number;
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols); this.generation = owner.receipts.open(); owner.lifetime = this.generation;
        this.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
          const bytes = new Uint8Array(event.data); const frame = readFrame(bytes);
          if (frame.kind === 8) {
            const sent = owner.sent.find(item => item.lifetime === this.generation && item.applied === null);
            assert.ok(sent, "Receipt must match an actual harness-observed transmission");
            sent.applied = frame.subtype === 1;
            if (!sent.applied) sent.journalAtRefusal = readRecoveredRows(path).length;
            owner.receipts.received(this.generation, bytes);
          }
          queueMicrotask(() => owner.observe(path));
        });
        this.addEventListener("close", () => owner.receipts.close(this.generation));
      }
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        assert.ok(data instanceof Uint8Array);
        const frame = readFrame(data);
        owner.frames.push({ lifetime: this.generation, kind: frame.kind, subtype: frame.subtype, bytes: Buffer.from(data).toString("base64") });
        if (frame.kind === 0 && (frame.subtype === 1 || frame.subtype === 2)) {
          const disposition = owner.expectations.shift();
          assert.ok(disposition, "Each transmitted update needs a harness-declared disposition");
          owner.sent.push({ lifetime: this.generation, subtype: frame.subtype, payload: Buffer.from(frame.payload).toString("base64"),
            disposition, applied: null, membership: membership(path), journalBefore: readRecoveredRows(path).length, journalAtRefusal: null });
        }
        owner.receipts.sent(this.generation, data); super.send(Uint8Array.from(data));
      }
    }
    const Gate = defect ? ObservedSocket : imageSocket(ObservedSocket, publication);
    class AttemptSocket extends Gate {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        assert.ok(data instanceof Uint8Array);
        const frame = readFrame(data);
        owner.attempts.push({ lifetime: owner.lifetime, kind: frame.kind, subtype: frame.subtype, payload: Buffer.from(frame.payload).toString("base64") });
        super.send(Uint8Array.from(data));
      }
    }
    return AttemptSocket;
    }
    this.socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}`, autoConnect: false,
      WebSocketPolyfill: observed(this), delay: 10000, initialDelay: 0, jitter: false, maxAttempts: 1 });
    this.socket.shouldConnect = false;
    this.provider = new HocuspocusProvider({ name: "fixture", document: publication.network, awareness: null, websocketProvider: this.socket,
      onStateless: ({ payload }) => this.notices.push(payload) });
    this.policy = new RefusedDevicePolicy(this.provider, this.socket);
    this.update = (bytes, origin): void => { if (origin !== this.provider && !publication.isInbound(origin)) this.receipts.localUpdate(bytes); };
    publication.editing.on("update", this.update);
    this.receipts.localUpdate(Y.encodeStateAsUpdate(publication.editing));
    publication.resume = () => this.provider.forceSync();
    this.provider.attach();
  }

  expect(...values: ("accepted" | "missing-blob")[]): void { this.expectations.push(...values); }
  get status(): string { return this.policy.current(this.publication.status(this.receipts.status)).status; }
  observe(path: string): void { this.observed.push({ status: this.status, refs: this.publication.items.map(item => item.ref), membership: membership(path) }); }
  async connect(): Promise<void> { void this.socket.connect(); await until(() => this.socket.status === "connected", "image client connected"); }
  async saved(): Promise<void> { await until(() => this.status === saved, "image saved status"); }
  async drop(): Promise<void> {
    this.socket.shouldConnect = false; this.socket.webSocket?.close();
    await until(() => this.socket.webSocket === null, "image client closed");
  }
  async fence(): Promise<void> {
    const label = JSON.stringify({ imageFence: ++this.fenceCount });
    this.provider.sendStateless(label); await until(() => this.notices.includes(label), "ordered socket image fence");
  }
  check(path: string): void {
    assert.deepEqual(this.expectations, [], "Every declared transmission must occur");
    const rows = readRecoveredRows(path);
    for (const sent of this.sent) {
      assert.equal(sent.applied, sent.disposition === "accepted", "Status contradicts harness-declared disposition");
      if (sent.disposition === "accepted") assert.ok(rows.some(row => row.payload === sent.payload), "Accepted update missing exact journal bytes");
      else {
        assert.notEqual(sent.journalAtRefusal, null);
        assert.ok(!rows.slice(sent.journalBefore, sent.journalAtRefusal ?? rows.length).some(row => row.payload === sent.payload),
          "Refused image update reached journal before its later accepted retry");
        assert.deepEqual(sent.membership, [], "Missing-blob disposition requires harness-observed absent membership");
      }
    }
    checkImagePromises(this.observed);
  }
  destroy(): void {
    this.publication.editing.off("update", this.update); this.publication.resume = () => {};
    this.policy.destroy(); this.provider.destroy(); this.socket.destroy(); this.publication.destroy(); this.publication.editing.destroy();
  }
}

export function checkImagePromises(observed: readonly { status: string; refs: string[]; membership: string[] }[]): void {
  for (const view of observed) if (view.status === saved) {
    for (const ref of view.refs) assert.ok(view.membership.includes(ref), "Saved picture lacks durable server membership");
  }
}

export function checkUploadReceipt(ref: string, status: number, recovered: { refs: string[] }): void {
  assert.equal(status, 201);
  assert.ok(recovered.refs.includes(ref), "Acknowledged upload lacks recovered membership");
}

export function checkText(document: Y.Doc, z: boolean): void {
  const identities = new IdentityBook();
  identities.bind("s1", { client: 7, clock: 0 }); identities.bind("s2", { client: 7, clock: 1 });
  identities.bind("a1", { client: 11, clock: 1 });
  const text = document.getText("R1");
  const characters: CollabCharacter[] = [];
  let offset = 0;
  for (const run of text.toDelta()) {
    assert.equal(typeof run.insert, "string");
    for (const value of String(run.insert)) {
      const identity = Y.createRelativePositionFromTypeIndex(text, offset++).item;
      assert.ok(identity);
      characters.push({ identity: { client: identity.client, clock: identity.clock }, notation: identities.notation(identity),
        value, marks: run.attributes ?? {}, beat: "R1" });
    }
  }
  checkModel({ rows: [{ id: "R1", characters }], carets: {}, recovery: [] }, {
    rows: [{ id: "R1", characters: z ? [["s1", "a", {}], ["s2", "b", {}], ["a1", "Z", {}]] : [["s1", "a", {}], ["s2", "b", {}]] }],
    carets: {}, recovery: [],
  }, identities, "image-text");
}

export function checkHeld(payloads: readonly string[]): void {
  for (const payload of payloads) assert.equal(Y.decodeUpdate(Buffer.from(payload, "base64")).structs.some(item => item.id.client === 11), false,
    "Held image or subsequent text reached the network boundary");
}

export function journalDocument(path: string): Y.Doc {
  const document = new Y.Doc();
  for (const row of readRecoveredRows(path)) Y.applyUpdate(document, Buffer.from(row.payload, "base64"));
  return document;
}
