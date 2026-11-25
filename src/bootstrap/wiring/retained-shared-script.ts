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
import { holdSessionCommands, sessionEntryRefusal, sharedSession } from "./session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, SHARED_ALREADY, SHARED_ENTER_FAILED, SHARED_NOT_RUNNING } from "./shared-session.ts";
import type { SharedEditorBackend, SharedSwitchOutcome, SharedSwitchPorts } from "./shared-session.ts";
import type { NativeMembershipRecord } from "../../../shared/native-replica.d.ts";

declare const SPLITPAGE_COLLAB_UI: boolean | undefined;

const desktopSharing = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI
  ? () => {
    const desktop = desktopPort();
    return { manage: desktop?.manageSharing, reference: desktop?.sharedReference, status: desktop?.relayOwner?.status };
  }
  : () => undefined;

type RetainedReplica = Extract<NativeLocalStoreOpen, { kind: "opened" }>;
const JOIN_TIMEOUT_MS = 15_000;
let localCopy: RetainedReplica | null = null;
let sharingControls: (() => RetainedSharingControls) | null = null;

interface RetainedSharingControls {
  readonly role: NativeMembershipRecord["role"];
  readonly link: string | null;
  readonly canManage: () => Promise<boolean>;
  readonly manage: (operation: "promote" | "reset" | "stop" | "check-link") => Promise<void>;
}

export function retainedSharingControls() {
  return sharingControls?.() ?? null;
}
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
  readonly created?: {
    readonly membership: NativeMembershipRecord;
    readonly state: Uint8Array;
    readonly complete: () => Promise<boolean>;
  };
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
  let token = options.token;
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
    replaceToken(session: RetainedReplica["session"], next: string) {
      detach();
      token = next;
      connected = false;
      permanentlyStopped = false;
      attach(bindSharedPictures({ session }, options.pictureOrigin, options.script, token));
    },
    bindCopy(copy: Parameters<typeof bindSharedPictures>[0], signal?: AbortSignal) {
      const bound = bindSharedPictures(copy, options.pictureOrigin, options.script, token, signal);
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
          attach(bindSharedPictures({ session: event.session }, options.pictureOrigin, options.script, token));
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
  const sharing = desktopSharing();
  const store = desktop ? createDesktopNativeLocalStore(desktop.nativeReplica, sharing?.manage)
    : createBrowserNativeLocalStore();
  const prepared: { replica?: RetainedReplica; membership?: NativeMembershipRecord } = {};
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
  const timed = !entry.created && !!(entry.relayUrl || entry.pictureOrigin);
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
    let current: NativeMembershipRecord | null;
    try {
      const membership = replica.membership;
      if (!membership) return SHARED_ENTER_FAILED;
      const saved = membership.record();
      const record = await (signal ? waitDuringLifetime(saved, signal) : saved);
      current = record;
      signal?.throwIfAborted();
      if (entry.created) {
        if (replica.restored || !applyNativePeerUpdate(replica.session, entry.created.state) || !replica.session.isStoredScript()) {
          return SHARED_ENTER_FAILED;
        }
        if ((await replica.flush()).kind !== "stored" || replica.hasUnstoredChanges()) return SHARED_ENTER_FAILED;
        await membership.join(entry.created.membership);
        current = entry.created.membership;
      } else if (entry.invitation) {
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
          staged = await membership.stageInvitation(entry.invitation.token, record, signal);
        } else if (cancellation) {
          return SHARED_ENTER_FAILED;
        } else {
          if (!replica.restored && (!state || !applyNativePeerUpdate(replica.session, state))) return SHARED_ENTER_FAILED;
          if (!replica.session.isStoredScript()) return SHARED_ENTER_FAILED;
          await membership.join(entry.invitation.token);
        }
        current = { role: "guest", token: entry.invitation.token };
      }
      if (!current || ((!signal || !entry.invitation) && !replica.session.isStoredScript())) return SHARED_ENTER_FAILED;
    } catch { return SHARED_ENTER_FAILED; }
    prepared.membership = current;
    return null;
  }
  async function closePrepared() {
    const replica = prepared.replica;
    if (!replica) return;
    trackClosing(name, replica);
    try { await staged?.rollback(); }
    finally {
      try { stop(); } finally { replica.session.close(); await replica.closed; }
      if (entry.created && !replica.restored) await store.delete(name);
    }
  }
  let connectCreated: (() => void) | undefined;
  try {
    const outcome = await enterSharedSession({ ...ports, prepare: () => (preparation = prepare()) }, (_, failedClose) => {
      const { replica } = prepared;
      let membership = prepared.membership;
      if (!replica || !membership) throw new Error("The retained copy was not prepared.");
      const { token } = membership;
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
      let liveRelay: ReturnType<typeof openNativeRelay> | undefined;
      const connect = () => {
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
                    collaborationState().setOfflineClashes(clashes);
                    entry.onOfflineNotice?.(clashes);
                  } finally {
                    relay.releaseOfflineGate();
                  }
                }
                return;
              }
              if (event.kind === "session-replaced" && sessionCurrent()) collaborationState().dismissOfflineClashes();
              pictureBinding.onRelayEvent(event);
            }
          });
          liveRelay = relay;
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
        pictureBinding?.finishPreparation();
      };
      if (entry.created) connectCreated = connect;
      else {
        try { connect(); }
        catch { throw new Error("The retained connection could not start."); }
      }
      const { backend } = bindNativeEditor(ports, replica.session, failedClose);
      let managing = false;
      let editorSession: Parameters<SharedEditorBackend["bind"]>[0] | undefined;
      const manage = replica.membership?.manage;
      const controls = () => {
        const link = pictureOrigin && membership?.guestLinkToken ? new URL("/", pictureOrigin) : null;
        if (link) {
          link.searchParams.set("join", entry.script);
          link.hash = membership?.guestLinkToken ?? "";
        }
        return {
          role: membership?.role ?? "guest",
          link: link?.href ?? null,
          async canManage() {
            if (!manage || !pictureOrigin || membership?.role !== "guest") return false;
            const settings = await sharing?.status?.();
            return sessionCurrent() && !!settings?.address
              && new URL(settings.address).origin === pictureOrigin;
          },
          async manage(operation: "promote" | "reset" | "stop" | "check-link") {
            if (!sessionCurrent() || !manage || !pictureOrigin || !liveRelay || managing || sessionEntryRefusal()) {
              throw new Error("The shared script is busy.");
            }
            const stopSharing = operation === "stop";
            if (stopSharing && !collaborationState().snapshot().relay.connected) throw new Error("The relay is offline.");
            if (stopSharing && backend.settle(true)) throw new Error("Finish editing before stopping sharing.");
            managing = true;
            const unhold = stopSharing ? editorSession?.hold("sharing-controls") : undefined;
            const release = holdSessionCommands("sharing-controls", stopSharing ? "all" : "entries");
            try {
              if (stopSharing && ((await replica.flush()).kind !== "stored" || replica.hasUnstoredChanges())) {
                throw new Error("The shared copy could not be saved.");
              }
              membership = await manage(operation, pictureOrigin);
              if (!sessionCurrent()) return;
              if (operation === "promote") {
                collaborationState().clearRefusal();
                pictureBinding?.replaceToken(liveRelay.session(), membership.token);
                liveRelay.reconnectWithToken(membership.token);
              }
            } finally {
              unhold?.();
              release();
              managing = false;
            }
            if (stopSharing && sessionCurrent() && !(await leaveRetainedSharedScript()).ok) {
              throw new Error("Could not leave the shared script.");
            }
          }
        } satisfies RetainedSharingControls;
      };
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
        bind(session) { editorSession = session; backend.bind(session); },
        ...(entry.created && { async finishEntry() {
          if (!await entry.created?.complete()) throw new Error("Could not complete sharing.");
        } }),
        beforeDocumentSwitch: () => pending() ? "shared-copy-unsaved" : null,
        beforeExplicitLeave: stopActive,
        start() {
          pictureBinding?.activate();
          backend.start();
          if (entry.relayUrl) sharingControls = controls;
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
          if (sharingControls === controls) sharingControls = null;
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
    }, entry.created ? undefined : signal);
    if (outcome.ok && prepared.replica) {
      staged?.commit();
      localCopy = prepared.replica;
      active = true;
      try { connectCreated?.(); }
      catch { notices.show("Could not connect to the shared script right now.", "warn"); }
      if (pictureOrigin && entry.relayUrl && sharing?.reference) {
        try {
          if (await sharing.reference([{ deployment: entry.deployment, script: entry.script, address: pictureOrigin }]) !== true) {
            throw new Error("Could not keep the shared script reference.");
          }
        } catch { notices.show("This computer could not remember which shared script to reopen.", "warn"); }
      }
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
  const discarded = copy.discardOnClose?.();
  const clear = desktopSharing()?.reference;
  const cleared = clear ? await clear([null]).catch(() => false) : true;
  return await discarded && cleared === true ? { ok: true } : { ok: false, reason: "shared-copy-erase-failed" };
}

export function retainedSharedScriptActive(): boolean {
  return localCopy !== null && sharedSession();
}

export async function confirmAndLeaveSharedSession(): Promise<SharedSwitchOutcome> {
  if (typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI && retainedSharingControls()?.role === "owner"
    && !window.confirm("The script will stay shared. This computer will give up its owner controls and remove its local shared copy. Leave shared script?")) {
    return { ok: false, reason: "cancelled" };
  }
  return leaveActiveSharedSession();
}

export async function leaveActiveSharedSession(): Promise<SharedSwitchOutcome> {
  return retainedSharedScriptActive() ? leaveRetainedSharedScript() : leaveRunningSharedSession();
}
