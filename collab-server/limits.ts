import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

export const MAX_WS_FRAGMENTS = 4096;
export const MAX_WS_BUFFERED_CHUNKS = 32_768;
export const MAX_UNAUTHENTICATED_QUEUE_BYTES = 262_144;
export const MAX_UNAUTHENTICATED_QUEUE_MESSAGES = 32;
export const MAX_PENDING_DOCUMENTS = 4;
export const HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 15_000;
export const HTTP_REQUEST_TIMEOUT_MS = 60_000;
export const HTTP_MAX_HEADERS_COUNT = 64;
export const RETRY_AFTER_SECONDS = "5";

export interface RelayLimitsConfig {
  readonly maxConnections: number;
  readonly maxConnectionsPerInvitation: number;
  readonly maxMessagesPerSecond: number;
}

interface ReservationRecord {
  readonly invitationId: string;
  readonly documentName: string;
  readonly detachSocket: () => void;
}

export function createRelayLimits(config: RelayLimitsConfig, now = () => performance.now()) {
  const activeSockets = new Set<Duplex>();
  const socketsByKey = new Map<string, Set<Duplex>>();
  const byInvitation = new Map<string, Set<string>>();
  const pendingByDocument = new Map<string, Set<string>>();
  const reservations = new Map<string, ReservationRecord>();
  const messageWindows = new Map<string, number[]>();

  function releaseReservation(reservationId: string): void {
    const record = reservations.get(reservationId);
    if (!record) return;
    reservations.delete(reservationId);
    record.detachSocket();
    const inviteSet = byInvitation.get(record.invitationId);
    if (inviteSet) {
      inviteSet.delete(reservationId);
      if (inviteSet.size === 0) byInvitation.delete(record.invitationId);
    }
    const pendingSet = pendingByDocument.get(record.documentName);
    if (pendingSet) {
      pendingSet.delete(reservationId);
      if (pendingSet.size === 0) pendingByDocument.delete(record.documentName);
    }
  }

  return {
    tryAdmitSocket(socket: Duplex, websocketKey?: string): boolean {
      if (socket.destroyed || activeSockets.size >= config.maxConnections) return false;
      activeSockets.add(socket);
      if (websocketKey) {
        const group = socketsByKey.get(websocketKey);
        if (group) group.add(socket);
        else socketsByKey.set(websocketKey, new Set([socket]));
      }
      socket.once("close", () => {
        activeSockets.delete(socket);
        if (websocketKey) {
          const group = socketsByKey.get(websocketKey);
          if (group) {
            group.delete(socket);
            if (group.size === 0) socketsByKey.delete(websocketKey);
          }
        }
      });
      return true;
    },
    totalSockets(): number {
      return activeSockets.size;
    },
    tryAdmitInvitation(invitationId: string, documentName: string, websocketKey: string | null): string | null {
      const candidates = websocketKey ? socketsByKey.get(websocketKey) : undefined;
      const socket = candidates?.size === 1 ? candidates.values().next().value : undefined;
      if (socket?.destroyed) return null;
      const current = byInvitation.get(invitationId);
      if (current && current.size >= config.maxConnectionsPerInvitation) return null;
      const reservationId = randomUUID();
      if (current) current.add(reservationId);
      else byInvitation.set(invitationId, new Set([reservationId]));
      const pending = pendingByDocument.get(documentName);
      if (pending) pending.add(reservationId);
      else pendingByDocument.set(documentName, new Set([reservationId]));
      let detachSocket = () => undefined;
      if (socket) {
        const onSocketClose = () => releaseReservation(reservationId);
        socket.once("close", onSocketClose);
        detachSocket = () => { socket.off("close", onSocketClose); };
      }
      reservations.set(reservationId, { invitationId, documentName, detachSocket });
      return reservationId;
    },
    activateInvitation(reservationId: string): void {
      const record = reservations.get(reservationId);
      if (!record) return;
      const pending = pendingByDocument.get(record.documentName);
      if (pending) {
        pending.delete(reservationId);
        if (pending.size === 0) pendingByDocument.delete(record.documentName);
      }
    },
    releaseInvitation(reservationId: string): void {
      releaseReservation(reservationId);
    },
    releasePendingForDocument(documentName: string): void {
      const pending = pendingByDocument.get(documentName);
      if (!pending) return;
      for (const reservationId of [...pending]) releaseReservation(reservationId);
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
    }
  };
}
