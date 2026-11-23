import { createBrowserNativeLocalStore } from "../../adapters/collab/native/browser-local-store.ts";
import { createDesktopNativeLocalStore } from "../../adapters/collab/native/desktop-local-store.ts";
import type { NativeLocalStore, NativeLocalStoreOpen } from "../../adapters/collab/native/local-store.ts";
import { applyNativePeerUpdate } from "../../adapters/collab/native/peer-update.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { sanitizeHtml } from "../richtext.ts";
import { notices } from "./ports/effects.ts";
import { bindNativeEditor } from "./native-shared-session.ts";
import { sharedSession } from "./session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, SHARED_ALREADY, SHARED_ENTER_FAILED, SHARED_NOT_RUNNING } from "./shared-session.ts";
import type { SharedEditorBackend, SharedSwitchOutcome, SharedSwitchPorts } from "./shared-session.ts";

type RetainedReplica = Extract<NativeLocalStoreOpen, { kind: "opened" }>;
interface RetainedCopy {
  readonly store: NativeLocalStore;
  readonly name: string;
  readonly replica: RetainedReplica;
}
let localCopy: RetainedCopy | null = null;
const closingCopies = new Map<string, RetainedReplica["closed"]>();

export interface RetainedSharedScript {
  readonly deployment: string;
  readonly script: string;
  readonly invitation?: { readonly token: string; readonly state: Uint8Array };
  readonly connect?: (replica: RetainedReplica, token: string) => () => void;
}

export async function enterRetainedSharedScript(ports: SharedSwitchPorts, entry: RetainedSharedScript): Promise<SharedSwitchOutcome> {
  if (sharedSession()) return { ok: false, reason: SHARED_ALREADY };
  const identity = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
  if (!identity.test(entry.deployment) || !identity.test(entry.script)) return { ok: false, reason: SHARED_ENTER_FAILED };
  const name = entry.deployment + "/" + entry.script;
  await closingCopies.get(name);
  const desktop = desktopPort();
  const store = desktop ? createDesktopNativeLocalStore(desktop.nativeReplica) : createBrowserNativeLocalStore();
  const replica = await store.open(name, { actor: ports.editor(), sanitize: sanitizeHtml });
  if (replica.kind === "failed") {
    if (replica.reason === "locked") notices.show("This shared script is already open in another tab.", "warn");
    return { ok: false, reason: replica.reason };
  }
  let active = false;
  let stopConnection: (() => void) | undefined;
  function stop() {
    const disconnect = stopConnection;
    stopConnection = undefined;
    disconnect?.();
  }
  try {
    const membership = replica.membership;
    if (!membership) return { ok: false, reason: SHARED_ENTER_FAILED };
    let token = await membership.token();
    if (entry.invitation) {
      if (!replica.restored && !applyNativePeerUpdate(replica.session, entry.invitation.state)) {
        return { ok: false, reason: SHARED_ENTER_FAILED };
      }
      if (!replica.session.isStoredScript()) return { ok: false, reason: SHARED_ENTER_FAILED };
      token = entry.invitation.token;
      await membership.join(token);
    }
    if (!token || !replica.session.isStoredScript()) return { ok: false, reason: SHARED_ENTER_FAILED };
    stopConnection = entry.connect?.(replica, token);
    let copy: RetainedCopy | undefined;
    const outcome = await enterSharedSession(ports, (_, failedClose) => {
      const { backend } = bindNativeEditor(ports, replica.session, failedClose);
      const retained: SharedEditorBackend = { ...backend, dispose(attempt) {
        if (localCopy === copy) localCopy = null;
        closingCopies.set(name, replica.closed);
        void replica.closed.then(() => { closingCopies.delete(name); });
        attempt(stop);
        backend.dispose(attempt);
      } };
      copy = { store, name, replica };
      return retained;
    });
    if (outcome.ok && copy) { localCopy = copy; active = true; }
    return outcome;
  } catch {
    return { ok: false, reason: SHARED_ENTER_FAILED };
  } finally {
    if (!active) {
      try { stop(); } finally { replica.session.close(); await replica.closed; }
    }
  }
}

export async function leaveRetainedSharedScript(): Promise<SharedSwitchOutcome> {
  const copy = localCopy;
  if (!copy) return { ok: false, reason: SHARED_NOT_RUNNING };
  let discarded = false;
  if (sharedSession()) {
    const outcome = leaveRunningSharedSession();
    if (!outcome.ok) return outcome;
    localCopy = copy;
    // why: deletion must run before the closing store releases its writer lock
    discarded = await copy.replica.discardOnClose?.() ?? false;
  }
  await copy.replica.closed;
  if (!discarded) {
    const removed = await copy.store.delete(copy.name);
    if (removed.kind === "failed") return { ok: false, reason: removed.reason };
  }
  if (localCopy === copy) localCopy = null;
  return { ok: true };
}
