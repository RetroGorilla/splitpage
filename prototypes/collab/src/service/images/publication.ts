import { createHash } from "node:crypto";
import * as Y from "yjs";
import { readFrame } from "../wire.ts";

export type ImageGalleryItem = { id: string; beat: "R1"; ref: string; pending: boolean };
export type ImageDesign = "upload-before-sync" | "pending-image";
export type ImageMechanism = "one-document" | "two-documents";
export type ImageReplicaCapture = { editing: string; network: string | null; blobs: [string, string][] };

export class ImagePublication {
  readonly editing: Y.Doc;
  readonly network: Y.Doc;
  readonly design: ImageDesign;
  readonly blobs = new Map<string, Uint8Array>();
  private readonly membership = new Set<string>();
  private readonly netOrigin = Object.freeze({ imageNetwork: true });
  resume: () => void = () => {};

  constructor(editing: Y.Doc, design: ImageDesign, mechanism: ImageMechanism = "one-document", capture?: ImageReplicaCapture) {
    this.editing = editing;
    this.design = design;
    if (capture) {
      Y.applyUpdate(editing, Buffer.from(capture.editing, "base64"));
      for (const [sha, bytes] of capture.blobs) this.blobs.set(sha, Buffer.from(bytes, "base64"));
    }
    this.network = mechanism === "one-document" ? editing : new Y.Doc();
    if (this.network !== editing) {
      Y.applyUpdate(this.network, capture?.network ? Buffer.from(capture.network, "base64") : Y.encodeStateAsUpdate(editing));
      this.network.on("update", this.inbound);
      editing.on("update", this.outbound);
    }
  }

  private readonly inbound = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this.netOrigin) Y.applyUpdate(this.editing, update, this.netOrigin);
  };

  private readonly outbound = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this.netOrigin && (this.design === "pending-image" || !this.waiting)) Y.applyUpdate(this.network, update, this.netOrigin);
  };

  get items(): ImageGalleryItem[] { return [...this.editing.getMap<ImageGalleryItem>("gallery").values()]; }
  get waiting(): boolean { return this.items.some(item => !this.membership.has(item.ref)); }
  isInbound(origin: unknown): boolean { return origin === this.netOrigin; }

  insert(bytes: Uint8Array, sha: string): void {
    if (createHash("sha256").update(bytes).digest("hex") !== sha) throw new Error("Local image hash mismatch");
    this.blobs.set(sha, Uint8Array.from(bytes));
    this.editing.getMap<ImageGalleryItem>("gallery").set("gP", {
      id: "gP", beat: "R1", ref: sha, pending: this.design === "pending-image",
    });
  }

  durable(sha: string): void {
    this.membership.add(sha);
    if (this.design === "pending-image") {
      for (const item of this.items) if (item.ref === sha && item.pending) {
        this.editing.getMap<ImageGalleryItem>("gallery").set(item.id, { ...item, pending: false });
      }
    }
    if (this.waiting) return;
    if (this.network !== this.editing) Y.applyUpdate(this.network,
      Y.encodeStateAsUpdate(this.editing, Y.encodeStateVector(this.network)), this.netOrigin);
    this.resume();
  }

  allow(bytes: Uint8Array): boolean {
    if (this.design !== "upload-before-sync" || this.network !== this.editing || !this.waiting) return true;
    const frame = readFrame(bytes);
    return frame.kind !== 0 || frame.subtype !== 1 && frame.subtype !== 2;
  }

  status(receiptStatus: string): string {
    if (receiptStatus === "Offline, saved on this device") return receiptStatus;
    return this.waiting ? "Saved on this device, waiting for images to upload" : receiptStatus;
  }

  picture(sha: string): "placeholder" | "picture" {
    return this.membership.has(sha) && this.items.some(item => item.ref === sha && !item.pending) ? "picture" : "placeholder";
  }

  export(): { text: string; images: string[]; missingImages: string[] } {
    const refs = [...new Set(this.items.map(item => item.ref))];
    return { text: this.editing.getText("R1").toString(), images: refs.filter(ref => this.blobs.has(ref)),
      missingImages: refs.filter(ref => !this.blobs.has(ref)) };
  }

  capture(): ImageReplicaCapture {
    return { editing: Buffer.from(Y.encodeStateAsUpdate(this.editing)).toString("base64"),
      network: this.network === this.editing ? null : Buffer.from(Y.encodeStateAsUpdate(this.network)).toString("base64"),
      blobs: [...this.blobs].map(([sha, bytes]) => [sha, Buffer.from(bytes).toString("base64")]) };
  }

  destroy(): void {
    if (this.network !== this.editing) {
      this.network.off("update", this.inbound); this.editing.off("update", this.outbound); this.network.destroy();
    }
  }
}

export function imageSocket(base: typeof WebSocket, publication: ImagePublication): typeof WebSocket {
  return class extends base {
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (!(data instanceof Uint8Array)) throw new Error("Image gate requires binary frames");
      if (publication.allow(data)) super.send(Uint8Array.from(data));
    }
  };
}
