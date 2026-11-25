import { Doc, encodeStateAsUpdate } from "yjs";
import { StateFirstProvider } from "./state-first-provider.ts";

export class InvitationSnapshotError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super("Could not load the shared script from the relay.");
    this.reason = reason;
  }
}

export async function readInvitationSnapshot(url: string, script: string, token: string, signal?: AbortSignal,
  waitMs = 30_000): Promise<Uint8Array> {
  const relay = new URL(url);
  relay.searchParams.set("wire", "1");
  relay.searchParams.set("schema", "1");

  async function attempt(): Promise<Uint8Array | "stalled" | "dropped"> {
    signal?.throwIfAborted();
    const document = new Doc();
    let authenticated = false;
    let provider: StateFirstProvider | undefined;
    let abort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const synced = await new Promise<"loaded" | "stalled" | "dropped">((resolve, reject) => {
        abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => resolve(authenticated ? "stalled" : "dropped"), waitMs);
        provider = new StateFirstProvider({
          url: relay.href, name: script, token, document, awareness: null,
          onAuthenticated() { authenticated = true; },
          onAuthenticationFailed({ reason }) { reject(new InvitationSnapshotError(reason)); },
          onClose({ event }) {
            if (event.reason === "access-removed") reject(new InvitationSnapshotError(event.reason));
            else resolve("dropped");
          }
        }, () => resolve("loaded"), () => {}, () => true);
      });
      signal?.throwIfAborted();
      return synced === "loaded" ? encodeStateAsUpdate(document) : synced;
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      try { provider?.destroy(); }
      finally { document.destroy(); }
    }
  }

  const first = await attempt();
  if (first instanceof Uint8Array) return first;
  const second = await attempt();
  if (second instanceof Uint8Array) return second;
  throw new InvitationSnapshotError(second === "stalled" ? "script-too-large-for-connection" : "relay-unreachable");
}
