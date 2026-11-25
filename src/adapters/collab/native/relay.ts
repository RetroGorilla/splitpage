import { MERGE_TOO_LARGE_MESSAGE, PERMANENT_COLLABORATION_REFUSALS } from "../../../application/collaboration/state.ts";
import { WebSocketStatus } from "@hocuspocus/provider";
import { nativeStoreOpener } from "./local-store.ts";
import { openNativeSession } from "./session.ts";
import type { NativeSessionChange, NativeSessionOptions } from "./session.ts";
import { StateFirstProvider } from "./state-first-provider.ts";
import { bindNativePresence } from "./presence.ts";
import type { PresencePeer, PresenceProfile } from "../../../application/collaboration/presence.ts";

type Session = ReturnType<typeof openNativeSession>;

export interface NativeRelayStatus {
  readonly connected: boolean;
  readonly firstSyncDone: boolean;
  readonly pendingChangeCount: number;
}

export type NativeRelayEvent =
  | { readonly kind: "status"; readonly status: NativeRelayStatus }
  | { readonly kind: "session-replaced"; readonly session: Session; readonly undoHistory: "fresh" }
  | { readonly kind: "session-reopen-failed"; readonly error: unknown }
  | { readonly kind: "authentication-failed"; readonly reason: string }
  | { readonly kind: "temporary-refusal"; readonly reason: string }
  | { readonly kind: "merge-too-large"; readonly message: string }
  | { readonly kind: "first-load-too-large"; readonly message: string }
  | { readonly kind: "synced" };

export interface NativeRelayOptions {
  readonly url: string;
  readonly name: string;
  readonly token: string;
  readonly sessionOptions: NativeSessionOptions;
  readonly onEvent: (event: NativeRelayEvent) => void;
  readonly reopen?: (failed: Session) => Promise<Session>;
  readonly now?: () => number;
  readonly onPresence?: (peers: readonly PresencePeer[]) => void;
}

const FIRST_LOAD_RESTARTS = 1;
const FIRST_LOAD_MARGIN_MS = 100;
const PERMANENT_REFUSALS = new Set<string>(PERMANENT_COLLABORATION_REFUSALS);
const TEMPORARY_REFUSALS = new Set([
  "too-many-connections",
  "rate-limited"
]);

export function openNativeRelay(session: Session, { url, name, token, sessionOptions, onEvent, reopen, onPresence, now = () => performance.now() }: NativeRelayOptions) {
  if (session.isClosingOrClosed()) throw new Error("Cannot open a relay for a closing or closed session.");
  const storeOpener = nativeStoreOpener(session);
  if (storeOpener && reopen !== storeOpener) throw new Error("A store-backed relay requires its store's reopen function.");
  const initialStatus: NativeRelayStatus = Object.freeze({ connected: false, firstSyncDone: false, pendingChangeCount: 0 });
  let current = session, status = initialStatus;
  let closing = false;
  let publicationStopped = false;
  const relayUrl = new URL(url);
  relayUrl.searchParams.set("wire", "1");
  relayUrl.searchParams.set("schema", "1");
  let stopSettled: (() => void) | undefined;
  let stopSession: (() => void) | undefined;
  let credentialGeneration = 0;
  let releaseGate: () => void = () => {};
  let presenceProfile: PresenceProfile | undefined;
  let sendPresence: ((profile: PresenceProfile) => void) | undefined;
  let provider = attach(current);

  function emit(event: NativeRelayEvent): void {
    // why: provider callbacks can run inside Yjs transactions
    const generation = credentialGeneration;
    queueMicrotask(() => {
      if (generation !== credentialGeneration) return;
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
    let downloadStarted: number | null = null;
    let reportedTemporaryClose = false;
    type PendingSend =
      | { readonly kind: "reconnect" }
      | { readonly kind: "noop" }
      | { readonly kind: "pending-update"; readonly beforeThrough: number }
      | { readonly kind: "update"; readonly through: number };
    const pendingSends: PendingSend[] = [];
    const journal = target.pendingEdits;
    let offlineThrough = journal?.hasPending() ? journal.through() : 0;
    let maxBlockedConfirmation = 0;
    releaseGate = () => {
      const gate = Math.max(offlineThrough, maxBlockedConfirmation);
      if (gate <= 0) return;
      offlineThrough = 0;
      maxBlockedConfirmation = 0;
      journal?.clearThrough(gate);
      if (journal?.hasPending() && pendingSends.some(item => item.kind === "update")) {
        journal.confirmationPoint();
      }
    };
    stopSettled?.();
    stopSettled = target.subscribeCommandSettled(() => {
      if (!journal || !pendingSends.length) return;
      for (let index = 0; index < pendingSends.length; index++) {
        const item = pendingSends[index];
        if (item?.kind !== "pending-update") continue;
        if (journal.through() > item.beforeThrough) {
          journal.confirmationPoint();
          pendingSends[index] = { kind: "update", through: journal.through() };
        } else {
          pendingSends[index] = { kind: "noop" };
        }
      }
    });
    stopSession?.();
    stopSession = target.subscribe(sessionChanged);
    // why: stock synced also fires on an upload acknowledgement before the download can have arrived
    const firstReply = () => updateStatus({ firstSyncDone: true });
    // why: the browser sees only complete frames, and the stock server sends this vector before its state reply
    const stateRequest = () => { downloadStarted = now(); };
    function stopPermanently(): void {
      publicationStopped = true;
      stopSettled?.();
      stopSettled = undefined;
      attached.configuration.websocketProvider.disconnect();
      attached.destroy();
      status = Object.freeze({ ...status, connected: false, firstSyncDone: false });
    }
    const confirmations = journal ? {
      onReset() {
        pendingSends.length = 0;
      },
      onSyncReplySent() {
        if (journal.hasPending()) offlineThrough = Math.max(offlineThrough, journal.through());
        pendingSends.push({ kind: "reconnect" });
      },
      onConnectedUpdateSent() {
        if (target.inCommand()) {
          pendingSends.push({ kind: "pending-update", beforeThrough: journal.through() });
        } else if (journal.hasPending()) {
          journal.confirmationPoint();
          pendingSends.push({ kind: "update", through: journal.through() });
        } else {
          pendingSends.push({ kind: "noop" });
        }
      },
      onSyncStatus(applied: boolean) {
        const entry = pendingSends.shift();
        if (!applied || !entry || entry.kind !== "update") return;
        if (offlineThrough > 0) {
          if (journal.hasPendingThrough(offlineThrough)) {
            maxBlockedConfirmation = Math.max(maxBlockedConfirmation, entry.through);
            return;
          }
          offlineThrough = 0;
          maxBlockedConfirmation = 0;
        }
        journal.clearThrough(entry.through);
        const nextUpdate = pendingSends.find(item => item.kind === "update");
        if (nextUpdate && journal.hasPending()) {
          journal.confirmationPoint();
        }
      },
      onSynced() {
        emit({ kind: "synced" });
      }
    } : undefined;
    const attached = new StateFirstProvider({
      url: relayUrl.href, name, token, document: target.ydoc,
      onOpen() {
        reportedTemporaryClose = false;
      },
      onStatus({ status: socketStatus }) {
        if (publicationStopped) return;
        const connected = socketStatus === WebSocketStatus.Connected;
        if (connected === status.connected) return;
        updateStatus(connected
          ? { connected, pendingChangeCount: Math.max(1, status.pendingChangeCount) }
          : { connected });
        if (!connected) {
          const started = downloadStarted;
          downloadStarted = null;
          const receiveTimeout = attached.configuration.websocketProvider.configuration.messageReconnectTimeout;
          const exhaustedWait = started !== null && !status.firstSyncDone && now() - started >= receiveTimeout - FIRST_LOAD_MARGIN_MS;
          if (exhaustedWait && ++restarts > FIRST_LOAD_RESTARTS) {
            close();
            emit({ kind: "first-load-too-large", message: "This script is too large to load over this connection." });
          }
        }
      },
      onAuthenticationFailed({ reason }) {
        if (publicationStopped) return;
        if (TEMPORARY_REFUSALS.has(reason)) {
          reportedTemporaryClose = true;
          updateStatus({ connected: false });
          attached.configuration.websocketProvider.webSocket?.close();
          emit({ kind: "temporary-refusal", reason });
          return;
        }
        emit({ kind: "authentication-failed", reason });
        if (PERMANENT_REFUSALS.has(reason)) stopPermanently();
      },
      onClose({ event }) {
        if (publicationStopped) return;
        if (PERMANENT_REFUSALS.has(event.reason)) {
          emit({ kind: "authentication-failed", reason: event.reason });
          stopPermanently();
          return;
        }
        if (TEMPORARY_REFUSALS.has(event.reason) && !reportedTemporaryClose) {
          reportedTemporaryClose = true;
          updateStatus({ connected: false });
          attached.configuration.websocketProvider.webSocket?.close();
          emit({ kind: "temporary-refusal", reason: event.reason });
        }
      },
      onStateless({ payload }) {
        if (payload !== "merge-too-large" || publicationStopped) return;
        emit({
          kind: "merge-too-large",
          message: MERGE_TOO_LARGE_MESSAGE
        });
        stopPermanently();
      },
      onUnsyncedChanges({ number }) {
        if (publicationStopped) return;
        updateStatus({ pendingChangeCount: number });
      }
    }, firstReply, stateRequest, target.checkPeerDelivery, confirmations);
    if (onPresence) {
      const send = bindNativePresence(attached, onPresence);
      sendPresence = send;
      if (presenceProfile) send(presenceProfile);
      attached.on("destroy", () => {
        if (sendPresence === send) sendPresence = undefined;
      });
    }
    return attached;
  }

  function sessionChanged(change: NativeSessionChange): void {
    if (change.kind !== "closed") return;
    stopSettled?.();
    stopSettled = undefined;
    if (!publicationStopped) provider.destroy();
    if (closing || change.reason === "requested") {
      if (publicationStopped) status = Object.freeze({ ...status, connected: false });
      else updateStatus({ connected: false });
      return;
    }
    if (reopen) {
      if (publicationStopped) status = Object.freeze({ ...status, connected: false });
      else updateStatus({ connected: false });
      void reopenStored(current, reopen);
    } else {
      const savedJournal = current.pendingEdits?.data();
      replace(openNativeSession(
        { kind: "state", state: change.state },
        savedJournal ? { ...sessionOptions, noticeJournal: savedJournal } : sessionOptions
      ));
    }
  }

  async function reopenStored(failed: Session, open: NonNullable<NativeRelayOptions["reopen"]>): Promise<void> {
    let replacement: Session | undefined;
    try {
      replacement = await open(failed);
      replace(replacement);
    }
    catch (error) {
      replacement?.close();
      emit({ kind: "session-reopen-failed", error });
    }
  }

  function replace(session: Session): void {
    if (closing) { session.close(); return; }
    current = session;
    updateStatus(initialStatus);
    if (!publicationStopped) provider = attach(current);
    else stopSession = current.subscribe(sessionChanged);
    emit({ kind: "session-replaced", session: current, undoHistory: "fresh" });
  }

  function reconnectWithToken(next: string): void {
    if (closing || current.isClosingOrClosed()) throw new Error("The shared session is closing.");
    if (!publicationStopped) provider.destroy();
    credentialGeneration++;
    token = next;
    publicationStopped = false;
    updateStatus(initialStatus);
    provider = attach(current);
  }

  function close(): void {
    closing = true;
    current.close();
  }

  function publishPresence(profile: PresenceProfile): void {
    presenceProfile = profile;
    sendPresence?.(profile);
  }

  return Object.freeze({ session: () => current, status: () => status, releaseOfflineGate: () => releaseGate(), reconnectWithToken, publishPresence, close });
}
