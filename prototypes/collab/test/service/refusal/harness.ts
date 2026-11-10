import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, connect } from "node:net";
import type { Socket } from "node:net";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import { ConnectionReceipts } from "../../../src/service/receipts.ts";
import { RefusedDevicePolicy } from "../../../src/service/refusal/policy.ts";
import { readFrame } from "../../../src/service/wire.ts";
import { fixture, readRecoveredRows, until } from "../harness.ts";

export type RefusalExpectation = "accepted" | "invalid-update" | "state-too-large" | "rate-window" | "frame-too-large" | "malformed-frame" | "access-removed" | "merged-state-too-large";
type Sent = { expectation: RefusalExpectation; subtype: number; payload: Uint8Array; applied: boolean | null };

function observeProxyRefusal(refused: () => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let fragments: Buffer[] = [];
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      assert.match(buffer.subarray(0, end).toString(), /^HTTP\/1\.1 101 /);
      buffer = buffer.subarray(end + 4);
      upgraded = true;
    }
    while (buffer.length >= 2) {
      const first = buffer[0] ?? 0;
      const second = buffer[1] ?? 0;
      assert.equal(first & 0x70, 0, "Proxy observation requires uncompressed server frames");
      assert.equal(second & 0x80, 0, "Server frames must be unmasked");
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const wide = buffer.readBigUInt64BE(2);
        assert.ok(wide <= 41943040n, "Bound the proxy's server-frame buffering");
        length = Number(wide); offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      const opcode = first & 0x0f;
      if (opcode === 8 && payload.length >= 2 && payload.readUInt16BE(0) === 1009) refused();
      if (opcode === 1 || opcode === 2) fragments = [payload];
      else if (opcode === 0) fragments.push(payload);
      else continue;
      if (!(first & 0x80)) continue;
      const message = readFrame(Buffer.concat(fragments));
      fragments = [];
      if (message.kind !== 5) continue;
      let prefix = 0;
      while (true) {
        const byte = message.payload[prefix++];
        assert.notEqual(byte, undefined, "Stateless string must have a complete length prefix");
        if (byte !== undefined && byte < 128) break;
      }
      const notice: unknown = JSON.parse(new TextDecoder().decode(message.payload.subarray(prefix)));
      if (notice && typeof notice === "object" && "rejected" in notice && typeof notice.rejected === "string") refused();
    }
  };
}

export async function countingProxy(target: number): Promise<{
  port: number; attempts: () => number; refusalSeen: () => boolean; afterRefusal: () => number; close: () => Promise<void>;
}> {
  let accepts = 0;
  let refusalSeen = false;
  let afterRefusal = 0;
  const sockets = new Set<Socket>();
  const proxy = createServer(incoming => {
    accepts++;
    if (refusalSeen) afterRefusal++;
    const outgoing = connect(target, "127.0.0.1");
    outgoing.on("data", observeProxyRefusal(() => { refusalSeen = true; }));
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.on("error", () => { incoming.destroy(); outgoing.destroy(); });
      socket.on("close", () => { sockets.delete(socket); incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing); outgoing.pipe(incoming);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port, attempts: () => accepts, refusalSeen: () => refusalSeen, afterRefusal: () => afterRefusal,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    },
  };
}

export function frame(subtype: number, payload: Uint8Array): Uint8Array {
  const length: number[] = [];
  let value = payload.length;
  while (value > 127) { length.push((value & 127) | 128); value = Math.floor(value / 128); }
  length.push(value);
  return Buffer.concat([Buffer.from([7, ...Buffer.from("fixture"), 0, subtype, ...length]), payload]);
}

export class RefusalClient {
  readonly document: Y.Doc;
  readonly socket: HocuspocusProviderWebsocket;
  readonly provider: HocuspocusProvider;
  readonly policy: RefusedDevicePolicy;
  readonly receipts = new ConnectionReceipts();
  readonly sent: Sent[] = [];
  readonly frames: { disposition: string; kind: number; subtype: number }[] = [];
  readonly incoming: { kind: number; subtype: number }[] = [];
  readonly closes: number[] = [];
  readonly notices: string[] = [];
  readonly views: string[] = [];
  private readonly expectations: RefusalExpectation[];

  constructor(port: number, initial: RefusalExpectation[], document = fixture(), policy = true) {
    this.document = document;
    this.expectations = [...initial];
    function observedSocket(owner: RefusalClient): typeof WebSocket {
      return class extends WebSocket {
        private readonly lifetime: number;
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.lifetime = owner.receipts.open();
          this.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
            const bytes = new Uint8Array(event.data);
            const parsed = readFrame(bytes);
            owner.incoming.push({ kind: parsed.kind, subtype: parsed.subtype });
            if (parsed.kind === 8) {
              const sent = owner.sent.find(item => item.applied === null);
              assert.ok(sent, "Receipt requires a harness-observed send");
              sent.applied = parsed.subtype === 1;
              owner.receipts.received(this.lifetime, bytes);
            }
            queueMicrotask(() => owner.views.push(owner.policy.current(owner.receipts.status).status));
          });
          this.addEventListener("close", (event: CloseEvent) => {
            owner.receipts.close(this.lifetime);
            owner.closes.push(event.code);
          });
        }
        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          assert.ok(data instanceof Uint8Array);
          let parsed;
          try { parsed = readFrame(data); }
          catch {
            assert.equal(owner.expectations.shift(), "malformed-frame");
            owner.frames.push({ disposition: "malformed-frame", kind: 0, subtype: 2 });
            super.send(Uint8Array.from(data));
            return;
          }
          let disposition = "protocol";
          if (parsed.kind === 0 && (parsed.subtype === 1 || parsed.subtype === 2)) {
            const expectation = owner.expectations.shift();
            assert.ok(expectation, "Every update requires a literal declared disposition");
            disposition = expectation;
            owner.sent.push({ expectation, subtype: parsed.subtype, payload: parsed.payload, applied: null });
          }
          owner.frames.push({ disposition, kind: parsed.kind, subtype: parsed.subtype });
          owner.receipts.sent(this.lifetime, data);
          super.send(Uint8Array.from(data));
        }
      };
    }
    const ObservedSocket = observedSocket(this);
    this.socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}`, autoConnect: false, WebSocketPolyfill: ObservedSocket,
      delay: 1, minDelay: 1, initialDelay: 0, jitter: false,
    });
    this.provider = new HocuspocusProvider({
      name: "fixture", document, awareness: null, websocketProvider: this.socket,
      onStateless: ({ payload }) => { this.notices.push(payload); },
    });
    this.policy = new RefusedDevicePolicy(this.provider, this.socket);
    if (!policy) this.policy.destroy();
    document.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== this.provider) this.receipts.localUpdate(update);
    });
    this.provider.attach();
  }

  expect(...expectations: RefusalExpectation[]): void { this.expectations.push(...expectations); }

  notice(index = 0): unknown {
    const payload = this.notices[index];
    assert.ok(payload, "Expected an observed stateless notice");
    return JSON.parse(payload) as unknown;
  }

  async connect(): Promise<void> {
    void this.socket.connect();
    await until(() => this.socket.status === "connected" || this.notices.length > 0, "connection or refusal");
  }

  async saved(): Promise<void> {
    await until(() => this.receipts.status === "Your changes saved to server", "initial durable receipt");
  }

  edit(text: string): void { this.document.getText("R1").insert(this.document.getText("R1").length, text); }

  assertDetached(proxy: { refusalSeen: () => boolean; afterRefusal: () => number }): void {
    assert.equal(proxy.refusalSeen(), true, "Proxy must independently observe the first refusal");
    assert.equal(proxy.afterRefusal(), 0, "Refused policy must not reconnect");
    assert.equal(this.socket.shouldConnect, false, "Refused policy must cancel connection retries");
    assert.equal(this.socket.reconnectTimeout, null, "Refused policy must cancel scheduled reconnect");
    assert.equal(this.socket.configuration.providerMap.has("fixture"), false, "Refused provider must detach");
    const frames = this.frames.length;
    const length = this.document.getText("R1").length;
    this.edit("!");
    this.provider.forceSync();
    assert.equal(this.document.getText("R1").length, length + 1, "Causal probe must really edit the local replica");
    assert.equal(this.frames.length, frames, "A later edit and forceSync must send no frame on any socket");
    assert.notEqual(this.policy.current("Your changes saved to server").status, "Your changes saved to server");
  }

  checkJournal(path: string): void {
    const rows = readRecoveredRows(path);
    for (const sent of this.sent) {
      const encoded = Buffer.from(sent.payload).toString("base64");
      if (sent.expectation === "accepted") {
        assert.equal(sent.applied, true);
        assert.ok(rows.some(row => row.payload === encoded), "Accepted send must have exact recovered bytes");
      } else {
        assert.notEqual(sent.applied, true, "Refused send must have no positive receipt");
        assert.equal(rows.some(row => row.payload === encoded), false, "Refused send must not reach the journal");
        if (sent.expectation === "invalid-update") assert.throws(() => Y.decodeUpdate(sent.payload));
        if (sent.expectation === "state-too-large") assert.ok(sent.payload.byteLength > 2097152);
        if (sent.expectation === "frame-too-large") assert.ok(sent.payload.byteLength > 4194304);
      }
    }
  }

  destroy(): void {
    this.policy.destroy(); this.provider.destroy(); this.socket.destroy(); this.document.destroy();
  }
}
