import { WebSocketStatus } from "@hocuspocus/provider";
import { openNativeSession } from "./session.ts";
import type { NativeSessionChange, NativeSessionOptions } from "./session.ts";
import { StateFirstProvider } from "./state-first-provider.ts";

type Session = ReturnType<typeof openNativeSession>;

export interface NativeRelayStatus {
  readonly connected: boolean;
  readonly firstSyncDone: boolean;
  readonly pendingChangeCount: number;
}

export type NativeRelayEvent =
  | { readonly kind: "status"; readonly status: NativeRelayStatus }
  | { readonly kind: "session-replaced"; readonly session: Session; readonly undoHistory: "fresh" }
  | { readonly kind: "authentication-failed"; readonly reason: string }
  | { readonly kind: "first-load-too-large"; readonly message: string };

export interface NativeRelayOptions {
  readonly url: string;
  readonly name: string;
  readonly token: string;
  readonly sessionOptions: NativeSessionOptions;
  readonly onEvent: (event: NativeRelayEvent) => void;
}

const FIRST_LOAD_RESTARTS = 1;

export function openNativeRelay(session: Session, { url, name, token, sessionOptions, onEvent }: NativeRelayOptions) {
  if (session.isClosingOrClosed()) throw new Error("Cannot open a relay for a closing or closed session.");
  const initialStatus: NativeRelayStatus = Object.freeze({ connected: false, firstSyncDone: false, pendingChangeCount: 0 });
  let current = session, status = initialStatus;
  let closing = false;
  let provider = attach(current);

  function emit(event: NativeRelayEvent): void {
    // why: provider callbacks can run inside Yjs transactions
    queueMicrotask(() => {
      try { onEvent(event); } catch {
        // why: a caller's notification failure must not interrupt the relay lifecycle
      }
    });
  }

  function updateStatus(change: Partial<NativeRelayStatus>): void {
    status = Object.freeze({ ...status, ...change });
    emit({ kind: "status", status });
  }

  function attach(target: Session): StateFirstProvider {
    let restarts = 0;
    let downloadStarted = false;
    target.subscribe(sessionChanged);
    // why: stock synced also fires on an upload acknowledgement before the download can have arrived
    const firstReply = () => {
      target.checkPeerDelivery();
      updateStatus({ firstSyncDone: true });
    };
    // why: the browser sees only complete frames, and the stock server sends this vector before its state reply
    const stateRequest = () => { downloadStarted = true; };
    return new StateFirstProvider({
      url, name, token, document: target.ydoc,
      onStatus({ status: socketStatus }) {
        const connected = socketStatus === WebSocketStatus.Connected;
        if (connected === status.connected) return;
        updateStatus({ connected });
        if (!connected) {
          const interruptedLoad = downloadStarted && !status.firstSyncDone;
          downloadStarted = false;
          if (interruptedLoad && ++restarts > FIRST_LOAD_RESTARTS) {
            close();
            emit({ kind: "first-load-too-large", message: "This script is too large to load over this connection." });
          }
        }
      },
      onAuthenticationFailed({ reason }) {
        emit({ kind: "authentication-failed", reason });
      },
      onUnsyncedChanges({ number }) {
        updateStatus({ pendingChangeCount: number });
      }
    }, firstReply, stateRequest);
  }

  function sessionChanged(change: NativeSessionChange): void {
    if (change.kind !== "closed") return;
    provider.destroy();
    if (closing || change.reason === "requested") {
      updateStatus({ connected: false });
      return;
    }
    current = openNativeSession({ kind: "state", state: change.state }, sessionOptions);
    updateStatus(initialStatus);
    provider = attach(current);
    emit({ kind: "session-replaced", session: current, undoHistory: "fresh" });
  }

  function close(): void {
    closing = true;
    current.close();
  }

  return Object.freeze({ session: () => current, status: () => status, close });
}
