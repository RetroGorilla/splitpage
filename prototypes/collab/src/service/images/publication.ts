import { createHash } from "node:crypto";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { ConnectionReceipts } from "../receipts.ts";
import { RefusedDevicePolicy } from "../refusal/policy.ts";
import { readFrame, syncFrame } from "../wire.ts";

export type ImageGalleryItem = { id: string; beat: "R1"; ref: string; pending: boolean };
export type ImageDesign = "upload-before-sync" | "pending-image";
export type ImageMechanism = "one-document" | "two-documents";
export type ImageReplicaCapture = { editing: string; network: string | null; blobs: [string, string][] };
export type ImageDocumentPort = {
  clientID: number;
  getText: (name: "R1") => { insert: (offset: number, text: string) => void; length: number; toString: () => string };
  getMap: (name: "gallery") => { set: (id: string, item: ImageGalleryItem) => void; values: () => IterableIterator<ImageGalleryItem> };
  snapshot: () => Uint8Array;
  on: () => never;
};
export type ImageTransport = {
  connect: () => Promise<void>;
  drop: () => void;
  status: () => string;
  shouldConnect: () => boolean;
  closed: () => boolean;
  forceSync: () => void;
  sendStateless: (payload: string) => void;
  send: (bytes: Uint8Array) => void;
  outgoing: (listener: () => boolean) => void;
  fence: () => string;
  view: (status: string) => ReturnType<RefusedDevicePolicy["current"]>;
  destroy: () => void;
};

function documentPort(document: Y.Doc): ImageDocumentPort {
  return Object.freeze({
    get clientID() { return document.clientID; },
    set clientID(value: number) { document.clientID = value; },
    getText(name: "R1") {
      const text = document.getText(name);
      return Object.freeze({ insert: (offset: number, value: string): void => text.insert(offset, value),
        get length() { return text.length; }, toString: (): string => text.toString() });
    },
    getMap(name: "gallery") {
      const map = document.getMap<ImageGalleryItem>(name);
      return Object.freeze({ set: (id: string, item: ImageGalleryItem): void => { map.set(id, structuredClone(item)); },
        values: (): IterableIterator<ImageGalleryItem> => structuredClone([...map.values()]).values() });
    },
    snapshot: (): Uint8Array => Y.encodeStateAsUpdate(document),
    on(): never { throw new Error("Image document publication is exclusively owned"); },
  });
}

export class ImagePublication {
  readonly editing: ImageDocumentPort;
  readonly network: ImageDocumentPort;
  readonly design: ImageDesign;
  readonly blobs = new Map<string, Uint8Array>();
  readonly #editing: Y.Doc;
  readonly #network: Y.Doc;
  readonly #membership = new Set<string>();
  readonly #netOrigin = Object.freeze({ imageNetwork: true });
  #transport: ImageTransport | null = null;
  #fence = 0;
  #control: string | null = null;

  constructor(seed: Y.Doc, design: ImageDesign, mechanism: ImageMechanism = "one-document", capture?: ImageReplicaCapture) {
    this.#editing = new Y.Doc();
    Y.applyUpdate(this.#editing, capture ? Buffer.from(capture.editing, "base64") : Y.encodeStateAsUpdate(seed));
    this.#editing.clientID = seed.clientID;
    this.design = design;
    if (capture) for (const [sha, bytes] of capture.blobs) this.blobs.set(sha, Buffer.from(bytes, "base64"));
    this.#network = mechanism === "one-document" ? this.#editing : new Y.Doc();
    this.editing = documentPort(this.#editing);
    this.network = this.#network === this.#editing ? this.editing : documentPort(this.#network);
    if (this.#network !== this.#editing) {
      Y.applyUpdate(this.#network, capture?.network ? Buffer.from(capture.network, "base64") : Y.encodeStateAsUpdate(this.#editing));
      this.#network.on("update", this.inbound);
      this.#editing.on("update", this.outbound);
    }
  }

  private readonly inbound = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this.#netOrigin) Y.applyUpdate(this.#editing, update, this.#netOrigin);
  };

  private readonly outbound = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this.#netOrigin && (this.design === "pending-image" || !this.waiting)) Y.applyUpdate(this.#network, update, this.#netOrigin);
  };

  get items(): ImageGalleryItem[] { return structuredClone([...this.#editing.getMap<ImageGalleryItem>("gallery").values()]); }
  get waiting(): boolean { return this.items.some(item => !this.#membership.has(item.ref)); }

  insert(bytes: Uint8Array, sha: string): void {
    if (createHash("sha256").update(bytes).digest("hex") !== sha) throw new Error("Local image hash mismatch");
    this.blobs.set(sha, Uint8Array.from(bytes));
    this.#editing.getMap<ImageGalleryItem>("gallery").set("gP", {
      id: "gP", beat: "R1", ref: sha, pending: this.design === "pending-image",
    });
  }

  durable(sha: string): void {
    this.#membership.add(sha);
    if (this.design === "pending-image") {
      for (const item of this.items) if (item.ref === sha && item.pending) {
        this.#editing.getMap<ImageGalleryItem>("gallery").set(item.id, { ...item, pending: false });
      }
    }
    if (this.waiting) return;
    if (this.#network !== this.#editing) Y.applyUpdate(this.#network,
      Y.encodeStateAsUpdate(this.#editing, Y.encodeStateVector(this.#network)), this.#netOrigin);
    this.#transport?.forceSync();
  }

  allow(bytes: Uint8Array): boolean {
    if (this.design !== "upload-before-sync" || !this.waiting) return true;
    const encoded = Buffer.from(bytes).toString("base64");
    if (encoded === this.#control) { this.#control = null; return true; }
    if (bytes.length === 1 && (bytes[0] === 9 || bytes[0] === 10)) return true;
    if (Buffer.from(bytes).equals(Buffer.from([7, ...Buffer.from("fixture"), 7]))) return true;
    if (Buffer.from(bytes).equals(Buffer.from([7, ...Buffer.from("fixture"), 2, 0, 0, 5, ...Buffer.from("4.8.0")]))) return true;
    if (Buffer.from(bytes).equals(Buffer.from(syncFrame("fixture", 0, Y.encodeStateVector(this.#network))))) return true;
    const frame = readFrame(bytes);
    if (frame.name === "fixture" && frame.kind === 0 && (frame.subtype === 1 || frame.subtype === 2)) return this.#network !== this.#editing;
    throw new Error(`Image gate refuses outgoing frame kind ${frame.kind}`);
  }

  attach(url: string, base: typeof WebSocket, receipts: ConnectionReceipts, stateless: (payload: string) => void): ImageTransport {
    if (this.#transport) throw new Error("Image document already has its exclusive transport");
    const Gate = imageSocket(base, this);
    const socket = new HocuspocusProviderWebsocket({ url, autoConnect: false, WebSocketPolyfill: Gate,
      delay: 10000, initialDelay: 0, jitter: false, maxAttempts: 1 });
    socket.shouldConnect = false;
    const provider = new HocuspocusProvider({ name: "fixture", document: this.#network, awareness: null,
      websocketProvider: socket, onStateless: ({ payload }) => stateless(payload) });
    const policy = new RefusedDevicePolicy(provider, socket);
    const update = (bytes: Uint8Array, origin: unknown): void => {
      if (origin !== provider && origin !== this.#netOrigin) receipts.localUpdate(bytes);
    };
    this.#editing.on("update", update);
    receipts.localUpdate(Y.encodeStateAsUpdate(this.#editing));
    this.#transport = Object.freeze({
      connect: async (): Promise<void> => { await socket.connect(); },
      drop: (): void => { socket.shouldConnect = false; socket.webSocket?.close(); },
      status: (): string => socket.status,
      shouldConnect: (): boolean => socket.shouldConnect,
      closed: (): boolean => socket.webSocket === null,
      forceSync: (): void => provider.forceSync(),
      sendStateless: (payload: string): void => {
        if (this.design === "upload-before-sync" && this.waiting) throw new Error("Image gate refuses outgoing frame kind 5");
        provider.sendStateless(payload);
      },
      send: (bytes: Uint8Array): void => {
        if (this.design === "upload-before-sync" && this.waiting && readFrame(bytes).kind === 0) {
          throw new Error("Image gate refuses caller-provided sync frames");
        }
        socket.webSocket?.send(Uint8Array.from(bytes));
      },
      outgoing: (listener: () => boolean): void => { provider.on("outgoingMessage", () => listener()); },
      fence: (): string => {
        const label = JSON.stringify({ imageFence: ++this.#fence });
        const value = Buffer.from(label);
        this.#control = Buffer.from([7, ...Buffer.from("fixture"), 5, value.length, ...value]).toString("base64");
        try { provider.sendStateless(label); } finally { this.#control = null; }
        return label;
      },
      view: (status: string) => policy.current(status),
      destroy: (): void => { this.#editing.off("update", update); policy.destroy(); provider.destroy(); socket.destroy(); },
    });
    provider.attach();
    return this.#transport;
  }

  status(receiptStatus: string): string {
    if (receiptStatus === "Offline, saved on this device") return receiptStatus;
    return this.waiting ? "Saved on this device, waiting for images to upload" : receiptStatus;
  }

  picture(sha: string): "placeholder" | "picture" {
    return this.#membership.has(sha) && this.items.some(item => item.ref === sha && !item.pending) ? "picture" : "placeholder";
  }

  export(): { text: string; images: string[]; missingImages: string[] } {
    const refs = [...new Set(this.items.map(item => item.ref))];
    return { text: this.#editing.getText("R1").toString(), images: refs.filter(ref => this.blobs.has(ref)),
      missingImages: refs.filter(ref => !this.blobs.has(ref)) };
  }

  capture(): ImageReplicaCapture {
    return { editing: Buffer.from(Y.encodeStateAsUpdate(this.#editing)).toString("base64"),
      network: this.#network === this.#editing ? null : Buffer.from(Y.encodeStateAsUpdate(this.#network)).toString("base64"),
      blobs: [...this.blobs].map(([sha, bytes]) => [sha, Buffer.from(bytes).toString("base64")]) };
  }

  destroy(): void {
    this.#transport?.destroy();
    if (this.#network !== this.#editing) this.#network.destroy();
    this.#editing.destroy();
  }
}

function imageSocket(base: typeof WebSocket, publication: ImagePublication): typeof WebSocket {
  return class extends base {
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (!(data instanceof Uint8Array)) throw new Error("Image gate requires binary frames");
      if (publication.allow(data)) super.send(Uint8Array.from(data));
    }
  };
}
