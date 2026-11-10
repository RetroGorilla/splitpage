import * as Y from "yjs";
import { readFrame } from "./wire.ts";

type ReceiptRange = { client: number; start: number; end: number; deletion: boolean };

function ranges(update: Uint8Array): ReceiptRange[] {
  const decoded = Y.decodeUpdate(update);
  return [
    ...decoded.structs.filter(struct => struct.constructor !== Y.Skip).map(struct => ({
      client: struct.id.client, start: struct.id.clock, end: struct.id.clock + struct.length, deletion: false,
    })),
    ...Array.from(decoded.ds.clients).flatMap(([client, items]) => items.map(item => ({
      client, start: item.clock, end: item.clock + item.len, deletion: true,
    }))),
  ];
}

export class ConnectionReceipts {
  private readonly instance: string | null;
  private lifetime = 0;
  private online = false;
  private exchangeSeen = false;
  private pending: ReceiptRange[][] = [];
  private durable: ReceiptRange[] = [];
  private edits: ReceiptRange[][] = [];
  private invalid = false;
  private refused: ReceiptRange[][] = [];

  constructor(instance: string | null = null) { this.instance = instance; }

  localUpdate(update: Uint8Array): void {
    this.edits.push(ranges(update));
  }

  restoreAcknowledged(capture: { instance: string; updates: readonly Uint8Array[] }): void {
    if (!this.instance || capture.instance !== this.instance) throw new Error("Receipt instance mismatch");
    for (const update of capture.updates) this.durable.push(...ranges(update));
  }

  open(): number {
    this.lifetime++;
    this.online = true;
    this.exchangeSeen = false;
    this.pending = [];
    return this.lifetime;
  }

  close(lifetime: number): void {
    if (lifetime !== this.lifetime) return;
    this.online = false;
    this.pending = [];
  }

  sent(lifetime: number, bytes: Uint8Array): void {
    if (lifetime !== this.lifetime || !this.online) return;
    const frame = readFrame(bytes);
    if (frame.kind === 0 && (frame.subtype === 1 || frame.subtype === 2)) {
      try { this.pending.push(ranges(frame.payload)); }
      catch { this.invalid = true; this.pending.push([]); }
      if (frame.subtype === 1) this.exchangeSeen = true;
    }
  }

  received(lifetime: number, bytes: Uint8Array): void {
    if (lifetime !== this.lifetime || !this.online) return;
    const frame = readFrame(bytes);
    if (frame.kind !== 8) return;
    const accepted = this.pending.shift();
    if (!accepted) throw new Error("Acknowledgement without a transmitted message");
    if (frame.subtype === 1) this.durable.push(...accepted);
    else this.refused.push(accepted);
  }

  get outstanding(): number {
    return this.pending.length;
  }

  get status(): string {
    if (!this.online) return "Offline, saved on this device";
    const covered = [...this.edits, ...this.refused].every(edit => edit.every(range => {
      let cursor = range.start;
      const matches = this.durable.filter(item => item.client === range.client && item.deletion === range.deletion)
        .sort((a, b) => a.start - b.start);
      for (const match of matches) {
        if (match.start > cursor) break;
        cursor = Math.max(cursor, match.end);
      }
      return cursor >= range.end;
    }));
    return this.exchangeSeen && !this.invalid && this.pending.length === 0 && covered
      ? "Your changes saved to server" : "Saved on this device, sending";
  }
}
