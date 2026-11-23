import { createBrowserNativeLocalStore } from "../../adapters/collab/native/browser-local-store.ts";
import { createDesktopNativeLocalStore } from "../../adapters/collab/native/desktop-local-store.ts";
import type { NativeInvitationStage, NativeLocalStoreOpen } from "../../adapters/collab/native/local-store.ts";
import { applyNativePeerUpdate } from "../../adapters/collab/native/peer-update.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { sanitizeHtml } from "../richtext.ts";
import { guardUnload, waitDuringLifetime } from "../startup/page-lifetime.ts";
import { notifyDesktopDocumentState, trackSharedDesktopUnsaved } from "./desktop-owners.ts";
import { notices } from "./ports/effects.ts";
import { bindNativeEditor } from "./native-shared-session.ts";
import { sharedSession } from "./session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, SHARED_ALREADY, SHARED_ENTER_FAILED, SHARED_NOT_RUNNING } from "./shared-session.ts";
import type { SharedEditorBackend, SharedSwitchOutcome, SharedSwitchPorts } from "./shared-session.ts";

type RetainedReplica = Extract<NativeLocalStoreOpen, { kind: "opened" }>;
let localCopy: RetainedReplica | null = null;
const closingCopies = new Map<string, RetainedReplica["closed"]>();

function trackClosing(name: string, replica: RetainedReplica): void {
  closingCopies.set(name, replica.closed);
  void replica.closed.then(() => {
    if (closingCopies.get(name) === replica.closed) closingCopies.delete(name);
  });
}

export interface RetainedSharedScript {
  readonly deployment: string;
  readonly script: string;
  readonly invitation?: { readonly token: string; readonly state: Uint8Array };
  readonly connect?: (replica: RetainedReplica, token: string) => () => void;
}

export async function enterRetainedSharedScript(ports: SharedSwitchPorts, entry: RetainedSharedScript, signal?: AbortSignal): Promise<SharedSwitchOutcome> {
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
  let stopConnection: (() => void) | undefined;
  function stop() {
    try { stopConnection?.(); }
    catch { throw new Error("The retained connection could not close."); }
    stopConnection = undefined;
  }
  async function prepare(): Promise<string | null> {
    const refusal = await ports.prepare?.();
    if (refusal) return refusal;
    signal?.throwIfAborted();
    await closingCopies.get(name);
    signal?.throwIfAborted();
    const replica = await store.open(name, { actor: ports.editor(), sanitize: sanitizeHtml });
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
        if (signal) {
          if (!membership.stageInvitation || (replica.restored && !replica.session.isStoredScript())) return SHARED_ENTER_FAILED;
          staged = await membership.stageInvitation(entry.invitation.token, token, signal);
        } else {
          if (!replica.restored && !applyNativePeerUpdate(replica.session, entry.invitation.state)) return SHARED_ENTER_FAILED;
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
      if (signal && entry.invitation && !replica.restored &&
          (!applyNativePeerUpdate(replica.session, entry.invitation.state) || !replica.session.isStoredScript())) {
        throw new Error("The invitation did not contain a shared script.");
      }
      try { stopConnection = entry.connect?.(replica, token); }
      catch { throw new Error("The retained connection could not start."); }
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
      const notify = () => {
        if (!stopDesktop || wasDirty === replica.hasUnstoredChanges()) return;
        wasDirty = replica.hasUnstoredChanges();
        notifyDesktopDocumentState();
      };
      const retained: SharedEditorBackend = { ...backend,
        beforeDocumentSwitch: () => pending() ? "shared-copy-unsaved" : null,
        beforeExplicitLeave: stop,
        start() {
          backend.start();
          stopUnload = guardUnload(window, pending);
          if (desktop) {
            stopDesktop = trackSharedDesktopUnsaved(replica.hasUnstoredChanges);
            stopChanges = replica.session.subscribe(() => { queueMicrotask(notify); });
            stopReceipts = replica.subscribe(notify);
            notify();
          }
        },
        dispose(attempt) {
          if (localCopy === replica) localCopy = null;
          trackClosing(name, replica);
          attempt(() => stopUnload?.());
          attempt(() => stopChanges?.());
          attempt(() => stopReceipts?.());
          attempt(() => stopDesktop?.());
          stopDesktop = undefined;
          attempt(stop);
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
