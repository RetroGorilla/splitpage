import { reportFailure, restrictLibraryLogs } from "../../../../collab-server/logging.ts";
import { startRelay } from "../../../../collab-server/relay.ts";

let release: (() => void) | undefined;
let hold: Promise<void> | undefined;
let holdDocumentLoad = false;
let releaseLoad: (() => void) | undefined;
process.on("message", message => {
  if (message === "hold") {
    hold = new Promise<void>(resolve => { release = resolve; });
    process.send?.("armed");
  }
  if (message === "release") {
    release?.();
    hold = undefined;
  }
  if (message === "stop") process.emit("SIGTERM");
  if (message === "hold-load") {
    holdDocumentLoad = true;
    process.send?.("load-armed");
  }
});

restrictLibraryLogs();
try {
  const relay = await startRelay(process.env, "127.0.0.1", [{
    priority: 101,
    async onAuthenticate() {
      if (releaseLoad) setImmediate(releaseLoad);
    },
    async onLoadDocument({ document }) {
      if (!holdDocumentLoad) return;
      holdDocumentLoad = false;
      document.getMap("fixture").set("data", new Uint8Array(15_000_000));
      await new Promise<void>(resolve => {
        releaseLoad = resolve;
        process.send?.("loading");
      });
      releaseLoad = undefined;
    },
    async onStoreDocument() {
      process.send?.("store-started");
      await hold;
    },
    async afterStoreDocument() {
      process.send?.("stored");
    }
  }]);
  process.on("SIGTERM", () => process.send?.("stopping"));
  process.send?.(relay.address.port);
} catch (error) {
  reportFailure(error, "Relay startup failed.");
  process.disconnect();
}
