import { HocuspocusProvider, MessageType, WebSocketStatus } from "@hocuspocus/provider";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import { messageYjsSyncStep1 } from "y-protocols/sync";

function requestsState(event: MessageEvent) {
  const decoder = createDecoder(new Uint8Array(event.data as ArrayBuffer));
  readVarString(decoder);
  return readVarUint(decoder) === MessageType.Sync && readVarUint(decoder) === messageYjsSyncStep1;
}

export class StateFirstProvider extends HocuspocusProvider {
  private sentState = false;
  private duringReply: Uint8Array[] | null = null;

  override async onOpen(event: Event) {
    this.sentState = false;
    await super.onOpen(event);
  }

  override documentUpdateHandler(update: Uint8Array, origin: unknown) {
    if (origin === this) return;
    if (this.sentState && this.configuration.websocketProvider.status === WebSocketStatus.Connected) {
      super.documentUpdateHandler(update, origin);
    } else {
      this.duringReply?.push(update);
      if (!this.hasUnsyncedChanges) this.incrementUnsyncedChanges();
    }
  }

  override onMessage(event: MessageEvent) {
    if (this.sentState || !requestsState(event)) return super.onMessage(event);
    const duringReply: Uint8Array[] = [];
    this.duringReply = duringReply;
    try { super.onMessage(event); } finally { this.duringReply = null; }
    this.sentState = true;
    for (const update of duringReply) super.documentUpdateHandler(update, null);
  }
}
