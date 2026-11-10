import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import { ConnectionReceipts } from "../receipts.ts";

export type LocalInstanceWrite = {
  generation: number; updates: readonly Uint8Array[]; membership: string | null;
  creation?: { operation: string; initial: Uint8Array; instance: string | null };
};
export type InstanceLocalCapture = LocalInstanceWrite & {
  editor: Uint8Array; network: Uint8Array; sequence: number; manifest: string[];
  blobs: { hash: string; bytes: Uint8Array }[];
};
export interface CompletionReplicaStore {
  readonly save: (
    editor: Y.Doc, network: Y.Doc, sequence: number, manifest: readonly string[],
    blobs: ReadonlyMap<string, Uint8Array>, owns: () => boolean, transition?: LocalInstanceWrite,
  ) => Promise<number>;
  readonly hydrate: () => Promise<InstanceLocalCapture | null>;
}

export class MemoryCompletionStore implements CompletionReplicaStore {
  private value: InstanceLocalCapture | null = null;
  private readonly beforeCommit: (write: LocalInstanceWrite) => Promise<void>;
  constructor(beforeCommit: (write: LocalInstanceWrite) => Promise<void> = async () => {}) { this.beforeCommit = beforeCommit; }

  async save(
    editor: Y.Doc, network: Y.Doc, sequence: number, manifest: readonly string[],
    blobs: ReadonlyMap<string, Uint8Array>, owns: () => boolean,
    write: LocalInstanceWrite = { generation: sequence, updates: [], membership: null },
  ): Promise<number> {
    const captured: InstanceLocalCapture = {
      ...write, updates: write.updates.map(update => update.slice()),
      ...(write.creation ? { creation: { ...write.creation, initial: write.creation.initial.slice() } } : {}),
      editor: Y.encodeStateAsUpdate(editor), network: Y.encodeStateAsUpdate(network), sequence,
      manifest: [...manifest], blobs: [...blobs].map(([hash, bytes]) => ({ hash, bytes: bytes.slice() })),
    };
    if (!owns()) throw new Error("Writable ownership ended");
    if (manifest.length) throw new Error("Image persistence seam not installed");
    await this.beforeCommit(captured);
    this.value = captured;
    return sequence;
  }

  async hydrate(): Promise<InstanceLocalCapture | null> {
    return this.value ? {
      ...this.value, updates: this.value.updates.map(update => update.slice()),
      ...(this.value.creation ? { creation: { ...this.value.creation, initial: this.value.creation.initial.slice() } } : {}),
      editor: this.value.editor.slice(), network: this.value.network.slice(), manifest: [...this.value.manifest],
      blobs: this.value.blobs.map(blob => ({ hash: blob.hash, bytes: blob.bytes.slice() })),
    } : null;
  }
}

async function persistEnvelope(store: CompletionReplicaStore, write: LocalInstanceWrite): Promise<void> {
  const doc = new Y.Doc();
  try {
    write.updates.forEach(update => Y.applyUpdate(doc, update));
    const saved = await store.save(doc, doc, write.generation, [], new Map(), () => true, write);
    if (saved !== write.generation) throw new Error("Local completion covered another generation");
  } finally { doc.destroy(); }
}

export async function instanceRequest(port: number, owner: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/instance`, {
    method: "POST", headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" },
    body: JSON.stringify(data), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Instance request failed (${response.status})`);
  return await response.json() as Record<string, unknown>;
}

function observeReplicaSocket(replica: NodeInstanceReplica): typeof WebSocket {
  return class extends WebSocket {
    readonly lifetime: number;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.lifetime = replica.receipts.open();
      this.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
        const bytes = new Uint8Array(event.data);
        replica.frames.push({ direction: "in", bytes: bytes.slice() });
        replica.receipts.received(this.lifetime, bytes);
      });
      this.addEventListener("close", () => replica.receipts.close(this.lifetime));
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (!(data instanceof Uint8Array)) throw new Error("Expected provider frame");
      replica.frames.push({ direction: "out", bytes: data.slice() });
      replica.receipts.sent(this.lifetime, data);
      super.send(Uint8Array.from(data));
    }
  };
}

export class NodeInstanceReplica {
  readonly id: string;
  readonly store: CompletionReplicaStore;
  readonly document: Y.Doc;
  readonly receipts = new ConnectionReceipts();
  readonly socket: HocuspocusProviderWebsocket;
  readonly provider: HocuspocusProvider;
  readonly frames: { direction: string; bytes: Uint8Array }[] = [];
  hydrated = false;
  localSaved = false;
  localError: unknown = null;
  generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly updates: Uint8Array[] = [];
  private submitted = false;
  private revision = 0;

  constructor(port: number, id: string, token: string, store: CompletionReplicaStore, document = new Y.Doc(), generation = 0, localUpdates: readonly Uint8Array[] = []) {
    this.id = id;
    this.store = store;
    this.document = document;
    this.generation = generation;
    this.submitted = generation > 0;
    this.updates.push(Y.encodeStateAsUpdate(document));
    for (const update of localUpdates) this.receipts.localUpdate(update);
    this.socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}`, autoConnect: false, WebSocketPolyfill: observeReplicaSocket(this),
      maxAttempts: 1, initialDelay: 0, jitter: false,
    });
    this.provider = new HocuspocusProvider({
      name: id, token, document, awareness: null, websocketProvider: this.socket,
      onSynced: ({ state }) => { if (state) void this.persist().then(() => { this.hydrated = this.localSaved; }); },
    });
    document.on("update", (update: Uint8Array, origin: unknown) => {
      this.updates.push(update.slice());
      if (origin !== this.provider) {
        this.generation++;
        this.submitted = true;
        this.receipts.localUpdate(update);
      }
      void this.persist();
    });
    this.provider.attach();
  }

  async connect(): Promise<void> {
    await this.persist();
    void this.socket.connect();
  }

  private persist(): Promise<void> {
    this.localSaved = false;
    const revision = ++this.revision;
    const write = { generation: this.generation, updates: this.updates.map(update => update.slice()), membership: this.id };
    this.tail = this.tail.then(async () => {
      try {
        await persistEnvelope(this.store, write);
        if (revision === this.revision) this.localSaved = true;
      } catch (error) { this.localError = error; this.localSaved = false; }
    });
    return this.tail;
  }

  async settled(): Promise<void> { await this.tail; }

  edit(text: string): void {
    if (!this.hydrated) throw new Error("Replica not hydrated");
    this.document.getText("R1").insert(this.document.getText("R1").length, text);
  }

  get status(): string {
    if (this.localError) return "Could not save on this device";
    if (!this.localSaved) return "Saving on this device";
    return this.submitted ? this.receipts.status : "Saved on this device";
  }

  destroy(): void {
    this.provider.destroy();
    this.socket.destroy();
    this.document.destroy();
  }
}

export class StandaloneHandoff {
  readonly source: Y.Doc;
  readonly store: CompletionReplicaStore;
  readonly replica: Y.Doc;
  readonly initial: Uint8Array;
  invitation: string | null = null;
  generation = 0;
  private readonly updates: Uint8Array[];
  private tail: Promise<void> = Promise.resolve();
  private readonly capture: (update: Uint8Array) => void;
  private readonly owns: () => boolean;
  private readonly requiredAssetsDurable: () => Promise<void>;
  private creation: LocalInstanceWrite["creation"];

  constructor(
    source: Y.Doc, store: CompletionReplicaStore,
    owns: () => boolean,
    requiredAssetsDurable: () => Promise<void> = async () => {},
    recovered?: LocalInstanceWrite,
  ) {
    this.source = source;
    this.store = store;
    this.owns = owns;
    this.requiredAssetsDurable = requiredAssetsDurable;
    this.initial = recovered?.creation?.initial.slice() ?? Y.encodeStateAsUpdate(source);
    this.replica = new Y.Doc();
    this.updates = recovered ? recovered.updates.map(update => update.slice()) : [this.initial];
    this.updates.forEach(update => Y.applyUpdate(this.replica, update));
    this.generation = recovered?.generation ?? 0;
    this.creation = recovered?.creation;
    this.capture = update => {
      this.generation++;
      this.updates.push(update.slice());
      Y.applyUpdate(this.replica, update);
      this.persist(null);
    };
    source.on("update", this.capture);
    this.persist(null);
  }

  private persist(membership: string | null): void {
    const write: LocalInstanceWrite = {
      generation: this.generation, updates: this.updates.map(update => update.slice()), membership,
      ...(this.creation ? { creation: { ...this.creation, initial: this.creation.initial.slice() } } : {}),
    };
    this.tail = this.tail.then(() => persistEnvelope(this.store, write));
  }

  async settled(): Promise<void> { await this.tail; }

  async complete(port: number, operation: string, owner: string, invite: string): Promise<NodeInstanceReplica> {
    if (this.creation && this.creation.operation !== operation) throw new Error("Creation operation changed");
    this.creation ??= { operation, initial: this.initial, instance: null };
    this.persist(null);
    await this.tail;
    const creation = await instanceRequest(port, owner, { action: "create", operation, invite });
    const id = String(creation.id);
    this.creation.instance = id;
    this.persist(null);
    await this.requiredAssetsDurable();
    await instanceRequest(port, owner, { action: "upload", operation, payload: Buffer.from(this.initial).toString("base64") });
    await instanceRequest(port, owner, { action: "commit", operation });
    if (!this.owns()) throw new Error("Handoff no longer owns the standalone document");
    const metadata = (update: Uint8Array): void => { this.updates.push(update.slice()); };
    this.replica.once("update", metadata);
    this.replica.getMap("identity").set("docId", id);
    this.replica.off("update", metadata);
    this.persist(id);
    for (;;) {
      const current = this.tail;
      await current;
      if (current === this.tail) break;
      this.persist(id);
    }
    if (!this.owns()) throw new Error("Handoff no longer owns the standalone document");
    this.source.off("update", this.capture);
    const client = new NodeInstanceReplica(port, id, owner, this.store, this.replica, this.generation, this.updates.slice(1));
    this.invitation = `?join=${id}#${invite}`;
    return client;
  }

  destroy(): void {
    this.source.off("update", this.capture);
    this.replica.destroy();
  }
}
