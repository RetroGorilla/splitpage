import { exposeTestHook } from "../../features/common/test-hooks.ts";
import { documentReader } from "./ports/document.ts";
import { openNativeEditor } from "./native-shared-session.ts";
import { createNativeTestPeer } from "./shared-native-test-peer.ts";
import { collaborationState } from "./collaboration-owner.ts";
import type { RetainedSharedScript } from "./retained-shared-script.ts";
import { captureDocumentOpeningLifetime } from "./transition-owners.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { sharedEntry } from "./shared-entry.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

function sharedTestBytes(state: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof state === "string") return Uint8Array.from(atob(state), character => character.charCodeAt(0));
  return state instanceof ArrayBuffer ? new Uint8Array(state.slice(0)) : Uint8Array.from(state);
}


function mountHook(invitationStatus: () => { readonly connected: boolean; readonly settled: boolean }) {
  let nativePeer: ReturnType<typeof createNativeTestPeer> | null = null;
  let withdraw = (): void => {};
  const lifetime = new AbortController();
  const stopped = { ok: false, reason: "app-stopped" } as const;
  const entry = () => lifetime.signal.aborted ? undefined : sharedEntry();
  const left = () => {
    nativePeer?.dispose();
    nativePeer = null;
  };

  async function enter(stored?: Uint8Array) {
    let session: ReturnType<typeof openNativeEditor>["native"] | undefined;
    const result = await entry()?.enter(undefined, undefined, undefined, entryPorts => (doc, failedClose) => {
      const { backend, native } = openNativeEditor(entryPorts, doc, failedClose, stored);
      session = native;
      return backend;
    });
    if (result?.ok && session) nativePeer = createNativeTestPeer(session);
    return result ?? stopped;
  }

  const hook = {
    enter: () => enter(),
    enterFrom: (state: string | Uint8Array | ArrayBuffer) => enter(sharedTestBytes(state)),
    snapshot: () => nativePeer?.snapshot(),
    leave: () => entry()?.leave() ?? stopped,
    enterRetained: (retained: RetainedSharedScript, cancellation?: AbortSignal) => {
      const session = entry();
      if (!session) return Promise.resolve(stopped);
      if (desktopPort()) return session.enter(retained);
      const opening = captureDocumentOpeningLifetime();
      return session.enter(retained, AbortSignal.any([
        lifetime.signal, opening.signal, ...(cancellation ? [cancellation] : [])
      ]));
    },
    invitationConnected: () => invitationStatus().connected,
    invitationSettled: () => invitationStatus().settled,
    nativePeer: {
      type: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["type"]>) => nativePeer?.type(...args),
      field: (...args: Parameters<NonNullable<typeof nativePeer>["field"]>) => nativePeer?.field(...args),
      join: (lower: string, upper: string) => nativePeer?.join(lower, upper),
      unjoin: (lower: string) => nativePeer?.unjoin(lower),
      split: (beat: string, offset: number) => nativePeer?.split(beat, offset),
      createFirstBeat: (narration?: string) => nativePeer?.createFirstBeat(narration),
      removeBeat: (id: string) => nativePeer?.removeBeat(id),
      replaceAll: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["replaceAll"]>) => nativePeer?.replaceAll(...args),
      undoPeer: () => nativePeer?.undoPeer(),
      redoPeer: () => nativePeer?.redoPeer(),
      titleType: (offset: number, text: string) => nativePeer?.titleType(offset, text),
      titleDelete: (from: number, to: number) => nativePeer?.titleDelete(from, to),
      titleReplace: (from: number, to: number, text: string) => nativePeer?.titleReplace(from, to, text),
      seedReader: () => nativePeer?.seedReader(),
      readLateReader: () => nativePeer?.readLateReader() ?? null,
      typeReader: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["typeReader"]>) =>
        nativePeer?.typeReader(...args) ?? null,
      undoReader: () => nativePeer?.undoReader() ?? null,
      queuedReaderUpdates: () => nativePeer?.queuedReaderUpdates() ?? [],
      deliverReaderUpdates: () => nativePeer?.deliverReaderUpdates() ?? [],
      deliverToReader: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["deliverToReader"]>) =>
        nativePeer?.deliverToReader(...args) ?? false,
      freshSnapshot: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["freshSnapshot"]>) =>
        nativePeer?.freshSnapshot(...args) ?? null,
      moveBeat: (...args: Parameters<NonNullable<typeof nativePeer>["moveBeat"]>) => nativePeer?.moveBeat(...args),
      removeComment: (id: string) => nativePeer?.removeComment(id),
      registry: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["registry"]>) => nativePeer?.registry(...args),
      format: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["format"]>) => nativePeer?.format(...args),
      hold: (mode?: "updates") => nativePeer?.hold(mode),
      queuedUpdates: () => nativePeer?.queuedUpdates(),
      drain: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["drain"]>) => nativePeer?.drain(...args),
      release: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["release"]>) => nativePeer?.release(...args),
      deliver: () => nativePeer?.deliver(),
      reviewOfflineChanges: () => {
        if (nativePeer) collaborationState().setOfflineClashes(nativePeer.offlineNotice());
      },
      step: (direction: "undo" | "redo") => nativePeer?.step(direction),
      delete: (...args: Parameters<ReturnType<typeof createNativeTestPeer>["delete"]>) => nativePeer?.delete(...args)
    },
    read: () => ({ app: documentReader.read(doc => doc ? JSON.parse(JSON.stringify(doc)) as unknown : null), peer: nativePeer?.read() ?? null })
  };
  exposeTestHook("__sharedTest", () => hook, release => { withdraw = release; });
  return {
    left,
    dispose() {
      lifetime.abort();
      left();
      withdraw();
    }
  };
}

export const startSharedTestHook = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS ? mountHook : undefined;
