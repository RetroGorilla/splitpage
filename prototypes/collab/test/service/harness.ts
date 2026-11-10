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

const journalPaths = new Map<number, string>();

export async function until(check: () => boolean, label = "condition", timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(5);
  }
}

export class JournalChild {
  readonly child: ChildProcess;
  readonly path: string;
  readonly events: Record<string, unknown>[] = [];
  private readonly heldEvents = new Map<string, Record<string, unknown>[]>();
  stderr = "";
  port = 0;

  constructor(path: string, environment: Record<string, string> = {}) {
    this.path = path;
    this.child = fork(new URL("../../src/service/server-process.ts", import.meta.url), [path], {
      stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, ...environment },
    });
    this.child.on("message", (value: unknown) => {
      if (typeof value !== "object" || value === null) return;
      const event = value as Record<string, unknown>;
      const held = this.heldEvents.get(String(event.event));
      if (held) held.push(event);
      else this.events.push(event);
    });
    this.child.stderr?.on("data", (data: Buffer) => { this.stderr += data.toString(); });
  }

  holdEvent(name: string): () => void {
    assert.equal(this.heldEvents.has(name), false);
    const held: Record<string, unknown>[] = [];
    this.heldEvents.set(name, held);
    return () => { this.heldEvents.delete(name); this.events.push(...held); };
  }

  async ready(): Promise<void> {
    await until(() => this.events.some(e => e.event === "ready") || this.child.exitCode !== null, "child ready");
    const ready = this.events.find(e => e.event === "ready");
    assert.ok(ready, this.stderr);
    assert.deepEqual(ready.configuration, { journalMode: "wal", synchronous: 2 });
    this.port = Number(ready.port);
    assert.ok(this.port > 0);
    journalPaths.set(this.port, this.path);
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

export async function workspace(): Promise<{ path: string; start: (environment?: Record<string, string>) => Promise<JournalChild>; clean: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), "journal-"));
  const children: JournalChild[] = [];
  return {
    path: join(folder, "updates.sqlite"),
    async start(environment = {}) {
      const server = new JournalChild(join(folder, "updates.sqlite"), environment);
      children.push(server);
      await server.ready();
      return server;
    },
    async clean() {
      for (const server of children) { await server.kill(); journalPaths.delete(server.port); }
      await rm(folder, { recursive: true, force: true });
    },
  };
}

export type HarnessMessageExpectation =
  | { disposition: "accepted" }
  | { disposition: "refused"; reason: "oversized"; maximumBytes: number }
  | { disposition: "refused"; reason: "undecodable" };
export type HarnessTransmission = HarnessMessageExpectation & {
  lifetime: number; bytes: string; applied: boolean | null;
  journalBeforeSend: number; notice: string | null;
};
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
  readonly closes: { lifetime: number; code: number; reason: string; status: string }[] = [];
  onOpen: (() => void) | null = null;
  private lifetime = 0;
  private readonly expectations: HarnessMessageExpectation[] = [];

  constructor(port: number, document = fixture()) {
    this.document = document;
    const journalPath = journalPaths.get(port);
    assert.ok(journalPath, "Socket must belong to a harness-owned journal");
    this.localUpdates.push(Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"));
    function observedSocket(owner: FixtureClient, journalPath: string): typeof WebSocket {
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
          this.addEventListener("close", (event: CloseEvent) => {
            owner.receipts.close(this.lifetime);
            owner.closes.push({ lifetime: this.lifetime, code: event.code, reason: event.reason, status: owner.receipts.status });
          });
        }
        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          assert.ok(data instanceof Uint8Array);
          const frame = readFrame(data);
          if (frame.kind === 0 && frame.subtype === 0) owner.syncStartCounts.push(owner.provider.unsyncedChanges);
          owner.frames.push({ direction: "out", lifetime: this.lifetime, kind: frame.kind, subtype: frame.subtype, payload: Buffer.from(frame.payload).toString("base64") });
          if (frame.kind === 0 && (frame.subtype === 1 || frame.subtype === 2)) {
            const reader = new DatabaseSync(journalPath, { readOnly: true });
            let journalBeforeSend: number;
            try { journalBeforeSend = Number(reader.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM updates").get()?.sequence); }
            finally { reader.close(); }
            owner.history.push({
              lifetime: this.lifetime, bytes: Buffer.from(frame.payload).toString("base64"), applied: null,
              ...(owner.expectations.shift() ?? { disposition: "accepted" }), journalBeforeSend, notice: null,
            });
          }
          owner.receipts.sent(this.lifetime, data);
          super.send(Uint8Array.from(data));
        }
      };
    }
    const ObservedSocket = observedSocket(this, journalPath);
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
      onStateless: ({ payload }) => {
        const notice: unknown = JSON.parse(payload);
        if (typeof notice !== "object" || notice === null || !("rejected" in notice)) return;
        const sent = this.history.find(item => item.lifetime === this.lifetime && item.applied === null);
        assert.ok(sent, "Refusal notice must match a transmitted message");
        sent.notice = String(notice.rejected);
      },
    });
    this.provider.attach();
  }

  expectNextMessage(expectation: HarnessMessageExpectation): void {
    this.expectations.push(expectation);
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
  for (const sent of history) {
    if (sent.notice !== null) {
      assert.equal(sent.disposition, "refused", "Server refusal notice disagrees with harness-declared acceptance");
      assert.equal(sent.notice, "invalid-or-oversized", "Refusal notice disagrees with the declared input refusal");
    }
    if (sent.disposition === "refused") {
      if (sent.reason === "oversized") assert.ok(Buffer.from(sent.bytes, "base64").length > sent.maximumBytes, "Harness-declared oversize must exceed the configured limit");
      else assert.throws(() => Y.decodeUpdate(Buffer.from(sent.bytes, "base64")), "Harness-declared undecodable input must fail independent decode");
    }
    if (!sent.applied) continue;
    const available = sent.disposition === "refused" ? rows.filter(row => row.sequence <= sent.journalBeforeSend) : rows;
    if (sent.disposition === "accepted") {
      assert.ok(available.some(row => row.payload === sent.bytes), "Acknowledged update missing exact bytes from recovered journal");
    }
    assertCoverage([sent.bytes], available.map(row => row.payload), "Acknowledged update lacks insertion or deletion coverage in its declared journal baseline");
  }
  for (const promise of promises) {
    for (const payload of promise.acknowledged) assert.ok(history.some(sent => sent.applied && sent.bytes === payload), "Saved promise requires an observed acknowledgement");
    assertCoverage(promise.local, promise.acknowledged, "Saved promise does not cover a local edit");
  }
}

function assertCoverage(required: readonly string[], available: readonly string[], message: string): void {
  function decode(payloads: readonly string[]): { insertions: Map<number, [number, number][]>; deletions: Map<number, [number, number][]> } {
    const insertions = new Map<number, [number, number][]>();
    const deletions = new Map<number, [number, number][]>();
    function add(target: Map<number, [number, number][]>, client: number, start: number, length: number): void {
      const intervals = target.get(client) ?? [];
      intervals.push([start, start + length]);
      target.set(client, intervals);
    }
    for (const payload of payloads) {
      const update = Y.decodeUpdate(Buffer.from(payload, "base64"));
      for (const struct of update.structs) {
        if (!(struct instanceof Y.Skip)) add(insertions, struct.id.client, struct.id.clock, struct.length);
      }
      for (const [client, items] of update.ds.clients) for (const item of items) add(deletions, client, item.clock, item.len);
    }
    for (const target of [insertions, deletions]) for (const intervals of target.values()) intervals.sort((a, b) => a[0] - b[0]);
    return { insertions, deletions };
  }
  const expected = decode(required);
  const covered = decode(available);
  for (const kind of ["insertions", "deletions"] as const) {
    for (const [client, intervals] of expected[kind]) {
      for (const [start, end] of intervals) {
        let cursor = start;
        for (const [from, to] of covered[kind].get(client) ?? []) {
          if (from > cursor) break;
          cursor = Math.max(cursor, to);
          if (cursor >= end) break;
        }
        assert.ok(cursor >= end, `${message}: ${kind}, client ${client}, clocks ${start}..${end}`);
      }
    }
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
