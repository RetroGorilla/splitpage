import { createBrowserNativeLocalStore } from "../../adapters/collab/native/browser-local-store.ts";
import { createDesktopNativeLocalStore } from "../../adapters/collab/native/desktop-local-store.ts";
import type { NativeLocalStoreOpen } from "../../adapters/collab/native/local-store.ts";
import { applyNativePeerUpdate } from "../../adapters/collab/native/peer-update.ts";
import { openNativeRelay } from "../../adapters/collab/native/relay.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { sanitizeHtml } from "../richtext.ts";
import { guardUnload } from "../startup/page-lifetime.ts";
import { notifyDesktopDocumentState, trackSharedDesktopUnsaved } from "./desktop-owners.ts";
import { notices } from "./ports/effects.ts";
import { documentReader } from "./ports/document.ts";
import { bindNativeEditor } from "./native-shared-session.ts";
import { bindSharedPictures } from "./shared-picture-session.ts";
import { sharedSession } from "./session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, SHARED_ALREADY, SHARED_ENTER_FAILED, SHARED_NOT_RUNNING } from "./shared-session.ts";
import type { SharedEditorBackend, SharedSwitchOutcome, SharedSwitchPorts } from "./shared-session.ts";

type RetainedReplica = Extract<NativeLocalStoreOpen, { kind: "opened" }>;
type PictureSession = ReturnType<typeof bindSharedPictures>;
let localCopy: RetainedReplica | null = null;
const closingCopies = new Map<string, RetainedReplica["closed"]>();

export interface RetainedSharedScript {
  readonly deployment: string;
  readonly script: string;
  readonly invitation?: { readonly token: string; readonly state?: Uint8Array };
  readonly relayUrl?: string;
  readonly pictureOrigin?: string;
  readonly signal?: AbortSignal;
  readonly connect?: (replica: RetainedReplica, token: string, pictures?: {
    readonly reconnect: () => void;
    readonly stop: () => void;
  }) => () => void;
}

function connectRetainedRelay(replica: RetainedReplica, url: string, name: string, token: string,
  actor: string, pictures: PictureSession | undefined, signal: AbortSignal) {
  let loaded: (ready: boolean) => void = () => {};
  const ready = new Promise<boolean>(resolve => { loaded = resolve; });
  const cancel = () => loaded(false);
  let connected = false;
  const relay = openNativeRelay(replica.session, {
    url, name, token, reopen: replica.reopen,
    sessionOptions: { actor, sanitize: sanitizeHtml },
    onEvent(event) {
      if (event.kind === "status") {
        if (event.status.connected && !connected) pictures?.reconnect();
        connected = event.status.connected;
        if (event.status.firstSyncDone) loaded(true);
      } else {
        pictures?.stop();
        cancel();
      }
    }
  });
  signal.addEventListener("abort", cancel, { once: true });
  return {
    ready,
    stop() {
      signal.removeEventListener("abort", cancel);
      cancel();
      relay.close();
    }
  };
}

export async function enterRetainedSharedScript(ports: SharedSwitchPorts, entry: RetainedSharedScript): Promise<SharedSwitchOutcome> {
  if (sharedSession()) return { ok: false, reason: SHARED_ALREADY };
  const identity = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
  if (!identity.test(entry.deployment) || !identity.test(entry.script)) return { ok: false, reason: SHARED_ENTER_FAILED };
  const name = entry.deployment + "/" + entry.script;
  const desktop = desktopPort();
  const store = desktop ? createDesktopNativeLocalStore(desktop.nativeReplica) : createBrowserNativeLocalStore();
  const prepared: { replica?: RetainedReplica; token?: string } = {};
  let active = false;
  let pictures: PictureSession | undefined;
  let stopConnection: (() => void) | undefined;
  function stop() {
    try { stopConnection?.(); }
    catch { throw new Error("The retained connection could not close."); }
    stopConnection = undefined;
    pictures?.stop();
  }
  async function prepare(): Promise<string | null> {
    const refusal = await ports.prepare?.();
    if (refusal) return refusal;
    await closingCopies.get(name);
    const replica = await store.open(name, { actor: ports.editor(), sanitize: sanitizeHtml });
    if (replica.kind === "failed") {
      if (replica.reason === "locked") notices.show("This shared script is already open in another tab.", "warn");
      return replica.reason;
    }
    prepared.replica = replica;
    const membership = replica.membership;
    if (!membership) return SHARED_ENTER_FAILED;
    let token: string | null;
    try {
      token = await membership.token();
      if (entry.invitation) {
        if (!replica.restored && entry.invitation.state && !applyNativePeerUpdate(replica.session, entry.invitation.state)) {
          return SHARED_ENTER_FAILED;
        }
        if (!entry.relayUrl && !replica.session.isStoredScript()) return SHARED_ENTER_FAILED;
        token = entry.invitation.token;
        if (!entry.relayUrl) await membership.join(token);
      }
      if (!token || (!entry.relayUrl && !replica.session.isStoredScript())) return SHARED_ENTER_FAILED;
    } catch { return SHARED_ENTER_FAILED; }
    prepared.token = token;
    const preparation = new AbortController();
    const stopReplacement = documentReader.onReplaced(() => preparation.abort());
    const signal = entry.signal ? AbortSignal.any([entry.signal, preparation.signal]) : preparation.signal;
    try {
      if (signal.aborted) return SHARED_ENTER_FAILED;
      let pictureOrigin = entry.pictureOrigin;
      if (entry.relayUrl) {
        const url = new URL(entry.relayUrl);
        if (url.protocol !== "ws:" && url.protocol !== "wss:") return SHARED_ENTER_FAILED;
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
        pictureOrigin = url.href;
      }
      if (pictureOrigin) pictures = bindSharedPictures(replica, pictureOrigin, entry.script, token, signal);
      if (entry.relayUrl) {
        const connection = connectRetainedRelay(replica, entry.relayUrl, entry.script, token, ports.editor(), pictures, signal);
        stopConnection = connection.stop;
        if ((!replica.restored || entry.invitation) && !await connection.ready) return SHARED_ENTER_FAILED;
        if (!replica.session.isStoredScript()) return SHARED_ENTER_FAILED;
      } else if (pictures) {
        stopConnection = entry.connect?.(replica, token, pictures);
      }
      if (entry.relayUrl && entry.invitation && !signal.aborted) await membership.join(token);
      if (pictures && !await pictures.hydrate()) return SHARED_ENTER_FAILED;
      return signal.aborted ? SHARED_ENTER_FAILED : null;
    } catch { return SHARED_ENTER_FAILED; }
    finally { stopReplacement(); }
  }
  try {
    const outcome = await enterSharedSession({ ...ports, prepare }, (_, failedClose) => {
      const { replica, token } = prepared;
      if (!replica || !token) throw new Error("The retained copy was not prepared.");
      if (!entry.relayUrl && !pictures) {
        try { stopConnection = entry.connect?.(replica, token); }
        catch { throw new Error("The retained connection could not start."); }
      }
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
          pictures?.activate();
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
          closingCopies.set(name, replica.closed);
          void replica.closed.then(() => { closingCopies.delete(name); });
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
    });
    if (outcome.ok && prepared.replica) { localCopy = prepared.replica; active = true; }
    return outcome;
  } catch {
    return { ok: false, reason: SHARED_ENTER_FAILED };
  } finally {
    if (!active && prepared.replica) {
      try { stop(); } finally { pictures?.stop(); prepared.replica.session.close(); await prepared.replica.closed; }
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
