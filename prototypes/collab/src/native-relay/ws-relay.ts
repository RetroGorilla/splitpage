import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Hocuspocus } from "@hocuspocus/server";
import type { ServerConfiguration } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import { loopback } from "./link.ts";

export async function openWsRelay(settings: Partial<ServerConfiguration> = {}) {
  const hocuspocus = new Hocuspocus(settings);
  const server = new WebSocketServer({ host: loopback, port: 0 });
  server.on("connection", (socket, request) => {
    const connection = hocuspocus.handleConnection(socket, new Request(`http://${loopback}:${address.port}${request.url ?? "/"}`, {
      headers: new Headers(Array.from({ length: request.rawHeaders.length / 2 }, (_, index): [string, string] =>
        [request.rawHeaders[index * 2] ?? "", request.rawHeaders[index * 2 + 1] ?? ""]))
    }));
    socket.on("message", data => connection.handleMessage(Array.isArray(data) ? Buffer.concat(data) :
      data instanceof ArrayBuffer ? new Uint8Array(data) : data));
    socket.on("close", (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
    socket.on("pong", () => connection.touch());
    socket.on("error", () => socket.terminate());
  });
  await once(server, "listening", { signal: AbortSignal.timeout(4_000) });
  const address = server.address() as AddressInfo;
  return {
    address, webSocketURL: `ws://${loopback}:${address.port}`,
    async destroy() {
      const closed = once(server, "close", { signal: AbortSignal.timeout(4_000) });
      server.close();
      for (const socket of server.clients) socket.terminate();
      await closed;
      hocuspocus.flushPendingStores();
      const deadline = AbortSignal.timeout(4_000);
      while (hocuspocus.getDocumentsCount() > 0) {
        deadline.throwIfAborted();
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
      await hocuspocus.hooks("onDestroy", { instance: hocuspocus });
    }
  };
}
