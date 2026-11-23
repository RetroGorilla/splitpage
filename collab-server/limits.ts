import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export const MAX_WS_FRAGMENTS = 1024;
export const MAX_WS_BUFFERED_CHUNKS = 1024;
export const MAX_UNAUTHENTICATED_QUEUE_BYTES = 262_144;
export const MAX_UNAUTHENTICATED_QUEUE_MESSAGES = 32;
export const MAX_PENDING_DOCUMENTS = 4;
export const HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 15_000;
export const HTTP_REQUEST_TIMEOUT_MS = 60_000;
export const HTTP_MAX_HEADERS_COUNT = 64;
export const RETRY_AFTER_SECONDS = "5";

const PICTURE_UPLOAD_PATH = /^\/api\/scripts\/[^/?]+\/pictures\/[^/?]+$/;

export interface RelayLimitsConfig {
  readonly maxConnections: number;
  readonly maxConnectionsPerInvitation: number;
  readonly maxMessagesPerSecond: number;
  readonly maxUploadsInFlight: number;
}

export function isPictureUpload(request: IncomingMessage): boolean {
  const path = (request.url ?? "").split("?")[0] ?? "";
  return request.method === "PUT" && PICTURE_UPLOAD_PATH.test(path);
}

export function createRelayLimits(config: RelayLimitsConfig, now = () => performance.now()) {
  const activeSockets = new Set<Duplex>();
  const byInvitation = new Map<string, Set<string>>();
  const messageWindows = new Map<string, number[]>();
  let inFlightUploads = 0;

  return {
    tryAdmitSocket(socket: Duplex): boolean {
      if (socket.destroyed || activeSockets.size >= config.maxConnections) return false;
      activeSockets.add(socket);
      socket.once("close", () => { activeSockets.delete(socket); });
      return true;
    },
    totalSockets(): number {
      return activeSockets.size;
    },
    tryAdmitInvitation(invitationId: string): string | null {
      const current = byInvitation.get(invitationId);
      if (current && current.size >= config.maxConnectionsPerInvitation) return null;
      const reservationId = randomUUID();
      if (current) current.add(reservationId);
      else byInvitation.set(invitationId, new Set([reservationId]));
      return reservationId;
    },
    releaseInvitation(invitationId: string, reservationId: string): void {
      const current = byInvitation.get(invitationId);
      if (!current) return;
      current.delete(reservationId);
      if (current.size === 0) byInvitation.delete(invitationId);
    },
    allowMessage(socketId: string): boolean {
      const timestamp = now();
      const cutoff = timestamp - 1000;
      if (messageWindows.size > config.maxConnections * 2) {
        for (const [id, times] of messageWindows) {
          if (times.length === 0 || (times[times.length - 1] ?? 0) <= cutoff) messageWindows.delete(id);
        }
      }
      const entries = messageWindows.get(socketId) ?? [];
      while (entries.length > 0 && (entries[0] ?? 0) <= cutoff) entries.shift();
      if (entries.length >= config.maxMessagesPerSecond) {
        messageWindows.set(socketId, entries);
        return false;
      }
      entries.push(timestamp);
      messageWindows.set(socketId, entries);
      return true;
    },
    clearSocket(socketId: string): void {
      messageWindows.delete(socketId);
    },
    tryAdmitUpload(response: ServerResponse): boolean {
      if (inFlightUploads >= config.maxUploadsInFlight) return false;
      inFlightUploads += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        inFlightUploads -= 1;
      };
      response.once("finish", release);
      response.once("close", release);
      return true;
    },
    uploadsInFlight(): number {
      return inFlightUploads;
    }
  };
}
