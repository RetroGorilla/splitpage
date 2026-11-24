import { HocuspocusProvider, MessageType } from "@hocuspocus/provider";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { createDecoder, readVarInt, readVarString, readVarUint } from "lib0/decoding";
import { createEncoder, Encoder, length, toUint8Array, writeVarString } from "lib0/encoding";
import { messageYjsSyncStep1, messageYjsSyncStep2 } from "y-protocols/sync";

export interface StateFirstConfirmationHooks {
  readonly onReset: () => void;
  readonly onSyncReplySent: () => void;
  readonly onConnectedUpdateSent: () => void;
  readonly onSyncStatus: (applied: boolean) => void;
}

type FrameHeader =
  | { readonly type: MessageType.Sync; readonly sync: number }
  | { readonly type: MessageType.SyncStatus; readonly applied: boolean };

function relayFrameHeader(data: ArrayBuffer): FrameHeader | undefined {
  const decoder = createDecoder(new Uint8Array(data));
  readVarString(decoder);
  const type = readVarUint(decoder);
  if (type === MessageType.Sync) return { type, sync: readVarUint(decoder) };
  if (type === MessageType.SyncStatus) return { type, applied: readVarInt(decoder) === 1 };
}

function outgoingSyncType(encoder: Encoder): number | undefined {
  const decoder = createDecoder(toUint8Array(encoder));
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
  private readonly confirmations: StateFirstConfirmationHooks | undefined;

  constructor(
    configuration: HocuspocusProviderConfiguration,
    onFirstReply: () => void,
    onStateRequest: () => void,
    checkPeerDelivery: () => boolean,
    confirmations?: StateFirstConfirmationHooks
  ) {
    super(configuration);
    this.onFirstReply = onFirstReply;
    this.onStateRequest = onStateRequest;
    this.checkPeerDelivery = checkPeerDelivery;
    this.confirmations = confirmations;
  }

  override async onOpen(event: Event) {
    this.confirmations?.onReset();
    this.sentState = false;
    this.heldSync = [];
    await super.onOpen(event);
  }

  override send(...args: Parameters<HocuspocusProvider["send"]>) {
    const attached = this.isAttached;
    const encoder: unknown = args[1]?.encoder;
    if (this.duringReply && encoder instanceof Encoder) {
      const address = createEncoder();
      writeVarString(address, this.effectiveName);
      // why: an empty reply adds two type bytes, a length byte and the two-byte empty Yjs update
      if (length(encoder) > length(address) + 5) this.heldSync = [];
    }
    super.send(...args);
    if (attached && this.confirmations && encoder instanceof Encoder && outgoingSyncType(encoder) === messageYjsSyncStep2) {
      this.confirmations.onSyncReplySent();
    }
  }

  override documentUpdateHandler(update: Uint8Array, origin: unknown) {
    if (origin === this) return;
    if (this.sentState && this.configuration.websocketProvider.webSocket?.readyState === WebSocket.OPEN) {
      const attached = this.isAttached;
      super.documentUpdateHandler(update, origin);
      if (attached) this.confirmations?.onConnectedUpdateSent();
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
      if (this.sentState && type === MessageType.SyncStatus) {
        const applied = readVarInt(decoder) === 1;
        if (applied) {
          const held = this.heldSync;
          this.heldSync = null;
          super.onMessage(event);
          this.confirmations?.onSyncStatus(true);
          for (const frame of held) this.onMessage(frame);
          return;
        }
        super.onMessage(event);
        this.confirmations?.onSyncStatus(false);
        return;
      }
    }
    const inspect = !this.sentState || this.awaitingFirstReply || this.confirmations !== undefined;
    const frame = inspect ? relayFrameHeader(event.data as ArrayBuffer) : undefined;
    const sync = frame?.type === MessageType.Sync ? frame.sync : undefined;
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
      if (frame?.type === MessageType.SyncStatus) this.confirmations?.onSyncStatus(frame.applied);
    }
    const delivered = this.checkPeerDelivery();
    if (this.awaitingFirstReply && sync === messageYjsSyncStep2 && delivered) {
      this.awaitingFirstReply = false;
      this.onFirstReply();
    }
  }

  override onClose() {
    this.confirmations?.onReset();
    this.heldSync = null;
    super.onClose();
  }

  override destroy() {
    this.confirmations?.onReset();
    this.heldSync = null;
    super.destroy();
  }
}
