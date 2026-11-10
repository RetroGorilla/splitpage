import type { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { readFrame } from "../wire.ts";

export type RefusalView = {
  status: string;
  explanation: string | null;
  reason: string | null;
  publication: "attached" | "detached" | "retry-after";
  export: "Standalone copy";
};

export class RefusedDevicePolicy {
  private readonly provider: HocuspocusProvider;
  private readonly socket: HocuspocusProviderWebsocket;
  private stopped = false;
  private view: RefusalView = {
    status: "Saved on this device, sending", explanation: null, reason: null,
    publication: "attached", export: "Standalone copy",
  };
  private readonly stateless = ({ payload }: { payload: string }): void => {
    const notice: unknown = JSON.parse(payload);
    if (!notice || typeof notice !== "object" || this.stopped) return;
    if ("rejected" in notice && typeof notice.rejected === "string") this.refuse(notice.rejected);
    else if ("retryAfter" in notice && typeof notice.retryAfter === "string") {
      this.view = { ...this.view, publication: "retry-after", reason: notice.retryAfter,
        explanation: "refusal.retry-after" };
    }
  };
  private readonly closed = ({ event }: { event: { code: number } }): void => {
    if (event.code === 1009) { this.refuse("frame-too-large"); this.socket.disconnect(); }
  };
  private readonly message = (event: MessageEvent<ArrayBuffer>): void => {
    if (!this.stopped) return;
    const frame = readFrame(new Uint8Array(event.data));
    if (frame.kind === 8 || frame.kind === 7) this.socket.disconnect();
  };

  constructor(provider: HocuspocusProvider, socket: HocuspocusProviderWebsocket) {
    this.provider = provider;
    this.socket = socket;
    provider.on("stateless", this.stateless);
    socket.on("close", this.closed);
    socket.on("message", this.message);
  }

  private refuse(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.view = {
      status: reason === "access-removed" ? "Access removed, local work kept" : "Saved on this device",
      explanation: "refusal.export-standalone-then-rejoin", reason,
      publication: "detached", export: "Standalone copy",
    };
    this.provider.detach();
    this.socket.shouldConnect = false;
    this.socket.clearReconnectTimeout();
  }

  current(receiptStatus: string): RefusalView {
    return { ...this.view, status: this.stopped ? this.view.status : receiptStatus };
  }

  deliberateRejoin(openFreshReplica: () => void): void {
    if (!this.stopped) throw new Error("Rejoin requires a refused device");
    openFreshReplica();
  }

  destroy(): void {
    this.provider.off("stateless", this.stateless);
    this.socket.off("close", this.closed);
    this.socket.off("message", this.message);
  }
}
