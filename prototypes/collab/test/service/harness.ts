import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import { ConnectionReceipts } from "../../src/service/receipts.ts";
import { readFrame } from "../../src/service/wire.ts";

export async function until(check: () => boolean, label = "condition", timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(5);
  }
}

export class JournalChild {
  readonly child: ChildProcess;
  readonly events: Record<string, unknown>[] = [];
  stderr = "";
  port = 0;

  constructor(path: string, environment: Record<string, string> = {}) {
    this.child = fork(new URL("../../src/service/server-process.ts", import.meta.url), [path], {
      stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, ...environment },
    });
    this.child.on("message", (value: unknown) => {
      if (typeof value === "object" && value !== null) this.events.push(value as Record<string, unknown>);
    });
    this.child.stderr?.on("data", (data: Buffer) => { this.stderr += data.toString(); });
  }

  async ready(): Promise<void> {
    await until(() => this.events.some(e => e.event === "ready") || this.child.exitCode !== null, "child ready");
    const ready = this.events.find(e => e.event === "ready");
    assert.ok(ready, this.stderr);
    assert.deepEqual(ready.configuration, { journalMode: "wal", synchronous: 2 });
    this.port = Number(ready.port);
    assert.ok(this.port > 0);
  }

  async command(command: string, data: Record<string, unknown> = {}, response = "configured"): Promise<Record<string, unknown>> {
    const start = this.events.length;
    this.child.send({ command, ...data });
    await until(() => this.events.slice(start).some(e => e.event === response), response);
    const result = this.events.slice(start).find(e => e.event === response);
    assert.ok(result);
    return result;
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGKILL");
    await exited;
  }
}

export async function workspace(): Promise<{ path: string; start: () => Promise<JournalChild>; clean: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), "journal-"));
  const children: JournalChild[] = [];
  return {
    path: join(folder, "updates.sqlite"),
    async start() {
      const server = new JournalChild(join(folder, "updates.sqlite"));
      children.push(server);
      await server.ready();
      return server;
    },
    async clean() {
      for (const server of children) await server.kill();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

export type HarnessTransmission = { lifetime: number; bytes: string; applied: boolean | null };
export type HarnessSavedPromise = { status: string; local: string[]; acknowledged: string[] };

export class FixtureClient {
  readonly document: Y.Doc;
  readonly receipts = new ConnectionReceipts();
  readonly socket: HocuspocusProviderWebsocket;
  readonly provider: HocuspocusProvider;
  readonly history: HarnessTransmission[] = [];
  readonly promises: HarnessSavedPromise[] = [];
  readonly localUpdates: string[] = [];
  readonly observations: { count: number; outstanding: number; status: string }[] = [];
  readonly syncStartCounts: number[] = [];
  readonly frames: { direction: string; lifetime: number; kind: number; subtype: number; payload: string }[] = [];
  readonly sockets: WebSocket[] = [];
  onOpen: (() => void) | null = null;
  private lifetime = 0;

  constructor(port: number, document = fixture()) {
    this.document = document;
    this.localUpdates.push(Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"));
    function observedSocket(owner: FixtureClient): typeof WebSocket {
      return class extends WebSocket {
        readonly lifetime: number;
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.lifetime = owner.receipts.open();
          owner.lifetime = this.lifetime;
          owner.sockets.push(this);
          this.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
            const bytes = new Uint8Array(event.data);
            const frame = readFrame(bytes);
            owner.frames.push({ direction: "in", lifetime: this.lifetime, kind: frame.kind, subtype: frame.subtype, payload: Buffer.from(frame.payload).toString("base64") });
            if (frame.kind === 8) {
              const sent = owner.history.find(item => item.lifetime === this.lifetime && item.applied === null);
              assert.ok(sent, "harness acknowledgement must match a send");
              sent.applied = frame.subtype === 1;
              owner.receipts.received(this.lifetime, bytes);
              queueMicrotask(() => {
                owner.observations.push({ count: owner.provider.unsyncedChanges, outstanding: owner.receipts.outstanding, status: owner.receipts.status });
                owner.recordPromise();
              });
            }
          });
          this.addEventListener("close", () => owner.receipts.close(this.lifetime));
        }
        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          assert.ok(data instanceof Uint8Array);
          const frame = readFrame(data);
          if (frame.kind === 0 && frame.subtype === 0) owner.syncStartCounts.push(owner.provider.unsyncedChanges);
          owner.frames.push({ direction: "out", lifetime: this.lifetime, kind: frame.kind, subtype: frame.subtype, payload: Buffer.from(frame.payload).toString("base64") });
          if (frame.kind === 0 && (frame.subtype === 1 || frame.subtype === 2)) {
            owner.history.push({ lifetime: this.lifetime, bytes: Buffer.from(frame.payload).toString("base64"), applied: null });
          }
          owner.receipts.sent(this.lifetime, data);
          super.send(Uint8Array.from(data));
        }
      };
    }
    const ObservedSocket = observedSocket(this);
    this.document.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== this.provider) {
        this.localUpdates.push(Buffer.from(update).toString("base64"));
        this.receipts.localUpdate(update);
      }
    });
    this.socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}`, autoConnect: false, WebSocketPolyfill: ObservedSocket,
      delay: 10000, initialDelay: 0, jitter: false, maxAttempts: 1,
    });
    this.socket.shouldConnect = false;
    this.provider = new HocuspocusProvider({
      name: "fixture", document, awareness: null, websocketProvider: this.socket,
      onOpen: () => { queueMicrotask(() => this.onOpen?.()); },
    });
    this.provider.attach();
  }

  async connect(): Promise<void> {
    void this.socket.connect();
    await until(() => this.socket.status === "connected", "socket open");
  }

  async saved(): Promise<void> {
    await until(() => this.receipts.status === "Your changes saved to server", "truthful saved status");
    this.recordPromise();
  }

  private recordPromise(): void {
    if (this.receipts.status !== "Your changes saved to server") return;
    this.promises.push({
      status: this.receipts.status, local: [...this.localUpdates],
      acknowledged: this.history.filter(item => item.applied).map(item => item.bytes),
    });
  }

  async drop(): Promise<void> {
    this.socket.shouldConnect = false;
    this.socket.webSocket?.close();
    await until(() => this.socket.webSocket === null, "ordinary close");
    this.receipts.close(this.lifetime);
  }

  edit(character: string): Uint8Array {
    let update: Uint8Array = new Uint8Array();
    const capture = (bytes: Uint8Array): void => { update = bytes; };
    this.document.once("update", capture);
    this.document.getText("R1").insert(this.document.getText("R1").length, character);
    return update;
  }

  destroy(): void {
    this.provider.destroy();
    this.socket.destroy();
    this.document.destroy();
  }
}

export function fixture(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 7;
  doc.getText("R1").insert(0, "abcd");
  doc.clientID = 11;
  return doc;
}

export function characterIdentities(document: Y.Doc): string[] {
  const text = document.getText("R1");
  return Array.from(text.toString(), (character, index) => {
    const id = Y.createRelativePositionFromTypeIndex(text, index).item;
    assert.ok(id);
    return `${character}:${id.client}:${id.clock}`;
  });
}

export function checkHistory(history: readonly HarnessTransmission[], rows: readonly { sequence: number; payload: string }[], promises: readonly HarnessSavedPromise[] = []): void {
  let previous = 0;
  for (const row of rows) {
    assert.ok(row.sequence > previous, "journal sequences must increase");
    previous = row.sequence;
  }
  for (const sent of history.filter(item => item.applied)) {
    assert.ok(rows.some(row => row.payload === sent.bytes), `Acknowledged update missing from recovered journal: ${sent.bytes}`);
  }
  for (const promise of promises) {
    const covered = new Y.Doc();
    try {
      for (const payload of promise.acknowledged) {
        assert.ok(rows.some(row => row.payload === payload), "Saved promise requires a committed message");
        Y.applyUpdate(covered, Buffer.from(payload, "base64"));
      }
      for (const payload of promise.local) {
        assert.ok(Y.snapshotContainsUpdate(Y.snapshot(covered), Buffer.from(payload, "base64")), "Saved promise does not cover a local edit");
      }
    } finally { covered.destroy(); }
  }
}

export function journalRows(inspection: Record<string, unknown>): { sequence: number; payload: string }[] {
  assert.ok(Array.isArray(inspection.rows));
  return inspection.rows.map((row: unknown) => {
    assert.ok(typeof row === "object" && row !== null && "sequence" in row && "payload" in row);
    assert.equal(typeof row.payload, "string");
    return { sequence: Number(row.sequence), payload: String(row.payload) };
  });
}

export function readRecoveredRows(path: string): { sequence: number; payload: string }[] {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    return reader.prepare("SELECT sequence, payload FROM updates WHERE document = 'fixture' ORDER BY sequence").all().map(row => {
      assert.ok(row.payload instanceof Uint8Array);
      return { sequence: Number(row.sequence), payload: Buffer.from(row.payload).toString("base64") };
    });
  } finally { reader.close(); }
}
