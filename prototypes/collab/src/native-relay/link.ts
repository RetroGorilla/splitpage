import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export const loopback = "127.0.0.1";

type Direction = "upload" | "download";

export async function openLink(port: number, mbps = Infinity) {
  let target = port;
  let connections = 0;
  const bytes = { upload: 0, download: 0 };
  const paced = { upload: 0, download: 0 };
  const holds = new Map<Direction, Promise<void>>();
  const pairs = new Set<() => void>();
  const pumps = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const bytesPerMs = mbps * 125;
  const chunkSize = Math.max(1, Math.floor(bytesPerMs * 20));

  const pump = async (from: Socket, to: Socket, direction: Direction, signal: AbortSignal) => {
    let next = performance.now();
    for await (const buffer of from as AsyncIterable<Buffer>) {
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        const piece = buffer.subarray(offset, offset + chunkSize);
        if (Number.isFinite(bytesPerMs)) {
          paced[direction] += piece.length;
          next = Math.max(next, performance.now() - 10) + piece.length / bytesPerMs;
          await delay(Math.max(0, next - performance.now()), undefined, { signal });
        }
        const held = holds.get(direction);
        if (held) await held;
        if (signal.aborted) return;
        bytes[direction] += piece.length;
        if (!to.write(piece)) await once(to, "drain", { signal });
      }
    }
  };

  const listener = createServer(client => {
    connections++;
    const server = createConnection({ host: loopback, port: target });
    const abort = new AbortController();
    const cut = () => {
      abort.abort();
      client.destroy();
      server.destroy();
      pairs.delete(cut);
    };
    pairs.add(cut);
    for (const socket of [client, server]) {
      socket.setNoDelay(true);
      socket.on("error", () => cut());
      socket.once("close", cut);
    }
    const run = Promise.all([
      pump(client, server, "upload", abort.signal),
      pump(server, client, "download", abort.signal)
    ].map(async task => {
      try {
        await task;
      } catch (error) {
        if (!abort.signal.aborted) errors.push(error);
      } finally {
        cut();
      }
    })).then(() => { pumps.delete(run); });
    pumps.add(run);
  });
  listener.listen(0, loopback);
  await once(listener, "listening");
  const address = listener.address() as AddressInfo;
  const releases = new Set<() => void>();

  return {
    url: `ws://${loopback}:${address.port}`,
    bytes, paced,
    get connections() { return connections; },
    retarget(port: number) { target = port; },
    hold(direction: Direction) {
      if (holds.has(direction)) throw new Error(`Already holding ${direction}`);
      let resume = () => {};
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const release = () => {
        holds.delete(direction);
        releases.delete(release);
        resume();
      };
      holds.set(direction, gate);
      releases.add(release);
      return release;
    },
    cut() { for (const cut of pairs) cut(); },
    async close() {
      const closed = once(listener, "close");
      listener.close();
      for (const cut of pairs) cut();
      for (const release of releases) release();
      await closed;
      await Promise.all(pumps);
      if (errors.length) throw new AggregateError(errors, "Pass-through failed");
    }
  };
}
