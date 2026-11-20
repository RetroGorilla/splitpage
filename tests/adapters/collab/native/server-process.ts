import { reportFailure, restrictLibraryLogs } from "../../../../collab-server/logging.ts";
import { startRelay } from "../../../../collab-server/relay.ts";

let release: (() => void) | undefined;
let hold: Promise<void> | undefined;
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
});

restrictLibraryLogs();
try {
  const relay = await startRelay(process.env, "127.0.0.1", [{
    priority: 101,
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
