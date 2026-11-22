import { HocuspocusProvider, MessageType } from "@hocuspocus/provider";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { createDecoder, readVarInt, readVarString, readVarUint } from "lib0/decoding";
import { createEncoder, Encoder, length, writeVarString } from "lib0/encoding";
import { messageYjsSyncStep1, messageYjsSyncStep2 } from "y-protocols/sync";

function relaySyncType(data: ArrayBuffer): number | undefined {
  const decoder = createDecoder(new Uint8Array(data));
  readVarString(decoder);
  if (readVarUint(decoder) === MessageType.Sync) return readVarUint(decoder);
}

export class StateFirstProvider extends HocuspocusProvider {
  private sentState = false;
  private awaitingFirstReply = true;
  private duringReply: Uint8Array[] | null = null;
  private heldSync: MessageEvent[] | null = null;
  private readonly onFirstReply: () => void;
  private readonly onStateRequest: () => void;
  private readonly checkPeerDelivery: () => boolean;

  constructor(configuration: HocuspocusProviderConfiguration, onFirstReply: () => void, onStateRequest: () => void, checkPeerDelivery: () => boolean) {
    super(configuration);
    this.onFirstReply = onFirstReply;
    this.onStateRequest = onStateRequest;
    this.checkPeerDelivery = checkPeerDelivery;
  }

  override async onOpen(event: Event) {
    this.sentState = false;
    this.heldSync = [];
    await super.onOpen(event);
  }

  override send(...args: Parameters<HocuspocusProvider["send"]>) {
    if (this.duringReply) {
      const encoder: unknown = args[1]?.encoder;
      if (encoder instanceof Encoder) {
        const address = createEncoder();
        writeVarString(address, this.effectiveName);
        // why: an empty reply adds two type bytes, a length byte and the two-byte empty Yjs update
        if (length(encoder) > length(address) + 5) this.heldSync = [];
      }
    }
    super.send(...args);
  }

  override documentUpdateHandler(update: Uint8Array, origin: unknown) {
    if (origin === this) return;
    if (this.sentState && this.configuration.websocketProvider.webSocket?.readyState === WebSocket.OPEN) {
      super.documentUpdateHandler(update, origin);
    } else {
      this.duringReply?.push(update);
      if (!this.hasUnsyncedChanges) this.incrementUnsyncedChanges();
    }
  }

  override onMessage(event: MessageEvent) {
    if (this.heldSync) {
      const decoder = createDecoder(new Uint8Array(event.data as ArrayBuffer));
      readVarString(decoder);
      const type = readVarUint(decoder);
      if (type === MessageType.Sync && (this.sentState || readVarUint(decoder) !== messageYjsSyncStep1)) {
        this.heldSync.push(event);
        return;
      }
      if (this.sentState && type === MessageType.SyncStatus && readVarInt(decoder) === 1) {
        const held = this.heldSync;
        this.heldSync = null;
        super.onMessage(event);
        for (const frame of held) this.onMessage(frame);
        return;
      }
    }
    const sync = this.sentState && !this.awaitingFirstReply ? undefined : relaySyncType(event.data as ArrayBuffer);
    if (!this.sentState && sync === messageYjsSyncStep1) {
      const earlyFrames = this.heldSync ?? [];
      this.heldSync = null;
      this.onStateRequest();
      const duringReply: Uint8Array[] = [];
      this.duringReply = duringReply;
      try { super.onMessage(event); } finally { this.duringReply = null; }
      this.sentState = true;
      for (const frame of earlyFrames) this.onMessage(frame);
      for (const update of duringReply) this.documentUpdateHandler(update, null);
    } else {
      super.onMessage(event);
    }
    const delivered = this.checkPeerDelivery();
    if (this.awaitingFirstReply && sync === messageYjsSyncStep2 && delivered) {
      this.awaitingFirstReply = false;
      this.onFirstReply();
    }
  }

  override onClose() {
    this.heldSync = null;
    super.onClose();
  }

  override destroy() {
    this.heldSync = null;
    super.destroy();
  }
}
