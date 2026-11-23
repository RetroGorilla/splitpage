import { reportFailure, restrictLibraryLogs } from "../../../../collab-server/logging.ts";
import { startRelay } from "../../../../collab-server/relay.ts";

interface DecoderRefusalRule {
  readonly stage: "beforeHandleMessage" | "beforeSync";
  readonly invitationId: string;
  readonly syncType?: number;
  readonly skipEmptyPayload?: boolean;
  readonly detail: string;
}

let release: (() => void) | undefined;
let hold: Promise<void> | undefined;
let holdDocumentLoad = false;
let failNextLoad = false;
let releaseLoad: (() => void) | undefined;
let heldSyncType: number | undefined;
let heldTraffic: Promise<void> | undefined;
let releaseTraffic: (() => void) | undefined;
let decoderRefusal: DecoderRefusalRule | undefined;
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
  if (message === "fail-next-load") {
    failNextLoad = true;
    process.send?.("fail-load-armed");
  }
  if (typeof message === "object" && message !== null && "holdSyncType" in message && typeof message.holdSyncType === "number") {
    heldSyncType = message.holdSyncType;
    heldTraffic = new Promise<void>(resolve => { releaseTraffic = resolve; });
    process.send?.("traffic-armed");
  }
  if (typeof message === "object" && message !== null && "refuseDecode" in message) {
    const candidate = (message as { refuseDecode?: unknown }).refuseDecode;
    if (
      typeof candidate === "object" && candidate !== null &&
      "stage" in candidate && (candidate.stage === "beforeHandleMessage" || candidate.stage === "beforeSync") &&
      "invitationId" in candidate && typeof candidate.invitationId === "string" &&
      "detail" in candidate && typeof candidate.detail === "string"
    ) {
      const syncType = "syncType" in candidate && typeof candidate.syncType === "number" ? candidate.syncType : undefined;
      const skipEmptyPayload = "skipEmptyPayload" in candidate && candidate.skipEmptyPayload === true;
      decoderRefusal = {
        stage: candidate.stage,
        invitationId: candidate.invitationId,
        detail: candidate.detail,
        ...(syncType === undefined ? {} : { syncType }),
        ...(skipEmptyPayload ? { skipEmptyPayload: true } : {})
      };
      process.send?.("decoder-refusal-armed");
    }
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
    async beforeHandleMessage({ context }) {
      const invitationId = (context as { invitationId?: string } | undefined)?.invitationId;
      if (decoderRefusal?.stage !== "beforeHandleMessage" || invitationId !== decoderRefusal.invitationId) return;
      const rule = decoderRefusal;
      decoderRefusal = undefined;
      process.send?.("decoder-refused:beforeHandleMessage");
      throw new RangeError(`Unexpected end of array (${rule.detail})`);
    },
    async onLoadDocument({ document }) {
      if (failNextLoad) {
        failNextLoad = false;
        process.send?.("load-failed");
        throw new Error("injected load failure");
      }
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
    async onStoreDocument({ documentName }) {
      process.send?.("store-started");
      process.send?.(`store-started:${documentName}`);
      await hold;
    },
    async afterStoreDocument({ documentName }) {
      process.send?.("stored");
      process.send?.(`stored:${documentName}`);
    }
  }]);
  // why: push after startRelay so this test hook runs after relay.ts acquires its per-document write lock
  relay.hocuspocus.configuration.extensions.push({
    async beforeSync({ context, type, payload }) {
      const invitationId = (context as { invitationId?: string } | undefined)?.invitationId;
      if (decoderRefusal?.stage !== "beforeSync" || invitationId !== decoderRefusal.invitationId) return;
      if (decoderRefusal.syncType !== undefined && type !== decoderRefusal.syncType) return;
      if (decoderRefusal.skipEmptyPayload && payload.length === 2 && payload[0] === 0 && payload[1] === 0) return;
      const rule = decoderRefusal;
      decoderRefusal = undefined;
      process.send?.(`decoder-refused:beforeSync:${type}`);
      throw new RangeError(`Unexpected end of array (${rule.detail})`);
    }
  });
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
