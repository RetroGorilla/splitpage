import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { ImagePublication } from "../../../src/service/images/publication.ts";
import type { ImageDesign, ImageReplicaCapture, ImageTransport } from "../../../src/service/images/publication.ts";
import type { ImageInstanceConfiguration } from "../../../src/service/images/configuration.ts";
import type { CompletionReplicaStore, InstanceLocalCapture, LocalInstanceWrite } from "../../../src/service/instance/client.ts";
import { ConnectionReceipts } from "../../../src/service/receipts.ts";
import { readFrame, syncFrame } from "../../../src/service/wire.ts";
import { characterIdentities, until } from "../harness.ts";
import type { JournalChild } from "../harness.ts";
import { imagePort, membership, png, sha, upload } from "../images/harness.ts";
import { OWNER, INVITE } from "./harness.ts";
import { instanceRequest } from "../../../src/service/instance/client.ts";

export class ImageLocalStore implements CompletionReplicaStore {
  private value: InstanceLocalCapture | null = null;
  readonly beforeCommit: (capture: InstanceLocalCapture) => Promise<void>;
  constructor(beforeCommit: (capture: InstanceLocalCapture) => Promise<void> = async () => {}) { this.beforeCommit = beforeCommit; }

  async save(editor: Y.Doc, network: Y.Doc, sequence: number, manifest: readonly string[], blobs: ReadonlyMap<string, Uint8Array>, owns: () => boolean,
    transition: LocalInstanceWrite = { generation: sequence, updates: [], membership: null }): Promise<number> {
    const captured = structuredClone({ ...transition, editor: Y.encodeStateAsUpdate(editor), network: Y.encodeStateAsUpdate(network), sequence,
      manifest: [...manifest], blobs: [...blobs].map(([hash, bytes]) => ({ hash, bytes: bytes.slice() })) });
    for (const hash of captured.manifest) {
      const bytes = captured.blobs.find(blob => blob.hash === hash)?.bytes;
      assert.ok(bytes, "Local image reference lacks bytes");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
    }
    if (!owns()) throw new Error("Local ownership ended");
    await this.beforeCommit(captured);
    this.value = captured;
    return sequence;
  }

  async hydrate(): Promise<InstanceLocalCapture | null> { return structuredClone(this.value); }
}

export function restoredImage(capture: InstanceLocalCapture, twoDocuments: boolean): ImageReplicaCapture {
  return {
    editing: Buffer.from(capture.editor).toString("base64"),
    network: twoDocuments ? Buffer.from(capture.network).toString("base64") : null,
    blobs: capture.blobs.map(blob => [blob.hash, Buffer.from(blob.bytes).toString("base64")]),
  };
}

type ImageLedgerRow = { lifetime: number; payload: Uint8Array; applied: boolean | null; membership: string[] };

function observedSocket(owner: ScopedImageReplica, path: string, configuration: ImageInstanceConfiguration): typeof WebSocket {
  return class extends WebSocket {
    readonly lifetime: number;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.lifetime = owner.receipts.open();
      this.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
        const bytes = new Uint8Array(event.data);
        const frame = readFrame(bytes);
        owner.frames.push({ direction: "in", lifetime: this.lifetime, bytes: bytes.slice() });
        if (frame.kind === 8) {
          const sent = owner.sent.find(row => row.lifetime === this.lifetime && row.applied === null);
          assert.ok(sent, "Receipt must match an actual image-instance send");
          sent.applied = frame.subtype === 1;
          owner.receipts.received(this.lifetime, bytes);
        }
        if (frame.kind === 0 && (frame.subtype === 1 || frame.subtype === 2)) queueMicrotask(() => {
          if (frame.subtype === 1) owner.networkHydrated = true;
          owner.localComplete = false;
          if (owner.editingEnabled) void owner.persist().catch(error => { owner.persistenceError = error; });
        });
      });
      this.addEventListener("close", () => owner.receipts.close(this.lifetime));
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      assert.ok(data instanceof Uint8Array);
      const frame = readFrame(data);
      owner.frames.push({ direction: "out", lifetime: this.lifetime, bytes: data.slice() });
      if (frame.kind === 0 && (frame.subtype === 1 || frame.subtype === 2)) {
        assert.equal(frame.name, configuration.instance);
        owner.sent.push({ lifetime: this.lifetime, payload: frame.payload.slice(), applied: null, membership: membership(path, configuration.instance) });
      }
      owner.receipts.sent(this.lifetime, data);
      super.send(Uint8Array.from(data));
    }
  };
}

export class ScopedImageReplica {
  readonly publication: ImagePublication;
  readonly receipts: ConnectionReceipts;
  readonly transport: ImageTransport;
  readonly configuration: ImageInstanceConfiguration;
  readonly store: ImageLocalStore;
  readonly frames: { direction: string; lifetime: number; bytes: Uint8Array }[] = [];
  readonly attempts: { kind: number; subtype: number }[] = [];
  readonly sent: ImageLedgerRow[] = [];
  readonly notices: string[] = [];
  readonly updates: Uint8Array[];
  networkHydrated = false;
  editingEnabled = false;
  localComplete = false;
  generation = 0;
  persistenceError: unknown = null;
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;
  private readonly downloadGate: () => Promise<void>;

  constructor(server: JournalChild, path: string, configuration: ImageInstanceConfiguration, design: ImageDesign, store: ImageLocalStore,
    seed: Y.Doc, capture?: ImageReplicaCapture, updates?: readonly Uint8Array[], downloadGate: () => Promise<void> = async () => {}) {
    this.configuration = { ...configuration };
    this.store = store;
    this.downloadGate = downloadGate;
    this.publication = new ImagePublication(seed, design, design === "upload-before-sync" ? "two-documents" : "one-document", capture, configuration);
    this.updates = updates ? updates.map(bytes => bytes.slice()) : [this.publication.editing.snapshot()];
    this.receipts = new ConnectionReceipts(configuration.instance);
    const allow = this.publication.allow.bind(this.publication);
    this.publication.allow = bytes => {
      const frame = readFrame(bytes);
      this.attempts.push({ kind: frame.kind, subtype: frame.subtype });
      return allow(bytes);
    };
    this.transport = this.publication.attach(`ws://127.0.0.1:${server.port}`, observedSocket(this, path, configuration), this.receipts,
      payload => this.notices.push(payload));
  }

  async connect(): Promise<void> { await this.transport.connect(); }

  async fence(): Promise<void> {
    await until(() => {
      const requests = this.frames.filter(event => event.direction === "out" && readFrame(event.bytes).kind === 0 && readFrame(event.bytes).subtype === 0).length;
      const replies = this.attempts.filter(frame => frame.kind === 0 && frame.subtype === 1).length;
      return requests > 0 && replies >= requests;
    }, "configured provider generates all requested sync replies");
    const label = this.transport.fence();
    await until(() => this.notices.includes(label), "image-instance ordered fence");
    for (const sent of this.sent) assert.equal(sent.applied, true, "Harness-declared accepted update must receive a positive receipt");
  }

  type(text: string): void {
    if (!this.editingEnabled) throw new Error("Image replica not hydrated");
    const before = this.publication.editing.snapshot();
    const target = this.publication.editing.getText("R1");
    target.insert(target.length, text);
    this.generation++;
    this.localComplete = false;
    this.updates.push(Y.diffUpdate(this.publication.editing.snapshot(), Y.encodeStateVectorFromUpdate(before)));
  }

  system(action: () => void): void {
    const before = this.publication.editing.snapshot();
    action();
    const after = this.publication.editing.snapshot();
    if (!Buffer.from(before).equals(after)) this.updates.push(Y.diffUpdate(after, Y.encodeStateVectorFromUpdate(before)));
  }

  persist(creation?: NonNullable<LocalInstanceWrite["creation"]>, membershipId: string | null = this.configuration.instance): Promise<void> {
    this.localComplete = false;
    const revision = ++this.revision;
    const captured = this.publication.capture();
    const editor = new Y.Doc(); const network = new Y.Doc();
    Y.applyUpdate(editor, Buffer.from(captured.editing, "base64"));
    Y.applyUpdate(network, Buffer.from(captured.network ?? captured.editing, "base64"));
    const sequence = this.generation;
    const manifest = this.publication.items.map(item => item.ref);
    const blobs = new Map(captured.blobs.map(([hash, bytes]) => [hash, Buffer.from(bytes, "base64")]));
    const write: LocalInstanceWrite = { generation: sequence, updates: this.updates.map(bytes => bytes.slice()), membership: membershipId,
      ...(creation ? { creation: structuredClone(creation) } : {}) };
    const saved = this.store.save.bind(this.store);
    this.tail = this.tail.then(async () => {
      try {
        assert.equal(await saved(editor, network, sequence, manifest, blobs, () => true, write), sequence);
        if (sequence === this.generation && revision === this.revision) this.localComplete = true;
      } finally { editor.destroy(); network.destroy(); }
    });
    return this.tail;
  }

  async hydrate(server: JournalChild): Promise<void> {
    await until(() => this.networkHydrated, "received instance state");
    await this.downloadGate();
    for (const item of this.publication.items) {
      const response = await fetch(`http://127.0.0.1:${imagePort(server)}/api/images/${this.configuration.instance}/${item.ref}`, {
        headers: { Authorization: `Bearer ${this.configuration.token}` }, signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(createHash("sha256").update(bytes).digest("hex"), item.ref);
      this.publication.blobs.set(item.ref, bytes);
      this.publication.durable(item.ref);
    }
    await this.fence();
    await this.persist();
    this.editingEnabled = true;
  }

  publishSnapshot(): void { this.transport.send(syncFrame(this.configuration.instance, 2, this.publication.editing.snapshot())); }
  async saved(): Promise<void> { await this.tail; await until(() => this.status === "Your changes saved to server", "image instance covering receipt"); }
  get status(): string {
    if (this.persistenceError) throw this.persistenceError;
    if (!this.localComplete) return "Saving on this device";
    if (this.generation === 0) return "Saved on this device";
    return this.publication.status(this.receipts.status);
  }
  acknowledged(): Uint8Array[] { return this.sent.filter(row => row.applied).map(row => row.payload.slice()); }
  destroy(): void { this.publication.destroy(); }
}

export class ImageCreationHandoff {
  readonly replica: ScopedImageReplica;
  readonly initial: Uint8Array;
  readonly operation: string;
  private shownInvitation: string | null = null;
  private readonly server: JournalChild;
  private readonly onInvitation: (link: string) => Promise<void>;

  private constructor(server: JournalChild, replica: ScopedImageReplica, initial: Uint8Array, operation: string, onInvitation: (link: string) => Promise<void>) {
    this.server = server; this.replica = replica; this.initial = initial.slice(); this.operation = operation;
    this.onInvitation = onInvitation;
  }

  static async begin(server: JournalChild, path: string, design: ImageDesign, store: ImageLocalStore,
    recovered?: InstanceLocalCapture, onInvitation: (link: string) => Promise<void> = async () => {}): Promise<ImageCreationHandoff> {
    const operation = recovered?.creation?.operation ?? "picture-handoff-k";
    const source = recovered ? new Y.Doc() : pictureSeed("abcd", "d00000000000000000000000000000001", design === "pending-image");
    const empty = new Y.Doc();
    try {
      if (recovered) Y.applyUpdate(source, recovered.editor);
      else {
        const initial = Y.encodeStateAsUpdate(source);
        await store.save(source, design === "upload-before-sync" ? empty : source, 0, [sha], new Map([[sha, png]]), () => true,
          { generation: 0, updates: [initial], membership: null, creation: { operation, initial, instance: null } });
      }
      const creation = await instanceRequest(server.port, OWNER, { action: "create", operation, invite: INVITE });
      const id = String(creation.id);
      if (recovered?.creation?.instance) assert.equal(id, recovered.creation.instance);
      if (source.getMap("identity").get("docId") !== id) {
        source.clientID = 7;
        source.getMap("identity").set("docId", id);
      }
      source.clientID = 11;
      const initial = recovered?.creation?.instance ? recovered.creation.initial : Y.encodeStateAsUpdate(source);
      const capture = recovered ? restoredImage(recovered, design === "upload-before-sync") : {
        editing: Buffer.from(initial).toString("base64"),
        network: design === "upload-before-sync" ? Buffer.from(Y.encodeStateAsUpdate(empty)).toString("base64") : null,
        blobs: [[sha, png.toString("base64")]] as [string, string][],
      };
      const replica = new ScopedImageReplica(server, path, { instance: id, token: INVITE }, design, store, source, capture, recovered?.updates);
      replica.generation = recovered?.generation ?? 0;
      replica.editingEnabled = true;
      const handoff = new ImageCreationHandoff(server, replica, initial, operation, onInvitation);
      try { await replica.persist(handoff.creation(), null); }
      catch (error) { replica.destroy(); throw error; }
      return handoff;
    } finally { source.destroy(); empty.destroy(); }
  }

  creation(): NonNullable<LocalInstanceWrite["creation"]> {
    return { operation: this.operation, initial: this.initial, instance: this.replica.configuration.instance };
  }

  get invitation(): string | null { return this.shownInvitation; }

  private async publishInvitation(): Promise<void> {
    this.shownInvitation = `?join=${this.replica.configuration.instance}#${INVITE}`;
    await this.onInvitation(this.shownInvitation);
  }

  async type(text: string): Promise<void> {
    this.replica.type(text);
    await this.replica.persist(this.creation(), null);
  }

  async complete(): Promise<void> {
    const id = this.replica.configuration.instance;
    await Promise.all([
      instanceRequest(this.server.port, OWNER, { action: "upload", operation: this.operation, payload: Buffer.from(this.initial).toString("base64") }),
      (async () => {
        const response = await upload(this.server, png, sha, { instance: id, token: OWNER });
        assert.equal(response.status, 201); await response.arrayBuffer();
      })(),
    ]);
    this.replica.system(() => this.replica.publication.durable(sha));
    await this.replica.persist(this.creation(), null);
    await instanceRequest(this.server.port, OWNER, { action: "commit", operation: this.operation });
    await this.replica.persist(this.creation(), id);
    await this.publishInvitation();
  }
}

export async function assertStoredP(path: string, instance: string): Promise<void> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT size FROM image_membership WHERE document=? AND sha=?").get(instance, sha);
    assert.ok(row, "Recovered picture lacks instance membership");
    assert.equal(row.size, png.byteLength);
  } finally { database.close(); }
  let bytes: Buffer;
  try { bytes = await readFile(join(`${path}.images`, sha)); }
  catch { throw new Error("Recovered picture bytes missing"); }
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
  assert.deepEqual(bytes, png);
}

export function assertPictureDocument(document: Y.Doc, instance: string, text: string, identities: readonly string[]): void {
  assert.equal(document.getText("R1").toString(), text);
  assert.deepEqual(characterIdentities(document), identities);
  assert.deepEqual(document.getText("R1").toDelta(), [{ insert: text }]);
  assert.deepEqual([...document.getMap("gallery").values()], [{ id: "gP", beat: "R1", ref: sha, pending: false }]);
  assert.equal(document.getMap("identity").get("docId"), instance);
}

export function pictureSeed(text: string, instance: string, pending: boolean): Y.Doc {
  const document = new Y.Doc();
  document.clientID = 7;
  document.getText("R1").insert(0, text);
  document.getMap("gallery").set("gP", { id: "gP", beat: "R1", ref: sha, pending });
  document.getMap("identity").set("docId", instance);
  document.clientID = 11;
  return document;
}

export async function initialInstance(server: JournalChild, text: string, operation = "picture-k"): Promise<{ id: string; source: Y.Doc }> {
  const creation = await instanceRequest(server.port, OWNER, { action: "create", operation, invite: INVITE });
  const id = String(creation.id);
  const source = pictureSeed(text, id, false);
  try {
    const response = await upload(server, png, sha, { instance: id, token: OWNER });
    assert.equal(response.status, 201); await response.arrayBuffer();
    await instanceRequest(server.port, OWNER, { action: "upload", operation, payload: Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64") });
    await instanceRequest(server.port, OWNER, { action: "commit", operation });
    return { id, source };
  } catch (error) { source.destroy(); throw error; }
}
