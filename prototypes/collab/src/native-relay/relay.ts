import { HocuspocusProvider, HocuspocusProviderWebsocket, MessageType } from "@hocuspocus/provider";
import type { HocuspocusProviderWebsocketConfiguration, WebSocketStatus } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import type { ServerConfiguration } from "@hocuspocus/server";
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { loopback } from "./link.ts";

export type RelayPacket = { type: number; payload: Uint8Array };

export function readSyncFrame(data: Uint8Array): RelayPacket | undefined {
  if (data.length <= 1) return;
  const decoder = createDecoder(data);
  readVarString(decoder);
  if (readVarUint(decoder) !== MessageType.Sync) return;
  const type = readVarUint(decoder);
  if (type === messageYjsSyncStep2 || type === messageYjsUpdate) return { type, payload: readVarUint8Array(decoder) };
}

export async function openRelay(settings: Partial<ServerConfiguration> = {}) {
  const server = new Server({ address: loopback, port: 0, quiet: true, stopOnSignals: false, ...settings });
  try {
    await server.listen();
    return server;
  } catch (error) {
    await server.destroy();
    throw error;
  }
}

export function openCopy(url: string, id: number, settings: Partial<HocuspocusProviderWebsocketConfiguration> = {}, doc = new Y.Doc()) {
  doc.clientID = id;
  const signals: { name: string; at: number; synced: boolean; count: number }[] = [];
  const incoming: RelayPacket[] = [];
  const socket = new HocuspocusProviderWebsocket({ url, autoConnect: false, ...settings });
  const record = (name: string, count = provider.unsyncedChanges) => {
    signals.push({ name, at: performance.now(), synced: provider.synced, count });
  };
  const closeEvents: { at: number; code: number; reason: string }[] = [];
  const provider = new HocuspocusProvider({
    websocketProvider: socket, document: doc, name: "script",
    onOpen: () => record("open"),
    onConnect: () => record("connect"),
    onAuthenticated: () => record("authenticated"),
    onStatus: ({ status }) => record(status),
    onSynced: () => record("synced"),
    onUnsyncedChanges: ({ number }) => record("pending", number),
    onClose: () => record("close"),
    onDisconnect: ({ event }) => {
      closeEvents.push({ at: performance.now(), code: event.code, reason: String(event.reason ?? "") });
      record("disconnect");
    },
    onMessage: ({ event }) => {
      const packet = readSyncFrame(new Uint8Array(event.data as ArrayBuffer));
      if (packet) incoming.push(packet);
    }
  });
  provider.attach();
  return {
    doc, provider, socket, signals, incoming, closeEvents,
    connect() { void socket.connect().catch(() => undefined); },
    status(): WebSocketStatus { return socket.status; },
    close() {
      provider.destroy();
      socket.destroy();
      doc.destroy();
    }
  };
}

export async function until(predicate: () => unknown, label: string, timeout = 4_000) {
  const abort = AbortSignal.timeout(timeout);
  while (!predicate()) {
    if (abort.aborted) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}
