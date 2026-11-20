import { HocuspocusProvider, MessageType } from "@hocuspocus/provider";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
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
  private readonly onFirstReply: () => void;
  private readonly onStateRequest: () => void;

  constructor(configuration: HocuspocusProviderConfiguration, onFirstReply: () => void, onStateRequest: () => void) {
    super(configuration);
    this.onFirstReply = onFirstReply;
    this.onStateRequest = onStateRequest;
  }

  override async onOpen(event: Event) {
    this.sentState = false;
    await super.onOpen(event);
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
    const sync = this.sentState && !this.awaitingFirstReply ? undefined : relaySyncType(event.data as ArrayBuffer);
    if (!this.sentState && sync === messageYjsSyncStep1) {
      this.onStateRequest();
      const duringReply: Uint8Array[] = [];
      this.duringReply = duringReply;
      try { super.onMessage(event); } finally { this.duringReply = null; }
      this.sentState = true;
      for (const update of duringReply) this.documentUpdateHandler(update, null);
    } else {
      super.onMessage(event);
    }
    if (this.awaitingFirstReply && sync === messageYjsSyncStep2) {
      this.awaitingFirstReply = false;
      this.onFirstReply();
    }
  }
}
