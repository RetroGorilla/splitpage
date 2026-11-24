import { createBrowserNativeLocalStore } from "../../adapters/collab/native/browser-local-store.ts";
import { createDesktopNativeLocalStore } from "../../adapters/collab/native/desktop-local-store.ts";
import type { NativeInvitationStage, NativeLocalStoreOpen, NativeLocalStoreReceipt } from "../../adapters/collab/native/local-store.ts";
import { applyNativePeerUpdate } from "../../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../../adapters/collab/native/session.ts";
import { openNativeRelay } from "../../adapters/collab/native/relay.ts";
import type { NativeRelayEvent } from "../../adapters/collab/native/relay.ts";
import { readInvitationSnapshot } from "../../adapters/collab/native/invitation-snapshot.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { isPermanentCollaborationRefusal, localWriteErrorMessage } from "../../application/collaboration/state.ts";
import type { CollaborationLocalWriteError } from "../../application/collaboration/state.ts";
import { sanitizeHtml } from "../richtext.ts";
import { guardUnload, waitDuringLifetime } from "../startup/page-lifetime.ts";
import { collaborationState, setSharedRetryLocalWrite } from "./collaboration-owner.ts";
import { notifyDesktopDocumentState, trackSharedDesktopUnsaved } from "./desktop-owners.ts";
import { notices } from "./ports/effects.ts";
import { bindNativeEditor } from "./native-shared-session.ts";
import { bindSharedPictures } from "./shared-picture-session.ts";
import { sharedSession } from "./session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, SHARED_ALREADY, SHARED_ENTER_FAILED, SHARED_NOT_RUNNING } from "./shared-session.ts";
import type { SharedEditorBackend, SharedSwitchOutcome, SharedSwitchPorts } from "./shared-session.ts";

type RetainedReplica = Extract<NativeLocalStoreOpen, { kind: "opened" }>;
const JOIN_TIMEOUT_MS = 15_000;
let localCopy: RetainedReplica | null = null;
const closingCopies = new Map<string, RetainedReplica["closed"]>();
let activeSessionToken = 0;

function trackClosing(name: string, replica: RetainedReplica): void {
  closingCopies.set(name, replica.closed);
  void replica.closed.then(() => {
    if (closingCopies.get(name) === replica.closed) closingCopies.delete(name);
  });
}

export interface RetainedSharedScript {
  readonly deployment: string;
  readonly script: string;
  readonly invitation?: { readonly token: string; readonly state?: Uint8Array };
  readonly relayUrl?: string;
  readonly pictureOrigin?: string;
  readonly signal?: AbortSignal;
  readonly onRelayConnected?: (connected: boolean) => void;
  readonly onOfflineNotice?: (clashes: ReturnType<ReturnType<typeof openNativeSession>["offlineNotice"]>) => void;
  readonly connect?: (replica: RetainedReplica, token: string) => () => void;
}

export function createRetainedPictureBinding(options: {
  readonly pictureOrigin: string;
  readonly script: string;
  readonly token: string;
  readonly sessionCurrent: () => boolean;
  readonly onLocalError: (error: CollaborationLocalWriteError | null) => void;
  readonly onRelayConnected?: ((connected: boolean) => void) | undefined;
}) {
  let pictures: ReturnType<typeof bindSharedPictures> | undefined;
  let stopCounts: (() => void) | undefined;
  let stopStorage: (() => void) | undefined;
  let started = false;
  let connected = false;
  let permanentlyStopped = false;

  function detach(): void {
    pictures?.stop();
    pictures = undefined;
    stopCounts?.();
    stopStorage?.();
    stopCounts = undefined;
    stopStorage = undefined;
    if (options.sessionCurrent()) options.onLocalError(null);
  }

  function attach(next: ReturnType<typeof bindSharedPictures>): void {
    if (!options.sessionCurrent() || permanentlyStopped) {
      next.stop();
      return;
    }
    pictures = next;
    stopCounts = next.subscribeCounts(counts => {
      if (options.sessionCurrent()) collaborationState().setPictures(counts);
    });
    stopStorage = next.subscribeStorageError(failed => {
      if (!options.sessionCurrent()) return;
      options.onLocalError(failed ? { reason: "io", message: localWriteErrorMessage("io"), code: "io" } : null);
    });
    collaborationState().setPictures(next.counts());
    options.onLocalError(next.storageError() ? { reason: "io", message: localWriteErrorMessage("io"), code: "io" } : null);
    if (started) next.activate();
  }

  return {
    attach,
    detach,
    bindCopy(copy: Parameters<typeof bindSharedPictures>[0], signal?: AbortSignal) {
      const bound = bindSharedPictures(copy, options.pictureOrigin, options.script, options.token, signal);
      attach(bound);
      return bound;
    },
    activate() {
      started = true;
      pictures?.activate();
      if (pictures && options.sessionCurrent()) collaborationState().setPictures(pictures.counts());
    },
    reconnect() { pictures?.reconnect(); },
    retryStorage() { pictures?.retryStorage(); },
    finishPreparation() { pictures?.finishPreparation(); },
    onRelayEvent(event: NativeRelayEvent) {
      if (!options.sessionCurrent()) return;
      if (event.kind === "status") {
        if (permanentlyStopped) return;
        if (event.status.connected && !connected) pictures?.reconnect();
        connected = event.status.connected;
        collaborationState().setRelay(event.status);
        options.onRelayConnected?.(event.status.connected && event.status.firstSyncDone);
      } else if (event.kind === "temporary-refusal") {
        options.onRelayConnected?.(false);
      } else if (event.kind === "merge-too-large") {
        permanentlyStopped = true;
        collaborationState().setMergeTooLarge(event.message);
        detach();
        options.onRelayConnected?.(false);
      } else if (event.kind === "authentication-failed") {
        const permanent = isPermanentCollaborationRefusal(event.reason);
        if (permanent) {
          permanentlyStopped = true;
          collaborationState().setRefusal(event.reason);
        }
        detach();
        options.onRelayConnected?.(false);
      } else if (event.kind === "session-replaced") {
        detach();
        options.onRelayConnected?.(false);
        if (!permanentlyStopped) {
          attach(bindSharedPictures({ session: event.session }, options.pictureOrigin, options.script, options.token));
        }
      } else if (event.kind === "synced") {
        return;
      } else {
        permanentlyStopped = true;
        detach();
        options.onRelayConnected?.(false);
      }
    }
  };
}

export async function enterRetainedSharedScript(ports: SharedSwitchPorts, entry: RetainedSharedScript, cancellation?: AbortSignal): Promise<SharedSwitchOutcome> {
  if (sharedSession()) return { ok: false, reason: SHARED_ALREADY };
  const identity = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
  if (!identity.test(entry.deployment) || !identity.test(entry.script)) return { ok: false, reason: SHARED_ENTER_FAILED };
  const name = entry.deployment + "/" + entry.script;
  const desktop = desktopPort();
  const store = desktop ? createDesktopNativeLocalStore(desktop.nativeReplica) : createBrowserNativeLocalStore();
  const prepared: { replica?: RetainedReplica; token?: string } = {};
  let staged: NativeInvitationStage | undefined;
  let preparation: Promise<string | null> | undefined;
  let active = false;
  const sessionToken = ++activeSessionToken;
  let sessionDisposed = false;
  const sessionCurrent = () => !sessionDisposed && sessionToken === activeSessionToken;
  let stopConnection: (() => void) | undefined;
  let pictures: ReturnType<typeof bindSharedPictures> | undefined;
  let state = entry.invitation?.state;
  const preparePicturesOnCopy = !!entry.pictureOrigin && !entry.relayUrl;
  let pictureOrigin = entry.pictureOrigin;
  if (entry.relayUrl) {
    try {
      const endpoint = new URL(entry.relayUrl);
      if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") return { ok: false, reason: SHARED_ENTER_FAILED };
      endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
      pictureOrigin = endpoint.origin;
    } catch { return { ok: false, reason: SHARED_ENTER_FAILED }; }
  }
  const deadline = new AbortController();
  const timed = !!(entry.relayUrl || entry.pictureOrigin);
  const timer = timed ? ports.timers.start(() => deadline.abort(), JOIN_TIMEOUT_MS) : undefined;
  const signals = [cancellation, entry.signal, timed ? deadline.signal : undefined].filter(s => s !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  function stop() {
    try { stopConnection?.(); }
    catch { throw new Error("The retained connection could not close."); }
    stopConnection = undefined;
    pictures?.stop();
  }
  async function hydrate(copy: Parameters<typeof bindSharedPictures>[0], token: string) {
    if (!pictureOrigin || !signal) return true;
    pictures = bindSharedPictures(copy, pictureOrigin, entry.script, token, signal);
    return waitDuringLifetime(pictures.hydrate(), signal);
  }
  async function prepare(): Promise<string | null> {
    const refusal = await ports.prepare?.();
    if (refusal) return refusal;
    signal?.throwIfAborted();
    await closingCopies.get(name);
    signal?.throwIfAborted();
    const replica = await store.open(name, { actor: ports.editor(), sanitize: sanitizeHtml, noticeJournal: true });
    if (replica.kind === "opened") prepared.replica = replica;
    signal?.throwIfAborted();
    if (replica.kind === "failed") {
      if (replica.reason === "locked") notices.show("This shared script is already open in another tab.", "warn");
      return replica.reason;
    }
    let token: string | null;
    try {
      const membership = replica.membership;
      if (!membership) return SHARED_ENTER_FAILED;
      const saved = membership.token();
      token = await (signal ? waitDuringLifetime(saved, signal) : saved);
      signal?.throwIfAborted();
      if (entry.invitation) {
        if (entry.relayUrl) {
          state ??= await readInvitationSnapshot(entry.relayUrl, entry.script, entry.invitation.token, signal);
          const preview = openNativeSession({ kind: "stored-script", state }, { actor: ports.editor(), sanitize: sanitizeHtml });
          try {
            if (replica.restored && !applyNativePeerUpdate(preview, replica.session.encodeState())) return SHARED_ENTER_FAILED;
            if (!preview.isStoredScript() || !await hydrate({ session: preview }, entry.invitation.token)) return SHARED_ENTER_FAILED;
          } finally { pictures?.stop(); pictures = undefined; preview.close(); }
          signal?.throwIfAborted();
          if (!replica.restored && !applyNativePeerUpdate(replica.session, state)) return SHARED_ENTER_FAILED;
          if (!replica.session.isStoredScript() || (await replica.flush()).kind !== "stored" || replica.hasUnstoredChanges()) {
            return SHARED_ENTER_FAILED;
          }
          signal?.throwIfAborted();
        }
        if (preparePicturesOnCopy) {
          if (!replica.restored && (!state || !applyNativePeerUpdate(replica.session, state))) return SHARED_ENTER_FAILED;
          if (!replica.session.isStoredScript()) return SHARED_ENTER_FAILED;
          stopConnection = entry.connect?.(replica, entry.invitation.token);
          if (!await hydrate(replica, entry.invitation.token)) return SHARED_ENTER_FAILED;
        }
        if (signal && membership.stageInvitation) {
          if (replica.restored && !replica.session.isStoredScript()) return SHARED_ENTER_FAILED;
          staged = await membership.stageInvitation(entry.invitation.token, token, signal);
        } else if (cancellation) {
          return SHARED_ENTER_FAILED;
        } else {
          if (!replica.restored && (!state || !applyNativePeerUpdate(replica.session, state))) return SHARED_ENTER_FAILED;
          if (!replica.session.isStoredScript()) return SHARED_ENTER_FAILED;
          await membership.join(entry.invitation.token);
        }
        token = entry.invitation.token;
      }
      if (!token || ((!signal || !entry.invitation) && !replica.session.isStoredScript())) return SHARED_ENTER_FAILED;
    } catch { return SHARED_ENTER_FAILED; }
    prepared.token = token;
    return null;
  }
  async function closePrepared() {
    const replica = prepared.replica;
    if (!replica) return;
    trackClosing(name, replica);
    try { await staged?.rollback(); }
    finally {
      try { stop(); } finally { replica.session.close(); await replica.closed; }
    }
  }
  try {
    const outcome = await enterSharedSession({ ...ports, prepare: () => (preparation = prepare()) }, (_, failedClose) => {
      const { replica, token } = prepared;
      if (!replica || !token) throw new Error("The retained copy was not prepared.");
      if (staged && entry.invitation && !replica.restored && !pictureOrigin &&
          (!state || !applyNativePeerUpdate(replica.session, state) || !replica.session.isStoredScript())) {
        throw new Error("The invitation did not contain a shared script.");
      }
      let docWriteError: CollaborationLocalWriteError | null = null;
      let pictureWriteError: CollaborationLocalWriteError | null = null;
      const syncLocalError = () => {
        if (!sessionCurrent()) return;
        collaborationState().setLocalWriteError(docWriteError ?? pictureWriteError);
      };
      const pictureBinding = pictureOrigin
        ? createRetainedPictureBinding({
          pictureOrigin,
          script: entry.script,
          token,
          sessionCurrent,
          onLocalError: error => { pictureWriteError = error; syncLocalError(); },
          onRelayConnected: entry.onRelayConnected
        })
        : null;
      try {
        if (entry.relayUrl && pictureBinding) {
          pictureBinding.bindCopy(replica);
          const relay = openNativeRelay(replica.session, {
            url: entry.relayUrl, name: entry.script, token, reopen: replica.reopen,
            sessionOptions: { actor: ports.editor(), sanitize: sanitizeHtml, noticeJournal: true },
            onEvent(event) {
              if (event.kind === "synced") {
                if (sessionCurrent()) {
                  try {
                    const clashes = relay.session().offlineNotice("returning");
                    entry.onOfflineNotice?.(clashes);
                  } finally {
                    relay.releaseOfflineGate();
                  }
                }
                return;
              }
              pictureBinding.onRelayEvent(event);
            }
          });
          stopConnection = () => { relay.close(); entry.onRelayConnected?.(false); };
        } else {
          if (pictures && pictureBinding) {
            pictureBinding.attach(pictures);
            pictures = undefined;
          } else if (pictureBinding) {
            pictureBinding.bindCopy(replica);
          }
          stopConnection ??= entry.connect?.(replica, token);
        }
      }
      catch { throw new Error("The retained connection could not start."); }
      pictureBinding?.finishPreparation();
      const { backend } = bindNativeEditor(ports, replica.session, failedClose);
      const pending = () => {
        if (!replica.hasUnstoredChanges()) return false;
        void replica.flush();
        return true;
      };
      let stopUnload: (() => void) | undefined;
      let stopDesktop: (() => void) | undefined;
      let stopChanges: (() => void) | undefined;
      let stopReceipts: (() => void) | undefined;
      let wasDirty = false;
      let pendingSyncQueued = false;
      const notifyDesktop = () => {
        if (!stopDesktop || wasDirty === replica.hasUnstoredChanges()) return;
        wasDirty = replica.hasUnstoredChanges();
        notifyDesktopDocumentState();
      };
      const syncLocalPending = () => {
        pendingSyncQueued = false;
        if (!sessionCurrent()) return;
        collaborationState().setLocalPending(replica.hasUnstoredChanges());
        notifyDesktop();
      };
      const handleReceipt = (receipt: NativeLocalStoreReceipt) => {
        if (!sessionCurrent()) return;
        if (receipt.kind === "stored") {
          docWriteError = null;
          collaborationState().setLocalPending(replica.hasUnstoredChanges());
          syncLocalError();
        } else if (receipt.operation !== "compact" || replica.hasUnstoredChanges()) {
          collaborationState().setLocalPending(replica.hasUnstoredChanges());
          docWriteError = {
            reason: receipt.reason,
            message: localWriteErrorMessage(receipt.reason),
            code: receipt.reason
          };
          syncLocalError();
        }
        notifyDesktop();
      };
      const stopActive = () => {
        stop();
        pictureBinding?.detach();
      };
      const retained: SharedEditorBackend = { ...backend,
        beforeDocumentSwitch: () => pending() ? "shared-copy-unsaved" : null,
        beforeExplicitLeave: stopActive,
        start() {
          pictureBinding?.activate();
          backend.start();
          stopUnload = guardUnload(window, pending);
          setSharedRetryLocalWrite(async () => {
            if (!sessionCurrent() || replica.session.isClosingOrClosed()) return;
            docWriteError = null;
            pictureWriteError = null;
            collaborationState().setLocalWriteError(null);
            if (replica.hasUnstoredChanges()) {
              collaborationState().setLocalPending(true);
              try {
                handleReceipt(await replica.flush());
              } catch {
                if (!sessionCurrent()) return;
                docWriteError = { reason: "io", message: localWriteErrorMessage("io"), code: "io" };
                collaborationState().setLocalPending(replica.hasUnstoredChanges());
                syncLocalError();
              }
            }
            pictureBinding?.retryStorage();
          });
          if (desktop) stopDesktop = trackSharedDesktopUnsaved(replica.hasUnstoredChanges);
          stopChanges = replica.session.subscribe(() => {
            if (pendingSyncQueued) return;
            pendingSyncQueued = true;
            queueMicrotask(syncLocalPending);
          });
          stopReceipts = replica.subscribe(handleReceipt);
          syncLocalPending();
        },
        dispose(attempt) {
          sessionDisposed = true;
          if (localCopy === replica) localCopy = null;
          trackClosing(name, replica);
          attempt(() => { if (sessionToken === activeSessionToken) setSharedRetryLocalWrite(null); });
          attempt(() => pictureBinding?.detach());
          attempt(() => stopUnload?.());
          attempt(() => stopChanges?.());
          attempt(() => stopReceipts?.());
          attempt(() => stopDesktop?.());
          stopDesktop = undefined;
          attempt(stopActive);
          backend.dispose(attempt);
        }
      };
      return retained;
    }, signal);
    if (outcome.ok && prepared.replica) {
      staged?.commit();
      localCopy = prepared.replica;
      active = true;
    }
    return outcome;
  } catch {
    return { ok: false, reason: SHARED_ENTER_FAILED };
  } finally {
    if (timed) ports.timers.stop(timer);
    if (!active) {
      if (signal?.aborted && preparation) {
        if (prepared.replica) trackClosing(name, prepared.replica);
        void preparation.then(closePrepared, closePrepared).catch(() => { ports.report(new Error("Could not close the refused shared copy.")); });
      } else await closePrepared();
    }
  }
}

export async function leaveRetainedSharedScript(): Promise<SharedSwitchOutcome> {
  const copy = localCopy;
  if (!copy || !sharedSession()) return { ok: false, reason: SHARED_NOT_RUNNING };
  const outcome = leaveRunningSharedSession();
  if (!outcome.ok) return outcome;
  // why: only the closing writer may erase this copy, before its lease is released
  return await copy.discardOnClose?.() ? { ok: true } : { ok: false, reason: "shared-copy-erase-failed" };
}

export function retainedSharedScriptActive(): boolean {
  return localCopy !== null && sharedSession();
}

export async function leaveActiveSharedSession(): Promise<SharedSwitchOutcome> {
  return retainedSharedScriptActive() ? leaveRetainedSharedScript() : leaveRunningSharedSession();
}
