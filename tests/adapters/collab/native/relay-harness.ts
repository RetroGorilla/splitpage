import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { MessageType } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import type { ServerConfiguration } from "@hocuspocus/server";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import { WebSocket, WebSocketServer } from "ws";
import { openNativeRelay } from "../../../../src/adapters/collab/native/relay.ts";
import type { NativeRelayEvent } from "../../../../src/adapters/collab/native/relay.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeSessionSource } from "../../../../src/adapters/collab/native/session.ts";
import { cells } from "./helpers.ts";
import { AT } from "./record-harness.ts";
import { structureScript } from "./structure-harness.ts";

const LOOPBACK = "127.0.0.1";
const NAME = "relay-script";
const TOKEN = "test-token";
const sessionOptions = { actor: "writer", sanitize: (text: unknown) => typeof text === "string" ? text : "" };

export function seedRelaySession() {
  return openNativeSession({
    kind: "document", document: structureScript({ R: "word" }),
    conversion: { cells, creation: "seed", at: AT, by: "writer" }
  }, sessionOptions);
}

export class RelaySignals {
  private readonly changed = new EventEmitter();
  private readonly signal: AbortSignal;

  constructor(signal: AbortSignal) { this.signal = signal; }

  notify(): void { this.changed.emit("change"); }

  async until<T>(read: () => T | undefined): Promise<T> {
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      await once(this.changed, "change", { signal: this.signal });
    }
  }
}

export async function openRelayFixture(t: TestContext, options: Partial<ServerConfiguration> = {}) {
  const signals = new RelaySignals(t.signal);
  const authenticated: { name: string; token: string }[] = [];
  const server = new Server({
    address: LOOPBACK, port: 0, quiet: true, stopOnSignals: false,
    async onAuthenticate({ documentName, token }) {
      authenticated.push({ name: documentName, token });
      assert.equal(documentName, NAME);
      assert.equal(token, TOKEN);
      signals.notify();
    },
    ...options
  });
  const close: (() => void | Promise<void>)[] = [() => server.destroy()];
  t.after(async () => {
    for (const stop of close.reverse()) await stop();
  });
  await server.listen();

  const url = `ws://${LOOPBACK}:${server.address.port}`;
  return {
    signals, authenticated, url,
    bridge() {
      const bridge = new RelayBridge(url, signals);
      close.push(() => bridge.close());
      return bridge;
    },
    copy(address = url, source: NativeSessionSource = { kind: "empty" }, onEvent?: (event: NativeRelayEvent) => void) {
      const events: NativeRelayEvent[] = [];
      const session = openNativeSession(source, sessionOptions);
      session.subscribe(() => signals.notify());
      const relay = openNativeRelay(session, {
        url: address, name: NAME, token: TOKEN, sessionOptions,
        onEvent(event) {
          if (event.kind === "session-replaced") event.session.subscribe(() => signals.notify());
          events.push(event);
          signals.notify();
          onEvent?.(event);
        }
      });
      close.push(relay.close);
      return { relay, session, events };
    }
  };
}

export function relayFrameType(data: Buffer): number | undefined {
  if (data.length <= 1) return;
  const decoder = createDecoder(data);
  readVarString(decoder);
  if (readVarUint(decoder) === MessageType.Sync) return readVarUint(decoder);
}

type Intercept = (data: Buffer, forward: () => void) => void;

export class RelayLink {
  upload: Intercept = (_, forward) => forward();
  download: Intercept = (_, forward) => forward();
  readonly sent: number[] = [];
  readonly dropped: Buffer[] = [];
  closed = false;
  private readonly client: WebSocket;
  private readonly upstream: WebSocket;
  private readonly retired = new AbortController();
  readonly signal = this.retired.signal;

  constructor(client: WebSocket, upstream: WebSocket, signals: RelaySignals) {
    this.client = client;
    this.upstream = upstream;
    const queued: Buffer[] = [];
    upstream.on("open", () => {
      for (const frame of queued.splice(0)) upstream.send(frame);
    });
    client.on("message", (data: Buffer) => {
      this.upload(data, () => {
        const type = relayFrameType(data);
        if (type !== undefined) this.sent.push(type);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        if (upstream.readyState === WebSocket.CONNECTING) queued.push(data);
      });
      signals.notify();
    });
    upstream.on("message", (data: Buffer) => {
      this.download(data, () => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      });
      signals.notify();
    });
    for (const socket of [client, upstream]) {
      socket.on("error", () => socket.terminate());
      socket.once("close", () => {
        this.closed = true;
        this.retired.abort();
        this.cut();
        signals.notify();
      });
    }
  }

  cut(): void {
    this.client.terminate();
    this.upstream.terminate();
  }
}

export class RelayBridge {
  readonly links: RelayLink[] = [];
  configure: (link: RelayLink) => void = () => undefined;
  private readonly server = new WebSocketServer({ host: LOOPBACK, port: 0 });
  private readonly sockets = new Set<WebSocket>();

  constructor(url: string, signals: RelaySignals) {
    this.server.on("connection", client => {
      const upstream = new WebSocket(url);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
      }
      const link = new RelayLink(client, upstream, signals);
      this.links.push(link);
      this.configure(link);
      signals.notify();
    });
  }

  async listen(): Promise<string> {
    await once(this.server, "listening");
    return `ws://${LOOPBACK}:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    const closed = once(this.server, "close");
    this.server.close();
    await Promise.all([...this.sockets].map(socket => {
      const done = once(socket, "close").catch(() => undefined);
      socket.terminate();
      return done;
    }));
    await closed;
  }
}
