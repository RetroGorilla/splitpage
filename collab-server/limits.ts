import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import type { InvitationRole } from "./access.ts";

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
  readonly maxConnectionsPerGuestInvitation: number;
  readonly maxMessagesPerSecond: number;
}

export function createRelayLimits(config: RelayLimitsConfig, now = () => performance.now()) {
  const activeSockets = new Set<Duplex>();
  const socketsByKey = new Map<string, Set<Duplex>>();
  const socketIdsBySocket = new Map<Duplex, Set<string>>();
  const byInvitation = new Map<string, Set<string>>();
  const reservations = new Map<string, string>();
  const messageWindows = new Map<string, number[]>();

  function invitationLimit(role: InvitationRole): number {
    return role === "guest" ? config.maxConnectionsPerGuestInvitation : config.maxConnectionsPerInvitation;
  }

  function releaseReservation(reservationId: string): void {
    const invitationId = reservations.get(reservationId);
    if (!invitationId) return;
    reservations.delete(reservationId);
    const inviteSet = byInvitation.get(invitationId);
    if (inviteSet) {
      inviteSet.delete(reservationId);
      if (inviteSet.size === 0) byInvitation.delete(invitationId);
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
        const boundIds = socketIdsBySocket.get(socket);
        if (boundIds) {
          for (const socketId of boundIds) messageWindows.delete(socketId);
          socketIdsBySocket.delete(socket);
        }
      });
      return true;
    },
    bindSocket(socketId: string, websocketKey: string | null): void {
      const candidates = websocketKey ? socketsByKey.get(websocketKey) : undefined;
      const socket = candidates?.size === 1 ? candidates.values().next().value : undefined;
      if (!socket || socket.destroyed) return;
      const boundIds = socketIdsBySocket.get(socket);
      if (boundIds) boundIds.add(socketId);
      else socketIdsBySocket.set(socket, new Set([socketId]));
    },
    totalSockets(): number {
      return activeSockets.size;
    },
    hasInvitationCapacity(invitationId: string, role: InvitationRole): boolean {
      const current = byInvitation.get(invitationId);
      return !current || current.size < invitationLimit(role);
    },
    tryAdmitInvitation(invitationId: string, role: InvitationRole): string | null {
      const current = byInvitation.get(invitationId);
      if (current && current.size >= invitationLimit(role)) return null;
      const reservationId = randomUUID();
      if (current) current.add(reservationId);
      else byInvitation.set(invitationId, new Set([reservationId]));
      reservations.set(reservationId, invitationId);
      return reservationId;
    },
    releaseInvitation(reservationId: string): void {
      releaseReservation(reservationId);
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
    }
  };
}
