import { reportFailure, restrictLibraryLogs } from "../../../../collab-server/logging.ts";
import { startRelay } from "../../../../collab-server/relay.ts";

let release: (() => void) | undefined;
let hold: Promise<void> | undefined;
let holdDocumentLoad = false;
let releaseLoad: (() => void) | undefined;
let heldSyncType: number | undefined;
let heldTraffic: Promise<void> | undefined;
let releaseTraffic: (() => void) | undefined;
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
  if (typeof message === "object" && message !== null && "holdSyncType" in message && typeof message.holdSyncType === "number") {
    heldSyncType = message.holdSyncType;
    heldTraffic = new Promise<void>(resolve => { releaseTraffic = resolve; });
    process.send?.("traffic-armed");
  }
  if (message === "release-traffic") {
    releaseTraffic?.();
    heldTraffic = undefined;
    setImmediate(() => process.send?.("traffic-released"));
  }
});

restrictLibraryLogs();
try {
  const relay = await startRelay(process.env, "127.0.0.1", [{
    priority: 101,
    async onAuthenticate() {
      if (process.env.SPLITPAGE_TEST_REPORT_AUTH) process.send?.("authentication-attempted");
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
    async beforeSync({ type }) {
      if (type !== heldSyncType || !heldTraffic) return;
      process.send?.("edit-queued");
      await heldTraffic;
    },
    async beforeHandleAwareness({ states }) {
      if (!heldTraffic || !Array.from(states.values()).some((state: Record<string, unknown>) => state.reviewPresence === "queued")) return;
      process.send?.("presence-queued");
      await heldTraffic;
    },
    async onStoreDocument() {
      process.send?.("store-started");
      await hold;
    },
    async afterStoreDocument() {
      process.send?.("stored");
    }
  }]);
  process.on("message", message => {
    if (typeof message === "string" && message.startsWith("revoke:")) {
      relay.revokeInvitation(message.slice("revoke:".length));
      process.send?.("revoked");
    }
    if (typeof message === "string" && message.startsWith("provision:")) {
      const name = message.slice("provision:".length);
      relay.registerScript(name, "active");
      process.send?.({ name, ...relay.issueInvitation(name, "test invitation") });
    }
    if (typeof message === "string" && message.startsWith("delete:")) {
      relay.deleteScript(message.slice("delete:".length));
      process.send?.("deleted");
    }
  });
  process.on("SIGTERM", () => process.send?.("stopping"));
  process.send?.(relay.address.port);
} catch (error) {
  reportFailure(error, "Relay startup failed.");
  process.disconnect();
}
